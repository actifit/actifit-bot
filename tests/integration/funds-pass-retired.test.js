/**
 * Funds passwords are retired. Through the real app.js routes against a real MongoDB (set
 * MONGO_TEST_URI): the old funds-password routes answer 410, and the routes that used a
 * funds password now act only for the account of the login session.
 */

const path = require('path');

const MONGO_URI = process.env.MONGO_TEST_URI;
const DB_NAME = 'funds_pass_retired_test_' + Date.now();

for (const m of ['node:fs', 'fs']) {
	jest.doMock(m, () => {
		const actual = jest.requireActual('fs');
		return {
			...actual,
			readFileSync: jest.fn((p, o) => {
				if (path.basename(p) !== 'config.json') return actual.readFileSync(p, o);
				const cfg = JSON.parse(actual.readFileSync(path.join(__dirname, '../test-config.json'), 'utf8'));
				Object.assign(cfg, { mongo_uri: MONGO_URI, mongo_local: MONGO_URI, db_name: DB_NAME });
				return JSON.stringify(cfg);
			}),
		};
	});
}
// Track the app's own MongoDB clients so the test can close them and exit cleanly.
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
jest.doMock('sscjs', () => jest.fn(() => ({ find: jest.fn(() => Promise.resolve([])) })));

const dhive = jest.requireActual('@hiveio/dhive');
const KEY = dhive.PrivateKey.fromSeed('funds-pass-retired-alice');
const pub = (k) => k.createPublic().toString();
const sign = (k, msg) => k.sign(dhive.cryptoUtils.sha256(Buffer.from(msg, 'utf8'))).toString();
const RETIRED = { error: 'Funds passwords have been retired. Your login session is used instead.', code: 'FUNDS_PASS_RETIRED' };

(MONGO_URI ? describe : describe.skip)('funds passwords retired (real app, real MongoDB)', () => {
	const request = require('supertest');
	const { MongoClient } = jest.requireActual('mongodb');
	let app, mc, db, token;
	let ip = 0;
	const nextIp = () => '203.0.113.' + (++ip); // the money routes allow 5 requests per 15 min per IP

	beforeAll(async () => {
		const origSetTimeout = global.setTimeout;
		jest.spyOn(global, 'setTimeout').mockImplementation((fn, d) => ((typeof d === 'number' && d > 20000) ? null : origSetTimeout(fn, d)));
		jest.spyOn(global, 'setInterval').mockImplementation(() => null);
		const express = require('express');
		const listen = express.application.listen;
		express.application.listen = jest.fn(() => ({ setTimeout: jest.fn(), close: jest.fn() }));
		app = require('../../app');
		express.application.listen = listen;
		const utils = require('../../utils');
		utils.getAccountData = jest.fn(async (u) => ({ HIVE: u === 'alice' ? { name: 'alice', posting: { weight_threshold: 1, account_auths: [], key_auths: [[pub(KEY), 1]] } } : null }));
		mc = await MongoClient.connect(MONGO_URI);
		db = mc.db(DB_NAME);
		// wait until app.js has connected to MongoDB and answers a DB-backed route
		for (let i = 0; i < 60; i++) {
			const r = await request(app).get('/userSettings/nobody');
			if (r.status === 200) break;
			await new Promise((res) => origSetTimeout(res, 500));
		}
		const ch = await request(app).post('/loginChallenge').send({ username: 'alice' });
		const login = await request(app).post('/loginVerify').send({ username: 'alice', nonce: ch.body.nonce, signature: sign(KEY, ch.body.message), method: 'keychain' });
		token = login.body.token;
		expect(token).toBeTruthy();
	}, 120000);
	afterAll(async () => {
		if (db) await db.dropDatabase();
		if (mc) await mc.close();
		await Promise.all(appClients.map((c) => c.close().catch(() => {})));
	});

	describe('retired routes', () => {
		test.each([
			['get', '/validatePassForDownload?user=alice&product_id=p1&pass=x'],
			['post', '/setUserFundsPass'],
			['get', '/confirmPaymentPasswordVerify?from=alice'],
			['get', '/userHasFundsPassSet/alice'],
			['get', '/resetFundsPass?user=alice'],
			['get', '/getUnverifiedFundsAccountList/'],
			['get', '/getFullFundsAccountList/'],
		])('%s %s answers 410 and leaves stored funds-password rows alone', async (method, url) => {
			await db.collection('account_funds_pass').deleteMany({});
			await db.collection('account_funds_pass').insertOne({ user: 'alice', pass: 'stored', passVerified: false });
			const r = await request(app)[method](url).set('x-acti-token', token).send({ pass: 'new-pass' });
			expect(r.status).toBe(410);
			expect(r.body).toEqual(RETIRED);
			const rows = await db.collection('account_funds_pass').find({}, { projection: { _id: 0 } }).toArray();
			expect(rows).toEqual([{ user: 'alice', pass: 'stored', passVerified: false }]);
		});
	});

	describe('/reissueDownloadToken', () => {
		beforeEach(async () => {
			await db.collection('user_product_key').deleteMany({});
			await db.collection('user_product_key').insertMany([
				{ user: 'alice', product_id: 'p1', access_token: 'alice-token', enabled: false, date: new Date() },
				{ user: 'bob', product_id: 'p2', access_token: 'bob-token', enabled: false, date: new Date() },
			]);
		});
		const reissue = (qs, tok = token) => {
			const r = request(app).get('/reissueDownloadToken' + qs).set('X-Forwarded-For', nextIp());
			return tok ? r.set('x-acti-token', tok) : r;
		};

		test('requires a session', async () => {
			const r = await reissue('?product_id=p1&user=alice', null);
			expect(r.body).toEqual({ success: false, message: 'Auth token is not provided' });
			expect((await db.collection('user_product_key').findOne({ user: 'alice' })).enabled).toBe(false);
		});

		test('returns the token for a product the session user bought, and re-enables it', async () => {
			const r = await reissue('?product_id=p1');
			expect(r.status).toBe(200);
			expect(r.body.success).toBe('success');
			// a NEW token: the old one stops working
			expect(r.body.access_token).toMatch(/^[0-9a-f]{48}$/);
			expect(r.body.access_token).not.toBe('alice-token');
			const row = await db.collection('user_product_key').findOne({ user: 'alice', product_id: 'p1' });
			expect(row.enabled).toBe(true);
			expect(row.last_updated).toBeInstanceOf(Date);
			expect(row.access_token).toBe(r.body.access_token);
		});

		test("refuses another user's product", async () => {
			const r = await reissue('?product_id=p2');
			expect(r.body).toEqual({ error: 'Access token record not found' });
			expect(JSON.stringify(r.body)).not.toContain('bob-token');
			expect((await db.collection('user_product_key').findOne({ user: 'bob' })).enabled).toBe(false);
		});

		test('a ?user= naming another account is refused', async () => {
			const r = await reissue('?product_id=p2&user=bob');
			expect(r.body).toEqual({ error: 'User mismatch' });
			expect((await db.collection('user_product_key').findOne({ user: 'bob' })).enabled).toBe(false);
		});

		test('product_id must be a non-empty string', async () => {
			for (const qs of ['', '?product_id=', '?product_id=%20', '?product_id=p1&product_id=p2']) {
				const r = await reissue(qs);
				expect(r.body).toEqual({ error: 'generic error' });
			}
			// an operator object is stopped earlier by the app-wide request sanitizer
			const op = await reissue('?product_id[$ne]=x');
			expect(op.body.error).toBeTruthy();
			expect(op.body.access_token).toBeUndefined();
			expect(await db.collection('user_product_key').countDocuments({ enabled: true })).toBe(0);
		});
	});

	describe('/cancelAFITMoveSE', () => {
		beforeEach(async () => {
			await db.collection('powering_down_he').deleteMany({});
			await db.collection('powering_down_he').insertMany([
				{ user: 'alice', daily_afit_transfer: 100, date: new Date() },
				{ user: 'bob', daily_afit_transfer: 200, date: new Date() },
			]);
		});
		const cancel = (body, tok = token) => {
			const r = request(app).post('/cancelAFITMoveSE').set('X-Forwarded-For', nextIp()).send(body);
			return tok ? r.set('x-acti-token', tok) : r;
		};
		const users = async () => (await db.collection('powering_down_he').find({}).toArray()).map((x) => x.user).sort();

		test('requires a session (a funds password alone does nothing)', async () => {
			const r = await cancel({ user: 'alice', fundsPass: 'whatever' }, null);
			expect(r.body).toEqual({ success: false, message: 'Auth token is not provided' });
			expect(await users()).toEqual(['alice', 'bob']);
		});

		test('a body.user naming another account is refused', async () => {
			const r = await cancel({ user: 'bob' });
			expect(r.body).toEqual({ error: 'User mismatch' });
			expect(await users()).toEqual(['alice', 'bob']);
		});

		test("cancels only the session user's power down", async () => {
			const r = await cancel({ user: 'alice' });
			expect(r.body).toEqual({ status: 'Success' });
			expect(await users()).toEqual(['bob']);
		});

		test('body.user is optional', async () => {
			const r = await cancel({});
			expect(r.body).toEqual({ status: 'Success' });
			expect(await users()).toEqual(['bob']);
		});
	});

	test('/modAction stays disabled for a logged-in account', async () => {
		const r = await request(app).post('/modAction').set('X-Forwarded-For', nextIp()).set('x-acti-token', token)
			.send({ targetAction: 'ban', banuser: 'bob', moderator: 'alice', fundsPass: 'x' });
		expect(r.status).toBe(503);
		expect(await db.collection('banned_accounts').countDocuments({})).toBe(0);
	});
});
