/**
 * /app/signupQuote and /app/signupWithKeys (signup_with_keys.js).
 *
 * What these tests pin:
 * - everything is off until the settings doc enables it (and promo codes separately);
 * - the request never carries a password or private key, and every field is a checked string;
 * - a payment is bound to the exact signup details (promo code included) through the memo;
 * - one claim per memo, leased to one request at a time; a stale request can't overwrite it;
 * - an account that already exists with the submitted (public) keys only counts as ours when,
 *   for this claim, we saw the name free and broadcast;
 * - payments are found through a shared transfer index that survives dust floods and needs
 *   no chain call per submit;
 * - failures that might still land stay retryable; definitive ones are final; a wrong promo
 *   code never locks the signup details; rewards that can't be recorded are flagged.
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
				if (op === '$exists' && (val !== undefined) !== arg) return false;
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
	const upsertDoc = (q, u) => {
		const base = Object.fromEntries(Object.entries(q).filter(([, v]) => typeof v !== 'object'));
		const d = apply({ ...base, ...(u.$setOnInsert || {}) }, u); checkUnique(d, null); docs.push(d); return d;
	};
	return {
		name, docs,
		async insertOne(doc) { const d = { _id: nextId++, ...doc }; checkUnique(d, null); docs.push(d); return { insertedId: d._id }; },
		async findOne(q) { const d = docs.find((x) => matches(x, q)); return d ? { ...d } : null; },
		async updateOne(q, u, opts = {}) {
			const i = docs.findIndex((x) => matches(x, q));
			if (i === -1) {
				if (!opts.upsert) return { matchedCount: 0, modifiedCount: 0 };
				upsertDoc(q, u); return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
			}
			const next = apply(docs[i], u); checkUnique(next, docs[i]);
			const changed = JSON.stringify(next) !== JSON.stringify(docs[i]);
			docs[i] = next;
			return { matchedCount: 1, modifiedCount: changed ? 1 : 0 };
		},
		async deleteOne(q) {
			const i = docs.findIndex((x) => matches(x, q));
			if (i !== -1) docs.splice(i, 1);
			return { deletedCount: i === -1 ? 0 : 1 };
		},
		async findOneAndUpdate(q, u, opts = {}) {
			const i = docs.findIndex((x) => matches(x, q));
			if (i === -1) {
				if (!opts.upsert) return null;
				const d = upsertDoc(q, u);
				return opts.returnDocument === 'after' ? { ...d } : null;
			}
			const before = docs[i];
			const next = apply(before, u); checkUnique(next, before); docs[i] = next;
			return opts.returnDocument === 'after' ? { ...next } : { ...before };
		},
		async countDocuments(q) { return docs.filter((x) => matches(x, q)).length; },
	};
}

function makeDb() {
	const cols = {
		settings: makeCollection('settings'),
		signup_claims: makeCollection('signup_claims', ['payment_ref']),
		signup_promo_codes: makeCollection('signup_promo_codes'),
		signup_rate_limits: makeCollection('signup_rate_limits'),
		signup_names: makeCollection('signup_names'),
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
const NOW = Date.parse('2026-11-01T12:00:00Z');
const chainTs = (ms) => new Date(ms).toISOString().slice(0, 19); // Hive style, no Z

function isValidName(name) {
	if (typeof name !== 'string' || name.length < 3 || name.length > 16) return false;
	return name.split('.').every((seg) => /^[a-z][a-z0-9-]+[a-z0-9]$/.test(seg));
}
// Format-level stand-in for utils.parseSignupPublicKeys (its checksum and curve checks are
// covered in signup-create-with-keys.test.js); keeps this suite fast.
function parseKeys(keys) {
	if (!keys || typeof keys !== 'object') return null;
	const out = {};
	for (const role of ['owner', 'active', 'posting', 'memo']) {
		const k = Object.prototype.hasOwnProperty.call(keys, role) ? keys[role] : undefined;
		if (typeof k !== 'string' || !/^STM[1-9A-HJ-NP-Za-km-z]{50}$/.test(k)) return null;
		out[role] = k;
	}
	return new Set(Object.values(out)).size === 4 ? out : null;
}
// distinct, well-formed public key sets without deriving keys
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const fakeKeys = (n) => Object.fromEntries(Object.entries(KEYS).map(([role, k]) =>
	[role, k.slice(0, -2) + B58[Math.floor(n / B58.length) % B58.length] + B58[n % B58.length]]));

let db, chain, created, recorded, delegated, createOutcomes, app, svcNow, deps, historyCalls, nextIdx, svc;

/** Append a transfer to the signup account's history (indices only grow, like on chain). */
function pay({ memo, amount = '40.000 HIVE', to = 'actifit.signup', ageMs = 60 * 1000, from = 'payer' }) {
	const idx = nextIdx++;
	chain.history.push([idx, { trx_id: 'trx' + idx, timestamp: chainTs(svcNow - ageMs), op: ['transfer', { from, to, amount, memo }] }]);
	return 'trx' + idx;
}
function dust(n, { memo = 'spam', amount = '0.001 HBD', ageMs = 1000, distinct = false } = {}) {
	for (let i = 0; i < n; i++) {
		const idx = nextIdx++;
		const m = distinct ? 'signup:' + String(i).padStart(24, '0') : memo;
		chain.history.push([idx, { trx_id: 'd' + idx, timestamp: chainTs(svcNow - ageMs), op: ['transfer', { from: 'x', to: 'actifit.signup', amount, memo: m }] }]);
	}
}
const VALID_FLOOD_MEMO = 'signup:' + 'f'.repeat(24);

function build({ enabled = true, promo = false, cap, promoCap } = {}) {
	db = makeDb();
	if (enabled !== null) {
		db.cols.settings.docs.push({ _id: 'signup_with_keys', enabled, promo_enabled: promo,
			...(cap !== undefined ? { daily_cap: cap } : {}), ...(promoCap !== undefined ? { promo_daily_cap: promoCap } : {}) });
	}
	chain = { accounts: new Set(['referrer1', 'promoowner']), history: [] };
	created = []; recorded = []; delegated = []; createOutcomes = []; historyCalls = [];
	svcNow = NOW; nextIdx = 0;
	deps = {
		getDb: () => db,
		getConfig: () => ({ signup_account: 'actifit.signup', account: 'actifit' }),
		now: () => svcNow,
		hiveCall: async (method, params) => {
			if (method === 'get_accounts') return params[0].filter((n) => chain.accounts.has(n)).map((name) => ({ name }));
			if (method === 'get_account_history') {
				const [account, start, limit, filterLow] = params;
				historyCalls.push({ account, start, limit, filterLow });
				if (start !== -1 && start < limit - 1) throw new Error('hived: start must be >= limit - 1');
				const upto = start === -1 ? chain.history : chain.history.filter((e) => e[0] <= start);
				return upto.slice(-limit);
			}
			throw new Error('unexpected ' + method);
		},
		isValidName, parseKeys,
		createAccount: async (name, keys) => {
			created.push({ name, keys });
			const out = createOutcomes.length ? createOutcomes.shift() : 'created';
			if (typeof out === 'function') return out(name);
			if (out === 'created') chain.accounts.add(name);
			return { created: out === 'created', reason: out };
		},
		quoteAmount: async (cur) => (cur === 'HIVE' ? { amount: 40, live: true } : { amount: 2, live: true }),
		requiredAmount: async (cur) => (cur === 'HIVE' ? { amount: 36, live: true } : { amount: 1.8, live: true }),
		paidAfitReward: () => 50,
		promoAfitReward: (p) => p.reward || 0,
		delegate: async (name) => { delegated.push(name); },
		recordSignup: async (s) => { recorded.push(s); return true; },
	};
	app = express();
	app.use(express.json());
	// the routes read deps through this object, so tests can swap a dependency after build
	svc = swk.registerSignupWithKeysRoutes(app, new Proxy({}, { get: (_t, k) => deps[k] }), { ipOf: () => '1.2.3.4' });
}

const base = (over = {}) => ({ new_account: 'newguy', keys: KEYS, referrer: 'referrer1', email: 'New@Example.com', sent_cur: 'HIVE', ...over });
const memoOf = (body) => swk.signupMemo({ ...body, email: (body.email || '').toLowerCase() });
const quote = (body) => request(app).post('/app/signupQuote').send(body);
const submit = (body) => request(app).post('/app/signupWithKeys').send({ memo: memoOf(body), ...body });
const claimOf = (body) => db.cols.signup_claims.docs.find((d) => d._id === memoOf(body));
const later = (ms = 11 * 1000) => { svcNow += ms; };

beforeEach(() => build());

// ---- memo ----------------------------------------------------------------------------------

describe('signupMemo', () => {
	it('is stable and changes with every field the signup depends on, promo code included', () => {
		const f = { new_account: 'newguy', keys: KEYS, referrer: 'a', email: 'b@c.de', sent_cur: 'HIVE', promo_code: '' };
		const m = swk.signupMemo(f);
		expect(m).toMatch(/^signup:[0-9a-f]{24}$/);
		expect(swk.signupMemo({ ...f })).toBe(m);
		for (const change of [{ new_account: 'newguy2' }, { keys: { ...KEYS, memo: fakeKeys(2).memo } }, { referrer: '' },
			{ email: '' }, { sent_cur: 'HBD' }, { promo_code: 'CODE1' }]) {
			expect(swk.signupMemo({ ...f, ...change })).not.toBe(m);
		}
	});
});

// ---- quote ---------------------------------------------------------------------------------

describe('POST /app/signupQuote', () => {
	it('is off without the settings doc, when disabled, and when the settings read fails', async () => {
		build({ enabled: null });
		expect((await quote(base())).status).toBe(503);
		build({ enabled: false });
		expect((await quote(base())).body).toEqual({ enabled: false, reason: 'signup_disabled' });
		build();
		db.cols.settings.findOne = async () => { throw new Error('db down'); };
		expect((await quote(base())).status).toBe(503);
	});

	it('quotes the memo, the amount in the chosen currency rounded up, the pay-to account and the reward', async () => {
		const res = await quote(base({ sent_cur: 'HBD' }));
		expect(res.status).toBe(200);
		expect(res.body).toEqual({
			enabled: true, reason: 'quoted', memo: memoOf(base({ sent_cur: 'HBD' })),
			amounts: { HBD: '2.000' }, signup_account: 'actifit.signup', afit_reward: 50,
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

	it('refuses a name that already exists, and a referrer that does not', async () => {
		chain.accounts.add('newguy');
		expect((await quote(base())).body.reason).toBe('username_taken');
		chain.accounts.delete('newguy');
		const res = await quote(base({ referrer: 'ghost' }));
		expect(res.status).toBe(400);
		expect(res.body.reason).toBe('invalid_referrer');
	});

	it('refuses to quote on a guessed price', async () => {
		deps.quoteAmount = async () => ({ amount: 40, live: false });
		const res = await quote(base());
		expect(res.status).toBe(503);
		expect(res.body.reason).toBe('price_unavailable');
	});

	it('reports a retryable server_error when the chain lookup fails', async () => {
		deps.hiveCall = async () => { throw new Error('node down'); };
		const res = await quote(base());
		expect(res.status).toBe(503);
		expect(res.body).toMatchObject({ reason: 'server_error', retryable: true });
	});

	it('stops quoting paid signups once the paid daily cap is used; promo signups do not count', async () => {
		build({ cap: 1 });
		db.cols.signup_claims.docs.push({ _id: 'p', path: 'promo', status: 'created', finalized_at: new Date(NOW - 1000) });
		expect((await quote(base())).status).toBe(200);
		db.cols.signup_claims.docs.push({ _id: 'x', path: 'paid', status: 'created', finalized_at: new Date(NOW - 1000) });
		expect((await quote(base())).status).toBe(503);
	});

	it('says promo_invalid while promo signups are off; otherwise quotes only the memo', async () => {
		expect((await quote(base({ promo_code: 'CODE1' }))).body).toEqual({ enabled: true, reason: 'promo_invalid' });
		build({ promo: true });
		const res = await quote(base({ promo_code: 'CODE1' }));
		expect(res.body).toEqual({ enabled: true, reason: 'quoted', memo: memoOf(base({ promo_code: 'CODE1' })) });
	});

	it('rate limits quotes per IP through a counter kept in the DB', async () => {
		let last;
		for (let i = 0; i < 31; i++) last = await quote(base());
		expect(last.status).toBe(429);
		expect(db.cols.signup_rate_limits.docs.some((d) => d._id.startsWith('quote:1.2.3.4:'))).toBe(true);
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

	it('rejects a memo that does not match the details, writing nothing', async () => {
		const res = await request(app).post('/app/signupWithKeys').send({ ...base(), memo: 'signup:000000000000000000000000' });
		expect(res.status).toBe(400);
		expect(res.body.reason).toBe('memo_mismatch');
		expect(db.cols.signup_claims.docs).toHaveLength(0);
	});

	it('writes no claim for a name that is taken or a referrer that does not exist', async () => {
		chain.accounts.add('newguy');
		expect((await submit(base())).body.reason).toBe('username_taken');
		chain.accounts.delete('newguy');
		expect((await submit(base({ referrer: 'ghost' }))).body.reason).toBe('invalid_referrer');
		expect(db.cols.signup_claims.docs).toHaveLength(0);
	});

	it('returns payment_pending with retry_after until the payment is on chain, and leaves the claim open', async () => {
		const res = await submit(base());
		expect(res.body).toEqual({ accountCreated: false, paymentReceivedTx: '', reason: 'payment_pending', retryable: true, retry_after: 10 });
		expect(claimOf(base())).toMatchObject({ status: 'pending' });
		expect(claimOf(base()).expires_at).toBeInstanceOf(Date);
		expect(created).toHaveLength(0);
	});

	it('creates the account with exactly the submitted keys once the payment is found', async () => {
		const trx = pay({ memo: memoOf(base()) });
		const res = await submit(base());
		expect(res.body).toEqual({ accountCreated: true, paymentReceivedTx: trx, reason: 'created', retryable: false });
		expect(created).toEqual([{ name: 'newguy', keys: KEYS }]);
		expect(recorded).toHaveLength(1);
		expect(recorded[0]).toMatchObject({
			new_account: 'newguy', referrer: 'referrer1', email: 'new@example.com', afit_reward: 50,
			confirming_tx: trx, verified_amount: 40, verified_currency: 'HIVE', promo: null,
		});
		expect(delegated).toEqual(['newguy']);
		const claim = claimOf(base());
		expect(claim).toMatchObject({ status: 'created', payment_trx_id: trx, payment_from: 'payer', verified_amount: 40,
			reward_amount: 50, reward_pending: false, delegated: true });
		expect(claim.lease_token).toBeUndefined();
		expect(claim.expires_at).toBeUndefined();
	});

	it('reads history with the transfer filter and pages that hived accepts', async () => {
		deps.historyPageSize = 50;
		pay({ memo: memoOf(base()), ageMs: 3600 * 1000 });
		dust(150);
		expect((await submit(base())).body.reason).toBe('created');
		expect(historyCalls.length).toBeGreaterThan(1);
		for (const c of historyCalls) {
			expect(c).toMatchObject({ account: 'actifit.signup', filterLow: 4 });
			if (c.start !== -1) expect(c.start).toBeGreaterThanOrEqual(c.limit - 1);
		}
	});

	it('does not re-read the chain for every submit (shared index, refreshed at most every 10 s)', async () => {
		await submit(base());
		const calls = historyCalls.length;
		await submit(base({ new_account: 'otherguy', keys: fakeKeys(1) }));
		expect(historyCalls.length).toBe(calls);
	});

	it('still finds a payment buried under a dust flood that arrived after the index was built', async () => {
		deps.historyPageSize = 10; // a refresh walks 20 pages = 200 entries, so 300 dust leaves a gap
		await submit(base()); // builds the index
		const trx = pay({ memo: memoOf(base()) });
		dust(300, { memo: VALID_FLOOD_MEMO, amount: '1.000 HIVE' });
		later();
		const res = await submit(base());
		expect(res.body).toMatchObject({ reason: 'created', paymentReceivedTx: trx });
	}, 60000);

	it('answers a repeat submit with already_created and creates or rewards nothing again', async () => {
		const trx = pay({ memo: memoOf(base()) });
		await submit(base());
		const res = await submit(base());
		expect(res.body).toMatchObject({ accountCreated: true, reason: 'already_created', paymentReceivedTx: trx });
		expect(created).toHaveLength(1);
		expect(recorded).toHaveLength(1);
	});

	it('checks one claim at most every 10 seconds', async () => {
		await submit(base());
		const checkedAt = claimOf(base()).last_checked_at;
		pay({ memo: memoOf(base()) });
		later(5000);
		expect((await submit(base())).body.reason).toBe('payment_pending');
		expect(created).toHaveLength(0);
		expect(claimOf(base()).last_checked_at).toEqual(checkedAt); // not even leased
		later(6000);
		later();
		expect((await submit(base())).body.reason).toBe('created');
	});

	it('returns payment_pending while another request holds the claim, and takes over an expired lease', async () => {
		pay({ memo: memoOf(base()) });
		await db.cols.signup_claims.insertOne({ _id: memoOf(base()), path: 'paid', status: 'processing', lease_token: 'other',
			lease_until: new Date(NOW + 60000), created_at: new Date(NOW) });
		expect((await submit(base())).body.reason).toBe('payment_pending');
		later(61000);
		expect((await submit(base())).body.reason).toBe('created');
	});

	it('does not let a stale request overwrite a claim another request finished', async () => {
		pay({ memo: memoOf(base()) });
		let releaseA;
		const gate = new Promise((r) => { releaseA = r; });
		// request A broadcasts (the account appears) but hangs past its lease
		createOutcomes.push(async (name) => { chain.accounts.add(name); await gate; return { reason: 'created' }; });
		const a = submit(base()).then((r) => r);
		for (let i = 0; i < 50 && created.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
		later(6 * 60 * 1000);
		// request B takes over, sees the account with our keys after our broadcast, finishes
		createOutcomes.push('exists_with_same_keys');
		const b = await submit(base());
		expect(b.body.reason).toBe('created');
		releaseA();
		await a;
		expect(claimOf(base()).status).toBe('created');
		expect(recorded).toHaveLength(1);
		expect(delegated).toHaveLength(1);
	});

	it.each([
		['too little', { amount: '10.000 HIVE' }],
		['the wrong currency', { amount: '40.000 HBD' }],
	])('reports payment_insufficient for %s and flags the claim for a refund', async (_l, over) => {
		const trx = pay({ memo: memoOf(base()), ...over });
		const res = await submit(base());
		expect(res.body).toMatchObject({ reason: 'payment_insufficient', retryable: false, accountCreated: false });
		expect(created).toHaveLength(0);
		expect(claimOf(base())).toMatchObject({ status: 'pending', insufficient_trx_id: trx, needs_refund: true });
		expect(claimOf(base()).expires_at).toBeUndefined();
	});

	it('completes an underpaid claim when a full transfer follows', async () => {
		pay({ memo: memoOf(base()), amount: '10.000 HIVE' });
		await submit(base());
		pay({ memo: memoOf(base()) });
		later();
		expect((await submit(base())).body.reason).toBe('created');
		// the short transfer still has to go back
		expect(claimOf(base())).toMatchObject({ needs_refund: true });
		expect(claimOf(base()).extra_transfers).toHaveLength(1);
	});

	it('never judges a payment against a guessed price', async () => {
		pay({ memo: memoOf(base()) });
		deps.requiredAmount = async () => ({ amount: 360, live: false });
		const res = await submit(base());
		expect(res.body).toMatchObject({ reason: 'server_error', retryable: true });
		expect(claimOf(base()).status).toBe('pending');
	});

	it('ignores transfers outside the window, dust, or to another account', async () => {
		pay({ memo: memoOf(base()), ageMs: 8 * 24 * 3600 * 1000 });
		pay({ memo: memoOf(base()), amount: '0.050 HIVE' }); // below the dust floor
		pay({ memo: memoOf(base()), to: 'someone' });
		expect((await submit(base())).body.reason).toBe('payment_pending');
	});

	it('counts the 7 day window from when the claim was made, not from now', async () => {
		await submit(base()); // claim made now
		pay({ memo: memoOf(base()), ageMs: 60 * 1000 });
		later(8 * 24 * 3600 * 1000); // submitted again 8 days later
		expect((await submit(base())).body.reason).toBe('created');
	});

	it('does not treat an existing account with these keys as ours when we never saw the name free', async () => {
		// keys are public: an account with these keys appears after a refusal that broadcast nothing
		pay({ memo: memoOf(base()) });
		createOutcomes.push('node_down');
		expect((await submit(base())).body).toMatchObject({ reason: 'server_error', retryable: true });
		expect(claimOf(base()).broadcast_attempted).toBe(false);
		chain.accounts.add('newguy');
		later();
		const res = await submit(base());
		expect(res.body).toMatchObject({ reason: 'username_taken', accountCreated: false });
		expect(claimOf(base())).toMatchObject({ status: 'failed', needs_refund: true });
		expect(recorded).toHaveLength(0);
	});

	it('finishes a signup whose broadcast result was unknown, on retry', async () => {
		pay({ memo: memoOf(base()) });
		createOutcomes.push(async (name) => { chain.accounts.add(name); return { reason: 'creation_failed' }; }, 'exists_with_same_keys');
		const first = await submit(base());
		expect(first.body).toMatchObject({ reason: 'creation_failed', retryable: true });
		expect(claimOf(base())).toMatchObject({ status: 'pending', broadcast_attempted: true });
		later();
		const second = await submit(base());
		expect(second.body).toMatchObject({ reason: 'created', accountCreated: true });
		expect(recorded).toHaveLength(1);
	});

	it('fails for good, flagged for a refund, when the name was taken by someone else', async () => {
		pay({ memo: memoOf(base()) });
		createOutcomes.push('username_taken');
		expect((await submit(base())).body).toMatchObject({ reason: 'username_taken', retryable: false });
		expect(claimOf(base())).toMatchObject({ status: 'failed', failure_reason: 'username_taken', needs_refund: true });
		later();
		expect((await submit(base())).body.reason).toBe('username_taken');
		expect(created).toHaveLength(1);
	});

	it.each([
		['no_account_token', 'creation_failed'],
		['node_down', 'server_error'],
	])('keeps the claim open and retryable on %s, then finishes', async (outcome, reason) => {
		pay({ memo: memoOf(base()) });
		createOutcomes.push(outcome);
		expect((await submit(base())).body).toMatchObject({ reason, retryable: true, retry_after: 10 });
		expect(claimOf(base())).toMatchObject({ status: 'pending', broadcast_attempted: false });
		expect(recorded).toHaveLength(0);
		later();
		expect((await submit(base())).body.reason).toBe('created');
	});

	it('returns a retryable server_error when createAccount throws', async () => {
		pay({ memo: memoOf(base()) });
		createOutcomes.push(async () => { throw new Error('boom'); });
		const res = await submit(base());
		expect(res.status).toBe(500);
		expect(res.body).toMatchObject({ reason: 'server_error', retryable: true });
		expect(claimOf(base()).status).toBe('pending');
	});

	it('records the signup with 0 and flags the reward when the reward amount is unavailable', async () => {
		pay({ memo: memoOf(base()) });
		deps.paidAfitReward = () => 0;
		expect((await submit(base())).body.reason).toBe('created');
		expect(recorded).toHaveLength(1);
		expect(recorded[0]).toMatchObject({ afit_reward: 0, referrer: 'referrer1' });
		expect(claimOf(base())).toMatchObject({ status: 'created', reward_pending: true, reward_amount: 0 });
	});

	it.each([
		['returns false', async () => false],
		['throws', async () => { throw new Error('calcRank failed'); }],
	])('finishes the account and flags the reward when recordSignup %s', async (_l, fn) => {
		pay({ memo: memoOf(base()) });
		deps.recordSignup = fn;
		expect((await submit(base())).body.reason).toBe('created');
		expect(claimOf(base())).toMatchObject({ status: 'created', reward_pending: true });
	});

	it('still finishes when the delegation fails', async () => {
		pay({ memo: memoOf(base()) });
		deps.delegate = async () => { throw new Error('rc'); };
		expect((await submit(base())).body.reason).toBe('created');
		expect(claimOf(base())).toMatchObject({ status: 'created' });
		expect(claimOf(base()).delegated).toBeUndefined();
	});

	it('lets only one claim per name broadcast; the other is refused and flagged for a refund', async () => {
		const other = base({ referrer: '' }); // same name and keys, different referrer: another memo
		pay({ memo: memoOf(base()) });
		pay({ memo: memoOf(other) });
		let releaseA;
		const gate = new Promise((r) => { releaseA = r; });
		createOutcomes.push(async (name) => { await gate; chain.accounts.add(name); return { reason: 'created' }; });
		const a = submit(base()).then((x) => x);
		for (let i = 0; i < 50 && created.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
		const b = await submit(other); // name still free on chain, but A holds the name
		expect(b.body).toMatchObject({ reason: 'username_taken', accountCreated: false });
		expect(claimOf(other)).toMatchObject({ status: 'failed', needs_refund: true });
		releaseA();
		expect((await a).body.reason).toBe('created');
		expect(created).toHaveLength(1);
		expect(recorded).toHaveLength(1);
	});

	it('frees the name when the broadcast was refused, so a retry can take it', async () => {
		pay({ memo: memoOf(base()) });
		createOutcomes.push('no_account_token');
		await submit(base());
		expect(db.cols.signup_names.docs).toHaveLength(0);
		later();
		expect((await submit(base())).body.reason).toBe('created');
		expect(db.cols.signup_names.docs).toEqual([expect.objectContaining({ _id: 'newguy', memo: memoOf(base()) })]);
	});

	it('keeps at most 10 transfers per memo', async () => {
		for (let i = 0; i < 12; i++) pay({ memo: memoOf(base()), amount: '2.000 HIVE' });
		pay({ memo: memoOf(base()) }); // the 13th, a full payment, is beyond the cap
		const res = await submit(base());
		expect(res.body.reason).toBe('payment_insufficient');
		expect(svc._transfers().transfersFor(memoOf(base()))).toHaveLength(10);
	});

	it('does not skip a payment when the index is full: it keeps a gap and reads it once there is room', async () => {
		deps.indexMaxEntries = 5;
		deps.historyPageSize = 3;
		const trx = pay({ memo: memoOf(base()) });
		// five newer flood transfers that will age out of the index first
		dust(5, { amount: '1.000 HIVE', distinct: true, ageMs: 14 * 24 * 3600 * 1000 - 60 * 1000 });
		expect((await submit(base())).body.reason).toBe('payment_pending');
		expect(svc._transfers()._state().gaps).toHaveLength(1);
		later(2 * 60 * 1000); // the flood is now past retention and gets pruned
		const res = await submit(base());
		expect(res.body).toMatchObject({ reason: 'created', paymentReceivedTx: trx });
		expect(svc._transfers()._state().gaps).toHaveLength(0);
	});

	it('treats a bad history reply as an error, not as the end of history', async () => {
		pay({ memo: memoOf(base()) });
		const real = deps.hiveCall;
		deps.hiveCall = async (m, p) => (m === 'get_account_history' ? null : real(m, p));
		const res = await submit(base());
		expect(res.status).toBe(500);
		expect(res.body).toMatchObject({ reason: 'server_error', retryable: true });
		expect(svc._transfers()._state().high).toBeNull();
		deps.hiveCall = real;
		later();
		expect((await submit(base())).body.reason).toBe('created');
	});

	it('runs a single first scan for concurrent cold submits', async () => {
		await Promise.all([submit(base()), submit(base({ new_account: 'otherguy', keys: fakeKeys(3) }))]);
		expect(historyCalls.filter((c) => c.start === -1)).toHaveLength(1);
	});

	it('works with an account that has no history yet', async () => {
		expect((await submit(base())).body.reason).toBe('payment_pending');
		expect(svc._transfers()._state().high).toBe(-1);
		pay({ memo: memoOf(base()) });
		later();
		expect((await submit(base())).body.reason).toBe('created');
	});

	it('drops transfers older than the index retention', async () => {
		pay({ memo: memoOf(base()), ageMs: 15 * 24 * 3600 * 1000 });
		expect((await submit(base())).body.reason).toBe('payment_pending');
		expect(svc._transfers()._state().size).toBe(0);
	});

	it('refuses to quote an amount below the dust floor', async () => {
		deps.quoteAmount = async () => ({ amount: 0.1, live: true }); // 0.09 after tolerance < 0.1 HIVE
		expect((await quote(base())).body.reason).toBe('price_unavailable');
	});

	it('keeps a gap when a later walk in the same refresh fails', async () => {
		deps.historyPageSize = 3;
		await submit(base({ new_account: 'warmup', keys: fakeKeys(5) })); // builds the (empty) index
		const trx = pay({ memo: memoOf(base()) });
		dust(100); // more than one refresh's head walk (20 pages x 3)
		const real = deps.hiveCall;
		let calls = 0;
		deps.hiveCall = async (m, p) => {
			if (m === 'get_account_history' && ++calls === 21) throw new Error('node blip'); // first gap walk
			return real(m, p);
		};
		later();
		expect((await submit(base())).status).toBe(500);
		expect(svc._transfers()._state().gaps).toHaveLength(1);
		deps.hiveCall = real;
		later();
		const res = await submit(base());
		expect(res.body).toMatchObject({ reason: 'created', paymentReceivedTx: trx });
	});

	it('takes over a stale name reservation whose claim is gone, but not a fresh one', async () => {
		pay({ memo: memoOf(base()) });
		db.cols.signup_names.docs.push({ _id: 'newguy', memo: 'signup:' + 'a'.repeat(24), at: new Date(NOW - 10 * 60 * 1000) });
		expect((await submit(base())).body.reason).toBe('username_taken');
		build();
		pay({ memo: memoOf(base()) });
		db.cols.signup_names.docs.push({ _id: 'newguy', memo: 'signup:' + 'a'.repeat(24), at: new Date(NOW - 2 * 3600 * 1000) });
		expect((await submit(base())).body.reason).toBe('created');
		expect(db.cols.signup_names.docs[0]).toMatchObject({ memo: memoOf(base()), took_over_from: 'signup:' + 'a'.repeat(24) });
	});

	it('does not take over a reservation whose claim is still processing', async () => {
		pay({ memo: memoOf(base()) });
		const old = 'signup:' + 'b'.repeat(24);
		db.cols.signup_claims.docs.push({ _id: old, path: 'paid', status: 'processing', lease_until: new Date(NOW + 60000) });
		db.cols.signup_names.docs.push({ _id: 'newguy', memo: old, at: new Date(NOW - 2 * 3600 * 1000) });
		expect((await submit(base())).body.reason).toBe('username_taken');
	});

	it('does not let the old holder count the account after its reservation was taken over', async () => {
		const a = base({ referrer: '' }); // same name and keys, another memo
		db.cols.signup_claims.docs.push({ _id: memoOf(a), path: 'paid', new_account: 'newguy', status: 'pending', broadcast_attempted: true,
			payment_trx_id: 'tA', verified_amount: 40, verified_currency: 'HIVE', created_at: new Date(NOW - 3 * 3600 * 1000) });
		db.cols.signup_names.docs.push({ _id: 'newguy', memo: memoOf(a), at: new Date(NOW - 2 * 3600 * 1000) });
		pay({ memo: memoOf(base()) });
		expect((await submit(base())).body.reason).toBe('created'); // takes over the stale reservation
		createOutcomes.push('exists_with_same_keys');
		const res = await submit(a);
		expect(res.body).toMatchObject({ reason: 'username_taken', accountCreated: false });
		expect(recorded).toHaveLength(1);
	});

	it('honours a paid submit even when the daily cap is used', async () => {
		build({ cap: 0 });
		pay({ memo: memoOf(base()) });
		expect((await submit(base())).body.reason).toBe('created');
	});

	it('rate limits new claims per IP, but not checks on an existing claim', async () => {
		const users = Array.from({ length: 21 }, (_, i) => base({ new_account: 'user' + String.fromCharCode(97 + i) + 'x', keys: fakeKeys(10 + i) }));
		for (let i = 0; i < 20; i++) expect((await submit(users[i])).status).toBe(200);
		expect((await submit(users[20])).status).toBe(429);
		later();
		expect((await submit(users[0])).status).toBe(200);
	}, 60000);
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

	it('does not lock the details after a wrong code: the right code still works', async () => {
		build({ promo: true }); addPromo();
		expect((await submit(promoBody({ promo_code: 'TYPO' }))).body.reason).toBe('promo_invalid');
		expect(db.cols.signup_claims.docs).toHaveLength(0);
		expect((await submit(promoBody())).body.reason).toBe('created');
	});

	it('lets the user pay instead after a wrong code', async () => {
		build({ promo: true }); addPromo();
		await submit(promoBody({ promo_code: 'TYPO' }));
		pay({ memo: memoOf(base()) });
		expect((await submit(base())).body.reason).toBe('created');
	});

	it('reports promo_invalid for an unknown or used-up code', async () => {
		build({ promo: true }); addPromo({ entries: 0 });
		expect((await submit(promoBody())).body.reason).toBe('promo_invalid');
		expect((await submit(promoBody({ promo_code: 'NOPE' }))).body.reason).toBe('promo_invalid');
		expect(created).toHaveLength(0);
	});

	it.each([
		['this IP made 10 wrong guesses', 'promo_fail:1.2.3.4:', 10],
		['everyone made 300 wrong guesses', 'promo_fail_all:', 300],
	])('locks promo signups for the hour when %s', async (_l, prefix, n) => {
		build({ promo: true }); addPromo();
		db.cols.signup_rate_limits.docs.push({ _id: prefix + Math.floor(NOW / 3600000), n });
		expect((await submit(promoBody())).body.reason).toBe('promo_invalid');
		expect((await quote(promoBody())).body.reason).toBe('promo_invalid');
		expect(promo().entries).toBe(2);
	});

	it('does not lock other IPs below the global limit', async () => {
		build({ promo: true }); addPromo();
		db.cols.signup_rate_limits.docs.push({ _id: 'promo_fail:9.9.9.9:' + Math.floor(NOW / 3600000), n: 50 });
		db.cols.signup_rate_limits.docs.push({ _id: 'promo_fail_all:' + Math.floor(NOW / 3600000), n: 299 });
		expect((await submit(promoBody())).body.reason).toBe('created');
	});

	it('counts a wrong code against the IP and the global total', async () => {
		build({ promo: true }); addPromo();
		await submit(promoBody({ promo_code: 'TYPO' }));
		const byId = (p) => db.cols.signup_rate_limits.docs.find((d) => d._id.startsWith(p));
		expect(byId('promo_fail:1.2.3.4:').n).toBe(1);
		expect(byId('promo_fail_all:').n).toBe(1);
	});

	it('gives the entry back when nothing was broadcast', async () => {
		build({ promo: true }); addPromo();
		createOutcomes.push('username_taken');
		expect((await submit(promoBody())).body.reason).toBe('username_taken');
		expect(promo().entries).toBe(2);
	});

	it('keeps the entry held when the broadcast result is unknown, and finishes on retry without a second entry', async () => {
		build({ promo: true }); addPromo();
		createOutcomes.push(async (name) => { chain.accounts.add(name); return { reason: 'creation_failed' }; }, 'exists_with_same_keys');
		expect((await submit(promoBody())).body).toMatchObject({ reason: 'creation_failed', retryable: true });
		expect(promo().entries).toBe(1);
		later();
		expect((await submit(promoBody())).body.reason).toBe('created');
		expect(promo().entries).toBe(1);
		expect(recorded).toHaveLength(1);
	});

	it('restores the entry exactly once and stays retryable when no account token is left', async () => {
		build({ promo: true }); addPromo();
		createOutcomes.push('no_account_token');
		expect((await submit(promoBody())).body).toMatchObject({ reason: 'creation_failed', retryable: true });
		expect(promo().entries).toBe(2);
		expect(claimOf(promoBody()).promo_id).toBeUndefined();
		expect(claimOf(promoBody()).expires_at).toBeInstanceOf(Date); // can expire again
		later();
		expect((await submit(promoBody())).body.reason).toBe('created');
		expect(promo().entries).toBe(1);
	});

	it('does not let a stale request give back an entry another request used', async () => {
		build({ promo: true }); addPromo();
		let releaseA;
		const gate = new Promise((r) => { releaseA = r; });
		// A holds the entry, then hangs past its lease and finally reports a refusal
		createOutcomes.push(async () => { await gate; return { reason: 'node_down' }; });
		const a = submit(promoBody()).then((x) => x);
		for (let i = 0; i < 50 && created.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
		later(6 * 60 * 1000);
		expect((await submit(promoBody())).body.reason).toBe('created'); // B uses the held entry
		releaseA();
		await a;
		expect(promo().entries).toBe(1);
		expect(claimOf(promoBody()).status).toBe('created');
	});

	it('stops promo signups once the promo daily cap is used', async () => {
		build({ promo: true, promoCap: 1 }); addPromo();
		db.cols.signup_claims.docs.push({ _id: 'x', path: 'promo', status: 'created', finalized_at: new Date(NOW - 1000) });
		expect((await submit(promoBody())).body).toMatchObject({ reason: 'signup_disabled', retryable: true });
		expect(promo().entries).toBe(2);
	});
});

// ---- settings cache ------------------------------------------------------------------------

describe('kill switch', () => {
	it('takes effect within the cache window on every server', async () => {
		expect((await quote(base())).status).toBe(200);
		db.cols.settings.docs[0].enabled = false;
		expect((await quote(base())).status).toBe(200); // cached
		later(61 * 1000);
		expect((await quote(base())).status).toBe(503);
	});
});
