/**
 * afit_balance.js - atomic off-chain AFIT debits/credits, the unique ledger indexes and the
 * shared per-user lock.
 *
 * The concurrency and index tests need real MongoDB semantics (conditional updates, unique
 * partial indexes, duplicate-key errors): set MONGO_TEST_URI. They are skipped without it.
 */

const afit = require('../afit_balance');

describe('deposit rules (no database)', () => {
	const ok = { operation: 'tokens_transfer', from: 'alice', to: 'recv', symbol: 'AFIT', quantity: '12.5', transactionId: 'abc' };
	const opts = { user: 'alice', receivingAccount: 'recv' };
	test('a plain AFIT transfer from the user to the receiving account is a deposit', () => {
		expect(afit.depositError(ok, opts)).toBeNull();
		expect(afit.depositError(ok, { receivingAccount: 'recv' })).toBeNull(); // any sender, for the bulk job
		expect(afit.depositError(Object.assign({}, ok, { quantity: 3 }), opts)).toBeNull();
	});
	test.each([
		[{ operation: 'tokens_stake' }, 'not_a_transfer'],
		[{ operation: undefined }, 'not_a_transfer'],
		[{ symbol: 'afit' }, 'not_afit'],
		[{ symbol: undefined }, 'not_afit'],
		[{ to: 'other' }, 'wrong_recipient'],
		[{ to: undefined }, 'wrong_recipient'],
		[{ from: 'bob' }, 'sender_mismatch'],
		[{ from: 'recv', to: 'recv' }, 'invalid_sender'],
		[{ from: '' }, 'invalid_sender'],
		[{ transactionId: '' }, 'invalid_deposit'],
		[{ transactionId: null }, 'invalid_deposit'],
		[{ quantity: '1e3' }, 'invalid_amount'],
		[{ quantity: '0x10' }, 'invalid_amount'],
		[{ quantity: ' 1' }, 'invalid_amount'],
		[{ quantity: '1.' }, 'invalid_amount'],
		[{ quantity: '.5' }, 'invalid_amount'],
		[{ quantity: '0' }, 'invalid_amount'],
		[{ quantity: '0.000000001' }, 'invalid_amount'],
		[{ quantity: -1 }, 'invalid_amount'],
		[{ quantity: NaN }, 'invalid_amount'],
		[{ quantity: ['5'] }, 'invalid_amount'],
	])('%o is refused (%s)', (change, reason) => {
		expect(afit.depositError(Object.assign({}, ok, change), opts)).toBe(reason);
	});
	test('fails closed without a configured receiving account', () => {
		for (const receivingAccount of [undefined, null, '', 5]) {
			expect(afit.depositError(ok, { user: 'alice', receivingAccount })).toBe('no_receiving_account');
		}
		expect(afit.depositError(null, opts)).toBe('invalid_deposit');
	});
	test('depositQuantity', () => {
		expect(afit.depositQuantity('260025.06')).toBe(260025.06);
		expect(afit.depositQuantity('2125.62860538')).toBe(2125.62860538);
		expect(afit.depositQuantity('140500')).toBe(140500);
		expect(afit.depositQuantity('1e5')).toBeNull();
	});
});

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
		expect(out).toEqual([{ name: 'afit_deposit_unique', present: false }, { name: 'afit_web_reward_unique', present: false }, { name: 'verified_tx_unique', present: false }]);
		expect(logs.join('\n')).toMatch(/afit_deposit_unique is MISSING/);
		expect(logs.join('\n')).toMatch(/afit_web_reward_unique is MISSING/);
		expect(logs.join('\n')).toMatch(/verified_tx unique index on tx_id is MISSING/);
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
		const day = new Date('2026-11-01T00:00:00Z');
		await col.insertOne({ user: 'ivy', reward_activity: 'Web Vote', reward_date: day, token_count: 1 });
		await expect(col.insertOne({ user: 'ivy', reward_activity: 'Web Vote', reward_date: day, token_count: 1 })).rejects.toMatchObject({ code: 11000 });
		await col.insertOne({ user: 'ivy', reward_activity: 'Web Edit', reward_date: day, token_count: 1 });
		await col.insertOne({ user: 'ivy', reward_activity: 'Web Vote', reward_date: new Date('2026-10-02T00:00:00Z'), token_count: 1 });
		// historical rows (before the index cut-off) may repeat: they are kept as they are
		const old = new Date('2020-03-12T00:00:00Z');
		await col.insertOne({ user: 'ivy', reward_activity: 'Web Vote', reward_date: old, token_count: 1 });
		await col.insertOne({ user: 'ivy', reward_activity: 'Web Vote', reward_date: old, token_count: 1 });
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
				{ name: 'verified_tx_unique', present: false }, // the collection does not even exist yet
			]);
			expect(logs.join('\n')).toMatch(/!!! token_transactions index afit_deposit_unique is MISSING/);
			expect((await other.collection('token_transactions').indexes()).map((i) => i.name)).toEqual(['_id_']);
			const ttl = (await other.collection('request_locks').indexes()).find((i) => i.name === 'request_locks_ttl');
			expect(ttl).toMatchObject({ key: { at: 1 }, expireAfterSeconds: 3600 });
			// once built by hand, the check is quiet
			await afit.createLedgerIndexes(other);
			await afit.createVerifiedTxIndex(other);
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

	test('verified_tx unique index: rows without a string tx_id stay out, a repeated tx_id is refused', async () => {
		const v = client.db('afit_balance_vtx_' + Date.now());
		try {
			// a plain (non-unique) index on tx_id does not count as the guard
			await v.collection('verified_tx').createIndex({ tx_id: 1 }, { name: 'tx_id_1' });
			expect((await afit.ensureLedgerIndexes(v, () => {})).find((x) => x.name === 'verified_tx_unique')).toEqual({ name: 'verified_tx_unique', present: false });
			await v.collection('verified_tx').insertMany([{ tx_id: 'a' }, { tx_id: null }, { tx_id: null }, { other: 1 }, { other: 2 }]);
			await afit.createVerifiedTxIndex(v);
			expect((await afit.ensureLedgerIndexes(v, () => {})).find((x) => x.name === 'verified_tx_unique').present).toBe(true);
			const dup = await v.collection('verified_tx').insertOne({ tx_id: 'a' }).catch((e) => e);
			expect(afit.isDuplicateKeyError(dup)).toBe(true);
			// a duplicate blocks the manual build
			const w = client.db('afit_balance_vtx2_' + Date.now());
			await w.collection('verified_tx').insertMany([{ tx_id: 'b' }, { tx_id: 'b' }]);
			await expect(afit.createVerifiedTxIndex(w)).rejects.toMatchObject({ code: 11000 });
			await w.dropDatabase();
		} finally {
			await v.dropDatabase();
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
	describe('rebuildCachedBalances (the daily rebuild)', () => {
		const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
		const fast = { lockWaitMs: 50, retryWaitMs: 50 };

		test('sets each cache to the ledger sum, only touching the users that differ', async () => {
			await db.collection('token_transactions').insertMany([
				{ user: 'same', token_count: 10 }, { user: 'same', token_count: 5 },
				{ user: 'drift', token_count: 100 }, { user: 'drift', token_count: -30 },
				{ user: 'fresh', token_count: 7 },
				{ user: 'nan', token_count: 4 }, { user: 'nan', token_count: NaN },
				{ user: 'neg', token_count: -12 },
				{ user: 'str', token_count: 15 },
				{ token_count: 999 }, // no user: never becomes a balance row
			]);
			await db.collection('user_tokens').insertMany([
				{ _id: 'same', user: 'same', tokens: 15, extra: 'kept' },
				{ _id: 'drift', user: 'drift', tokens: 90, extra: 'kept' },
				{ _id: 'nan', user: 'nan', tokens: NaN },
				{ _id: 'gone', user: 'gone', tokens: 3 }, // no ledger rows at all
				{ _id: 'zero', user: 'zero', tokens: 0 },
				{ _id: 'str', user: 'str', tokens: '15' }, // a string balance can never be spent
			]);
			const r = await afit.rebuildCachedBalances(db, fast);
			expect(r).toMatchObject({ users: 6, cached: 6, candidates: 6, updated: 6, busy: [], failed: 0 });
			const docs = Object.fromEntries((await db.collection('user_tokens').find({}).toArray()).map((d) => [d._id, d]));
			expect(docs.same).toEqual({ _id: 'same', user: 'same', tokens: 15, extra: 'kept' });
			expect(docs.drift).toEqual({ _id: 'drift', user: 'drift', tokens: 70, extra: 'kept' });
			expect(docs.fresh.tokens).toBe(7);
			expect(docs.nan.tokens).toBe(4);
			expect(docs.neg.tokens).toBe(-12);
			expect(docs.gone.tokens).toBe(0);
			expect(docs.zero.tokens).toBe(0);
			expect(docs.str.tokens).toBe(15);
			expect(Object.keys(docs).sort()).toEqual(['drift', 'fresh', 'gone', 'nan', 'neg', 'same', 'str', 'zero']);
			// floating-point noise between $inc and $sum is not a difference
			await db.collection('user_tokens').updateOne({ _id: 'same' }, { $set: { tokens: 15 + 1e-12 } });
			expect((await afit.rebuildCachedBalances(db, fast)).candidates).toBe(0);
			expect(await db.collection('request_locks').countDocuments({})).toBe(0);
		});

		test('a spend half-done when the rebuild starts is not undone: the rebuild waits for its lock', async () => {
			await db.collection('token_transactions').insertOne({ user: 'alice', token_count: 100 });
			await db.collection('user_tokens').insertOne({ _id: 'alice', user: 'alice', tokens: 100 });
			// a debit in progress: lock held, AFIT taken from the cache, ledger row not yet written
			const lock = await afit.acquireAfitLock(db, 'alice');
			await db.collection('user_tokens').updateOne({ _id: 'alice' }, { $inc: { tokens: -40 } });
			const rebuild = afit.rebuildCachedBalances(db, { lockWaitMs: 50, retryWaitMs: 5000 });
			await sleep(400);
			// the old $out rebuild had already written the stale sum (100) by now
			await db.collection('token_transactions').insertOne({ user: 'alice', token_count: -40 });
			await lock.release();
			const r = await rebuild;
			expect(r.busy).toEqual([]);
			expect(await balance('alice')).toBe(60);
		});

		test('a user whose lock stays busy is left alone and reported, the others are rebuilt', async () => {
			await db.collection('token_transactions').insertMany([{ user: 'held', token_count: 5 }, { user: 'free', token_count: 8 }]);
			await db.collection('user_tokens').insertMany([{ _id: 'held', user: 'held', tokens: 1 }, { _id: 'free', user: 'free', tokens: 1 }]);
			await db.collection('request_locks').insertOne({ _id: 'afit:held', owner: 'someone', at: new Date() });
			const logs = [];
			const r = await afit.rebuildCachedBalances(db, Object.assign({ log: (m) => logs.push(m) }, fast));
			expect(r).toMatchObject({ candidates: 2, updated: 1, busy: ['held'], failed: 0 });
			expect(await balance('held')).toBe(1);
			expect(await balance('free')).toBe(8);
			expect(logs.join(' ')).toMatch(/lock stayed busy for 1 user/);
		});

		test('debits and credits running during rebuilds: every cache ends equal to its ledger', async () => {
			const users = ['u0', 'u1', 'u2', 'u3', 'u4', 'u5'];
			for (const u of users) {
				await db.collection('token_transactions').insertOne({ user: u, token_count: 500 });
				await db.collection('user_tokens').insertOne({ _id: u, user: u, tokens: 500 });
			}
			const ops = [];
			for (let i = 0; i < 120; i++) {
				const u = users[i % users.length];
				ops.push((async () => {
					await sleep(Math.floor(Math.random() * 300));
					const lock = await afit.acquireAfitLock(db, u, { waitMs: 20000, pollMs: 10 });
					try {
						if (i % 3 === 0) await afit.creditAfit(db, u, 3, { reward_activity: 'test credit' });
						else await afit.debitAfit(db, u, 2, { ledgerRow: { reward_activity: 'test debit' } });
					} finally { await lock.release(); }
				})());
			}
			// and some reward rows written straight to the ledger, as the daily jobs do
			for (const u of users) ops.push(sleep(100).then(() => db.collection('token_transactions').insertOne({ user: u, token_count: 1.5 })));
			const rebuilds = [0, 100, 200].map((d) => sleep(d).then(() => afit.rebuildCachedBalances(db, { lockWaitMs: 20000, concurrency: 2 })));
			await Promise.all(ops.concat(rebuilds));
			await afit.rebuildCachedBalances(db, fast); // picks up the direct ledger rows
			for (const u of users) {
				const sum = (await rows({ user: u })).reduce((s, x) => s + x.token_count, 0);
				expect(await balance(u)).toBeCloseTo(sum, 9);
			}
			expect(await db.collection('request_locks').countDocuments({})).toBe(0);
		}, 60000);
	});
});
