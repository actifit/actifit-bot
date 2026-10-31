/**
 * Routes removed with server-side signing, and the on-chain-verified ("Keychain")
 * confirmation routes that replace them, through the real app.js against a real MongoDB
 * (set MONGO_TEST_URI).
 *
 * utils.findVerifyTrx (the on-chain lookup) is stubbed: the stub records the transaction
 * in verified_tx the way the real one does after a chain match, so the rest of the path
 * (verifyGadgetTransaction / verifyWorkoutTransaction / verifyFriendTransaction and
 * claimVerifiedTx) runs for real.
 */

const path = require('path');

const MONGO_URI = process.env.MONGO_TEST_URI;
const DB_NAME = 'keychain_confirm_test_' + Date.now();

for (const m of ['node:fs', 'fs']) {
	jest.doMock(m, () => {
		const actual = jest.requireActual('fs');
		return {
			...actual,
			readFileSync: jest.fn((p, o) => {
				if (path.basename(p) !== 'config.json') return actual.readFileSync(p, o);
				const cfg = JSON.parse(actual.readFileSync(path.join(__dirname, '../test-config.json'), 'utf8'));
				Object.assign(cfg, { mongo_uri: MONGO_URI, mongo_local: MONGO_URI, db_name: DB_NAME, workoutGenerationFeesAFIT: 5 });
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
const KEY = dhive.PrivateKey.fromSeed('keychain-confirm-key');
const pub = (k) => k.createPublic().toString();

// a custom_json the user signed on the device, as the chain returns it
const signedOp = (user, json) => [['custom_json', { required_auths: [], required_posting_auths: [user], id: 'actifit', json: JSON.stringify(json) }]];
const chainTx = (trxID, operations) => ({
	transaction_id: trxID,
	ref_block_num: 1234,
	block_num: 99000000,
	expiration: new Date(Date.now() + 10 * 60 * 1000).toISOString().slice(0, 19),
	operations,
});

(MONGO_URI ? describe : describe.skip)('removed signing routes and Keychain confirmations (real app, real MongoDB)', () => {
	const request = require('supertest');
	const { MongoClient, ObjectId } = jest.requireActual('mongodb');
	let app, mc, db, utils, token, ipN = 0;
	const ip = () => '198.51.100.' + ((ipN++ % 250) + 1);
	const bal = async (u) => { const d = await db.collection('user_tokens').findOne({ _id: u }); return d ? d.tokens : undefined; };
	const setBal = (u, tokens) => db.collection('user_tokens').replaceOne({ _id: u }, { _id: u, user: u, tokens }, { upsert: true });
	// findVerifyTrx stand-in: "finds" the given transaction on chain and records it in
	// verified_tx exactly like storeVerifiedTrx does
	const chainHas = (tx) => {
		utils.findVerifyTrx = jest.fn(async (req) => {
			if (req.params.trxID !== tx.transaction_id) return false;
			await db.collection('verified_tx').insertOne({ tx_id: tx.transaction_id, ref_block_num: tx.ref_block_num, tx, chain: 'HIVE', date: new Date() });
			return tx;
		});
	};
	let logSpy;
	// findVerifyTrx polls the chain every 5s; the real-verification tests below let that
	// one interval run, fast, and keep every other background timer off
	let fastPoll = false;
	let realFindVerifyTrx;

	beforeAll(async () => {
		const origSetTimeout = global.setTimeout;
		jest.spyOn(global, 'setTimeout').mockImplementation((fn, d) => ((typeof d === 'number' && d > 20000) ? null : origSetTimeout(fn, d)));
		const origSetInterval = global.setInterval;
		jest.spyOn(global, 'setInterval').mockImplementation((fn, d) => ((fastPoll && d === 5000) ? origSetInterval(fn, 10) : null));
		const express = require('express');
		const listen = express.application.listen;
		express.application.listen = jest.fn(() => ({ setTimeout: jest.fn(), close: jest.fn() }));
		app = require('../../app');
		express.application.listen = listen;
		utils = require('../../utils');
		realFindVerifyTrx = utils.findVerifyTrx;
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
		for (const c of ['user_tokens', 'token_transactions', 'user_gadgets', 'verified_tx', 'consumed_tx', 'request_locks', 'user_requests', 'friends']) {
			await db.collection(c).deleteMany({});
		}
		utils.findVerifyTrx = jest.fn(async () => false);
	});
	afterEach(() => logSpy.mockRestore());

	describe('removed routes answer 404', () => {
		const removed = [
			['get', '/performTrx?user=alice'],
			['post', '/performTrxPost?user=alice'],
			['get', '/delegateRC?user=alice&delegatees=bob&max_rc=1'],
			['post', '/memoDecode?user=alice'],
			['get', '/claimRewards?user=alice'],
			['post', '/loginKeychain/'],
			['post', '/loginKeychainVerify'],
			['get', '/confirmBuyAction?from=alice'],
			['get', '/proceedAfitTransition?user=alice&amount=1&txid=x'],
			['get', '/proceedAfitxTransition?user=alice&amount=1&txid=x'],
			['get', '/processBuyOrderHive?user=alice&product_id=x'],
			['get', '/processTipRequest?trxId=x&blkNo=1'],
			['post', '/linkXAccount?user=alice'],
			['get', '/claimXEngagementReward?user=alice&tweetId=1'],
		];
		test.each(removed)('%s %s', async (method, url) => {
			const r = await request(app)[method](url).set('X-Forwarded-For', ip()).set('x-acti-token', token).send({ username: 'alice', operation: '[]' });
			expect(r.status).toBe(404);
		});

		test('the read-only latest X post route is kept', async () => {
			const r = await request(app).get('/latestXPost').set('X-Forwarded-For', ip());
			expect(r.status).toBe(200);
		});
	});

	describe('GET /activateGadgetKeychain', () => {
		const gadget = new ObjectId();
		const url = (trx, benefic) => '/activateGadgetKeychain/alice/' + gadget + '/' + trx + '/HIVE' + (benefic ? '/' + benefic : '')
			+ '?operation=' + encodeURIComponent(JSON.stringify(signedOp('alice', { transaction: 'activate-gadget', gadget: String(gadget) })));
		const status = async () => (await db.collection('user_gadgets').findOne({ user: 'alice', gadget })).status;
		beforeEach(() => db.collection('user_gadgets').insertOne({ user: 'alice', gadget, status: 'bought' }));

		test('activates the gadget once the signed transaction is confirmed on chain', async () => {
			chainHas(chainTx('act1', signedOp('alice', { transaction: 'activate-gadget', gadget: String(gadget) })));
			const r = await request(app).get(url('act1')).set('X-Forwarded-For', ip());
			expect(r.body).toEqual({ status: 'success' });
			expect(utils.findVerifyTrx).toHaveBeenCalledTimes(1);
			expect(utils.findVerifyTrx.mock.calls[0][0].params).toMatchObject({ user: 'alice', gadget: String(gadget), trxID: 'act1' });
			expect(await status()).toBe('active');
			// the transaction is consumed: replaying it activates nothing more
			expect(await db.collection('consumed_tx').findOne({ _id: 'act1' })).toMatchObject({ purpose: 'activate-gadget' });
		});

		test('a transaction not found on chain activates nothing', async () => {
			const r = await request(app).get(url('missing')).set('X-Forwarded-For', ip());
			expect(r.body).toEqual({ status: 'error' });
			expect(await status()).toBe('bought');
		});

		test('a findVerifyTrx error (e.g. already processed) activates nothing', async () => {
			utils.findVerifyTrx = jest.fn(async () => ({ error: 'trx already exists' }));
			const r = await request(app).get(url('dup')).set('X-Forwarded-For', ip());
			expect(r.body).toEqual({ status: 'error' });
			expect(await status()).toBe('bought');
		});

		test('a transaction signed by someone else, or for another action, activates nothing', async () => {
			chainHas(chainTx('act2', signedOp('mallory', { transaction: 'activate-gadget', gadget: String(gadget) })));
			expect((await request(app).get(url('act2')).set('X-Forwarded-For', ip())).body).toEqual({ status: 'error' });
			chainHas(chainTx('act3', signedOp('alice', { transaction: 'buy-gadget', gadget: String(gadget) })));
			expect((await request(app).get(url('act3')).set('X-Forwarded-For', ip())).body).toEqual({ status: 'error' });
			expect(await status()).toBe('bought');
		});

		test('the beneficiary must match the signed transaction, and cannot be the user', async () => {
			chainHas(chainTx('act4', signedOp('alice', { transaction: 'activate-gadget', gadget: String(gadget), benefic: 'bob' })));
			expect((await request(app).get(url('act4', 'carol')).set('X-Forwarded-For', ip())).body).toEqual({ status: 'error' });
			expect(await status()).toBe('bought');

			chainHas(chainTx('act5', signedOp('alice', { transaction: 'activate-gadget', gadget: String(gadget), benefic: 'alice' })));
			expect((await request(app).get(url('act5', 'alice')).set('X-Forwarded-For', ip())).body).toEqual({ error: 'User & friend cannot be the same account' });

			chainHas(chainTx('act6', signedOp('alice', { transaction: 'activate-gadget', gadget: String(gadget), benefic: 'bob' })));
			expect((await request(app).get(url('act6', 'bob')).set('X-Forwarded-For', ip())).body).toEqual({ status: 'success' });
			const row = await db.collection('user_gadgets').findOne({ user: 'alice', gadget });
			expect(row).toMatchObject({ status: 'active', benefic: 'bob' });
		});

		test('an exception during verification answers {error} instead of crashing', async () => {
			utils.findVerifyTrx = jest.fn(async () => { throw new Error('rpc exploded'); });
			const r = await request(app).get(url('boom')).set('X-Forwarded-For', ip());
			expect(r.body).toEqual({ error: 'Error activating gadget' });
		});
	});

	describe('GET /generateWorkoutKeychain', () => {
		const op = signedOp('alice', { transaction: 'generate-workout-wizard' });
		const url = (user, trx) => '/generateWorkoutKeychain/' + user + '/' + trx + '/HIVE?operation=' + encodeURIComponent(JSON.stringify(op));

		test('charges the fee once the signed transaction is confirmed on chain', async () => {
			await setBal('alice', 12);
			chainHas(chainTx('wk1', op));
			const r = await request(app).get(url('alice', 'wk1')).set('X-Forwarded-For', ip()).set('x-acti-token', token);
			expect(r.body.status).toBe('Success');
			expect(utils.findVerifyTrx).toHaveBeenCalledTimes(1);
			expect(await bal('alice')).toBe(7);
			expect(await db.collection('token_transactions').find({ user: 'alice', reward_activity: 'Buy Workout' }).toArray()).toHaveLength(1);
		});

		test('one signed transaction pays for one workout only', async () => {
			await setBal('alice', 12);
			chainHas(chainTx('wkR', op));
			const first = await request(app).get(url('alice', 'wkR')).set('X-Forwarded-For', ip()).set('x-acti-token', token);
			expect(first.body.status).toBe('Success');
			const again = await request(app).get(url('alice', 'wkR')).set('X-Forwarded-For', ip()).set('x-acti-token', token);
			expect(again.body.status).not.toBe('Success');
			expect(await bal('alice')).toBe(7);
		});

		test('a transaction not found on chain charges nothing', async () => {
			await setBal('alice', 12);
			const r = await request(app).get(url('alice', 'nope')).set('X-Forwarded-For', ip()).set('x-acti-token', token);
			expect(r.body).toEqual({ status: 'error' });
			expect(await bal('alice')).toBe(12);
		});

		test('a transaction for another action charges nothing', async () => {
			await setBal('alice', 12);
			chainHas(chainTx('wk2', signedOp('alice', { transaction: 'buy-gadget' })));
			const r = await request(app).get(url('alice', 'wk2')).set('X-Forwarded-For', ip()).set('x-acti-token', token);
			expect(r.body).toEqual({ error: 'error verifying trx' });
			expect(await bal('alice')).toBe(12);
		});

		test('needs a session, for the same user as the URL', async () => {
			await setBal('alice', 12);
			chainHas(chainTx('wk3', op));
			const noToken = await request(app).get(url('alice', 'wk3')).set('X-Forwarded-For', ip());
			expect(noToken.body.status).not.toBe('Success');
			const other = await request(app).get(url('bob', 'wk3')).set('X-Forwarded-For', ip()).set('x-acti-token', token);
			expect(other.body).toEqual({ error: 'User mismatch' });
			expect(utils.findVerifyTrx).not.toHaveBeenCalled();
			expect(await bal('alice')).toBe(12);
		});
	});

	describe('an account flagged to change its posting key', () => {
		const gadget = new ObjectId();
		const flagAlice = () => db.collection('key_rotation_required').insertOne({ user: 'alice', since: new Date('2026-10-21T19:00:00Z') });
		afterEach(() => db.collection('key_rotation_required').deleteMany({}));

		test('can still activate and deactivate its gadgets', async () => {
			await flagAlice();
			await db.collection('user_gadgets').insertOne({ user: 'alice', gadget, status: 'bought' });
			const act = signedOp('alice', { transaction: 'activate-gadget', gadget: String(gadget) });
			chainHas(chainTx('flagAct', act));
			const r = await request(app).get('/activateGadgetKeychain/alice/' + gadget + '/flagAct/HIVE?operation=' + encodeURIComponent(JSON.stringify(act)))
				.set('X-Forwarded-For', ip());
			expect(r.body).toEqual({ status: 'success' });
			expect((await db.collection('user_gadgets').findOne({ user: 'alice', gadget })).status).toBe('active');

			const deact = signedOp('alice', { transaction: 'deactivate-gadget', gadget: String(gadget) });
			chainHas(chainTx('flagDeact', deact));
			const d = await request(app).get('/deactivateGadgetKeychain/alice/' + gadget + '/flagDeact/HIVE?operation=' + encodeURIComponent(JSON.stringify(deact)))
				.set('X-Forwarded-For', ip());
			expect(d.body.status).toBe('success');
			expect((await db.collection('user_gadgets').findOne({ user: 'alice', gadget })).status).toBe('bought');
		});

		test('still cannot generate a workout', async () => {
			await flagAlice();
			await setBal('alice', 12);
			const op = signedOp('alice', { transaction: 'generate-workout-wizard' });
			chainHas(chainTx('flagWk', op));
			const r = await request(app).get('/generateWorkoutKeychain/alice/flagWk/HIVE?operation=' + encodeURIComponent(JSON.stringify(op)))
				.set('X-Forwarded-For', ip()).set('x-acti-token', token);
			expect(r.status).toBe(403);
			expect(r.body.code).toBe('KEY_ROTATION_REQUIRED');
			expect(await bal('alice')).toBe(12);
		});
	});

	describe('friend routes', () => {
		// userA signs and acts; the signed json names userB as the target
		const op = (signer, transaction, target) => signedOp(signer, { transaction, target });
		const url = (route, userA, userB, trx, ops) => '/' + route + '/' + userA + '/' + userB + '/1/' + trx + '/HIVE?operation=' + encodeURIComponent(JSON.stringify(ops));
		const call = (route, userA, userB, trx, ops) => request(app).get(url(route, userA, userB, trx, ops)).set('X-Forwarded-For', ip());
		const pending = (initiator, target) => db.collection('user_requests').findOne({ initiator, target, request: 'friendship' });
		const flag = (user) => db.collection('key_rotation_required').insertOne({ user, since: new Date('2026-10-21T19:00:00Z') });
		afterEach(() => db.collection('key_rotation_required').deleteMany({}));

		test('a signed friend request works once; replaying it on either route is refused', async () => {
			const ops = op('alice', 'add-friend-request', 'bob');
			chainHas(chainTx('fr1', ops));
			expect((await call('addFriendHiveKeychain', 'alice', 'bob', 'fr1', ops)).body).toEqual({ status: 'success' });
			expect(await pending('alice', 'bob')).toMatchObject({ status: 'pending' });
			expect(await db.collection('consumed_tx').findOne({ _id: 'fr1' })).toMatchObject({ purpose: 'add-friend-request' });

			// the transaction stays recorded in verified_tx, but it authorises one action only
			utils.findVerifyTrx = jest.fn(async () => chainTx('fr1', ops));
			expect((await call('addFriendHiveKeychain', 'alice', 'bob', 'fr1', ops)).body).toEqual({ status: 'error' });
			expect((await call('addFriend', 'alice', 'bob', 'fr1', ops)).body).toEqual({ status: 'error' });
			expect(await db.collection('user_requests').countDocuments({})).toBe(1);
		});

		test('the acting user must be the signer, for the named target and action', async () => {
			const bySomeoneElse = op('mallory', 'add-friend-request', 'bob');
			chainHas(chainTx('fr2', bySomeoneElse));
			expect((await call('addFriendHiveKeychain', 'alice', 'bob', 'fr2', bySomeoneElse)).body).toEqual({ status: 'error' });
			const otherTarget = op('alice', 'add-friend-request', 'carol');
			chainHas(chainTx('fr3', otherTarget));
			expect((await call('addFriendHiveKeychain', 'alice', 'bob', 'fr3', otherTarget)).body).toEqual({ status: 'error' });
			const otherAction = op('alice', 'cancel-friendship', 'bob');
			chainHas(chainTx('fr4', otherAction));
			expect((await call('addFriendHiveKeychain', 'alice', 'bob', 'fr4', otherAction)).body).toEqual({ status: 'error' });
			expect(await db.collection('user_requests').countDocuments({})).toBe(0);
			expect(await db.collection('consumed_tx').countDocuments({})).toBe(0);
		});

		test('accept is signed by the accepting user (userA); a transaction signed by the requester does not act for them', async () => {
			await db.collection('user_requests').insertOne({ initiator: 'alice', target: 'bob', request: 'friendship', status: 'pending', date: new Date() });
			// bob accepts alice's request
			const accept = op('bob', 'accept-friendship', 'alice');
			chainHas(chainTx('fa1', accept));
			expect((await call('acceptFriendHiveKeychain', 'bob', 'alice', 'fa1', accept)).body).toEqual({ status: 'success' });
			expect(await pending('alice', 'bob')).toMatchObject({ status: 'approved' });
			expect(await db.collection('friends').countDocuments({})).toBe(1);
			// replayed: no second friendship row
			utils.findVerifyTrx = jest.fn(async () => chainTx('fa1', accept));
			expect((await call('acceptFriendHiveKeychain', 'bob', 'alice', 'fa1', accept)).body.status).toBe('error');
			expect(await db.collection('friends').countDocuments({})).toBe(1);
			// a transaction signed by alice cannot accept as bob
			const forged = op('alice', 'accept-friendship', 'alice');
			chainHas(chainTx('fa2', forged));
			expect((await call('acceptFriendHiveKeychain', 'bob', 'alice', 'fa2', forged)).body.status).toBe('error');
			expect(await db.collection('friends').countDocuments({})).toBe(1);
		});

		test('the sender of a request cannot accept it themselves', async () => {
			await db.collection('user_requests').insertOne({ initiator: 'alice', target: 'bob', request: 'friendship', status: 'pending', date: new Date() });
			// alice signs an acceptance of her own request to bob
			const self = op('alice', 'accept-friendship', 'bob');
			chainHas(chainTx('fs1', self));
			expect((await call('acceptFriendHiveKeychain', 'alice', 'bob', 'fs1', self)).body.status).toBe('error');
			expect(await pending('alice', 'bob')).toMatchObject({ status: 'pending' });
			expect(await db.collection('friends').countDocuments({})).toBe(0);
		});

		test('a cancelled request cannot be accepted', async () => {
			await db.collection('user_requests').insertOne({ initiator: 'alice', target: 'bob', request: 'friendship', status: 'cancelled', date: new Date() });
			const accept = op('bob', 'accept-friendship', 'alice');
			chainHas(chainTx('fc1', accept));
			expect((await call('acceptFriendHiveKeychain', 'bob', 'alice', 'fc1', accept)).body.status).toBe('error');
			expect(await db.collection('friends').countDocuments({})).toBe(0);
		});

		test('cancel and drop work once each', async () => {
			await db.collection('user_requests').insertOne({ initiator: 'alice', target: 'bob', request: 'friendship', status: 'pending', date: new Date() });
			const cancel = op('alice', 'cancel-friend-request', 'bob');
			chainHas(chainTx('fc1', cancel));
			expect((await call('cancelFriendRequestHiveKeychain', 'alice', 'bob', 'fc1', cancel)).body).toEqual({ status: 'success' });
			expect(await pending('alice', 'bob')).toMatchObject({ status: 'cancelled' });

			await db.collection('friends').insertOne({ userA: 'bob', userB: 'alice', date: new Date() });
			const drop = op('alice', 'cancel-friendship', 'bob');
			chainHas(chainTx('fd1', drop));
			expect((await call('dropFriendshipHiveKeychain', 'alice', 'bob', 'fd1', drop)).body).toEqual({ status: 'success' });
			expect(await db.collection('friends').countDocuments({})).toBe(0);
			// replaying the drop on the non-Keychain route removes nothing
			await db.collection('friends').insertOne({ userA: 'bob', userB: 'alice', date: new Date() });
			expect((await call('dropFriendship', 'alice', 'bob', 'fd1', drop)).body).toEqual({ status: 'error' });
			expect(await db.collection('friends').countDocuments({})).toBe(1);
		});

		test.each([
			['addFriendHiveKeychain', 'add-friend-request'],
			['addFriend', 'add-friend-request'],
			['cancelFriendRequestHiveKeychain', 'cancel-friend-request'],
			['cancelFriendRequest', 'cancel-friend-request'],
			['acceptFriendHiveKeychain', 'accept-friendship'],
			['acceptFriend', 'accept-friendship'],
			['dropFriendshipHiveKeychain', 'cancel-friendship'],
			['dropFriendship', 'cancel-friendship'],
		])('a flagged acting user is refused on /%s', async (route, transaction) => {
			await flag('alice');
			const ops = op('alice', transaction, 'bob');
			chainHas(chainTx('flag-' + route, ops));
			const r = await call(route, 'alice', 'bob', 'flag-' + route, ops);
			expect(r.status).toBe(403);
			expect(r.body.code).toBe('KEY_ROTATION_REQUIRED');
			expect(utils.findVerifyTrx).not.toHaveBeenCalled();
			expect(await db.collection('consumed_tx').countDocuments({})).toBe(0);
		});

		test('the claim itself refuses a flagged signer (friend actions are not key-change exempt)', async () => {
			await flag('alice');
			const ops = op('alice', 'add-friend-request', 'bob');
			await db.collection('verified_tx').insertOne({ tx_id: 'fx1', tx: chainTx('fx1', ops), chain: 'HIVE', date: new Date() });
			expect(await utils.verifyFriendTransaction('alice', 'bob', 'add-friend-request', 1, 'fx1', 'HIVE', db)).toBe(false);
			expect(await db.collection('consumed_tx').countDocuments({})).toBe(0);
		});

		test('an unflagged acting user is unaffected, even when the target is flagged', async () => {
			await flag('bob');
			const ops = op('alice', 'add-friend-request', 'bob');
			chainHas(chainTx('fr5', ops));
			expect((await call('addFriendHiveKeychain', 'alice', 'bob', 'fr5', ops)).body).toEqual({ status: 'success' });
			expect(await pending('alice', 'bob')).toMatchObject({ status: 'pending' });
		});
	});

	describe('real findVerifyTrx (only the chain lookup is stubbed)', () => {
		const hive = require('@hiveio/hive-js');
		const gadget = new ObjectId();
		const actOp = signedOp('alice', { transaction: 'activate-gadget', gadget: String(gadget) });
		const wkOp = signedOp('alice', { transaction: 'generate-workout-wizard' });
		const q = (ops) => '?operation=' + encodeURIComponent(JSON.stringify(ops));
		const status = async () => (await db.collection('user_gadgets').findOne({ user: 'alice', gadget })).status;
		let txSpy;
		beforeEach(async () => {
			utils.findVerifyTrx = realFindVerifyTrx;
			fastPoll = true;
			await db.collection('user_gadgets').insertOne({ user: 'alice', gadget, status: 'bought' });
			// the chain knows exactly these transactions
			const onChain = {
				actR: chainTx('actR', actOp),
				wkR: chainTx('wkR', wkOp),
			};
			txSpy = jest.spyOn(hive.api, 'getTransactionAsync').mockImplementation(async (id) => onChain[id] || null);
		});
		afterEach(() => { fastPoll = false; txSpy.mockRestore(); });

		test('a missing ?operation is refused before any chain lookup', async () => {
			const r = await request(app).get('/activateGadgetKeychain/alice/' + gadget + '/actR/HIVE').set('X-Forwarded-For', ip());
			expect(r.body).toEqual({ status: 'error' });
			expect(txSpy).not.toHaveBeenCalled();
			expect(await status()).toBe('bought');
			expect(await db.collection('verified_tx').countDocuments({})).toBe(0);
		});

		test('an ?operation that does not match the chain transaction is refused', async () => {
			const forged = signedOp('alice', { transaction: 'activate-gadget', gadget: String(new ObjectId()) });
			const r = await request(app).get('/activateGadgetKeychain/alice/' + gadget + '/actR/HIVE' + q(forged)).set('X-Forwarded-For', ip());
			expect(r.body).toEqual({ status: 'error' });
			expect(txSpy).toHaveBeenCalled();
			expect(await status()).toBe('bought');
			expect(await db.collection('verified_tx').countDocuments({})).toBe(0);
		}, 20000);

		test('a gadget tx confirmed via /activateGadgetKeychain cannot be replayed on /activateGadget or the Keychain route', async () => {
			const ok = await request(app).get('/activateGadgetKeychain/alice/' + gadget + '/actR/HIVE' + q(actOp)).set('X-Forwarded-For', ip());
			expect(ok.body).toEqual({ status: 'success' });
			await db.collection('user_gadgets').updateOne({ user: 'alice', gadget }, { $set: { status: 'bought' } });
			const legacy = await request(app).get('/activateGadget/alice/' + gadget + '/1/actR/HIVE').set('X-Forwarded-For', ip());
			expect(legacy.body).toEqual({ status: 'error' });
			const again = await request(app).get('/activateGadgetKeychain/alice/' + gadget + '/actR/HIVE' + q(actOp)).set('X-Forwarded-For', ip());
			expect(again.body).toEqual({ status: 'error' });
			expect(await status()).toBe('bought');
		}, 20000);

		test('a workout tx confirmed via /generateWorkoutKeychain cannot be replayed on /generateWorkout', async () => {
			await setBal('alice', 20);
			const ok = await request(app).get('/generateWorkoutKeychain/alice/wkR/HIVE' + q(wkOp)).set('X-Forwarded-For', ip()).set('x-acti-token', token);
			expect(ok.body.status).toBe('Success');
			const legacy = await request(app).get('/generateWorkout/alice/1/wkR/HIVE').set('X-Forwarded-For', ip()).set('x-acti-token', token);
			expect(legacy.body).toEqual({ error: 'error verifying trx' });
			expect(await bal('alice')).toBe(15);
		}, 20000);
	});
});
