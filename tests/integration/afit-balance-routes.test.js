/**
 * AFIT balance writers through the real app.js routes, against a real MongoDB (set
 * MONGO_TEST_URI): gadget buys, workout buys, deposit credits, the balance rebuild, web
 * rewards and the admin-secret gates. Chain checks are stubbed on utils.
 */

const path = require('path');

const MONGO_URI = process.env.MONGO_TEST_URI;
const DB_NAME = 'afit_routes_test_' + Date.now();
const ADMIN_TOKEN = 'test-admin-ops-token';
const WALLET = 'wallet.test';

for (const m of ['node:fs', 'fs']) {
	jest.doMock(m, () => {
		const actual = jest.requireActual('fs');
		return {
			...actual,
			readFileSync: jest.fn((p, o) => {
				if (path.basename(p) !== 'config.json') return actual.readFileSync(p, o);
				const cfg = JSON.parse(actual.readFileSync(path.join(__dirname, '../test-config.json'), 'utf8'));
				Object.assign(cfg, {
					mongo_uri: MONGO_URI, mongo_local: MONGO_URI, db_name: DB_NAME,
					hive_engine_trans_acct_his: 'https://history.example.invalid/accountHistory',
					hive_engine_actifit_he: WALLET, steem_engine_actifit_se: WALLET,
					workoutGenerationFeesAFIT: 5,
					actifitWebVoteToken: 'vote-token', actifitWebEditRewardAmount: 2,
				});
				return JSON.stringify(cfg);
			}),
		};
	});
}
const appClients = [];
jest.doMock('mongodb', () => {
	const actual = jest.requireActual('mongodb');
	class TrackedClient extends actual.MongoClient {
		constructor(...args) { super(...args); appClients.push(this); }
	}
	return { ...actual, MongoClient: TrackedClient };
});
jest.doMock('firebase-admin', () => ({ initializeApp: jest.fn(), credential: { cert: jest.fn() }, messaging: jest.fn(() => ({})) }));
jest.doMock('@hiveio/dhive', () => {
	const actual = jest.requireActual('@hiveio/dhive');
	return { ...actual, Client: jest.fn(() => ({ database: { call: jest.fn(async (m) => (m === 'get_account_history' ? [] : null)) } })) };
});
jest.doMock('web3', () => { const W = jest.fn(() => ({ eth: { Contract: jest.fn(() => ({ methods: {} })), accounts: { wallet: { add: jest.fn(), create: jest.fn() } } }, utils: {} })); W.Web3 = W; return W; });
jest.doMock('sscjs', () => jest.fn(() => ({ find: jest.fn(() => Promise.resolve([])), findOne: jest.fn(() => Promise.resolve(null)) })));

const dhive = jest.requireActual('@hiveio/dhive');
const KEY = dhive.PrivateKey.fromSeed('afit-routes-key');
const pub = (k) => k.createPublic().toString();

(MONGO_URI ? describe : describe.skip)('AFIT balance writers (real app, real MongoDB)', () => {
	const request = require('supertest');
	const { MongoClient, ObjectId } = jest.requireActual('mongodb');
	let app, mc, db, utils, token, ipN = 0;
	const ip = () => '198.51.100.' + ((ipN++ % 250) + 1);
	const bal = async (u) => { const d = await db.collection('user_tokens').findOne({ _id: u }); return d ? d.tokens : undefined; };
	const setBal = (u, tokens) => db.collection('user_tokens').replaceOne({ _id: u }, { _id: u, user: u, tokens }, { upsert: true });
	const ledger = (q) => db.collection('token_transactions').find(q).toArray();
	let logSpy;

	beforeAll(async () => {
		const origSetTimeout = global.setTimeout;
		jest.spyOn(global, 'setTimeout').mockImplementation((fn, d) => ((typeof d === 'number' && d > 20000) ? null : origSetTimeout(fn, d)));
		jest.spyOn(global, 'setInterval').mockImplementation(() => null);
		const express = require('express');
		const listen = express.application.listen;
		express.application.listen = jest.fn(() => ({ setTimeout: jest.fn(), close: jest.fn() }));
		app = require('../../app');
		express.application.listen = listen;
		utils = require('../../utils');
		utils.getAccountData = jest.fn(async () => ({ HIVE: { name: 'alice', posting: { weight_threshold: 1, account_auths: [], key_auths: [[pub(KEY), 1]] } } }));
		utils.validateAccountLogin = jest.fn(async (u, k) => ({ result: u === 'alice' && k === KEY.toString(), account: { name: 'alice' } }));
		utils.sendNotification = jest.fn(async () => true);
		mc = await MongoClient.connect(MONGO_URI);
		db = mc.db(DB_NAME);
		for (let i = 0; i < 60; i++) {
			const r = await request(app).get('/userSettings/nobody');
			if (r.status === 200) break;
			await new Promise((res) => origSetTimeout(res, 500));
		}
		// the startup index check is fire-and-forget: wait for the TTL index it adds
		for (let i = 0; i < 40; i++) {
			const idx = await db.collection('request_locks').indexes().catch(() => []);
			if (idx.some((x) => x.name === 'request_locks_ttl')) break;
			await new Promise((res) => origSetTimeout(res, 250));
		}
		const login = await request(app).post('/loginAuth').set('X-Forwarded-For', ip()).send({ username: 'alice', ppkey: KEY.toString() });
		token = login.body.token;
	}, 120000);
	afterAll(async () => {
		if (db) await db.dropDatabase();
		if (mc) await mc.close();
		await Promise.all(appClients.map((c) => c.close().catch(() => {})));
	});
	beforeEach(async () => {
		logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
		for (const c of ['user_tokens', 'token_transactions', 'user_gadgets', 'products', 'request_locks', 'exchange_afit_steem']) {
			await db.collection(c).deleteMany({});
		}
		utils.verifyGadgetTransaction = jest.fn(async () => true);
		utils.verifyWorkoutTransaction = jest.fn(async () => true);
	});
	afterEach(() => logSpy.mockRestore());

	test('startup does NOT build the ledger indexes; without them a deposit still credits once', async () => {
		expect(token).toBeTruthy();
		const names = (await db.collection('token_transactions').indexes()).map((i) => i.name);
		expect(names).not.toContain('afit_deposit_unique');
		expect(names).not.toContain('afit_web_reward_unique');
		expect((await db.collection('request_locks').indexes()).find((i) => i.name === 'request_locks_ttl')).toMatchObject({ expireAfterSeconds: 3600 });
		// the per-user lock + keyed upsert are the guard until the indexes are built by hand
		await setBal('alice', 0);
		utils.confirmSEAFITReceived = jest.fn(async () => ({ operation: 'tokens_transfer', from: 'alice', to: WALLET, symbol: 'AFIT', quantity: '4', transactionId: 'dep-noidx', timestamp: 1790000000 }));
		const rec = () => request(app).get('/confirmAFITSEReceipt?user=alice').set('X-Forwarded-For', ip()).set('x-acti-token', token);
		await Promise.all([rec(), rec(), rec(), rec()]);
		expect(await bal('alice')).toBe(4);
		expect(await ledger({ user: 'alice', se_trx_ref: 'dep-noidx' })).toHaveLength(1);
		// build them as the ops procedure would, for the rest of this file
		await require('../../afit_balance').createLedgerIndexes(db);
	});

	describe('gadget buys', () => {
		const gadget = (over = {}) => Object.assign({
			_id: new ObjectId(), name: 'Boost', level: 1, type: 'ingame', count: 10, active: true,
			price: [{ price: 100, currency: 'AFIT', actifit_percent_cut: 10 }],
			benefits: { time_span: 7, time_unit: 'days' },
		}, over);
		const buy = (user, id, trx) => request(app).get('/buyGadget/' + user + '/' + id + '/1/' + trx + '/HIVE').set('X-Forwarded-For', ip());

		test('two concurrent buys with balance for one: exactly one succeeds, the other is refused', async () => {
			const p = gadget();
			await db.collection('products').insertOne(p);
			await setBal('alice', 150);
			const [a, b] = await Promise.all([buy('alice', p._id, 'trxA'), buy('alice', p._id, 'trxB')]);
			const bodies = [a.body, b.body];
			expect(bodies.filter((x) => x.status === 'Success')).toHaveLength(1);
			expect(bodies.find((x) => x.status === 'Success')).toEqual({ status: 'Success', user_tokens: 50 });
			expect(bodies.find((x) => x.status !== 'Success')).toEqual({ error: 'Account does not have enough AFIT funds' });
			expect(await bal('alice')).toBe(50);
			expect(await ledger({ user: 'alice', reward_activity: 'Buy Product' })).toHaveLength(1);
			expect(await db.collection('user_gadgets').countDocuments({ user: 'alice' })).toBe(1);
			expect((await db.collection('products').findOne({ _id: p._id })).count).toBe(9);
			expect(await db.collection('request_locks').countDocuments({})).toBe(0);
		});

		test('a product without benefits is refused before any AFIT is taken (and nothing crashes)', async () => {
			const p = gadget({ benefits: undefined });
			await db.collection('products').insertOne(p);
			await setBal('alice', 500);
			const r = await buy('alice', p._id, 'trxC');
			expect(r.body.error).toMatch(/no valid benefits/);
			expect(await bal('alice')).toBe(500);
			expect(await ledger({ user: 'alice' })).toHaveLength(0);
			// the app is still up
			expect((await request(app).get('/userSettings/nobody')).status).toBe(200);
		});

		test('a product that is not an in-game gadget, or has no valid price, is refused', async () => {
			const real = gadget({ type: 'real' });
			const free = gadget({ price: [{ price: -5, currency: 'AFIT' }] });
			await db.collection('products').insertMany([real, free]);
			await setBal('alice', 500);
			expect((await buy('alice', real._id, 'trxD')).body.error).toMatch(/not an in-game gadget/);
			expect((await buy('alice', free._id, 'trxE')).body.error).toMatch(/price is not valid/);
			expect(await bal('alice')).toBe(500);
			expect(await ledger({ user: 'alice' })).toHaveLength(0);
		});

		test('multi-gadget: the total is taken once; a balance short of the total buys nothing', async () => {
			const p1 = gadget({ price: [{ price: 40, currency: 'AFIT' }] });
			const p2 = gadget({ price: [{ price: 60, currency: 'AFIT' }] });
			await db.collection('products').insertMany([p1, p2]);
			await setBal('alice', 90);
			const multi = (trx) => request(app).get('/buyMultiGadget/alice/' + p1._id + '-' + p2._id + '/1/' + trx + '/HIVE').set('X-Forwarded-For', ip());
			expect((await multi('trxM1')).body).toEqual({ error: 'Account does not have enough AFIT funds' });
			expect(await bal('alice')).toBe(90);
			expect(await ledger({ user: 'alice' })).toHaveLength(0);
			await setBal('alice', 130);
			expect((await multi('trxM2')).body).toEqual({ status: 'Success', user_tokens: 30 });
			expect((await ledger({ user: 'alice' })).map((x) => x.token_count).sort()).toEqual([-40, -60]);
			expect(await db.collection('user_gadgets').countDocuments({ user: 'alice' })).toBe(2);
		});

		test('multi-gadget partial delivery: the undelivered items are refunded and reported', async () => {
			const p1 = gadget({ price: [{ price: 10, currency: 'AFIT' }] });
			const p2 = gadget({ price: [{ price: 20, currency: 'AFIT' }] });
			const p3 = gadget({ price: [{ price: 40, currency: 'AFIT' }] });
			await db.collection('products').insertMany([p1, p2, p3]);
			await setBal('alice', 100);
			// make the user_gadgets insert fail for item 2 (and only item 2)
			await db.collection('user_gadgets').createIndex({ gadget: 1 }, { unique: true, name: 'test_fail_item2' });
			await db.collection('user_gadgets').insertOne({ user: 'someone-else', gadget: p2._id });
			try {
				const r = await request(app).get('/buyMultiGadget/alice/' + p1._id + '-' + p2._id + '-' + p3._id + '/1/trxP/HIVE').set('X-Forwarded-For', ip());
				expect(r.body).toEqual({ error: 'Error performing buy action. DB storing issue', delivered: [String(p1._id)] });
				expect(await bal('alice')).toBe(90); // only item 1 charged
				const rows = await ledger({ user: 'alice' });
				expect(rows.map((x) => x.product_id)).toEqual([String(p1._id)]);
				expect(rows.map((x) => x.token_count)).toEqual([-10]);
				const owned = await db.collection('user_gadgets').find({ user: 'alice' }).toArray();
				expect(owned.map((g) => String(g.gadget))).toEqual([String(p1._id)]);
				expect(logSpy.mock.calls.some((c) => /PARTIALLY DELIVERED/.test(String(c[0])))).toBe(true);
			} finally {
				await db.collection('user_gadgets').dropIndex('test_fail_item2');
			}
		});

		test('multi-gadget: a stock-count update that throws mid-cart does not undo or hide the delivery', async () => {
			const { Collection } = jest.requireActual('mongodb');
			const p1 = gadget({ price: [{ price: 10, currency: 'AFIT' }], count: 5 });
			const p2 = gadget({ price: [{ price: 20, currency: 'AFIT' }], count: 5 });
			const p3 = gadget({ price: [{ price: 40, currency: 'AFIT' }], count: 5 });
			await db.collection('products').insertMany([p1, p2, p3]);
			await setBal('alice', 100);
			const realUpdateOne = Collection.prototype.updateOne;
			// the stock update of item 2 (and only item 2) throws, as a DB blip would
			const spy = jest.spyOn(Collection.prototype, 'updateOne').mockImplementation(function (filter, ...rest) {
				if (this.collectionName === 'products' && filter && String(filter._id) === String(p2._id)) {
					return Promise.reject(new Error('stock update exploded'));
				}
				return realUpdateOne.call(this, filter, ...rest);
			});
			try {
				const r = await request(app).get('/buyMultiGadget/alice/' + p1._id + '-' + p2._id + '-' + p3._id + '/1/trxStock/HIVE').set('X-Forwarded-For', ip());
				// every item was delivered, so this is a success: no error, nothing refunded
				expect(r.body).toEqual({ status: 'Success', user_tokens: 30 });
			} finally {
				spy.mockRestore();
			}
			expect(await bal('alice')).toBe(30);
			expect((await ledger({ user: 'alice' })).map((x) => x.token_count).sort((a, b) => a - b)).toEqual([-40, -20, -10]);
			const owned = await db.collection('user_gadgets').find({ user: 'alice' }).toArray();
			expect(owned.map((g) => String(g.gadget)).sort()).toEqual([p1, p2, p3].map((x) => String(x._id)).sort());
			const counts = Object.fromEntries((await db.collection('products').find({}).toArray()).map((x) => [String(x._id), x.count]));
			expect(counts).toEqual({ [String(p1._id)]: 4, [String(p2._id)]: 5, [String(p3._id)]: 4 });
			expect(await db.collection('request_locks').countDocuments({})).toBe(0);
		});

		test('multi-gadget: an unexpected error after a delivery still reports what was delivered', async () => {
			const afitBalance = require('../../afit_balance');
			const p1 = gadget({ price: [{ price: 10, currency: 'AFIT' }] });
			const p2 = gadget({ price: [{ price: 20, currency: 'AFIT' }] });
			await db.collection('products').insertMany([p1, p2]);
			await setBal('alice', 100);
			// item 2 cannot be stored, and the refund path then throws too
			await db.collection('user_gadgets').createIndex({ gadget: 1 }, { unique: true, name: 'test_fail_item2b' });
			await db.collection('user_gadgets').insertOne({ user: 'someone-else', gadget: p2._id });
			const restore = jest.spyOn(afitBalance, 'restoreAfit').mockImplementation(async () => { throw new Error('refund exploded'); });
			try {
				const r = await request(app).get('/buyMultiGadget/alice/' + p1._id + '-' + p2._id + '/1/trxBoom/HIVE').set('X-Forwarded-For', ip());
				expect(r.body).toEqual({ error: 'Error performing buy action', delivered: [String(p1._id)] });
				expect(logSpy.mock.calls.some((c) => /gadget buy FAILED after delivering/.test(String(c[0])))).toBe(true);
				expect(logSpy.mock.calls.some((c) => /REFUND FAILED \(manual fix needed\)/.test(String(c[0])))).toBe(true);
			} finally {
				restore.mockRestore();
				await db.collection('user_gadgets').dropIndex('test_fail_item2b');
			}
			expect(await db.collection('request_locks').countDocuments({})).toBe(0);
		});

		test('a refused buy does not consume the signed transaction (checks run before verification)', async () => {
			const bad = gadget({ benefits: { time_span: 'x' } });
			const p = gadget();
			await db.collection('products').insertMany([bad, p]);
			await setBal('alice', 50); // price 100
			expect((await buy('alice', bad._id, 'trxQ')).body.error).toMatch(/no valid benefits/);
			expect((await buy('alice', p._id, 'trxR')).body).toEqual({ error: 'Account does not have enough AFIT funds' });
			expect(utils.verifyGadgetTransaction).not.toHaveBeenCalled();
			// an unexpected (non ebook/real) type is logged, not refused
			const odd = gadget({ type: 'boost' });
			await db.collection('products').insertOne(odd);
			await setBal('alice', 500);
			expect((await buy('alice', odd._id, 'trxS')).body).toEqual({ status: 'Success', user_tokens: 400 });
			expect(utils.verifyGadgetTransaction).toHaveBeenCalledTimes(1);
		});

		test('an unverified transaction charges nothing', async () => {
			const p = gadget();
			await db.collection('products').insertOne(p);
			await setBal('alice', 500);
			utils.verifyGadgetTransaction = jest.fn(async () => false);
			expect((await buy('alice', p._id, 'trxF')).body).toEqual({ error: 'error verifying trx' });
			expect(await bal('alice')).toBe(500);
		});

		test('an exception inside the purchase answers {error} instead of crashing', async () => {
			const p = gadget();
			await db.collection('products').insertOne(p);
			await setBal('alice', 500);
			utils.verifyGadgetTransaction = jest.fn(async () => { throw new Error('rpc exploded'); });
			expect((await buy('alice', p._id, 'trxG')).body).toEqual({ error: 'Error performing buy action' });
			expect(await bal('alice')).toBe(500);
			expect(await db.collection('request_locks').countDocuments({})).toBe(0);
		});

		test('a gadget buy waits for a concurrent AFIT exchange of the same user, and they never overspend', async () => {
			const p = gadget({ price: [{ price: 50, currency: 'AFIT' }] });
			await db.collection('products').insertOne(p);
			// the exchange needs 10000 still held at its debit: whether both fit depends on the
			// order the lock hands them out; either way the balance must equal the ledger
			await setBal('alice', 10040);
			const [g, e] = await Promise.all([
				buy('alice', p._id, 'trxH'),
				request(app).post('/performAfitSteemExchange').set('X-Forwarded-For', ip()).set('x-acti-token', token).send({ user: 'alice', tokens: '50' }),
			]);
			const okCount = [g.body.status === 'Success', e.body.status === 'Success'].filter(Boolean).length;
			expect(okCount).toBeGreaterThanOrEqual(1);
			const after = await bal('alice');
			expect(after).toBe(10040 - 50 * okCount);
			expect(after).toBeGreaterThanOrEqual(0);
			const sum = (await ledger({ user: 'alice' })).reduce((s, x) => s + x.token_count, 0);
			expect(sum).toBe(-50 * okCount);
		});
	});

	test('workout buy: concurrent requests never overspend', async () => {
		await setBal('alice', 12); // the fee is 5: two fit, the third does not
		const results = await Promise.all(['w1', 'w2', 'w3'].map((trx) =>
			request(app).get('/generateWorkout/alice/1/' + trx + '/HIVE').set('X-Forwarded-For', ip()).set('x-acti-token', token)));
		const ok = results.filter((r) => r.body.status === 'Success');
		expect(ok).toHaveLength(2);
		expect(results.filter((r) => r.body.error === 'Account does not have enough AFIT funds')).toHaveLength(1);
		expect(await bal('alice')).toBe(2);
		expect(await ledger({ user: 'alice', reward_activity: 'Buy Workout' })).toHaveLength(2);
	});

	describe('deposits', () => {
		const deposit = { operation: 'tokens_transfer', from: 'alice', to: WALLET, symbol: 'AFIT', quantity: '25', transactionId: 'dep-1', timestamp: 1790000000 };
		const receipt = () => request(app).get('/confirmAFITSEReceipt?user=alice').set('X-Forwarded-For', ip()).set('x-acti-token', token);

		test('a receipt called twice (concurrently and again later) credits once', async () => {
			await setBal('alice', 10);
			utils.confirmSEAFITReceived = jest.fn(async () => Object.assign({}, deposit));
			const [a, b] = await Promise.all([receipt(), receipt()]);
			for (const r of [a, b]) expect(JSON.parse(r.text.trim())).toEqual({ afit_se_power: 'success', afit_amount: 0 });
			const again = await receipt();
			expect(JSON.parse(again.text.trim())).toEqual({ afit_se_power: 'success', afit_amount: 0 });
			expect(await bal('alice')).toBe(35);
			expect(await ledger({ user: 'alice', se_trx_ref: 'dep-1' })).toHaveLength(1);
		});

		test('the bulk job and a receipt racing for one deposit credit once; the bulk job awaits its credits', async () => {
			await setBal('alice', 0);
			const realFetch = global.fetch;
			global.fetch = jest.fn(async () => ({ json: async () => [
				Object.assign({}, deposit, { transactionId: 'dep-2' }),
				{ operation: 'tokens_transfer', from: 'bob', to: WALLET, symbol: 'AFIT', quantity: '7', transactionId: 'dep-3', timestamp: 1790000000 },
				{ operation: 'tokens_transfer', from: WALLET, to: 'carol', symbol: 'AFIT', quantity: '9', transactionId: 'dep-4', timestamp: 1790000000 }, // outgoing: skipped
				{ operation: 'tokens_transfer', from: 'dan', to: WALLET, symbol: 'OTHER', quantity: '1000', transactionId: 'dep-5', timestamp: 1790000000 }, // not AFIT: skipped
				{ operation: 'tokens_transfer', from: 'erin', to: WALLET, symbol: 'AFIT', quantity: 'NaN', transactionId: 'dep-6', timestamp: 1790000000 }, // bad amount: skipped
			] }));
			utils.confirmSEAFITReceived = jest.fn(async () => Object.assign({}, deposit, { transactionId: 'dep-2' }));
			try {
				const [bulk] = await Promise.all([
					request(app).get('/confirmAFITSEBulk').set('X-Forwarded-For', ip()).set('x-admin-token', ADMIN_TOKEN),
					receipt(),
				]);
				expect(JSON.parse(bulk.text)).toEqual({ status: 'done updating AFIT SE moves' });
				// awaited: by the time the bulk job answers, its credits are in
				expect(await bal('bob')).toBe(7);
				expect(await bal('alice')).toBe(25);
				expect(await ledger({ user: 'alice', se_trx_ref: 'dep-2' })).toHaveLength(1);
				for (const u of ['carol', 'dan', 'erin', WALLET]) expect(await bal(u)).toBeUndefined();
				// a second bulk run changes nothing
				await request(app).get('/confirmAFITSEBulk?token=' + ADMIN_TOKEN).set('X-Forwarded-For', ip());
				expect(await bal('bob')).toBe(7);
				expect(await bal('alice')).toBe(25);
			} finally {
				global.fetch = realFetch;
			}
		});
	});

	describe('deposit validation', () => {
		const receipt = () => request(app).get('/confirmAFITSEReceipt?user=alice').set('X-Forwarded-For', ip()).set('x-acti-token', token);
		const good = { operation: 'tokens_transfer', from: 'alice', to: WALLET, symbol: 'AFIT', quantity: '5', transactionId: 'ok-1', timestamp: 1790000000 };
		const bad = [
			['a stake to the receiving account', { operation: 'tokens_stake' }],
			['a delegation', { operation: 'tokens_delegate' }],
			['an entry with no operation', { operation: undefined }],
			['another token', { symbol: 'AFITX' }],
			['a transfer to another account', { to: 'someone.else' }],
			['a transfer by another user', { from: 'mallory' }],
			['an exponent quantity', { quantity: '1e6' }],
			['a hex quantity', { quantity: '0x10' }],
			['a padded quantity', { quantity: ' 5' }],
			['a negative quantity', { quantity: '-5' }],
			['a zero quantity', { quantity: '0' }],
			['too many decimals', { quantity: '1.123456789' }],
			['no transaction id', { transactionId: '' }],
		];

		test.each(bad)('the receipt route does not credit %s', async (_label, change) => {
			await setBal('alice', 1);
			utils.confirmSEAFITReceived = jest.fn(async () => Object.assign({}, good, change, { transactionId: change.transactionId === '' ? '' : 'bad-' + _label }));
			const r = await receipt();
			expect(r.text).toMatch(/Error adding AFIT tokens to user balance/);
			expect(await bal('alice')).toBe(1);
			expect(await ledger({ user: 'alice' })).toHaveLength(0);
		});

		test('the bulk job credits only the valid transfers in a mixed history', async () => {
			const realFetch = global.fetch;
			// (a transfer by another user is a valid deposit for THAT user, so it is left out here)
			const entries = bad.filter(([label]) => !/another user/.test(label)).map(([label, change], i) => Object.assign({}, good, { from: 'u' + i, transactionId: 'bulk-' + i }, change));
			entries.push(Object.assign({}, good, { from: 'valid', transactionId: 'bulk-valid', quantity: '12.12345678' }));
			global.fetch = jest.fn(async () => ({ json: async () => entries }));
			try {
				const r = await request(app).get('/confirmAFITSEBulk').set('X-Forwarded-For', ip()).set('x-admin-token', ADMIN_TOKEN);
				expect(JSON.parse(r.text)).toEqual({ status: 'done updating AFIT SE moves' });
			} finally {
				global.fetch = realFetch;
			}
			expect(await bal('valid')).toBe(12.12345678);
			const rows = await db.collection('token_transactions').find({}).toArray();
			expect(rows.map((x) => x.user)).toEqual(['valid']);
		});
	});

	describe('/recalculateUserTokens', () => {
		const recalc = () => request(app).get('/recalculateUserTokens?user=alice').set('X-Forwarded-For', ip()).set('x-acti-token', token);

		test('sets the balance to the exact ledger sum, negative included (no clamp to 0), keeping other fields', async () => {
			await db.collection('user_tokens').insertOne({ _id: 'alice', user: 'alice', tokens: 500, extra: 'kept' });
			await db.collection('token_transactions').insertMany([
				{ user: 'alice', token_count: 20 }, { user: 'alice', token_count: -50 }, { user: 'alice', token_count: NaN },
			]);
			const r = await recalc();
			expect(r.text).toBe('success recalculating & updating user token count: -30');
			expect(await db.collection('user_tokens').findOne({ _id: 'alice' })).toEqual({ _id: 'alice', user: 'alice', tokens: -30, extra: 'kept' });
		});

		test('another user\'s balance cannot be recalculated', async () => {
			await setBal('bob', 77);
			await db.collection('token_transactions').insertOne({ user: 'bob', token_count: 1 });
			const r = await request(app).get('/recalculateUserTokens?user=bob').set('X-Forwarded-For', ip()).set('x-acti-token', token);
			expect(r.body).toEqual({ error: 'User mismatch' });
			expect(await bal('bob')).toBe(77);
		});

		test('waits for the per-user AFIT lock, and reports busy rather than rebuilding mid-spend', async () => {
			await setBal('alice', 1);
			await db.collection('request_locks').insertOne({ _id: 'afit:alice', owner: 'someone-else', at: new Date() });
			const r = await recalc();
			expect(r.body).toEqual({ error: expect.stringMatching(/being processed/) });
			expect(await bal('alice')).toBe(1);
		}, 20000);
	});

	test('web rewards: concurrent requests record one reward per activity and day', async () => {
		const exists = utils.hiveAccountExists;
		const votes = utils.countActifitVotesToday;
		utils.hiveAccountExists = jest.fn(async () => true);
		utils.countActifitVotesToday = jest.fn(async () => 3);
		try {
			const results = await Promise.all([1, 2, 3, 4, 5].map(() =>
				request(app).get('/rewardActifitWebVote/alice?url=x&web_vote_token=vote-token').set('X-Forwarded-For', ip()).set('x-acti-token', token)));
			expect(results.filter((r) => r.body.rewarded === true)).toHaveLength(1);
			expect(await ledger({ user: 'alice', reward_activity: 'Web Vote' })).toHaveLength(1);
		} finally {
			utils.hiveAccountExists = exists;
			utils.countActifitVotesToday = votes;
		}
	});

	describe('admin-secret routes', () => {
		test('a missing or wrong token gets nothing; the header and the query parameter both work', async () => {
			const realFetch = global.fetch;
			global.fetch = jest.fn(async () => ({ json: async () => [] }));
			try {
				expect((await request(app).get('/confirmAFITSEBulk').set('X-Forwarded-For', ip())).body).toEqual({});
				expect((await request(app).get('/confirmAFITSEBulk?token=wrong').set('X-Forwarded-For', ip())).body).toEqual({});
				expect((await request(app).get('/confirmAFITSEBulk').set('x-admin-token', 'wrong').set('X-Forwarded-For', ip())).body).toEqual({});
				expect(global.fetch).not.toHaveBeenCalled();
				expect(JSON.parse((await request(app).get('/confirmAFITSEBulk').set('x-admin-token', ADMIN_TOKEN).set('X-Forwarded-For', ip())).text)).toEqual({ status: 'done updating AFIT SE moves' });
				expect(JSON.parse((await request(app).get('/confirmAFITSEBulk?token=' + ADMIN_TOKEN).set('X-Forwarded-For', ip())).text)).toEqual({ status: 'done updating AFIT SE moves' });
			} finally {
				global.fetch = realFetch;
			}
		});

		test('/refundPurchase and /cancelAFITBuy validate the amount and never go negative', async () => {
			const p = { _id: new ObjectId(), name: 'Shirt', type: 'real' };
			await db.collection('products').insertOne(p);
			await setBal('alice', 10);
			const q = (route, extra) => request(app).get(route + '?specPass=test-spec-pass&user=alice' + extra).set('X-Forwarded-For', ip());
			expect((await q('/refundPurchase', '&product_id=' + p._id + '&afit_paid=abc')).body).toEqual({ error: 'invalid user or AFIT amount' });
			expect((await q('/refundPurchase', '&product_id=' + p._id + '&afit_paid=-5')).body).toEqual({ error: 'invalid user or AFIT amount' });
			expect((await q('/refundPurchase', '&product_id=' + p._id + '&afit_paid=15')).body).toEqual({ status: 'success' });
			expect(await bal('alice')).toBe(25);
			expect((await q('/cancelAFITBuy', '&afit=100')).body).toEqual({ error: 'Account does not have enough AFIT funds' });
			expect(await bal('alice')).toBe(25);
			expect((await q('/cancelAFITBuy', '&afit=20')).body).toEqual({ status: 'success' });
			expect(await bal('alice')).toBe(5);
			expect((await ledger({ user: 'alice' })).map((x) => x.token_count).sort((a, b) => a - b)).toEqual([-20, 15]);
			// force=1: explicit ops claw-back may take the balance negative
			expect((await q('/cancelAFITBuy', '&afit=30&force=1')).body).toEqual({ status: 'success' });
			expect(await bal('alice')).toBe(-25);
			expect((await ledger({ user: 'alice', forced: true })).map((x) => x.token_count)).toEqual([-30]);
			expect((await request(app).get('/cancelAFITBuy?specPass=nope&user=alice&afit=1').set('X-Forwarded-For', ip())).body).toEqual({ error: 'error' });
		});

		test('/cancelOutdatedAfitSteemExchange refunds each overdue exchange exactly once', async () => {
			await setBal('alice', 0);
			const old = new Date(Date.now() - 400 * 24 * 3600 * 1000);
			await db.collection('exchange_afit_steem').insertMany([
				{ user: 'alice', paid_afit: 50, upvote_processed: false, date: old },
				{ user: 'alice', paid_afit: 'junk', upvote_processed: false, date: old },
			]);
			const run = () => request(app).get('/cancelOutdatedAfitSteemExchange?token=' + ADMIN_TOKEN).set('X-Forwarded-For', ip());
			const [a, b] = await Promise.all([run(), run()]);
			const counts = [a.body.trans_refunded_count, b.body.trans_refunded_count];
			expect(counts.reduce((s, n) => s + n, 0)).toBe(1);
			expect(await bal('alice')).toBe(50);
			expect(await ledger({ user: 'alice', reward_activity: 'Refund Exchange AFIT To Upvote' })).toHaveLength(1);
		});
	});

	test('a new user reads tokens as the same "x.xxx" string as everyone else', async () => {
		expect((await request(app).get('/user/brandnewuser')).body.tokens).toBe('0.000');
		await setBal('alice', 12.5);
		expect((await request(app).get('/user/alice')).body.tokens).toBe('12.500');
	});
});
