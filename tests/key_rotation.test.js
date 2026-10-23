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
		expect(decideRotation([created], 'u', OLD, SINCE)).toEqual({ allowed: false, reason: 'not_rotated' });
	});

	test('posting key replaced after the flag date, logging in with the new key -> allowed', () => {
		const rotated = entry('2026-01-11T08:00:00', 'account_update', Object.assign({ account: 'u' }, posting(NEW)));
		expect(decideRotation([created, rotated], 'u', NEW, SINCE)).toEqual({ allowed: true, reason: 'rotated' });
	});

	test('a new key added while the old key is kept -> refused, whichever key is listed first', () => {
		const added = entry('2026-01-11T08:00:00', 'account_update', Object.assign({ account: 'u' }, posting(NEW, OLD)));
		expect(decideRotation([created, added], 'u', [NEW, OLD], SINCE)).toEqual({ allowed: false, reason: 'old_key' });
		expect(decideRotation([created, added], 'u', [OLD, NEW], SINCE)).toEqual({ allowed: false, reason: 'old_key' });
	});

	test('posting authority changed but the old key was kept and used -> refused', () => {
		const added = entry('2026-01-11T08:00:00', 'account_update', Object.assign({ account: 'u' }, posting(OLD, EXTRA)));
		expect(decideRotation([created, added], 'u', OLD, SINCE)).toEqual({ allowed: false, reason: 'old_key' });
	});

	test('account_update that leaves posting untouched does not count as a rotation', () => {
		const memoOnly = entry('2026-01-11T08:00:00', 'account_update', { account: 'u', memo_key: 'STM_MEMO', json_metadata: '' });
		expect(decideRotation([created, memoOnly], 'u', OLD, SINCE)).toEqual({ allowed: false, reason: 'not_rotated' });
	});

	test('account_update2 with a new posting key counts', () => {
		const rotated = entry('2026-01-12T00:00:00', 'account_update2', Object.assign({ account: 'u' }, posting(NEW)));
		expect(decideRotation([created, rotated], 'u', NEW, SINCE).allowed).toBe(true);
	});

	test('the prior key set is the LATEST one at or before the flag date', () => {
		const earlier = entry('2024-03-01T00:00:00', 'account_update', Object.assign({ account: 'u' }, posting(NEW)));
		const backToOld = entry('2025-06-01T00:00:00', 'account_update', Object.assign({ account: 'u' }, posting(OLD)));
		const after = entry('2026-01-11T00:00:00', 'account_update', Object.assign({ account: 'u' }, posting(NEW)));
		// NEW was in use before 2025 but not at the flag date, so it is acceptable now
		expect(decideRotation([after, backToOld, created, earlier], 'u', NEW, SINCE).allowed).toBe(true);
	});

	test('a change exactly at the flag date belongs to the exposed key set', () => {
		const atSince = entry('2026-01-10T12:00:00', 'account_update', Object.assign({ account: 'u' }, posting(NEW)));
		expect(decideRotation([created, atSince], 'u', NEW, SINCE)).toEqual({ allowed: false, reason: 'not_rotated' });
	});

	test('rotated but no earlier key set in history -> refused (cannot verify)', () => {
		const rotated = entry('2026-01-11T08:00:00', 'account_update', Object.assign({ account: 'u' }, posting(NEW)));
		expect(decideRotation([rotated], 'u', NEW, SINCE)).toEqual({ allowed: false, reason: 'unknown_prior_keys' });
	});

	test('empty or malformed history -> refused', () => {
		expect(decideRotation([], 'u', NEW, SINCE).allowed).toBe(false);
		expect(decideRotation(null, 'u', NEW, SINCE).allowed).toBe(false);
		expect(decideRotation([[1, null], [2, { op: 'x' }]], 'u', NEW, SINCE).allowed).toBe(false);
	});

	test('accounts the user created for others never count as own key changes', () => {
		const createdFor = (ts, name, key) => entry(ts, 'create_claimed_account', Object.assign({ creator: 'u', new_account_name: name }, posting(key)));
		// foreign creations on both sides of the flag date, the user's own key never changed
		const history = [created, createdFor('2025-12-01T00:00:00', 'friend1', 'STM_FRIEND1'), createdFor('2026-01-11T00:00:00', 'friend2', 'STM_FRIEND2')];
		expect(decideRotation(history, 'u', OLD, SINCE)).toEqual({ allowed: false, reason: 'not_rotated' });
		// and after a genuine rotation the user's own pre-flag key set is still the baseline
		const rotated = entry('2026-01-12T00:00:00', 'account_update', Object.assign({ account: 'u' }, posting(NEW)));
		expect(decideRotation(history.concat([rotated]), 'u', NEW, SINCE).allowed).toBe(true);
		expect(decideRotation(history.concat([rotated]), 'u', OLD, SINCE).allowed).toBe(false);
	});

	test('an update to another account is ignored', () => {
		const other = entry('2026-01-11T08:00:00', 'account_update', Object.assign({ account: 'someone' }, posting(NEW)));
		expect(decideRotation([created, other], 'u', NEW, SINCE).allowed).toBe(false);
	});

	test('unrelated operation types are ignored', () => {
		const vote = entry('2026-01-11T08:00:00', 'vote', Object.assign({ voter: 'u' }, posting(NEW)));
		expect(decideRotation([created, vote], 'u', NEW, SINCE).allowed).toBe(false);
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
		const older = [[5, { timestamp: '2020-05-01T00:00:00', op: ['account_create', Object.assign({ new_account_name: 'u' }, posting(OLD))] }]];
		const client = clientReturning([recent, older]);
		await expect(checkRotation(client, 'u', NEW, SINCE)).resolves.toEqual({ allowed: true, reason: 'rotated' });
		expect(client.calls[1]).toEqual(['u', 1000, 1000, HISTORY_FILTER_LOW, 0]);
	});

	test('paging does not stop at a foreign creation before reaching the user key set', async () => {
		const recent = [];
		for (let i = 1001; i <= 2000; i++) {
			const ts = i === 1001 ? '2025-12-01T00:00:00' : '2026-01-11T00:00:00';
			const op = i === 2000
				? ['account_update', Object.assign({ account: 'u' }, posting(NEW))]
				: ['create_claimed_account', Object.assign({ creator: 'u', new_account_name: 'f' + i }, posting('STM_F' + i))];
			recent.push([i, { timestamp: ts, op }]);
		}
		const older = [[5, { timestamp: '2020-05-01T00:00:00', op: ['account_create', Object.assign({ new_account_name: 'u' }, posting(OLD))] }]];
		const client = clientReturning([recent, older]);
		await expect(checkRotation(client, 'u', NEW, SINCE)).resolves.toEqual({ allowed: true, reason: 'rotated' });
		expect(client.calls.length).toBe(2);
	});

	test('a node that never answers fails closed after the deadline', async () => {
		jest.useFakeTimers();
		const log = jest.spyOn(console, 'log').mockImplementation(() => {});
		const client = { database: { call: jest.fn(() => new Promise(() => {})) } };
		const pending = checkRotation(client, 'u', NEW, SINCE);
		jest.advanceTimersByTime(15000);
		await expect(pending).resolves.toEqual({ allowed: false, reason: 'chain_error' });
		log.mockRestore();
		jest.useRealTimers();
	});

	test('filter covers exactly the posting-authority operations', () => {
		const bits = [9, 10, 23, 41, 43];
		expect(HISTORY_FILTER_LOW).toBe(bits.reduce((m, b) => m + Math.pow(2, b), 0));
	});
});

describe('createTracker', () => {
	const { createTracker } = require('../key_rotation');
	const account = { posting: { key_auths: [[NEW, 1]] } };

	const setup = ({ flag = { user: 'u', since: SINCE }, check = async () => ({ allowed: false, reason: 'not_rotated' }), acct = account, now } = {}) => {
		const col = {
			findOne: jest.fn(async () => flag),
			deleteOne: jest.fn(async () => ({ deletedCount: 1 })),
		};
		const deps = {
			getCollection: () => col,
			getAccount: jest.fn(async () => acct),
			checkRotation: jest.fn(check),
			endSessions: jest.fn(async () => {}),
		};
		if (now) deps.now = now;
		return { col, deps, tracker: createTracker(deps) };
	};
	const mockRes = () => ({ statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } });
	const runGate = async (mw, req) => {
		const res = mockRes();
		const next = jest.fn();
		await mw(req, res, next);
		return { res, next };
	};
	const sessionReq = (user = 'u') => ({ user: { _id: user } });
	let log;
	beforeEach(() => { log = jest.spyOn(console, 'log').mockImplementation(() => {}); });
	afterEach(() => log.mockRestore());

	test('unflagged account: no chain call, gate passes', async () => {
		const { deps, tracker } = setup({ flag: null });
		await expect(tracker.status('u')).resolves.toEqual({ flagged: false });
		const { next } = await runGate(tracker.gate, sessionReq());
		expect(next).toHaveBeenCalled();
		expect(deps.checkRotation).not.toHaveBeenCalled();
	});

	test('flagged and not rotated: gate answers 403 KEY_ROTATION_REQUIRED', async () => {
		const { tracker } = setup();
		const { res, next } = await runGate(tracker.gate, sessionReq());
		expect(next).not.toHaveBeenCalled();
		expect(res.statusCode).toBe(403);
		expect(res.body.code).toBe('KEY_ROTATION_REQUIRED');
		expect(res.body.error).toBe(res.body.message);
	});

	test('rotated: status reports it without clearing; clear() removes the flag', async () => {
		const { col, deps, tracker } = setup({ check: async () => ({ allowed: true, reason: 'rotated' }) });
		await expect(tracker.status('u', account, { fresh: true })).resolves.toEqual({ flagged: true, rotated: true });
		expect(col.deleteOne).not.toHaveBeenCalled();
		expect(deps.checkRotation).toHaveBeenCalledWith('u', [NEW], SINCE);
		await tracker.clear('u');
		expect(col.deleteOne).toHaveBeenCalledWith({ user: 'u' });
	});

	test('fresh (login) skips a cached not-rotated answer', async () => {
		let rotated = false;
		const { deps, tracker } = setup({ check: async () => (rotated ? { allowed: true, reason: 'rotated' } : { allowed: false, reason: 'not_rotated' }) });
		await tracker.status('u');
		rotated = true;
		await expect(tracker.status('u')).resolves.toMatchObject({ rotated: false });
		await expect(tracker.status('u', account, { fresh: true })).resolves.toEqual({ flagged: true, rotated: true });
		expect(deps.checkRotation).toHaveBeenCalledTimes(2);
	});

	test('all current posting keys are checked, not only the first', async () => {
		const { deps, tracker } = setup();
		await tracker.status('u', { posting: { key_auths: [[NEW, 1], [OLD, 1]] } });
		expect(deps.checkRotation).toHaveBeenCalledWith('u', [NEW, OLD], SINCE);
	});

	test('rotated, seen by the gate on an existing session: sessions ended, 401, flag kept', async () => {
		const { col, deps, tracker } = setup({ check: async () => ({ allowed: true, reason: 'rotated' }) });
		const { res, next } = await runGate(tracker.gate, sessionReq());
		expect(next).not.toHaveBeenCalled();
		expect(res.statusCode).toBe(401);
		expect(res.body.code).toBe('LOGIN_AGAIN');
		expect(deps.endSessions).toHaveBeenCalledWith('u');
		expect(col.deleteOne).not.toHaveBeenCalled();
	});

	test('the account passed at login is used instead of a fresh lookup', async () => {
		const { deps, tracker } = setup();
		await tracker.status('u', { posting: { key_auths: [[OLD, 1]] } });
		expect(deps.getAccount).not.toHaveBeenCalled();
		expect(deps.checkRotation).toHaveBeenCalledWith('u', [OLD], SINCE);
	});

	test('chain error: gate answers 503 TRY_AGAIN; retried after 30 seconds, not before', async () => {
		let t = 0;
		const { deps, tracker } = setup({ check: async () => ({ allowed: false, reason: 'chain_error' }), now: () => t });
		const { res } = await runGate(tracker.gate, sessionReq());
		expect(res.statusCode).toBe(503);
		expect(res.body.code).toBe('TRY_AGAIN');
		t = 20 * 1000; await runGate(tracker.gate, sessionReq());
		expect(deps.checkRotation).toHaveBeenCalledTimes(1);
		t = 31 * 1000; await runGate(tracker.gate, sessionReq());
		expect(deps.checkRotation).toHaveBeenCalledTimes(2);
	});

	test('concurrent checks for the same user share one chain walk', async () => {
		let release;
		const { deps, tracker } = setup({ check: () => new Promise((r) => { release = () => r({ allowed: false, reason: 'not_rotated' }); }) });
		const a = tracker.status('u');
		const b = tracker.status('u');
		await new Promise((r) => setImmediate(r));
		release();
		await Promise.all([a, b]);
		expect(deps.checkRotation).toHaveBeenCalledTimes(1);
	});

	test('account lookup failure fails closed', async () => {
		const { tracker } = setup({ acct: null });
		const { res, next } = await runGate(tracker.gate, sessionReq());
		expect(next).not.toHaveBeenCalled();
		expect(res.statusCode).toBe(503);
	});

	test('a throwing dependency fails closed', async () => {
		const col = { findOne: jest.fn(async () => { throw new Error('db down'); }) };
		const tracker = createTracker({ getCollection: () => col, getAccount: async () => account, checkRotation: jest.fn(), endSessions: jest.fn() });
		const { res, next } = await runGate(tracker.gate, sessionReq());
		expect(next).not.toHaveBeenCalled();
		expect(res.statusCode).toBe(503);
	});

	test('a flag without a valid Date is refused, never passed', async () => {
		for (const since of [null, true, '2026-01-10', new Date('nope')]) {
			const { deps, tracker } = setup({ flag: { user: 'u', since } });
			const { res, next } = await runGate(tracker.gate, sessionReq());
			expect(next).not.toHaveBeenCalled();
			expect(res.statusCode).toBe(403);
			expect(deps.checkRotation).not.toHaveBeenCalled();
		}
	});

	test('a not-rotated result is cached for 10 minutes', async () => {
		let t = 0;
		const { deps, tracker } = setup({ now: () => t });
		await tracker.status('u');
		t = 9 * 60 * 1000; await tracker.status('u');
		expect(deps.checkRotation).toHaveBeenCalledTimes(1);
		t = 11 * 60 * 1000; await tracker.status('u');
		expect(deps.checkRotation).toHaveBeenCalledTimes(2);
	});

	describe('gateForUser (transaction-signed routes)', () => {
		const byQuery = (tracker) => tracker.gateForUser((req) => req.query && req.query.user);

		test('flagged account is refused even if its key has changed', async () => {
			const { deps, tracker } = setup({ check: async () => ({ allowed: true, reason: 'rotated' }) });
			const { res, next } = await runGate(byQuery(tracker), { query: { user: 'u' } });
			expect(next).not.toHaveBeenCalled();
			expect(res.statusCode).toBe(403);
			expect(res.body.code).toBe('KEY_ROTATION_REQUIRED');
			expect(deps.checkRotation).not.toHaveBeenCalled();
		});

		test('unflagged account passes; missing user is left to the route', async () => {
			const { tracker } = setup({ flag: null });
			expect((await runGate(byQuery(tracker), { query: { user: 'u' } })).next).toHaveBeenCalled();
			expect((await runGate(byQuery(tracker), { query: {} })).next).toHaveBeenCalled();
		});

		test('lookup failure fails closed', async () => {
			const col = { findOne: jest.fn(async () => { throw new Error('db down'); }) };
			const tracker = createTracker({ getCollection: () => col, getAccount: jest.fn(), checkRotation: jest.fn(), endSessions: jest.fn() });
			const { res, next } = await runGate(byQuery(tracker), { query: { user: 'u' } });
			expect(next).not.toHaveBeenCalled();
			expect(res.statusCode).toBe(503);
		});
	});
});
