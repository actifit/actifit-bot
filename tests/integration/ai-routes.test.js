/**
 * The Gemini routes (ai_proxy.js) never answer without a login session, so the server-held
 * key cannot be used by an anonymous caller. Runs the real app.js on the in-memory mock DB.
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

describe('AI routes need a login session', () => {
	test.each([
		['/ai/chat', { history: [{ role: 'user', text: 'hi' }] }],
		['/ai/workoutPlan', { request: { fitnessGoal: 'x' } }],
		['/ai/translate', { author: 'bob', permlink: 'p' }],
	])('POST %s without a token is refused and never reaches Google', async (url, body) => {
		const res = await request(app).post(url).send(body);
		expect(res.body).toEqual({ success: false, message: 'Auth token is not provided' });
		expect(global.fetch).not.toHaveBeenCalled();
	});

	test('a forged token is refused too', async () => {
		const res = await request(app).post('/ai/chat').set('x-acti-token', 'Bearer not-a-jwt').send({ history: [{ role: 'user', text: 'hi' }] });
		expect(res.body).toEqual({ success: false, message: 'Token is not valid' });
		expect(global.fetch).not.toHaveBeenCalled();
	});
});
