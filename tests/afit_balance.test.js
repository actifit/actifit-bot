/**
 * afit_balance.js - atomic off-chain AFIT debits/credits, the unique ledger indexes and the
 * shared per-user lock.
 *
 * The concurrency and index tests need real MongoDB semantics (conditional updates, unique
 * partial indexes, duplicate-key errors): set MONGO_TEST_URI. They are skipped without it.
 */

const afit = require('../afit_balance');

describe('amount rules (no database)', () => {
	test('finiteAmount / positiveAmount', () => {
		expect(afit.finiteAmount('12.5')).toBe(12.5);
		expect(afit.finiteAmount(-3)).toBe(-3);
		for (const v of [NaN, Infinity, '', '  ', 'abc', null, undefined, true, [5], {}]) {
			expect(afit.finiteAmount(v)).toBeNull();
		}
		expect(afit.positiveAmount('0')).toBeNull();
		expect(afit.positiveAmount(-1)).toBeNull();
		expect(afit.positiveAmount('0.001')).toBe(0.001);
	});

	test('utils shares the very same rule', () => {
		// utils is not load-time safe, so compare against the source instead of requiring it
		const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'utils.js'), 'utf8');
		expect(src).toMatch(/const finiteAmount = afitBalance\.finiteAmount;/);
		expect(src).toMatch(/const FINITE_AMOUNT = afitBalance\.FINITE_AMOUNT;/);
	});

	test('invalid input never reaches the database', async () => {
		const db = { collection: jest.fn(() => { throw new Error('must not be called'); }) };
		for (const bad of [0, -5, 'abc', NaN, Infinity, null]) {
			await expect(afit.debitAfit(db, 'alice', bad)).resolves.toEqual({ ok: false, reason: 'invalid_amount' });
			await expect(afit.creditAfit(db, 'alice', bad, {})).resolves.toEqual({ ok: false, reason: 'invalid_amount' });
		}
		await expect(afit.debitAfit(db, '', 5)).resolves.toMatchObject({ ok: false });
		await expect(afit.creditAfit(db, { $ne: 1 }, 5, {})).resolves.toMatchObject({ ok: false });
		expect(db.collection).not.toHaveBeenCalled();
	});

	test('ensureLedgerIndexes never builds the ledger indexes and never rejects', async () => {
		const logs = [];
		const created = [];
		const db = { collection: (name) => ({
			createIndex: (key, opts) => { created.push(name + ':' + opts.name); return Promise.resolve(opts.name); },
			indexes: () => Promise.resolve([{ name: '_id_' }]),
		}) };
		const out = await afit.ensureLedgerIndexes(db, (m) => logs.push(m));
		expect(out).toEqual([{ name: 'afit_deposit_unique', present: false }, { name: 'afit_web_reward_unique', present: false }]);
		expect(logs.join('\n')).toMatch(/afit_deposit_unique is MISSING/);
		expect(logs.join('\n')).toMatch(/afit_web_reward_unique is MISSING/);
		// only the small request_locks TTL index is built
		expect(created).toEqual(['request_locks:request_locks_ttl']);
		const failing = { collection: () => ({ createIndex: () => Promise.reject(new Error('x')), indexes: () => Promise.reject(new Error('y')) }) };
		await expect(afit.ensureLedgerIndexes(failing, () => {})).resolves.toEqual([]);
		await expect(afit.ensureLedgerIndexes({ collection: () => { throw new Error('x'); } }, () => {})).resolves.toEqual([]);
		await expect(afit.ensureLedgerIndexes({ collection: () => ({}) })).resolves.toEqual([]);
	});

	test('debitAfit allowNegative (admin claw-back) skips the balance floor', async () => {
		const calls = [];
		const db = { collection: () => ({
			updateOne: (f, u) => { calls.push(f); return Promise.resolve({ matchedCount: 1 }); },
			findOne: () => Promise.resolve({ tokens: -5 }),
		}) };
		await expect(afit.debitAfit(db, 'alice', 10, { allowNegative: true })).resolves.toMatchObject({ ok: true, balance: -5 });
		await afit.debitAfit(db, 'alice', 10);
		expect(calls).toEqual([{ _id: 'alice' }, { _id: 'alice', tokens: { $gte: 10 } }]);
	});
});

const MONGO_URI = process.env.MONGO_TEST_URI;
(MONGO_URI ? describe : describe.skip)('against a real MongoDB', () => {
	const { MongoClient } = require('mongodb');
	let client, db;
	const balance = async (u) => { const d = await db.collection('user_tokens').findOne({ _id: u }); return d && d.tokens; };
	const rows = (q) => db.collection('token_transactions').find(q).toArray();

	beforeAll(async () => {
		client = await MongoClient.connect(MONGO_URI);
		db = client.db('afit_balance_test_' + Date.now());
		await afit.createLedgerIndexes(db);
	});
	afterAll(async () => { await db.dropDatabase(); await client.close(); });
	beforeEach(async () => {
		await db.collection('user_tokens').deleteMany({});
		await db.collection('token_transactions').deleteMany({});
		await db.collection('request_locks').deleteMany({});
	});

	test('N parallel debits against a balance that covers only some: exactly the affordable number succeed', async () => {
		await db.collection('user_tokens').insertOne({ _id: 'alice', user: 'alice', tokens: 55 });
		const results = await Promise.all(Array.from({ length: 20 }, (_, i) =>
			afit.debitAfit(db, 'alice', 10, { ledgerRow: { reward_activity: 'Buy Product', n: i } })));
		const ok = results.filter((r) => r.ok);
		expect(ok).toHaveLength(5);
		expect(results.filter((r) => !r.ok).every((r) => r.reason === 'insufficient_funds')).toBe(true);
		expect(await balance('alice')).toBe(5);
		const ledger = await rows({ user: 'alice' });
		expect(ledger).toHaveLength(5);
		expect(ledger.every((r) => r.token_count === -10)).toBe(true);
		// every reported post-debit balance is >= 0
		expect(ok.every((r) => r.balance >= 0)).toBe(true);
	});

	test('minBalance is enforced at the instant of the debit', async () => {
		await db.collection('user_tokens').insertOne({ _id: 'bob', user: 'bob', tokens: 120 });
		const r = await Promise.all([1, 2, 3].map(() => afit.debitAfit(db, 'bob', 50, { minBalance: 100 })));
		// balance must be >= max(100, 50) when each debit runs: only the first one fits
		expect(r.filter((x) => x.ok)).toHaveLength(1);
		expect(await balance('bob')).toBe(70);
	});

	test('a missing, NaN or string balance never matches (fails closed)', async () => {
		await db.collection('user_tokens').insertMany([
			{ _id: 'nan', tokens: NaN }, { _id: 'str', tokens: '1000' },
		]);
		for (const u of ['nan', 'str', 'nobody']) {
			await expect(afit.debitAfit(db, u, 1)).resolves.toMatchObject({ ok: false, reason: 'insufficient_funds' });
		}
		expect(await rows({})).toHaveLength(0);
	});

	test('the AFIT is given back when the ledger row cannot be written', async () => {
		await db.collection('user_tokens').insertOne({ _id: 'carol', user: 'carol', tokens: 100 });
		const broken = {
			collection: (name) => name === 'token_transactions'
				? { insertOne: () => Promise.reject(new Error('write failed')) }
				: db.collection(name),
		};
		const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
		const r = await afit.debitAfit(broken, 'carol', 40, { ledgerRow: { reward_activity: 'x' } });
		spy.mockRestore();
		expect(r).toMatchObject({ ok: false, reason: 'ledger_failed' });
		expect(await balance('carol')).toBe(100);
		expect(await rows({})).toHaveLength(0);
	});

	test('undoDebit removes the ledger row and gives the AFIT back', async () => {
		await db.collection('user_tokens').insertOne({ _id: 'dave', user: 'dave', tokens: 100 });
		const d = await afit.debitAfit(db, 'dave', 30, { ledgerRow: { reward_activity: 'x' } });
		expect(d).toMatchObject({ ok: true, amount: 30, balance: 70 });
		expect(await rows({ user: 'dave' })).toHaveLength(1);
		await expect(afit.undoDebit(db, 'dave', d)).resolves.toBe(true);
		expect(await balance('dave')).toBe(100);
		expect(await rows({ user: 'dave' })).toHaveLength(0);
	});

	test('creditAfit writes the ledger row first, then $inc with upsert (keeps other fields)', async () => {
		const r = await afit.creditAfit(db, 'erin', 12.5, { reward_activity: 'Refund Product', token_count: 999999 });
		expect(r).toMatchObject({ ok: true, amount: 12.5, balance: 12.5, balanceUpdated: true });
		expect(await db.collection('user_tokens').findOne({ _id: 'erin' })).toEqual({ _id: 'erin', user: 'erin', tokens: 12.5 });
		const [row] = await rows({ user: 'erin' });
		expect(row.token_count).toBe(12.5); // the caller cannot override the amount
		await db.collection('user_tokens').updateOne({ _id: 'erin' }, { $set: { extra: 1 } });
		await afit.creditAfit(db, 'erin', 2.5, { reward_activity: 'x' });
		expect(await db.collection('user_tokens').findOne({ _id: 'erin' })).toEqual({ _id: 'erin', user: 'erin', tokens: 15, extra: 1 });
	});

	test('credit idempotency: parallel credits of one deposit credit exactly once (unique index)', async () => {
		await db.collection('user_tokens').insertOne({ _id: 'fred', user: 'fred', tokens: 1 });
		const row = { reward_activity: 'Move AFIT HE to Actifit Wallet', se_trx_ref: 'trx-1', exchange: 'HE' };
		const results = await Promise.all(Array.from({ length: 12 }, () =>
			afit.creditAfit(db, 'fred', 25, row, { dedupe: { user: 'fred', se_trx_ref: 'trx-1' } })));
		expect(results.filter((r) => r.ok)).toHaveLength(1);
		expect(results.filter((r) => r.duplicate)).toHaveLength(11);
		expect(await balance('fred')).toBe(26);
		expect(await rows({ user: 'fred', se_trx_ref: 'trx-1' })).toHaveLength(1);
		// a later repeat is a duplicate too
		await expect(afit.creditAfit(db, 'fred', 25, row, { dedupe: { user: 'fred', se_trx_ref: 'trx-1' } })).resolves.toMatchObject({ duplicate: true });
		expect(await balance('fred')).toBe(26);
	});

	test('the deposit index rejects a second row for one trx, and ignores rows without one', async () => {
		const col = db.collection('token_transactions');
		await col.insertOne({ user: 'gina', se_trx_ref: 'abc', token_count: 5 });
		await expect(col.insertOne({ user: 'gina', se_trx_ref: 'abc', token_count: 5 })).rejects.toMatchObject({ code: 11000 });
		// the same trx ref for another user, and rows with no / null ref, are not constrained
		await col.insertOne({ user: 'hank', se_trx_ref: 'abc', token_count: 5 });
		await col.insertMany([{ user: 'gina', token_count: 1 }, { user: 'gina', token_count: 1 }, { user: 'gina', se_trx_ref: null }, { user: 'gina', se_trx_ref: null }]);
		const idx = await col.indexes();
		expect(idx.find((i) => i.name === 'afit_deposit_unique')).toMatchObject({ unique: true, key: { user: 1, se_trx_ref: 1 } });
	});

	test('the web reward index allows one row per user, activity and day', async () => {
		const col = db.collection('token_transactions');
		const day = new Date('2026-10-01T00:00:00Z');
		await col.insertOne({ user: 'ivy', reward_activity: 'Web Vote', reward_date: day, token_count: 1 });
		await expect(col.insertOne({ user: 'ivy', reward_activity: 'Web Vote', reward_date: day, token_count: 1 })).rejects.toMatchObject({ code: 11000 });
		await col.insertOne({ user: 'ivy', reward_activity: 'Web Edit', reward_date: day, token_count: 1 });
		await col.insertOne({ user: 'ivy', reward_activity: 'Web Vote', reward_date: new Date('2026-10-02T00:00:00Z'), token_count: 1 });
		// ordinary rows without reward_date are untouched
		await col.insertMany([{ user: 'ivy', reward_activity: 'Web Vote' }, { user: 'ivy', reward_activity: 'Web Vote' }]);
	});

	test('startup check: reports the ledger indexes, builds only the request_locks TTL', async () => {
		const other = client.db('afit_balance_chk_' + Date.now());
		try {
			await other.collection('token_transactions').insertOne({ user: 'jo', token_count: 1 });
			const logs = [];
			expect(await afit.ensureLedgerIndexes(other, (m) => logs.push(m))).toEqual([
				{ name: 'afit_deposit_unique', present: false }, { name: 'afit_web_reward_unique', present: false },
			]);
			expect(logs.join('\n')).toMatch(/!!! token_transactions index afit_deposit_unique is MISSING/);
			expect((await other.collection('token_transactions').indexes()).map((i) => i.name)).toEqual(['_id_']);
			const ttl = (await other.collection('request_locks').indexes()).find((i) => i.name === 'request_locks_ttl');
			expect(ttl).toMatchObject({ key: { at: 1 }, expireAfterSeconds: 3600 });
			// once built by hand, the check is quiet
			await afit.createLedgerIndexes(other);
			logs.length = 0;
			expect((await afit.ensureLedgerIndexes(other, (m) => logs.push(m))).every((x) => x.present)).toBe(true);
			expect(logs).toEqual([]);
			// a duplicate blocks the manual build (that is why the procedure checks first)
			const third = client.db('afit_balance_dups_' + Date.now());
			await third.collection('token_transactions').insertMany([{ user: 'jo', se_trx_ref: 'd' }, { user: 'jo', se_trx_ref: 'd' }]);
			await expect(afit.createLedgerIndexes(third)).rejects.toMatchObject({ code: 11000 });
			await third.dropDatabase();
		} finally {
			await other.dropDatabase();
		}
	});

	test('acquireLock: one holder at a time, waiters get it after release, stale locks are replaced', async () => {
		const got = await Promise.all([1, 2, 3].map(() => afit.acquireAfitLock(db, 'kim')));
		expect(got.filter(Boolean)).toHaveLength(1);
		const holder = got.find(Boolean);
		const waiting = afit.acquireAfitLock(db, 'kim', { waitMs: 3000, pollMs: 50 });
		await new Promise((r) => setTimeout(r, 200));
		await holder.release();
		const second = await waiting;
		expect(second).toBeTruthy();
		await second.release();
		expect(await db.collection('request_locks').countDocuments({})).toBe(0);
		// a lock from a crashed request (older than LOCK_STALE_MS) does not block forever
		await db.collection('request_locks').insertOne({ _id: 'afit:kim', owner: 'gone', at: new Date(Date.now() - afit.LOCK_STALE_MS - 1000) });
		const third = await afit.acquireAfitLock(db, 'kim');
		expect(third).toBeTruthy();
		await third.release();
		// busy without waiting -> null
		await db.collection('request_locks').insertOne({ _id: 'afit:kim', owner: 'other', at: new Date() });
		await expect(afit.acquireAfitLock(db, 'kim')).resolves.toBeNull();
	});
});
