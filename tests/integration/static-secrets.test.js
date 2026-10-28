/**
 * Routes called by our own services with a static shared secret in the query string
 * (/appendVerifiedPost, /sendNotification: the post creator and the notifier;
 * /updateProposalNotified: the notifier; /mintProducts: ops). The secret is compared in
 * constant time and fails CLOSED. Callers keep passing it exactly as before. Runs the real
 * app.js on the in-memory mock DB with the secrets configured (test-config.json); the
 * missing-secret case is in admin-fail-closed.test.js.
 */

const path = require('path');
const { createMockDb } = require('../helpers/mock-db');

const mockDb = createMockDb();

for (const m of ['node:fs', 'fs']) {
	jest.doMock(m, () => {
		const actual = jest.requireActual('fs');
		return {
			...actual,
			readFileSync: jest.fn((p, o) => {
				if (path.basename(p) !== 'config.json') return actual.readFileSync(p, o);
				const cfg = JSON.parse(actual.readFileSync(path.join(__dirname, '../test-config.json'), 'utf8'));
				cfg.hive_engine_trans_acct_his = 'https://history.example.invalid/accountHistory';
				return JSON.stringify(cfg);
			}),
		};
	});
}
jest.doMock('firebase-admin', () => ({ initializeApp: jest.fn(), credential: { cert: jest.fn(() => 'mock-cert') }, messaging: jest.fn(() => ({})) }));
jest.doMock('mongodb', () => {
	const actual = jest.requireActual('mongodb');
	const MockMongoClient = jest.fn(() => ({ connect: jest.fn(() => Promise.resolve({ db: () => mockDb })) }));
	return { ...actual, MongoClient: MockMongoClient };
});
jest.doMock('dsteem', () => ({ Client: jest.fn(() => ({ api: { setOptions: jest.fn() }, broadcast: {}, database: {} })) }));
jest.doMock('@hiveio/dhive', () => ({ Client: jest.fn(() => ({})) }));
jest.doMock('dblurt', () => ({ Client: jest.fn(() => ({})) }));
jest.doMock('@hiveio/hive-js', () => ({ config: { set: jest.fn() }, api: { setOptions: jest.fn() }, broadcast: {} }));
jest.doMock('@blurtfoundation/blurtjs', () => ({ api: { setOptions: jest.fn() } }));
jest.doMock('web3', () => { const W = jest.fn(() => ({ eth: { Contract: jest.fn(() => ({ methods: {} })), accounts: { wallet: { add: jest.fn(), create: jest.fn() } } }, utils: {} })); W.Web3 = W; return W; });
jest.doMock('sscjs', () => jest.fn(() => ({ find: jest.fn(() => Promise.resolve([])) })));

const request = require('supertest');
let app;
const realFetch = global.fetch;

beforeAll((done) => {
	const origSetTimeout = global.setTimeout;
	jest.spyOn(global, 'setTimeout').mockImplementation((fn, d) => ((typeof d === 'number' && d > 5000) ? null : origSetTimeout(fn, d)));
	jest.spyOn(global, 'setInterval').mockImplementation(() => null);
	const express = require('express');
	const listen = express.application.listen;
	express.application.listen = jest.fn(() => ({ setTimeout: jest.fn(), close: jest.fn() }));
	app = require('../../app');
	express.application.listen = listen;
	origSetTimeout(done, 1000);
});
beforeEach(() => { global.fetch = jest.fn(async () => ({ json: async () => [] })); });
afterAll(() => { global.fetch = realFetch; });

const post = (q) => request(app).get('/appendVerifiedPost?author=alice&permlink=p1&json_metadata=%7B%7D' + q);
const notif = (q) => request(app).get('/sendNotification?notifType=none&user=alice' + q);
const mint = (q) => request(app).get('/mintProducts?minAmount=1' + q);
const prop = (q) => request(app).get('/updateProposalNotified?author=alice&permlink=p1' + q);

// test-config.json: verifyParam / verifyPostToken, verifyNotifParam / verifyNotifToken,
// prop_key; prodMintSecret is not in it, so /mintProducts is the missing-secret case here
const WRONG = ['', '=', '=wrong', '=test-post-tokeX', '=test-post-token%20', '[]=test-post-token'];

test('/appendVerifiedPost: the right secret stores the post; anything else stores nothing', async () => {
	for (const w of WRONG) {
		const r = await post('&verifyParam' + w);
		expect(r.text).toBe('{}');
	}
	// repeated parameter (an array) used to pass the loose != comparison
	expect((await post('&verifyParam=test-post-token&verifyParam=test-post-token')).text).toBe('{}');
	expect(mockDb.collection('verified_posts').insertOne).not.toHaveBeenCalled();
	expect((await post('&verifyParam=test-post-token')).text).toBe('{success}');
	expect(mockDb.collection('verified_posts').insertOne).toHaveBeenCalledTimes(1);
});

test('/sendNotification: only the right secret gets past the check', async () => {
	for (const w of ['', '=', '=wrong', '=test-notif-tokeX']) {
		expect((await notif('&verifyNotifParam' + w)).text).toBe('{}');
	}
	// past the check: an unknown notifType is then refused by the handler itself
	expect((await notif('&verifyNotifParam=test-notif-token')).text).toBe('{error: not supported}');
});

test('/updateProposalNotified: only the right secret gets past the check', async () => {
	expect((await prop('&secr=wrong')).body).toEqual({});
	expect((await prop('&secr=test-prop-ke')).body).toEqual({});
	expect((await prop('&secr=test-prop-key')).body).toEqual({ status: 'success' });
});

test('/mintProducts: with prodMintSecret not configured, nothing is minted (no secret, empty, or "undefined")', async () => {
	for (const q of ['', '&secret=', '&secret=undefined']) {
		expect((await mint(q)).body).toEqual({ error: 'error' });
	}
	expect(mockDb.collection('products').updateMany).not.toHaveBeenCalled();
});
