/**
 * Posting-key rotation gate for flagged accounts (key_rotation.js).
 */

const { decideRotation, checkRotation, HISTORY_FILTER_LOW } = require('../key_rotation');

const SINCE = new Date('2026-01-10T12:00:00Z');
const OLD = 'STM_OLD_POSTING';
const NEW = 'STM_NEW_POSTING';
const EXTRA = 'STM_EXTRA_POSTING';

let idx = 0;
const entry = (timestamp, type, payload) => [++idx, { timestamp, op: [type, payload] }];
const posting = (...keys) => ({ posting: { weight_threshold: 1, account_auths: [], key_auths: keys.map((k) => [k, 1]) } });

const created = entry('2020-05-01T00:00:00', 'account_create', Object.assign({ new_account_name: 'u' }, posting(OLD)));

describe('decideRotation', () => {
	test('no posting change after the flag date -> refused', () => {
		expect(decideRotation([created], OLD, SINCE)).toEqual({ allowed: false, reason: 'not_rotated' });
	});

	test('posting key replaced after the flag date, logging in with the new key -> allowed', () => {
		const rotated = entry('2026-01-11T08:00:00', 'account_update', Object.assign({ account: 'u' }, posting(NEW)));
		expect(decideRotation([created, rotated], NEW, SINCE)).toEqual({ allowed: true, reason: 'rotated' });
	});

	test('posting authority changed but the old key was kept and used -> refused', () => {
		const added = entry('2026-01-11T08:00:00', 'account_update', Object.assign({ account: 'u' }, posting(OLD, EXTRA)));
		expect(decideRotation([created, added], OLD, SINCE)).toEqual({ allowed: false, reason: 'old_key' });
	});

	test('account_update that leaves posting untouched does not count as a rotation', () => {
		const memoOnly = entry('2026-01-11T08:00:00', 'account_update', { account: 'u', memo_key: 'STM_MEMO', json_metadata: '' });
		expect(decideRotation([created, memoOnly], OLD, SINCE)).toEqual({ allowed: false, reason: 'not_rotated' });
	});

	test('account_update2 with a new posting key counts', () => {
		const rotated = entry('2026-01-12T00:00:00', 'account_update2', Object.assign({ account: 'u' }, posting(NEW)));
		expect(decideRotation([created, rotated], NEW, SINCE).allowed).toBe(true);
	});

	test('the prior key set is the LATEST one at or before the flag date', () => {
		const earlier = entry('2024-03-01T00:00:00', 'account_update', Object.assign({ account: 'u' }, posting(NEW)));
		const backToOld = entry('2025-06-01T00:00:00', 'account_update', Object.assign({ account: 'u' }, posting(OLD)));
		const after = entry('2026-01-11T00:00:00', 'account_update', Object.assign({ account: 'u' }, posting(NEW)));
		// NEW was in use before 2025 but not at the flag date, so it is acceptable now
		expect(decideRotation([after, backToOld, created, earlier], NEW, SINCE).allowed).toBe(true);
	});

	test('a change exactly at the flag date belongs to the exposed key set', () => {
		const atSince = entry('2026-01-10T12:00:00', 'account_update', Object.assign({ account: 'u' }, posting(NEW)));
		expect(decideRotation([created, atSince], NEW, SINCE)).toEqual({ allowed: false, reason: 'not_rotated' });
	});

	test('rotated but no earlier key set in history -> refused (cannot verify)', () => {
		const rotated = entry('2026-01-11T08:00:00', 'account_update', Object.assign({ account: 'u' }, posting(NEW)));
		expect(decideRotation([rotated], NEW, SINCE)).toEqual({ allowed: false, reason: 'unknown_prior_keys' });
	});

	test('empty or malformed history -> refused', () => {
		expect(decideRotation([], NEW, SINCE).allowed).toBe(false);
		expect(decideRotation(null, NEW, SINCE).allowed).toBe(false);
		expect(decideRotation([[1, null], [2, { op: 'x' }]], NEW, SINCE).allowed).toBe(false);
	});

	test('unrelated operation types are ignored', () => {
		const vote = entry('2026-01-11T08:00:00', 'vote', Object.assign({ voter: 'u' }, posting(NEW)));
		expect(decideRotation([created, vote], NEW, SINCE).allowed).toBe(false);
	});
});

describe('checkRotation', () => {
	const clientReturning = (pages) => {
		const calls = [];
		return {
			calls,
			database: { call: jest.fn(async (method, params) => { calls.push(params); return pages.shift() || []; }) },
		};
	};

	test('queries filtered history and decides from it', async () => {
		const rotated = entry('2026-01-11T08:00:00', 'account_update', Object.assign({ account: 'u' }, posting(NEW)));
		const client = clientReturning([[created, rotated]]);
		await expect(checkRotation(client, 'u', NEW, SINCE)).resolves.toEqual({ allowed: true, reason: 'rotated' });
		expect(client.database.call).toHaveBeenCalledWith('get_account_history', ['u', -1, 1000, HISTORY_FILTER_LOW, 0]);
	});

	test('a chain error is reported as chain_error, never as allowed', async () => {
		const client = { database: { call: jest.fn(async () => { throw new Error('node down'); }) } };
		const log = jest.spyOn(console, 'log').mockImplementation(() => {});
		await expect(checkRotation(client, 'u', NEW, SINCE)).resolves.toEqual({ allowed: false, reason: 'chain_error' });
		log.mockRestore();
	});

	test('pages back until it reaches the key set in effect at the flag date', async () => {
		// a full page of post-flag changes, then the creation op on the next page
		const recent = [];
		for (let i = 1001; i <= 2000; i++) recent.push([i, { timestamp: '2026-01-11T00:00:00', op: ['account_update', Object.assign({ account: 'u' }, posting(NEW))] }]);
		const older = [[5, { timestamp: '2020-05-01T00:00:00', op: ['account_create', posting(OLD)] }]];
		const client = clientReturning([recent, older]);
		await expect(checkRotation(client, 'u', NEW, SINCE)).resolves.toEqual({ allowed: true, reason: 'rotated' });
		expect(client.calls[1]).toEqual(['u', 1000, 1000, HISTORY_FILTER_LOW, 0]);
	});

	test('filter covers exactly the posting-authority operations', () => {
		const bits = [9, 10, 23, 41, 43];
		expect(HISTORY_FILTER_LOW).toBe(bits.reduce((m, b) => m + Math.pow(2, b), 0));
	});
});
