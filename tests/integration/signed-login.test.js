/**
 * Signed-challenge login and /loginAuth through the real app.js routes, against a real
 * MongoDB (set MONGO_TEST_URI). Chain reads are stubbed: account data via utils, and
 * account history via the dhive client.
 */

const path = require('path');

const MONGO_URI = process.env.MONGO_TEST_URI;
const DB_NAME = 'signed_login_test_' + Date.now();

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
let history = [];
jest.doMock('@hiveio/dhive', () => {
	const actual = jest.requireActual('@hiveio/dhive');
	return { ...actual, Client: jest.fn(() => ({ database: { call: jest.fn(async (m) => (m === 'get_account_history' ? history : null)) } })) };
});
jest.doMock('web3', () => { const W = jest.fn(() => ({ eth: { Contract: jest.fn(() => ({ methods: {} })), accounts: { wallet: { add: jest.fn(), create: jest.fn() } } }, utils: {} })); W.Web3 = W; return W; });
jest.doMock('sscjs', () => jest.fn(() => ({ find: jest.fn(() => Promise.resolve([])) })));

const dhive = jest.requireActual('@hiveio/dhive');
const sha256 = (t) => require('crypto').createHash('sha256').update(t).digest('hex');
const OLD = dhive.PrivateKey.fromSeed('signed-login-old');
const NEW = dhive.PrivateKey.fromSeed('signed-login-new');
const OTHER = dhive.PrivateKey.fromSeed('signed-login-other');
const pub = (k) => k.createPublic().toString();
const sign = (k, msg) => k.sign(dhive.cryptoUtils.sha256(Buffer.from(msg, 'utf8'))).toString();
const acct = (keys, threshold = 1, account_auths = []) => ({
	name: 'alice', posting: { weight_threshold: threshold, account_auths, key_auths: keys.map((k) => [pub(k), 1]) },
});
const FLAG_SINCE = new Date('2026-10-20T00:00:00Z');
const upd = (ts, keys) => [0, { timestamp: ts, op: ['account_update', { account: 'alice', posting: { key_auths: keys.map((k) => [pub(k), 1]) } }] }];

(MONGO_URI ? describe : describe.skip)('signed-challenge login (real app, real MongoDB)', () => {
	const request = require('supertest');
	const { MongoClient } = jest.requireActual('mongodb');
	let app, mc, db;
	const chain = {};

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
		utils.getAccountData = jest.fn(async (u) => ({ HIVE: chain[u] || null }));
		utils.validateAccountLogin = jest.fn(async (u, k) => {
			const a = chain[u];
			if (!a) return { result: false };
			let ok = false;
			try { ok = dhive.PrivateKey.fromString(k).createPublic().toString() === a.posting.key_auths[0][0]; } catch (e) {}
			return { result: ok, account: a };
		});
		mc = await MongoClient.connect(MONGO_URI);
		db = mc.db(DB_NAME);
		// wait until app.js has connected to MongoDB and answers a DB-backed route
		for (let i = 0; i < 60; i++) {
			const r = await request(app).get('/userSettings/nobody');
			if (r.status === 200) break;
			await new Promise((res) => origSetTimeout(res, 500));
		}
	}, 120000);
	afterAll(async () => {
		if (db) await db.dropDatabase();
		if (mc) await mc.close();
		await Promise.all(appClients.map((c) => c.close().catch(() => {})));
	});

	async function signedLogin(key, user = 'alice') {
		const ch = await request(app).post('/loginChallenge').send({ username: user });
		if (ch.status !== 200) return ch;
		return request(app).post('/loginVerify').send({ username: user, nonce: ch.body.nonce, signature: sign(key, ch.body.message), method: 'keychain' });
	}

	test('/loginAuth and /loginVerify both issue working sessions; stored keys are dropped, other fields kept', async () => {
		chain.alice = acct([OLD]);
		await db.collection('user_login_token').insertOne({ user: 'alice', token: 'x', ppkey: 'old', keeploggedin: true, custom: 1 });
		const r1 = await request(app).post('/loginAuth').send({ username: 'alice', ppkey: OLD.toString(), keeploggedin: 'yes', loginsource: 'web' });
		expect(r1.status).toBe(200);
		const row1 = await db.collection('user_login_token').findOne({ user: 'alice' });
		expect(row1).toMatchObject({ token_hash: sha256(r1.body.token), keeploggedin: 'yes', loginsrc: 'web', custom: 1 });
		expect(row1.token).toBeUndefined(); // only the hash is stored
		expect(row1.ppkey).toBeUndefined();

		const r2 = await signedLogin(OLD);
		expect(r2.status).toBe(200);
		const row2 = await db.collection('user_login_token').findOne({ user: 'alice' });
		expect(row2).toMatchObject({ token_hash: sha256(r2.body.token), loginsrc: 'signed-keychain' });
		expect(row2.token).toBeUndefined();
		// the session gets past checkHdrs into the handler (which reports this user has no links)
		const use = await request(app).get('/myFreeSignupLinks/').set('x-acti-token', r2.body.token);
		expect(use.status).toBe(200);
		expect(use.body).toEqual({ error: 'no current free signup links' });
		// a made-up token is stopped by checkHdrs
		const bad = await request(app).get('/myFreeSignupLinks/').set('x-acti-token', 'not-a-token');
		expect(bad.body).toMatchObject({ success: false, message: 'Token is not valid' });
	});

	test('session tokens are stored hashed: the stored value cannot be used as a session', async () => {
		chain.alice = acct([OLD]);
		const r = await request(app).post('/loginAuth').send({ username: 'alice', ppkey: OLD.toString() });
		const row = await db.collection('user_login_token').findOne({ user: 'alice' });
		expect(row.token_hash).toBe(sha256(r.body.token));
		const withHash = await request(app).get('/myFreeSignupLinks/').set('x-acti-token', row.token_hash);
		expect(withHash.body).toMatchObject({ success: false, message: 'Token is not valid' });
		const withToken = await request(app).get('/myFreeSignupLinks/').set('x-acti-token', r.body.token);
		expect(withToken.body).toEqual({ error: 'no current free signup links' });
	});

	test('a session row written before hashing (plaintext token) still works until it expires', async () => {
		const jwt = require('jsonwebtoken');
		const cfg = JSON.parse(jest.requireActual('fs').readFileSync(require('path').join(__dirname, '../test-config.json'), 'utf8'));
		const legacy = jwt.sign({ username: 'legacyuser' }, cfg.secret, { expiresIn: '24h' });
		await db.collection('user_login_token').insertOne({ user: 'legacyuser', token: legacy, lastlogin: new Date() });
		const use = await request(app).get('/myFreeSignupLinks/').set('x-acti-token', legacy);
		expect(use.body).toEqual({ error: 'no current free signup links' });
		// logout removes the legacy row too
		await request(app).get('/resetLogin').set('x-acti-token', legacy);
		expect(await db.collection('user_login_token').countDocuments({ user: 'legacyuser' })).toBe(0);
	});

	test('web rewards accept a valid session token but not an expired one, even if its row exists', async () => {
		const jwt = require('jsonwebtoken');
		const cfg = JSON.parse(jest.requireActual('fs').readFileSync(require('path').join(__dirname, '../test-config.json'), 'utf8'));
		const expired = jwt.sign({ username: 'rewarduser', exp: Math.floor(Date.now() / 1000) - 60 }, cfg.secret);
		await db.collection('user_login_token').insertOne({ user: 'rewarduser', token: expired, keeploggedin: true });
		const utils = require('../../utils');
		const exists = utils.hiveAccountExists;
		utils.hiveAccountExists = jest.fn(async () => true);
		const logs = [];
		const spy = jest.spyOn(console, 'log').mockImplementation((...a) => { logs.push(a.join(' ')); });
		try {
			await request(app).get('/rewardActifitWebVote/rewarduser?url=x').set('x-acti-token', expired);
			expect(logs).toContain('rewardActifitTokenWeb: invalid or expired session for user rewarduser');
			// a valid session gets past the token check
			chain.alice = acct([OLD]);
			const login = await request(app).post('/loginAuth').send({ username: 'alice', ppkey: OLD.toString() });
			logs.length = 0;
			await request(app).get('/rewardActifitWebVote/alice?url=x').set('x-acti-token', login.body.token);
			expect(logs.some((l) => l.startsWith('rewardActifitTokenWeb: invalid'))).toBe(false);
			// it went on to the next check (vote count), proving the token was accepted
			expect(logs.some((l) => l.startsWith('rewardActifitTokenWeb: insufficient actifit_vote ops for alice'))).toBe(true);
		} finally {
			spy.mockRestore();
			utils.hiveAccountExists = exists;
		}
	});

	test('the challenge message names actifit.io and the user', async () => {
		const ch = await request(app).post('/loginChallenge').send({ username: 'alice' });
		expect(ch.body.message).toBe('Log in to actifit.io\nuser: alice\nnonce: ' + ch.body.nonce);
	});

	test('flagged, key not changed: login works with a notice, flag kept', async () => {
		await db.collection('key_rotation_required').deleteMany({});
		await db.collection('key_rotation_required').insertOne({ user: 'alice', since: FLAG_SINCE });
		chain.alice = acct([OLD]);
		history = [upd('2026-01-01T00:00:00', [OLD])];
		const r = await signedLogin(OLD);
		expect(r.status).toBe(200);
		expect(r.body.security_notice.code).toBe('KEY_ROTATION_RECOMMENDED');
		expect((await db.collection('key_rotation_required').findOne({ user: 'alice' })).cleared_at).toBeUndefined();
	});

	test('flagged, new key added but old kept: notice, flag kept', async () => {
		chain.alice = acct([OLD, NEW]);
		history = [upd('2026-01-01T00:00:00', [OLD]), upd('2026-10-21T00:00:00', [OLD, NEW])];
		const r = await signedLogin(NEW);
		expect(r.status).toBe(200);
		expect(r.body.security_notice.code).toBe('KEY_ROTATION_RECOMMENDED');
		expect((await db.collection('key_rotation_required').findOne({ user: 'alice' })).cleared_at).toBeUndefined();
	});

	test('flagged, keys changed: old key refused; new key clears the flag and ends other sessions', async () => {
		await db.collection('user_login_token').insertOne({ user: 'alice', token: 'stale-other-row' });
		chain.alice = acct([NEW]);
		history = [upd('2026-01-01T00:00:00', [OLD]), upd('2026-10-21T00:00:00', [NEW])];
		expect((await signedLogin(OLD)).status).toBe(403);
		const r = await signedLogin(NEW);
		expect(r.status).toBe(200);
		expect(r.body.security_notice).toBeUndefined();
		expect((await db.collection('key_rotation_required').findOne({ user: 'alice' })).cleared_at).toBeInstanceOf(Date);
		const rows = await db.collection('user_login_token').find({ user: 'alice' }).toArray();
		expect(rows.map((x) => x.token_hash)).toEqual([sha256(r.body.token)]);
	});

	test('a key held through an app account authority (account_auths) cannot log in', async () => {
		chain.alice = acct([NEW], 1, [['peakd.app', 1]]);
		chain['peakd.app'] = acct([OTHER]);
		expect((await signedLogin(OTHER)).status).toBe(403);
	});

	test('malformed usernames are refused', async () => {
		for (const body of [{ username: 'ali:ce' }, { username: 'Alice' }, { username: ['alice'] }, { username: 'alice\nFAKE' }]) {
			expect((await request(app).post('/loginChallenge').send(body)).status).toBe(400);
		}
	});
});
