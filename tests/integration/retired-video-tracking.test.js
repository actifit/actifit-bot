/**
 * 3Speak's studio service is gone: /userAddedVid and /userVidNotifier tracked uploads there.
 * Both now answer 410 and never touch the database, so a leftover caller (an old app, a cron
 * job) can't write to it or wipe it. Runs the real app.js on the in-memory mock DB.
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
	origSetTimeout(done, 300);
});
beforeEach(() => { global.fetch = jest.fn(async () => ({ json: async () => [] })); });
afterAll(() => { global.fetch = realFetch; });

describe('retired 3Speak studio video tracking', () => {
	test.each([
		'/userAddedVid/alice/abc123/new',
		'/userAddedVid/alice/abc123',
		'/userVidNotifier',
		'/userVidNotifier?threshold=1',
	])('GET %s answers 410 without touching the database', async (url) => {
		const touched = () => mockDb.collection.mock.calls.filter((c) => c[0] === 'user_submitted_vid').length;
		const before = touched();
		const res = await request(app).get(url);
		expect(touched()).toBe(before);
		expect(res.status).toBe(410);
		expect(res.body).toEqual({ error: 'This endpoint has been retired' });
		expect(global.fetch).not.toHaveBeenCalled();
	});
});
