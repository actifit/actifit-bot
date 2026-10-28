/**
 * Crash hardening in utils.js:
 *  - sendNotification must never reject (most callers fire it without awaiting it, and an
 *    unhandled rejection used to end the process);
 *  - confirmSEAFITReceived must stop its polling timer once it gives up (it used to keep
 *    firing every 5s forever after resolving null).
 * Config, Firebase and chain clients are mocked; no database or network is used.
 */

const path = require('path');

for (const m of ['node:fs', 'fs']) {
	jest.doMock(m, () => {
		const actual = jest.requireActual('fs');
		return {
			...actual,
			readFileSync: jest.fn((p, o) => {
				if (path.basename(p) !== 'config.json') return actual.readFileSync(p, o);
				const cfg = JSON.parse(actual.readFileSync(path.join(__dirname, 'test-config.json'), 'utf8'));
				cfg.hive_engine_trans_acct_his = 'https://history.example.invalid/accountHistory';
				return JSON.stringify(cfg);
			}),
		};
	});
}
jest.doMock('firebase-admin', () => ({ initializeApp: jest.fn(), credential: { cert: jest.fn() }, messaging: jest.fn(() => ({ sendEach: jest.fn(() => Promise.resolve({ successCount: 1, failureCount: 0 })) })) }));
jest.doMock('@hiveio/dhive', () => ({ Client: jest.fn(() => ({ database: {} })) }));
jest.doMock('dblurt', () => ({ Client: jest.fn(() => ({})) }));
jest.doMock('@hiveio/hive-js', () => ({ config: { set: jest.fn() }, api: { setOptions: jest.fn() }, broadcast: {} }));
jest.doMock('@blurtfoundation/blurtjs', () => ({ api: { setOptions: jest.fn() } }));
jest.doMock('sscjs', () => jest.fn(() => ({ find: jest.fn(() => Promise.resolve([])) })));

const utils = require('../utils');

describe('utils.sendNotification never rejects', () => {
	let logSpy;
	beforeEach(() => { logSpy = jest.spyOn(console, 'log').mockImplementation(() => {}); });
	afterEach(() => logSpy.mockRestore());

	test('settings lookup failure resolves false', async () => {
		const db = { collection: () => ({ findOne: () => Promise.reject(new Error('db down')) }) };
		await expect(utils.sendNotification(db, 'alice', 'actifit', 't', 'payment', 'd', 'u')).resolves.toBe(false);
	});

	test('a db.collection that throws synchronously resolves false', async () => {
		const db = { collection: () => { throw new Error('no connection'); } };
		await expect(utils.sendNotification(db, 'alice', 'actifit', 't', 'payment', 'd', 'u')).resolves.toBe(false);
	});

	test('an insert failure resolves false', async () => {
		const db = { collection: (n) => (n === 'user_settings'
			? { findOne: () => Promise.resolve(null) }
			: { insertOne: () => Promise.reject(new Error('write failed')) }) };
		await expect(utils.sendNotification(db, 'alice', 'actifit', 't', 'payment', 'd', 'u')).resolves.toBe(false);
	});
});

describe('utils.confirmSEAFITReceived stops polling when it gives up', () => {
	const realFetch = global.fetch;
	afterEach(() => { global.fetch = realFetch; jest.useRealTimers(); });

	test('resolves null after its attempts and leaves no timer behind', async () => {
		jest.useFakeTimers();
		const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
		global.fetch = jest.fn(() => Promise.resolve({ json: () => Promise.resolve([]) }));
		const p = utils.confirmSEAFITReceived('alice', 'HIVE');
		await jest.advanceTimersByTimeAsync(5000 * 16);
		await expect(p).resolves.toBeNull();
		expect(global.fetch).toHaveBeenCalledTimes(14);
		expect(jest.getTimerCount()).toBe(0);
		await jest.advanceTimersByTimeAsync(5000 * 10);
		expect(global.fetch).toHaveBeenCalledTimes(14); // nothing keeps polling
		logSpy.mockRestore();
	});

	test('a match resolves it and clears the timer', async () => {
		jest.useFakeTimers();
		const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
		global.fetch = jest.fn(() => Promise.resolve({ json: () => Promise.resolve([{ from: 'alice', transactionId: 't1', quantity: '5' }]) }));
		const p = utils.confirmSEAFITReceived('alice', 'HIVE');
		await jest.advanceTimersByTimeAsync(5000);
		await expect(p).resolves.toMatchObject({ transactionId: 't1' });
		expect(jest.getTimerCount()).toBe(0);
		logSpy.mockRestore();
	});
});
