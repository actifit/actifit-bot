/**
 * Challenge Engine F6 write helpers (Trello #180) — prepare/validate + tier gate.
 */

const write = require('../arena_write');

const createBody = (over = {}) => write.buildCreateOp({
	id: 'ch_x', type: 'duel',
	window: { start: '2026-08-25T00:00:00Z', end: '2026-08-26T00:00:00Z' },
	scoring: { metric: 'activity_count', rule: 'head_to_head' },
	...over,
});

describe('arena_write op builders', () => {
	test('buildJoinOp / buildLeaveOp shape', () => {
		expect(write.buildJoinOp('ch1')).toEqual({ op: 'join', v: 1, challenge_id: 'ch1' });
		expect(write.buildLeaveOp('ch1')).toEqual({ op: 'leave', v: 1, challenge_id: 'ch1' });
	});
	test('buildCreateOp defaults to a free, friendly, public challenge', () => {
		const op = createBody();
		expect(op).toMatchObject({ op: 'challenge_create', v: 1, origin_tier: 'friendly', visibility: 'public', entry: { mode: 'free' } });
	});
});

describe('arena_write.validateProposedOp', () => {
	test('accepts a valid friendly create', () => {
		expect(write.validateProposedOp(createBody(), { callerTier: 'friendly' })).toMatchObject({ ok: true });
	});

	test('rejects a schema-invalid op (I1 fee) via F1 validation', () => {
		const r = write.validateProposedOp(createBody({ entry: { mode: 'fee' } }), { callerTier: 'friendly' });
		expect(r.ok).toBe(false);
		expect(r.errors.join(' ')).toMatch(/I1/);
	});

	test('tier gate — friendly caller may not create an official challenge', () => {
		const r = write.validateProposedOp(createBody({ origin_tier: 'official' }), { callerTier: 'friendly' });
		expect(r.ok).toBe(false);
		expect(r.errors.join(' ')).toMatch(/tier/);
	});

	test('tier gate — friendly caller may not attach a pool or AFIT rewards', () => {
		expect(write.validateProposedOp(createBody({ pool_ref: 'pool1' }), { callerTier: 'friendly' }).ok).toBe(false);
		expect(write.validateProposedOp(createBody({ rewards: { afit: 100 } }), { callerTier: 'friendly' }).ok).toBe(false);
	});

	test('community caller may create a community challenge with a pool', () => {
		const r = write.validateProposedOp(createBody({ origin_tier: 'community', pool_ref: 'pool1' }), { callerTier: 'community' });
		expect(r.ok).toBe(true);
	});

	test('official caller may create an official challenge; defaults to friendly floor', () => {
		expect(write.validateProposedOp(createBody({ origin_tier: 'official' }), { callerTier: 'official' }).ok).toBe(true);
		// no callerTier → safe 'friendly' floor → official create rejected
		expect(write.validateProposedOp(createBody({ origin_tier: 'official' })).ok).toBe(false);
	});
});
