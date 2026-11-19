/**
 * ad_reward.js: AdMob SSV callbacks and v1 rewarded-ad intents ("r1_<id>" custom data).
 * In-memory stand-in for the collections; real MongoDB runs when MONGO_TEST_URI is set.
 */

const ar = require('../ad_reward');

function fakeDb(opts = {}) {
	const { bareDocs = false } = opts;
	const intents = new Map();
	const tx = [];
	const seen = new Map();
	const matchesTx = (d, q) => d.user === q.user && d.reward_activity === q.reward_activity
		&& d.tier === q.tier && d.date >= q.date.$gte;
	const dup = () => { const e = new Error('dup'); e.code = 11000; return e; };
	return {
		intents, tx, seen, opts,
		collection(name) {
			if (name === 'ad_reward_intents') return {
				createIndex: async () => 'ok',
				insertOne: async (doc) => { intents.set(doc._id, doc); return { insertedId: doc._id }; },
				deleteMany: async (q) => {
					for (const [k, d] of intents) if (d.user === q.user && d.tier === q.tier) intents.delete(k);
					return {};
				},
				findOneAndDelete: async (q) => {
					const d = intents.get(q._id);
					const hit = d && d.expires_at > q.expires_at.$gt ? d : null;
					if (hit) intents.delete(q._id);
					return bareDocs ? hit : { value: hit };
				},
			};
			if (name === 'token_transactions') return {
				createIndex: async () => 'ok',
				countDocuments: async (q) => tx.filter((d) => matchesTx(d, q)).length,
				findOne: async (q) => tx.find((d) => d.user === q.user) || null,
				insertOne: async (doc) => {
					if (opts.failTxInsert) throw new Error('write failed');
					if (doc._id && tx.some((d) => d._id === doc._id)) throw dup();
					tx.push(doc);
					// the write was applied, but the driver reports a failure (socket timeout)
					if (opts.appliedThenFail) { opts.appliedThenFail = false; throw new Error('socket timeout'); }
					return {};
				},
			};
			if (name === 'user_tokens') return {
				findOne: async (q) => {
					if (opts.failKnownLookup) { opts.failKnownLookup = false; throw new Error('read failed'); }
					return KNOWN.has(q._id) ? { _id: q._id } : null;
				},
			};
			if (name === 'ad_ssv_transactions') return {
				createIndex: async () => 'ok',
				insertOne: async (doc) => {
					if (seen.has(doc._id)) throw dup();
					seen.set(doc._id, Object.assign({}, doc)); return {};
				},
				findOne: async (q) => seen.get(q._id) || null,
				updateOne: async (q, u) => { if (seen.has(q._id)) Object.assign(seen.get(q._id), u.$set); return {}; },
				deleteOne: async (q) => { seen.delete(q._id); return {}; },
			};
			throw new Error('unexpected collection ' + name);
		},
	};
}

const KNOWN = new Set(['alice', 'bob', 'carol', 'dave']);
const T0 = Date.UTC(2026, 10, 18, 12, 0, 0);
const at = (ms) => () => ms;
const notBanned = () => false;
const q = (id, extra = {}) => Object.assign({ custom_data: 'r1_' + id, transaction_id: 't1', ad_network: 'n', ad_unit: 'u' }, extra);

describe('rewardAmount', () => {
	test('stays inside the tier range, floored to 3 decimals', () => {
		expect(ar.rewardAmount(4, () => 0)).toBe(0.01);
		expect(ar.rewardAmount(4, () => 0.999999)).toBeLessThanOrEqual(10);
		expect(ar.rewardAmount(1, () => 0.5)).toBe(1.505);
		for (let i = 0; i < 200; i++) {
			const v = ar.rewardAmount(3);
			expect(v).toBeGreaterThanOrEqual(0.01);
			expect(v).toBeLessThanOrEqual(7);
			expect(Number(v.toFixed(3))).toBe(v);
		}
	});
	test('unknown tier pays nothing', () => {
		expect(ar.rewardAmount(9)).toBe(0);
	});
});

describe('capLegacyAmount', () => {
	test('caps the client-chosen amount at the tier maximum', () => {
		expect(ar.capLegacyAmount('4', '9.5')).toBe(9.5);
		expect(ar.capLegacyAmount('4', '5000')).toBe(10);
		expect(ar.capLegacyAmount('1', '3.2')).toBe(3);
	});
	test('refuses unknown tiers and non-positive amounts', () => {
		expect(ar.capLegacyAmount('5', '1')).toBeNull();
		expect(ar.capLegacyAmount('1x', '1')).toBeNull();
		expect(ar.capLegacyAmount('free', '1')).toBeNull();
		expect(ar.capLegacyAmount('2', '-3')).toBeNull();
		expect(ar.capLegacyAmount('2', 'abc')).toBeNull();
	});
});

describe('parseV1', () => {
	test('accepts only r1_ + 32 hex chars', () => {
		expect(ar.parseV1('r1_' + 'a'.repeat(32))).toBe('a'.repeat(32));
		expect(ar.parseV1('r1_' + 'a'.repeat(31))).toBeNull();
		expect(ar.parseV1('r1_' + 'A'.repeat(32))).toBeNull();
		expect(ar.parseV1('r1_' + 'a'.repeat(32) + '_x')).toBeNull();
		expect(ar.parseV1(['r1_' + 'a'.repeat(32)])).toBeNull();
		expect(ar.parseV1(undefined)).toBeNull();
	});
	test('legacy custom data is left to the legacy path', () => {
		expect(ar.parseV1('alice_2.5_2_5K%20Reward')).toBeNull();
	});
});

describe('intents', () => {
	test('the intent reply carries no amount (it is picked at payment, so it cannot be rerolled)', async () => {
		const db = fakeDb();
		const out = await ar.createIntent(db, 'alice', '3', at(T0));
		expect(Object.keys(out)).toEqual(['id']);
		expect(out.id).toMatch(/^[0-9a-f]{32}$/);
	});

	test('an intent is consumed once', async () => {
		const db = fakeDb();
		const { id } = await ar.createIntent(db, 'alice', 3, at(T0));
		expect(await ar.consumeIntent(db, id, at(T0 + 1000))).toMatchObject({ user: 'alice', tier: 3 });
		expect(await ar.consumeIntent(db, id, at(T0 + 2000))).toBeNull();
	});

	test('driver 6 shape (bare document) works too', async () => {
		const db = fakeDb({ bareDocs: true });
		const { id } = await ar.createIntent(db, 'alice', 3, at(T0));
		expect(await ar.consumeIntent(db, id, at(T0 + 1000))).toMatchObject({ user: 'alice' });
		expect(await ar.consumeIntent(db, id, at(T0 + 1000))).toBeNull();
	});

	test('a new intent replaces the open one for the same user and tier', async () => {
		const db = fakeDb();
		const a = await ar.createIntent(db, 'alice', 2, at(T0));
		const b = await ar.createIntent(db, 'alice', 2, at(T0));
		await ar.createIntent(db, 'alice', 3, at(T0));
		expect(db.intents.size).toBe(2);
		expect(await ar.consumeIntent(db, a.id, at(T0))).toBeNull();
		expect(await ar.consumeIntent(db, b.id, at(T0))).not.toBeNull();
	});

	test('an expired intent is refused', async () => {
		const db = fakeDb();
		const { id } = await ar.createIntent(db, 'alice', 1, at(T0));
		expect(await ar.consumeIntent(db, id, at(T0 + ar.INTENT_TTL_MS + 1))).toBeNull();
	});

	test('a bad tier or malformed id is refused', async () => {
		const db = fakeDb();
		expect(await ar.createIntent(db, 'alice', 0, at(T0))).toEqual({ error: 'bad_tier' });
		expect(await ar.createIntent(db, 'alice', 'x', at(T0))).toEqual({ error: 'bad_tier' });
		expect(await ar.consumeIntent(db, { $ne: null }, at(T0))).toBeNull();
		expect(await ar.consumeIntent(db, 'zz', at(T0))).toBeNull();
	});

	test('no new intent once the tier was paid today (UTC), by either format; tomorrow is fine', async () => {
		const db = fakeDb();
		db.tx.push({ user: 'alice', reward_activity: 'Ad Reward', tier: '2', date: new Date(T0 - 3600 * 1000) });
		expect(await ar.createIntent(db, 'alice', 2, at(T0))).toEqual({ error: 'already_claimed' });
		expect((await ar.createIntent(db, 'alice', 3, at(T0))).id).toBeDefined();
		expect((await ar.createIntent(db, 'bob', 2, at(T0))).id).toBeDefined();
		expect((await ar.createIntent(db, 'alice', 2, at(T0 + 24 * 3600 * 1000))).id).toBeDefined();
	});
});

describe('payIntent', () => {
	test('pays once: stored row, server-picked amount, notification', async () => {
		const db = fakeDb();
		const notify = jest.fn();
		const { id } = await ar.createIntent(db, 'alice', 4, at(T0));
		const out = await ar.payIntent(db, q(id), notBanned, notify, at(T0 + 60000));
		expect(out).toMatchObject({ status: 'success', user: 'alice' });
		expect(out.amount).toBeGreaterThanOrEqual(0.01);
		expect(out.amount).toBeLessThanOrEqual(10);
		expect(db.tx).toHaveLength(1);
		expect(db.tx[0]).toMatchObject({ user: 'alice', reward_activity: 'Ad Reward', tier: '4', token_count: out.amount, transaction_id: 't1' });
		expect(notify).toHaveBeenCalledWith('alice', out.amount, 4);
		// AdMob retry of the same callback
		expect(await ar.payIntent(db, q(id), notBanned, notify, at(T0 + 61000))).toEqual({ error: 'Unknown or expired reward' });
		expect(db.tx).toHaveLength(1);
	});

	test('two intents for one tier and day pay once (the ledger row id is per user, tier and day)', async () => {
		const db = fakeDb();
		const a = await ar.createIntent(db, 'alice', 1, at(T0));
		// a second id slipped in before the first was replaced
		db.intents.set('b'.repeat(32), { _id: 'b'.repeat(32), user: 'alice', tier: 1, expires_at: new Date(T0 + 60000) });
		const [r1, r2] = await Promise.all([
			ar.payIntent(db, q(a.id), notBanned, () => {}, at(T0)),
			ar.payIntent(db, q('b'.repeat(32)), notBanned, () => {}, at(T0)),
		]);
		expect([r1, r2].filter((r) => r.status === 'success')).toHaveLength(1);
		expect(db.tx).toHaveLength(1);
	});

	test('a banned user is not paid', async () => {
		const db = fakeDb();
		const { id } = await ar.createIntent(db, 'alice', 1, at(T0));
		expect(await ar.payIntent(db, q(id), (u) => u === 'alice', () => {}, at(T0))).toEqual({ error: 'Account banned from rewards' });
		expect(db.tx).toHaveLength(0);
	});

	test('a failed payment write frees the day slot, puts the intent back and throws', async () => {
		const db = fakeDb({ failTxInsert: true });
		const log = jest.spyOn(console, 'log').mockImplementation(() => {});
		const { id } = await ar.createIntent(db, 'alice', 2, at(T0));
		await expect(ar.payIntent(db, q(id), notBanned, () => {}, at(T0))).rejects.toThrow('write failed');
		expect(db.tx).toHaveLength(0);
		expect(db.intents.has(id)).toBe(true);
		expect(log).toHaveBeenCalledWith('ad reward NOT paid', id, 'alice', 2, 't1', 'write failed');
		log.mockRestore();
	});
});

const MONGO_URI = process.env.MONGO_TEST_URI;
(MONGO_URI ? describe : describe.skip)('intents (real MongoDB)', () => {
	const { MongoClient } = require('mongodb');
	let client, db;
	beforeAll(async () => {
		client = await MongoClient.connect(MONGO_URI);
		db = client.db('ad_reward_test_' + Date.now());
	});
	afterAll(async () => { await db.dropDatabase(); await client.close(); });

	test('concurrent consumes of one id: exactly one wins', async () => {
		const { id } = await ar.createIntent(db, 'alice', 4);
		const results = await Promise.all([1, 2, 3, 4, 5].map(() => ar.consumeIntent(db, id)));
		expect(results.filter(Boolean)).toHaveLength(1);
	});
});

describe('checkCallback (AdMob SSV shape)', () => {
	const UNITS = ['ca-app-pub-123/5550001'];
	const NOW = T0;
	const good = (over = {}) => {
		const p = Object.assign({
			ad_network: '5450213213286189855', ad_unit: '5550001', custom_data: 'r1_' + 'a'.repeat(32),
			reward_amount: '1', reward_item: 'gift', timestamp: String(NOW - 1000), transaction_id: 'abc123',
			user_id: '', signature: 'MEUCIQ-sig', key_id: '3335741209',
		}, over);
		return Object.keys(p).map((k) => k + '=' + encodeURIComponent(p[k])).join('&');
	};

	test('accepts a callback from our ad unit, both id forms', () => {
		const r = ar.checkCallback(good(), UNITS, NOW);
		expect(r.ok).toBe(true);
		expect(r.params.custom_data).toBe('r1_' + 'a'.repeat(32));
		expect(ar.checkCallback(good({ ad_unit: 'ca-app-pub-123/5550001' }), ['5550001'], NOW).ok).toBe(true);
	});

	test('refuses another app ad unit (Google signs every app with the same keys)', () => {
		expect(ar.checkCallback(good({ ad_unit: '9990001' }), UNITS, NOW)).toEqual({ ok: false, error: 'not our ad unit' });
	});

	test('fails closed when no ad units are configured', () => {
		expect(ar.checkCallback(good(), undefined, NOW).ok).toBe(false);
		expect(ar.checkCallback(good(), [], NOW).ok).toBe(false);
	});

	test('refuses anything after signature and key_id (the library does not verify it)', () => {
		expect(ar.checkCallback(good() + '&ad_unit=5550001', UNITS, NOW).ok).toBe(false);
		expect(ar.checkCallback(good() + '&x=1', UNITS, NOW).ok).toBe(false);
	});

	test('refuses a repeated parameter (Express would make it an array)', () => {
		const s = good().replace('&reward_amount=', '&ad_unit=5550001&reward_amount=');
		expect(ar.checkCallback(s, UNITS, NOW).ok).toBe(false);
	});

	test('refuses "signature" inside the signed part (the library would verify a prefix)', () => {
		const s = good({ ad_unit: '9990001' }).replace('&reward_amount=', '&signaturex=1&ad_unit=5550001&reward_amount=');
		expect(ar.checkCallback(s, UNITS, NOW).ok).toBe(false);
		expect(ar.checkCallback(good({ custom_data: 'signature_1_1_x' }), UNITS, NOW).ok).toBe(false);
	});

	test('refuses bracketed keys; accepts a new signed parameter (Google may add one)', () => {
		const s = good().replace('&reward_amount=', '&custom_data[a]=1&reward_amount=');
		expect(ar.checkCallback(s, UNITS, NOW).ok).toBe(false);
		expect(ar.checkCallback(good().replace('&reward_amount=', '&new_param=1&reward_amount='), UNITS, NOW).ok).toBe(true);
	});

	test('AdMob omits custom_data and user_id when unset; + is a space', () => {
		const s = good().replace(/&custom_data=[^&]*/, '').replace(/&user_id=[^&]*/, '');
		const r = ar.checkCallback(s, UNITS, NOW);
		expect(r.ok).toBe(true);
		expect(r.params.custom_data).toBeUndefined();
		const plus = ar.checkCallback(good().replace(/custom_data=[^&]*/, 'custom_data=alice_1_1_10K+steps'), UNITS, NOW);
		expect(plus.params.custom_data).toBe('alice_1_1_10K steps');
	});

	test('refuses stale and future timestamps, and a missing transaction id', () => {
		expect(ar.checkCallback(good({ timestamp: String(NOW - 25 * 3600e3) }), UNITS, NOW).ok).toBe(false);
		expect(ar.checkCallback(good({ timestamp: String(NOW + 10 * 60e3) }), UNITS, NOW).ok).toBe(false);
		expect(ar.checkCallback(good({ timestamp: 'x' }), UNITS, NOW).ok).toBe(false);
		expect(ar.checkCallback(good({ transaction_id: '' }), UNITS, NOW).ok).toBe(false);
	});

	test('refuses a query with no signature', () => {
		expect(ar.checkCallback('ad_unit=5550001&custom_data=x', UNITS, NOW).ok).toBe(false);
		expect(ar.checkCallback(undefined, UNITS, NOW).ok).toBe(false);
	});
});

describe('takeTransaction (replay guard)', () => {
	test('new once; busy while the first copy is still being paid; done afterwards', async () => {
		const db = fakeDb();
		expect(await ar.takeTransaction(db, 'tx1', T0)).toBe('new');
		expect(await ar.takeTransaction(db, 'tx1', T0 + 1000)).toBe('busy');
		expect(await ar.takeTransaction(db, 'tx2', T0)).toBe('new');
		// a crashed request does not block the id forever
		expect(await ar.takeTransaction(db, 'tx1', T0 + 61000)).toBe('done');
		db.seen.get('tx2').status = 'done';
		expect(await ar.takeTransaction(db, 'tx2', T0 + 1000)).toBe('done');
	});
});

describe('handleCallback (the whole /ssv-verify route, real signatures)', () => {
	const crypto = require('crypto');
	const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
	const PEM = publicKey.export({ type: 'spki', format: 'pem' });
	const UNIT = '5550001';
	let fetches;
	const fetchKeys = async () => { fetches++; return { keys: [{ keyId: 3335741209, pem: PEM }] }; };
	let txSeq = 0;

	// a callback as AdMob sends it: alphabetical, signature over everything before it
	function callback(customData, { key = privateKey, unit = UNIT, ts = T0 - 1000, tx } = {}) {
		const p = { ad_network: '5450213213286189855', ad_unit: unit, custom_data: customData, reward_amount: '1',
			reward_item: 'gift', timestamp: String(ts), transaction_id: tx || 'tx' + (++txSeq), user_id: '' };
		const signed = Object.keys(p).map((k) => k + '=' + encodeURIComponent(p[k])).join('&');
		const sig = crypto.sign('sha256', Buffer.from(signed), key).toString('base64url');
		return signed + '&signature=' + sig + '&key_id=3335741209';
	}
	const run = (db, raw, extra = {}) => ar.handleCallback(db, raw, Object.assign({
		adUnits: [UNIT], banned: notBanned, notify: () => {}, now: at(T0), fetchKeys,
	}, extra));

	let log;
	beforeEach(() => {
		ar.resetKeyCacheForTests();
		fetches = 0;
		log = jest.spyOn(console, 'log').mockImplementation(() => {});
	});
	afterEach(() => log.mockRestore());

	test('a genuine v1 callback pays; the same callback again is a duplicate', async () => {
		const db = fakeDb();
		const { id } = await ar.createIntent(db, 'alice', 3, at(T0));
		const raw = callback('r1_' + id);
		expect(await run(db, raw)).toEqual({ status: 200, body: { status: 'success' } });
		expect(db.tx).toHaveLength(1);
		expect(await run(db, raw)).toEqual({ status: 200, body: { error: 'Duplicate callback' } });
		expect(db.tx).toHaveLength(1);
	});

	test('a percent-encoded value verifies over the raw bytes', async () => {
		const db = fakeDb();
		const raw = callback('alice_2.5_1_10K steps/day');
		expect(raw).toContain('10K%20steps%2Fday');
		expect(await run(db, raw)).toEqual({ status: 200, body: { status: 'success' } });
		expect(db.tx[0]).toMatchObject({ user: 'alice', token_count: 2.5, custom_data: 'alice_2.5_1_10K steps/day' });
	});

	test('a changed signed value, a foreign key and an unknown key id are refused', async () => {
		const db = fakeDb();
		const raw = callback('alice_3_1_x');
		expect((await run(db, raw.replace('alice_3_1_x', 'mallory_3_1_x'))).status).toBe(400);
		const other = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
		expect((await run(db, callback('alice_3_1_x', { key: other }))).status).toBe(400);
		expect((await run(db, raw.replace('key_id=3335741209', 'key_id=1')))).toEqual({ status: 400, body: 'Invalid callback' });
		expect(db.tx).toHaveLength(0);
	});

	test('another app ad unit is refused even with a valid signature', async () => {
		const db = fakeDb();
		expect((await run(db, callback('alice_3_1_x', { unit: '9990001' }))).status).toBe(400);
		expect(db.tx).toHaveLength(0);
	});

	test('legacy: capped, once per tier and day even when two arrive together, not a non-Hive name', async () => {
		const db = fakeDb();
		const outs = await Promise.all([run(db, callback('alice_99_4_x')), run(db, callback('alice_99_4_x'))]);
		expect(outs.map((o) => o.body.status || o.body.error).sort())
			.toEqual(['Account already rewarded today for this tier', 'success']);
		expect(db.tx).toHaveLength(1);
		expect(db.tx[0].token_count).toBe(10);
		expect((await run(db, callback('b@d_1_1_x'))).body).toEqual({ error: 'Error performing action' });
		expect((await run(db, callback('alice_5abc_2_x'))).body).toEqual({ error: 'Error performing action' });
	});

	test('legacy and v1 for the same tier and day pay once', async () => {
		const db = fakeDb();
		const { id } = await ar.createIntent(db, 'alice', 2, at(T0));
		const outs = await Promise.all([run(db, callback('r1_' + id)), run(db, callback('alice_1_2_x'))]);
		expect(outs.filter((o) => o.body.status === 'success')).toHaveLength(1);
		expect(db.tx).toHaveLength(1);
	});

	test('a database failure answers 500 and AdMob retry of the same callback is paid', async () => {
		const db = fakeDb({ failTxInsert: true });
		const { id } = await ar.createIntent(db, 'alice', 4, at(T0));
		const raw = callback('r1_' + id);
		expect(await run(db, raw)).toEqual({ status: 500, body: 'Try again' });
		expect(db.tx).toHaveLength(0);
		db.opts.failTxInsert = false;
		expect(await run(db, raw)).toEqual({ status: 200, body: { status: 'success' } });
		expect(db.tx).toHaveLength(1);
		// legacy too
		db.opts.failTxInsert = true;
		const legacy = callback('bob_1_1_x');
		expect((await run(db, legacy)).status).toBe(500);
		db.opts.failTxInsert = false;
		expect((await run(db, legacy)).body).toEqual({ status: 'success' });
	});

	test('Google keys are fetched once, not per callback; an unknown key id refetches at most once a minute', async () => {
		const db = fakeDb();
		await Promise.all([run(db, callback('alice_1_1_x')), run(db, callback('bob_1_1_x')), run(db, callback('carol_1_1_x'))]);
		expect(fetches).toBe(1);
		const bad = callback('dave_1_1_x').replace('key_id=3335741209', 'key_id=7');
		await run(db, bad, { now: at(T0 + 61000) });
		await run(db, bad, { now: at(T0 + 62000) });
		expect(fetches).toBe(2);
	});

	test('keys unreachable: 503 so AdMob retries, and a retry seconds later is paid', async () => {
		const db = fakeDb();
		const failing = async () => { throw new Error('offline'); };
		const raw = callback('alice_1_1_x');
		expect(await run(db, raw, { fetchKeys: failing })).toEqual({ status: 503, body: 'Try again' });
		expect(db.tx).toHaveLength(0);
		expect((await run(db, raw, { now: at(T0 + 4000) })).body).toEqual({ status: 'success' });
	});

	test('one unreadable key does not drop the others', async () => {
		const db = fakeDb();
		const mixed = async () => ({ keys: [{ keyId: 1, pem: 'garbage' }, { keyId: 3335741209, pem: PEM }] });
		expect((await run(db, callback('alice_1_1_x'), { fetchKeys: mixed })).body).toEqual({ status: 'success' });
	});

	test('keys older than 24 h keep verifying while a background refresh runs', async () => {
		const db = fakeDb();
		await run(db, callback('alice_1_1_x'));
		let release;
		const slow = () => new Promise((r) => { release = () => r({ keys: [{ keyId: 3335741209, pem: PEM }] }); });
		const later = T0 + 25 * 3600e3;
		const out = await run(db, callback('bob_1_1_x', { ts: later - 1000 }), { now: at(later), fetchKeys: slow });
		expect(out.body).toEqual({ status: 'success' });
		release();
	});

	test('a retry while the first copy is still being paid gets 503, not "duplicate"', async () => {
		const db = fakeDb();
		const raw = callback('alice_1_1_x');
		await run(db, raw);
		const tx = raw.match(/transaction_id=([^&]+)/)[1];
		db.seen.get(tx).status = 'processing';
		expect(await run(db, raw)).toEqual({ status: 503, body: 'Try again' });
	});

	test('a write that failed but was applied is not paid twice on the retry', async () => {
		const db = fakeDb({ appliedThenFail: true });
		const raw = callback('alice_3_2_x');
		expect((await run(db, raw)).status).toBe(500);
		expect((await run(db, raw)).body).toEqual({ error: 'Account already rewarded today for this tier' });
		expect(db.tx).toHaveLength(1);
	});

	test('legacy: only accounts Actifit already knows are paid', async () => {
		const db = fakeDb();
		expect((await run(db, callback('stranger_1_1_x'))).body).toEqual({ error: 'Unknown account' });
		expect(db.tx).toHaveLength(0);
	});

	test('legacy: an account with ledger rows but no balance row yet is known', async () => {
		const db = fakeDb();
		db.tx.push({ _id: 'x', user: 'newbie', reward_activity: 'Signup', tier: '', date: new Date(T0 - 1000) });
		expect((await run(db, callback('newbie_1_1_x'))).body).toEqual({ status: 'success' });
	});

	test('legacy: a failed account lookup answers 500 and the retry is paid', async () => {
		const db = fakeDb({ failKnownLookup: true });
		const raw = callback('alice_1_3_x');
		expect((await run(db, raw)).status).toBe(500);
		expect((await run(db, raw)).body).toEqual({ status: 'success' });
	});

	test('legacy: after the cut-off even an unknown account gets the update message', async () => {
		const db = fakeDb();
		expect((await run(db, callback('stranger_1_1_x'), { legacyUntil: new Date(T0).toISOString() })).body)
			.toEqual({ error: 'Please update the app to claim rewards' });
	});

	test('legacy: switched off from the configured date, v1 unaffected', async () => {
		const db = fakeDb();
		const until = new Date(T0).toISOString();
		expect((await run(db, callback('alice_1_1_x'), { legacyUntil: until })).body)
			.toEqual({ error: 'Please update the app to claim rewards' });
		expect((await run(db, callback('alice_1_1_x'), { legacyUntil: new Date(T0 + 1).toISOString() })).body)
			.toEqual({ status: 'success' });
		const { id } = await ar.createIntent(db, 'bob', 1, at(T0));
		expect((await run(db, callback('r1_' + id), { legacyUntil: until })).body).toEqual({ status: 'success' });
		expect((await run(db, callback('carol_1_1_x'), { legacyUntil: 'not a date' })).body).toEqual({ status: 'success' });
	});

	test('legacy: an iOS name with capitals is paid to the lowercase account', async () => {
		const db = fakeDb();
		expect((await run(db, callback('Alice_1_1_x'))).body).toEqual({ status: 'success' });
		expect(db.tx[0]).toMatchObject({ user: 'alice', _id: ar.rewardRowId('alice', 1, T0) });
	});

	test('a restored intent stays usable for the retry even if it was about to expire', async () => {
		const db = fakeDb({ failTxInsert: true });
		const { id } = await ar.createIntent(db, 'alice', 4, at(T0 - 29 * 60e3));
		const raw = callback('r1_' + id);
		expect((await run(db, raw)).status).toBe(500);
		db.opts.failTxInsert = false;
		expect((await run(db, raw, { now: at(T0 + 2 * 60e3) })).body).toEqual({ status: 'success' });
	});
});
