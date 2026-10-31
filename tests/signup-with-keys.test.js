/**
 * /app/signupQuote and /app/signupWithKeys (signup_with_keys.js).
 *
 * What these tests pin:
 * - everything is off until the settings doc enables it (and promo codes separately);
 * - the request never carries a password or private key, and every field is a checked string;
 * - a payment is bound to the exact signup details through the memo;
 * - one claim per memo and one per payment transaction, so a double tap or replay can never
 *   create or reward twice;
 * - an account that already exists with the submitted (public) keys only counts as ours when
 *   we broadcast for this claim before;
 * - failures that might still land stay retryable; definitive ones are final and the promo
 *   entry is given back only when nothing was broadcast.
 */

const express = require('express');
const request = require('supertest');
const dhive = require('@hiveio/dhive');
const swk = require('../signup_with_keys');

// ---- a tiny Mongo stand-in with the semantics the module relies on -----------------------

function getPath(doc, key) { return key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), doc); }

function matches(doc, q) {
	for (const [k, v] of Object.entries(q || {})) {
		if (k === '$or') { if (!v.some((sub) => matches(doc, sub))) return false; continue; }
		const val = getPath(doc, k);
		if (v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v)) {
			for (const [op, arg] of Object.entries(v)) {
				if (op === '$gt' && !(val > arg)) return false;
				if (op === '$gte' && !(val >= arg)) return false;
				if (op === '$lt' && !(val < arg)) return false;
				if (op === '$type' && typeof val !== arg) return false;
			}
		} else if (val !== v) return false;
	}
	return true;
}

function dupError() { const e = new Error('E11000 duplicate key'); e.code = 11000; return e; }

function makeCollection(name, uniqueFields = []) {
	const docs = [];
	let nextId = 1;
	const checkUnique = (doc, self) => {
		for (const f of ['_id', ...uniqueFields]) {
			if (doc[f] === undefined || (f !== '_id' && typeof doc[f] !== 'string')) continue;
			if (docs.some((d) => d !== self && d[f] === doc[f])) throw dupError();
		}
	};
	const apply = (doc, u) => {
		const next = { ...doc };
		if (u.$set) Object.assign(next, u.$set);
		if (u.$unset) for (const k of Object.keys(u.$unset)) delete next[k];
		if (u.$inc) for (const [k, n] of Object.entries(u.$inc)) next[k] = (next[k] || 0) + n;
		return next;
	};
	const replaceAt = (i, next) => { checkUnique(next, docs[i]); docs[i] = next; };
	return {
		name, docs,
		async insertOne(doc) { const d = { _id: nextId++, ...doc }; checkUnique(d, null); docs.push(d); return { insertedId: d._id }; },
		async findOne(q) { const d = docs.find((x) => matches(x, q)); return d ? { ...d } : null; },
		async updateOne(q, u, opts = {}) {
			const i = docs.findIndex((x) => matches(x, q));
			if (i === -1) {
				if (!opts.upsert) return { matchedCount: 0 };
				const base = Object.fromEntries(Object.entries(q).filter(([, v]) => typeof v !== 'object'));
				const d = apply({ ...base, ...(u.$setOnInsert || {}) }, u); checkUnique(d, null); docs.push(d); return { upsertedCount: 1 };
			}
			replaceAt(i, apply(docs[i], u));
			return { matchedCount: 1 };
		},
		async findOneAndUpdate(q, u, opts = {}) {
			const i = docs.findIndex((x) => matches(x, q));
			if (i === -1) {
				if (!opts.upsert) return null;
				const base = Object.fromEntries(Object.entries(q).filter(([, v]) => typeof v !== 'object'));
				const d = apply({ ...base, ...(u.$setOnInsert || {}) }, u); checkUnique(d, null); docs.push(d);
				return opts.returnDocument === 'after' ? { ...d } : null;
			}
			const before = docs[i];
			replaceAt(i, apply(before, u));
			return opts.returnDocument === 'after' ? { ...docs[i] } : { ...before };
		},
		async countDocuments(q) { return docs.filter((x) => matches(x, q)).length; },
	};
}

function makeDb() {
	const cols = {
		settings: makeCollection('settings'),
		signup_claims: makeCollection('signup_claims', ['payment_trx_id']),
		signup_promo_codes: makeCollection('signup_promo_codes'),
		signup_rate_limits: makeCollection('signup_rate_limits'),
	};
	return { cols, collection: (n) => cols[n] };
}

// ---- fixtures ------------------------------------------------------------------------------

const keysFor = (user, pass) => {
	const out = {};
	for (const role of ['owner', 'active', 'posting', 'memo']) out[role] = dhive.PrivateKey.fromLogin(user, pass, role).createPublic().toString();
	return out;
};
const KEYS = keysFor('newguy', 'P5Ksignuptestpassword');
const OTHER_KEYS = keysFor('newguy', 'someone-else');
const NOW = Date.parse('2026-11-01T12:00:00Z');
const chainTs = (ms) => new Date(ms).toISOString().slice(0, 19); // Hive style, no Z

function isValidName(name) {
	if (typeof name !== 'string' || name.length < 3 || name.length > 16) return false;
	return name.split('.').every((seg) => /^[a-z][a-z0-9-]+[a-z0-9]$/.test(seg));
}
function parseKeys(keys) {
	if (!keys || typeof keys !== 'object') return null;
	const out = {};
	for (const role of ['owner', 'active', 'posting', 'memo']) {
		const k = Object.prototype.hasOwnProperty.call(keys, role) ? keys[role] : undefined;
		if (typeof k !== 'string') return null;
		try { dhive.PublicKey.fromString(k); } catch (_) { return null; }
		out[role] = k;
	}
	return new Set(Object.values(out)).size === 4 ? out : null;
}

let db, chain, created, recorded, delegated, createOutcomes, app, svcNow;

function transfer({ memo, amount = '40.000 HIVE', to = 'actifit.signup', ageMs = 60 * 1000, trx = 'trx1', idx = 10, from = 'payer' }) {
	return [idx, { trx_id: trx, timestamp: chainTs(svcNow - ageMs), op: ['transfer', { from, to, amount, memo }] }];
}

function build({ enabled = true, promo = false, cap } = {}) {
	db = makeDb();
	if (enabled !== null) db.cols.settings.docs.push({ _id: 'signup_with_keys', enabled, promo_enabled: promo, ...(cap !== undefined ? { daily_cap: cap } : {}) });
	chain = { accounts: new Set(['referrer1', 'promoowner']), history: [] };
	created = []; recorded = []; delegated = []; createOutcomes = [];
	svcNow = NOW;
	const deps = {
		getDb: () => db,
		getConfig: () => ({ signup_account: 'actifit.signup', account: 'actifit' }),
		now: () => svcNow,
		hiveCall: async (method, params) => {
			if (method === 'get_accounts') return params[0].filter((n) => chain.accounts.has(n)).map((name) => ({ name }));
			if (method === 'get_account_history') {
				const [, start, limit] = params;
				const all = chain.history.slice().sort((a, b) => a[0] - b[0]);
				const upto = start === -1 ? all : all.filter((e) => e[0] <= start);
				return upto.slice(-limit);
			}
			throw new Error('unexpected ' + method);
		},
		isValidName, parseKeys,
		createAccount: async (name, keys) => {
			created.push({ name, keys });
			const out = createOutcomes.length ? createOutcomes.shift() : 'created';
			if (out === 'created') chain.accounts.add(name);
			return { created: out === 'created', reason: out };
		},
		quoteAmount: async (cur) => (cur === 'HIVE' ? { amount: 40, live: true } : { amount: 2, live: true }),
		requiredAmount: async (cur) => (cur === 'HIVE' ? 36 : 1.8),
		paidAfitReward: () => 50,
		promoAfitReward: (p) => p.reward || 0,
		delegate: async (name) => { delegated.push(name); },
		recordSignup: async (s) => { recorded.push(s); return true; },
	};
	app = express();
	app.use(express.json());
	swk.registerSignupWithKeysRoutes(app, deps, { ipOf: () => '1.2.3.4' });
}

const base = (over = {}) => ({ new_account: 'newguy', keys: KEYS, referrer: 'referrer1', email: 'New@Example.com', sent_cur: 'HIVE', ...over });
const memoOf = (body) => swk.signupMemo({ ...body, email: (body.email || '').toLowerCase() });
const quote = (body) => request(app).post('/app/signupQuote').send(body);
const submit = (body) => request(app).post('/app/signupWithKeys').send({ memo: memoOf(body), ...body });
const claimOf = (body) => db.cols.signup_claims.docs.find((d) => d._id === memoOf(body));

beforeEach(() => build());

// ---- memo ----------------------------------------------------------------------------------

describe('signupMemo', () => {
	it('is stable and changes with every field the signup depends on', () => {
		const f = { new_account: 'newguy', keys: KEYS, referrer: 'a', email: 'b@c.de', sent_cur: 'HIVE' };
		const m = swk.signupMemo(f);
		expect(m).toMatch(/^signup:[0-9a-f]{24}$/);
		expect(swk.signupMemo({ ...f })).toBe(m);
		for (const change of [{ new_account: 'newguy2' }, { keys: { ...KEYS, memo: OTHER_KEYS.memo } }, { referrer: '' },
			{ email: '' }, { sent_cur: 'HBD' }]) {
			expect(swk.signupMemo({ ...f, ...change })).not.toBe(m);
		}
	});
});

// ---- quote ---------------------------------------------------------------------------------

describe('POST /app/signupQuote', () => {
	it('is off without the settings doc, and when it is disabled', async () => {
		build({ enabled: null });
		expect((await quote(base())).status).toBe(503);
		build({ enabled: false });
		const res = await quote(base());
		expect(res.status).toBe(503);
		expect(res.body).toEqual({ enabled: false, reason: 'signup_disabled' });
	});

	it('quotes the memo, amounts rounded up to 3 dp, the pay-to account and the fixed reward', async () => {
		const res = await quote(base());
		expect(res.status).toBe(200);
		expect(res.body).toEqual({
			enabled: true, reason: 'quoted', memo: memoOf(base()),
			amounts: { HIVE: '40.000', HBD: '2.000' }, signup_account: 'actifit.signup', afit_reward: 50,
		});
	});

	it.each(['new_pass', 'password', 'owner_key', 'wif'])('rejects a request carrying %s', async (field) => {
		const res = await quote({ ...base(), [field]: 'x' });
		expect(res.status).toBe(400);
		expect(res.body.reason).toBe('invalid_request');
	});

	it.each([
		['a bad username', { new_account: 'Bad_Name' }, 'invalid_username'],
		['an object username', { new_account: { $ne: null } }, 'invalid_username'],
		['a missing key', { keys: { owner: KEYS.owner } }, 'invalid_keys'],
		['a broken key', { keys: { ...KEYS, memo: 'STM123' } }, 'invalid_keys'],
		['a duplicate key', { keys: { ...KEYS, active: KEYS.owner } }, 'invalid_keys'],
		['the new account as referrer', { referrer: 'newguy' }, 'invalid_referrer'],
		['a bad email', { email: 'not-an-email' }, 'invalid_email'],
		['STEEM', { sent_cur: 'STEEM' }, 'invalid_currency'],
		['a promo code with symbols', { promo_code: 'a b$' }, 'promo_invalid'],
	])('rejects %s with 400', async (_l, over, reason) => {
		const res = await quote(base(over));
		expect(res.status).toBe(400);
		expect(res.body.reason).toBe(reason);
	});

	it('refuses a name that already exists', async () => {
		chain.accounts.add('newguy');
		expect((await quote(base())).body.reason).toBe('username_taken');
	});

	it('refuses a referrer that does not exist on chain', async () => {
		const res = await quote(base({ referrer: 'ghost' }));
		expect(res.status).toBe(400);
		expect(res.body.reason).toBe('invalid_referrer');
	});

	it('refuses to quote on a guessed price', async () => {
		const deps2App = express(); deps2App.use(express.json());
		swk.registerSignupWithKeysRoutes(deps2App, {
			getDb: () => db, getConfig: () => ({ signup_account: 'actifit.signup' }), now: () => svcNow,
			hiveCall: async () => [], isValidName, parseKeys,
			quoteAmount: async () => ({ amount: 40, live: false }), paidAfitReward: () => 50,
		}, { ipOf: () => '1.2.3.4' });
		const res2 = await request(deps2App).post('/app/signupQuote').send(base({ referrer: '' }));
		expect(res2.status).toBe(503);
		expect(res2.body.reason).toBe('server_error');
	});

	it('stops quoting paid signups once the daily cap is used', async () => {
		build({ cap: 1 });
		db.cols.signup_claims.docs.push({ _id: 'x', status: 'created', finalized_at: new Date(NOW - 1000) });
		expect((await quote(base())).status).toBe(503);
	});

	it('says promo_invalid for a promo code while promo signups are off', async () => {
		expect((await quote(base({ promo_code: 'CODE1' }))).body.reason).toBe('promo_invalid');
	});

	it('rate limits per IP through a counter kept in the DB', async () => {
		let last;
		for (let i = 0; i < 31; i++) last = await quote(base());
		expect(last.status).toBe(429);
	}, 60000);
});

// ---- paid submit ---------------------------------------------------------------------------

describe('POST /app/signupWithKeys (paid)', () => {
	it('is off when disabled', async () => {
		build({ enabled: false });
		const res = await submit(base());
		expect(res.status).toBe(503);
		expect(res.body.reason).toBe('signup_disabled');
	});

	it('rejects a memo that does not match the details', async () => {
		const res = await request(app).post('/app/signupWithKeys').send({ ...base(), memo: 'signup:000000000000000000000000' });
		expect(res.status).toBe(400);
		expect(res.body.reason).toBe('memo_mismatch');
		expect(db.cols.signup_claims.docs).toHaveLength(0);
	});

	it('returns payment_pending until the payment is on chain, and leaves the claim open', async () => {
		const res = await submit(base());
		expect(res.body).toEqual({ accountCreated: false, paymentReceivedTx: '', reason: 'payment_pending', retryable: true });
		expect(claimOf(base()).status).toBe('pending');
		expect(created).toHaveLength(0);
	});

	it('creates the account with exactly the submitted keys once the payment is found', async () => {
		chain.history.push(transfer({ memo: memoOf(base()) }));
		const res = await submit(base());
		expect(res.body).toEqual({ accountCreated: true, paymentReceivedTx: 'trx1', reason: 'created', retryable: false });
		expect(created).toEqual([{ name: 'newguy', keys: KEYS }]);
		expect(recorded).toHaveLength(1);
		expect(recorded[0]).toMatchObject({
			new_account: 'newguy', referrer: 'referrer1', email: 'new@example.com', afit_reward: 50,
			confirming_tx: 'trx1', verified_amount: 40, verified_currency: 'HIVE', promo: null,
		});
		expect(delegated).toEqual(['newguy']);
		const claim = claimOf(base());
		expect(claim).toMatchObject({ status: 'created', payment_trx_id: 'trx1', payment_from: 'payer', verified_amount: 40 });
		expect(claim.keys).toEqual(KEYS);
	});

	it('answers a repeat submit with already_created and creates or rewards nothing again', async () => {
		chain.history.push(transfer({ memo: memoOf(base()) }));
		await submit(base());
		const res = await submit(base());
		expect(res.body).toMatchObject({ accountCreated: true, reason: 'already_created', paymentReceivedTx: 'trx1' });
		expect(created).toHaveLength(1);
		expect(recorded).toHaveLength(1);
	});

	it('returns payment_pending while another request holds the claim', async () => {
		chain.history.push(transfer({ memo: memoOf(base()) }));
		await db.cols.signup_claims.insertOne({ _id: memoOf(base()), path: 'paid', status: 'processing', lease_until: new Date(NOW + 60000) });
		const res = await submit(base());
		expect(res.body.reason).toBe('payment_pending');
		expect(created).toHaveLength(0);
	});

	it('takes over a claim whose lease expired', async () => {
		chain.history.push(transfer({ memo: memoOf(base()) }));
		await db.cols.signup_claims.insertOne({ _id: memoOf(base()), path: 'paid', status: 'processing', lease_until: new Date(NOW - 1) });
		expect((await submit(base())).body.reason).toBe('created');
	});

	it.each([
		['too little', { amount: '10.000 HIVE' }],
		['the wrong currency', { amount: '40.000 HBD' }],
	])('reports payment_insufficient for %s', async (_l, over) => {
		chain.history.push(transfer({ memo: memoOf(base()), ...over }));
		const res = await submit(base());
		expect(res.body).toMatchObject({ reason: 'payment_insufficient', retryable: false, accountCreated: false });
		expect(created).toHaveLength(0);
		expect(claimOf(base())).toMatchObject({ status: 'pending', insufficient_trx_id: 'trx1' });
	});

	it('ignores a transfer older than 72 hours, or to another account', async () => {
		chain.history.push(transfer({ memo: memoOf(base()), ageMs: 73 * 3600 * 1000 }));
		chain.history.push(transfer({ memo: memoOf(base()), to: 'someone', trx: 'trx2', idx: 11 }));
		expect((await submit(base())).body.reason).toBe('payment_pending');
	});

	it('finds a payment beyond the first history page', async () => {
		chain.history.push(transfer({ memo: memoOf(base()), idx: 5, ageMs: 3600 * 1000 }));
		for (let i = 0; i < 1000; i++) chain.history.push(transfer({ memo: 'other', idx: 100 + i, trx: 'o' + i }));
		expect((await submit(base())).body.reason).toBe('created');
	});

	it('refuses to use one payment transaction for two claims', async () => {
		// a forged second claim already took trx1
		await db.cols.signup_claims.insertOne({ _id: 'signup:other', path: 'paid', status: 'created', payment_trx_id: 'trx1' });
		chain.history.push(transfer({ memo: memoOf(base()) }));
		const res = await submit(base());
		expect(res.body.reason).toBe('memo_mismatch');
		expect(created).toHaveLength(0);
	});

	it('does not treat an existing account with these keys as ours on the first attempt', async () => {
		// keys are public: anyone could submit an existing account's keys
		chain.history.push(transfer({ memo: memoOf(base()) }));
		createOutcomes.push('exists_with_same_keys');
		const res = await submit(base());
		expect(res.body).toMatchObject({ reason: 'username_taken', accountCreated: false });
		expect(recorded).toHaveLength(0);
		expect((await submit(base())).body.reason).toBe('username_taken'); // final
	});

	it('finishes a signup whose broadcast result was unknown, on retry', async () => {
		chain.history.push(transfer({ memo: memoOf(base()) }));
		createOutcomes.push('creation_failed', 'exists_with_same_keys');
		const first = await submit(base());
		expect(first.body).toMatchObject({ reason: 'creation_failed', retryable: true, paymentReceivedTx: 'trx1' });
		expect(claimOf(base()).status).toBe('pending');
		const second = await submit(base());
		expect(second.body).toMatchObject({ reason: 'created', accountCreated: true });
		expect(recorded).toHaveLength(1);
	});

	it('fails for good when the name was taken by someone else', async () => {
		chain.history.push(transfer({ memo: memoOf(base()) }));
		createOutcomes.push('username_taken');
		expect((await submit(base())).body).toMatchObject({ reason: 'username_taken', retryable: false });
		expect(claimOf(base())).toMatchObject({ status: 'failed', failure_reason: 'username_taken' });
		expect((await submit(base())).body.reason).toBe('username_taken');
		expect(created).toHaveLength(1);
	});

	it.each([
		['no_account_token', 'creation_failed'],
		['node_down', 'server_error'],
	])('keeps the claim open and retryable on %s', async (outcome, reason) => {
		chain.history.push(transfer({ memo: memoOf(base()) }));
		createOutcomes.push(outcome);
		expect((await submit(base())).body).toMatchObject({ reason, retryable: true });
		expect(claimOf(base()).status).toBe('pending');
		expect(recorded).toHaveLength(0);
		expect((await submit(base())).body.reason).toBe(outcome === 'no_account_token' ? 'created' : 'created');
	});

	it('records the signup without the referrer when the referrer no longer exists', async () => {
		chain.history.push(transfer({ memo: memoOf(base()) }));
		chain.accounts.delete('referrer1');
		await submit(base());
		expect(recorded[0].referrer).toBe('');
	});

	it('honours a paid submit even when the daily cap is used', async () => {
		build({ cap: 0 });
		chain.history.push(transfer({ memo: memoOf(base()) }));
		expect((await submit(base())).body.reason).toBe('created');
	});
});

// ---- promo submit --------------------------------------------------------------------------

describe('POST /app/signupWithKeys (promo)', () => {
	const promoBody = (over = {}) => base({ promo_code: 'CODE1', referrer: 'referrer1', ...over });
	const addPromo = (over = {}) => db.cols.signup_promo_codes.docs.push({ _id: 'p1', code: 'CODE1', entries: 2,
		assigned_user: 'promoowner', signup_reward: true, referrer_reward: true, delegation: false, reward: 25, ...over });
	const promo = () => db.cols.signup_promo_codes.docs[0];

	it('is refused while promo signups are off, without touching the code', async () => {
		addPromo();
		expect((await submit(promoBody())).body.reason).toBe('promo_invalid');
		expect(promo().entries).toBe(2);
	});

	it('creates the account, uses one entry, and credits the promo owner, not the client referrer', async () => {
		build({ promo: true }); addPromo();
		const res = await submit(promoBody());
		expect(res.body).toMatchObject({ accountCreated: true, reason: 'created' });
		expect(promo().entries).toBe(1);
		expect(recorded[0]).toMatchObject({ referrer: 'promoowner', afit_reward: 25, verified_amount: 0, signup_reward: true });
		expect(delegated).toEqual([]);
		expect((await submit(promoBody())).body.reason).toBe('already_created');
		expect(promo().entries).toBe(1);
	});

	it('reports promo_invalid for an unknown or used-up code', async () => {
		build({ promo: true }); addPromo({ entries: 0 });
		expect((await submit(promoBody())).body.reason).toBe('promo_invalid');
		expect((await submit(promoBody({ promo_code: 'NOPE' }))).body.reason).toBe('promo_invalid');
		expect(created).toHaveLength(0);
	});

	it('gives the entry back when nothing was broadcast', async () => {
		build({ promo: true }); addPromo();
		createOutcomes.push('username_taken');
		expect((await submit(promoBody())).body.reason).toBe('username_taken');
		expect(promo().entries).toBe(2);
	});

	it('keeps the entry held when the broadcast result is unknown, and finishes on retry without a second entry', async () => {
		build({ promo: true }); addPromo();
		createOutcomes.push('creation_failed', 'exists_with_same_keys');
		expect((await submit(promoBody())).body).toMatchObject({ reason: 'creation_failed', retryable: true });
		expect(promo().entries).toBe(1);
		expect((await submit(promoBody())).body.reason).toBe('created');
		expect(promo().entries).toBe(1);
		expect(recorded).toHaveLength(1);
	});

	it('restores the entry and stays retryable when no account token is left', async () => {
		build({ promo: true }); addPromo();
		createOutcomes.push('no_account_token');
		expect((await submit(promoBody())).body).toMatchObject({ reason: 'creation_failed', retryable: true });
		expect(promo().entries).toBe(2);
		expect(claimOf(promoBody()).promo_id).toBeUndefined();
	});

	it('stops promo signups once the daily cap is used', async () => {
		build({ promo: true, cap: 1 }); addPromo();
		db.cols.signup_claims.docs.push({ _id: 'x', status: 'created', finalized_at: new Date(NOW - 1000) });
		expect((await submit(promoBody())).body).toMatchObject({ reason: 'signup_disabled', retryable: true });
		expect(promo().entries).toBe(2);
	});

	it('does not let a paid claim be reused as a promo claim', async () => {
		build({ promo: true }); addPromo();
		await submit(base({ promo_code: '' }));
		const res = await submit(promoBody({ promo_code: 'CODE1' }));
		// same details -> same memo, different path
		expect(res.status).toBe(400);
		expect(res.body.reason).toBe('memo_mismatch');
	});
});

// ---- settings cache ------------------------------------------------------------------------

describe('kill switch', () => {
	it('takes effect within the cache window on every server', async () => {
		expect((await quote(base())).status).toBe(200);
		db.cols.settings.docs[0].enabled = false;
		expect((await quote(base())).status).toBe(200); // cached
		svcNow += 61 * 1000;
		expect((await quote(base())).status).toBe(503);
	});
});
