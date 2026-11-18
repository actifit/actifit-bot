/**
 * ad_reward.js: v1 rewarded-ad intents ("r1_<id>" SSV custom data).
 * In-memory stand-in for the collections; real MongoDB runs when MONGO_TEST_URI is set.
 */

const ar = require('../ad_reward');

function fakeDb({ failTxInsert = false, bareDocs = false } = {}) {
	const intents = new Map();
	const tx = [];
	const claims = [];
	const matchesTx = (d, q) => d.user === q.user && d.reward_activity === q.reward_activity
		&& d.tier === q.tier && d.date >= q.date.$gte;
	const sameClaim = (a, b) => a.user === b.user && a.tier === b.tier && a.day === b.day;
	return {
		intents, tx, claims,
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
			if (name === 'ad_reward_claims') return {
				createIndex: async () => 'ok',
				insertOne: async (doc) => {
					if (claims.some((c) => sameClaim(c, doc))) { const e = new Error('dup'); e.code = 11000; throw e; }
					claims.push(doc); return {};
				},
				deleteOne: async (q) => { const i = claims.findIndex((c) => sameClaim(c, q)); if (i >= 0) claims.splice(i, 1); return {}; },
			};
			if (name === 'token_transactions') return {
				createIndex: async () => 'ok',
				countDocuments: async (q) => tx.filter((d) => matchesTx(d, q)).length,
				insertOne: async (doc) => { if (failTxInsert) throw new Error('write failed'); tx.push(doc); return {}; },
			};
			throw new Error('unexpected collection ' + name);
		},
	};
}

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

	test('two intents for one tier and day pay once (database claim marker)', async () => {
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

	test('a failed payment write frees the day slot and reports the error', async () => {
		const db = fakeDb({ failTxInsert: true });
		const log = jest.spyOn(console, 'log').mockImplementation(() => {});
		const { id } = await ar.createIntent(db, 'alice', 2, at(T0));
		expect(await ar.payIntent(db, q(id), notBanned, () => {}, at(T0))).toEqual({ error: 'Error performing buy action. DB storing issue' });
		expect(db.claims).toHaveLength(0);
		expect(log).toHaveBeenCalledWith('ad reward NOT paid', id, 'alice', 2, expect.any(Number), 'write failed');
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
