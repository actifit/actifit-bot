/**
 * The admin / cron routes must fail CLOSED when their shared secret is missing from config.
 * `req.query.token !== config.admin_ops_token` used to let every request through whenever
 * the key was absent (undefined === undefined). Runs the real app.js on the in-memory mock DB
 * with a config that has neither admin_ops_token nor specPass.
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
				delete cfg.admin_ops_token;
				delete cfg.specPass;
				for (const k of ['verifyPostToken', 'verifyNotifToken', 'prop_key', 'prodMintSecret']) delete cfg[k];
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
	origSetTimeout(done, 300);
});
beforeEach(() => { global.fetch = jest.fn(async () => ({ json: async () => [] })); });
afterAll(() => { global.fetch = realFetch; });

test.each([
	'/confirmAFITSEBulk',
	'/confirmAFITSEBulk?token=',
	'/confirmAFITSEBulk?token=undefined',
	'/cancelOutdatedAfitSteemExchange',
	'/sendAirdropResultsNotif',
])('%s answers {} and does nothing when admin_ops_token is not configured', async (route) => {
	const r = await request(app).get(route);
	expect(r.body).toEqual({});
	expect(global.fetch).not.toHaveBeenCalled();
	expect(mockDb.collection('exchange_afit_steem').find).not.toHaveBeenCalled();
});

test('an x-admin-token header does not help either', async () => {
	const r = await request(app).get('/confirmAFITSEBulk').set('x-admin-token', '');
	expect(r.body).toEqual({});
	expect(global.fetch).not.toHaveBeenCalled();
});

test.each(['/refundPurchase', '/cancelAFITBuy'])('%s is refused when specPass is not configured', async (route) => {
	const r = await request(app).get(route + '?user=alice&afit=5&afit_paid=5&product_id=x&specPass=');
	expect(r.body).toEqual({ error: 'error' });
	expect(mockDb.collection('token_transactions').__data()).toHaveLength(0);
});

test.each([
	['/appendVerifiedPost?author=a&permlink=p&json_metadata=%7B%7D', '{}'],
	['/appendVerifiedPost?author=a&permlink=p&json_metadata=%7B%7D&verifyParam=', '{}'],
	['/appendVerifiedPost?author=a&permlink=p&json_metadata=%7B%7D&verifyParam=undefined', '{}'],
	['/sendNotification?notifType=none&user=a', '{}'],
	['/sendNotification?notifType=none&user=a&verifyNotifParam=', '{}'],
	['/updateProposalNotified?author=a&permlink=p&secr=undefined', '{}'],
	['/mintProducts', '{"error":"error"}'],
	['/mintProducts?secret=', '{"error":"error"}'],
])('%s is refused when its secret is not configured', async (route, body) => {
	const r = await request(app).get(route);
	expect(r.text).toBe(body);
	expect(mockDb.collection('verified_posts').insertOne).not.toHaveBeenCalled();
	expect(mockDb.collection('products').updateMany).not.toHaveBeenCalled();
});
