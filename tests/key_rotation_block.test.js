/**
 * Key-change block: recorded when a flagged account rotates, and used by transaction-signed
 * routes instead of a time hold (key_rotation.js).
 */

const { decideRotation, createTracker } = require('../key_rotation');

const SINCE = new Date('2026-01-10T12:00:00Z');
const OLD = 'STM_OLD_POSTING';
const NEW = 'STM_NEW_POSTING';
let idx = 0;
const entry = (timestamp, type, payload, block) => [++idx, Object.assign({ timestamp, op: [type, payload] }, block ? { block } : {})];
const posting = (...keys) => ({ posting: { weight_threshold: 1, account_auths: [], key_auths: keys.map((k) => [k, 1]) } });
const created = entry('2020-05-01T00:00:00', 'account_create', Object.assign({ new_account_name: 'u' }, posting(OLD)), 100);

describe('decideRotation: rotatedBlock', () => {
	test('is the block of the latest own posting change after the flag date', () => {
		const first = entry('2026-01-11T08:00:00', 'account_update', Object.assign({ account: 'u' }, posting('STM_MID')), 5000);
		const second = entry('2026-01-12T08:00:00', 'account_update', Object.assign({ account: 'u' }, posting(NEW)), 6000);
		expect(decideRotation([created, second, first], 'u', NEW, SINCE)).toEqual({ allowed: true, reason: 'rotated', rotatedBlock: 6000 });
	});

	test('ignores accounts created for others and changes before the flag date', () => {
		const other = entry('2026-01-13T08:00:00', 'account_create', Object.assign({ new_account_name: 'someone' }, posting('STM_X')), 9000);
		const before = entry('2026-01-09T08:00:00', 'account_update', Object.assign({ account: 'u' }, posting(OLD)), 4000);
		const rotated = entry('2026-01-11T08:00:00', 'account_update', Object.assign({ account: 'u' }, posting(NEW)), 5000);
		expect(decideRotation([created, before, other, rotated], 'u', NEW, SINCE).rotatedBlock).toBe(5000);
	});

	test('not rotated: no block reported', () => {
		expect(decideRotation([created], 'u', OLD, SINCE)).toEqual({ allowed: false, reason: 'not_rotated' });
	});
});

describe('gateForUser with exactTx', () => {
	const CLEARED = new Date('2026-01-12T00:00:00Z');
	const account = { posting: { key_auths: [[NEW, 1]] } };
	const setup = ({ flag, check = async () => ({ allowed: true, reason: 'rotated', rotatedBlock: 5000 }), now = () => CLEARED.getTime() + 60 * 1000 } = {}) => {
		const col = {
			find: jest.fn(() => ({ toArray: async () => (flag ? [flag] : []) })),
			updateMany: jest.fn(async () => ({ modifiedCount: 1 })),
		};
		const deps = { getCollection: () => col, getAccount: jest.fn(async () => account), checkRotation: jest.fn(check), endSessions: jest.fn(), now };
		return { col, deps, tracker: createTracker(deps) };
	};
	const run = async (mw, user = 'u') => {
		const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
		const next = jest.fn();
		await mw({ params: { user } }, res, next);
		return { res, next };
	};
	const byParam = (t, opts) => t.gateForUser((r) => r.params.user, opts);
	let log;
	beforeEach(() => { log = jest.spyOn(console, 'log').mockImplementation(() => {}); });
	afterEach(() => log.mockRestore());

	test('cleared with a stored key-change block: passes at once, no chain call', async () => {
		const { deps, tracker } = setup({ flag: { user: 'u', since: SINCE, cleared_at: CLEARED, rotated_block: 5000 } });
		const { next } = await run(byParam(tracker, { exactTx: true }));
		expect(next).toHaveBeenCalled();
		expect(deps.checkRotation).not.toHaveBeenCalled();
	});

	test('cleared before blocks were stored: reads the block from the chain once, saves it, passes', async () => {
		const flag = { user: 'u', since: SINCE, cleared_at: CLEARED };
		const { col, deps, tracker } = setup({ flag });
		const { next } = await run(byParam(tracker, { exactTx: true }));
		expect(next).toHaveBeenCalled();
		expect(deps.checkRotation).toHaveBeenCalledWith('u', [NEW], SINCE);
		expect(col.updateMany).toHaveBeenCalledWith({ user: 'u', cleared_at: CLEARED }, { $set: { rotated_block: 5000 } });
	});

	test('block cannot be established (chain error or no block): falls back to the hold', async () => {
		for (const check of [async () => ({ allowed: false, reason: 'chain_error' }), async () => ({ allowed: true, reason: 'rotated' }), async () => { throw new Error('node down'); }]) {
			const { col, tracker } = setup({ flag: { user: 'u', since: SINCE, cleared_at: CLEARED }, check });
			const { res, next } = await run(byParam(tracker, { exactTx: true }));
			expect(next).not.toHaveBeenCalled();
			expect(res.body.code).toBe('KEY_ROTATION_HOLD');
			expect(col.updateMany).not.toHaveBeenCalled();
		}
	});

	test('a failed lookup is not repeated for a while', async () => {
		const { deps, tracker } = setup({ flag: { user: 'u', since: SINCE, cleared_at: CLEARED }, check: async () => ({ allowed: false, reason: 'unknown_prior_keys' }) });
		await run(byParam(tracker, { exactTx: true }));
		await run(byParam(tracker, { exactTx: true }));
		expect(deps.checkRotation).toHaveBeenCalledTimes(1);
	});

	test('status reports the key-change block when rotated (login passes it to clear)', async () => {
		const { tracker } = setup({ flag: { user: 'u', since: SINCE } });
		await expect(tracker.status('u', account, { fresh: true })).resolves.toEqual({ flagged: true, rotated: true, rotatedBlock: 5000 });
	});

	test('without exactTx the time hold still applies', async () => {
		const { tracker } = setup({ flag: { user: 'u', since: SINCE, cleared_at: CLEARED, rotated_block: 5000 } });
		const { res, next } = await run(byParam(tracker));
		expect(next).not.toHaveBeenCalled();
		expect(res.body.code).toBe('KEY_ROTATION_HOLD');
	});

	test('a flag that is not cleared is still refused', async () => {
		const { res, next } = await run(byParam(setup({ flag: { user: 'u', since: SINCE } }).tracker, { exactTx: true }));
		expect(next).not.toHaveBeenCalled();
		expect(res.body.code).toBe('KEY_ROTATION_REQUIRED');
	});

	test('clear stores the key-change block; unclear removes it', async () => {
		const { col, tracker } = setup({ flag: { user: 'u', since: SINCE } });
		await tracker.clear('u', 'tok', 5000);
		expect(col.updateMany.mock.calls[0][1].$set.rotated_block).toBe(5000);
		await tracker.clear('u', 'tok');
		expect(col.updateMany.mock.calls[1][1].$set).not.toHaveProperty('rotated_block');
		expect(col.updateMany.mock.calls[1][1].$unset).toEqual({ rotated_block: '' });
		await tracker.unclear('u');
		expect(col.updateMany.mock.calls[2][1].$unset).toHaveProperty('rotated_block');
	});
});
