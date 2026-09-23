/**
 * Challenge Engine — tier policy + server-side tier derivation (Trello #180).
 *
 * Unit tests for arena_tier.js: the ONE source of truth shared by the advisory
 * validate endpoint and the authoritative ingest gate.
 */

const tier = require('../arena_tier');

const createOp = (over = {}) => ({
	op: 'challenge_create', v: 1, id: 'ch_x', type: 'duel',
	origin_tier: 'friendly',
	window: { start: '2026-08-25T00:00:00Z', end: '2026-08-26T00:00:00Z' },
	entry: { mode: 'free' },
	scoring: { metric: 'activity_count', rule: 'head_to_head' },
	...over,
});

describe('arena_tier.normalizeTier', () => {
	test('passes known tiers through, floors unknown to friendly', () => {
		expect(tier.normalizeTier('official')).toBe('official');
		expect(tier.normalizeTier('community')).toBe('community');
		expect(tier.normalizeTier('friendly')).toBe('friendly');
		expect(tier.normalizeTier('root')).toBe('friendly');
		expect(tier.normalizeTier(undefined)).toBe('friendly');
	});
});

describe('arena_tier.createTierErrors — §7.4 gate', () => {
	test('friendly caller: friendly create is clean', () => {
		expect(tier.createTierErrors(createOp(), 'friendly')).toEqual([]);
	});

	test('friendly caller may not create community/official', () => {
		expect(tier.createTierErrors(createOp({ origin_tier: 'community' }), 'friendly').length).toBeGreaterThan(0);
		expect(tier.createTierErrors(createOp({ origin_tier: 'official' }), 'friendly').length).toBeGreaterThan(0);
	});

	test('friendly-tier challenge may not attach a pool or non-merit/badge rewards', () => {
		expect(tier.createTierErrors(createOp({ pool_ref: 'p1' }), 'friendly').join(' ')).toMatch(/pool/);
		expect(tier.createTierErrors(createOp({ rewards: { afit: 100 } }), 'friendly').join(' ')).toMatch(/merits\/badges/);
		// merits/badges are allowed
		expect(tier.createTierErrors(createOp({ rewards: { merits: 10, badges: ['x'] } }), 'friendly')).toEqual([]);
	});

	test('community caller may create friendly or community (with pool)', () => {
		expect(tier.createTierErrors(createOp({ origin_tier: 'community', pool_ref: 'p1' }), 'community')).toEqual([]);
		expect(tier.createTierErrors(createOp({ origin_tier: 'official' }), 'community').length).toBeGreaterThan(0);
	});

	test('official caller may create any tier', () => {
		expect(tier.createTierErrors(createOp({ origin_tier: 'official' }), 'official')).toEqual([]);
		expect(tier.createTierErrors(createOp({ origin_tier: 'community', pool_ref: 'p1' }), 'official')).toEqual([]);
	});

	test('unknown caller tier is floored to friendly', () => {
		expect(tier.createTierErrors(createOp({ origin_tier: 'official' }), 'root').length).toBeGreaterThan(0);
	});

	test('official-only ops rejected for non-official callers', () => {
		expect(tier.createTierErrors({ op: 'settle', challenge_id: 'c' }, 'community').join(' ')).toMatch(/official-only/);
		expect(tier.createTierErrors({ op: 'enroll', challenge_id: 'c' }, 'friendly').join(' ')).toMatch(/official-only/);
		expect(tier.createTierErrors({ op: 'settle', challenge_id: 'c' }, 'official')).toEqual([]);
	});

	test('terminal challenge_update is official-only', () => {
		expect(tier.createTierErrors({ op: 'challenge_update', id: 'c', state: 'archived' }, 'friendly').join(' ')).toMatch(/official-only/);
		expect(tier.createTierErrors({ op: 'challenge_update', id: 'c', state: 'settled' }, 'community').join(' ')).toMatch(/official-only/);
		expect(tier.createTierErrors({ op: 'challenge_update', id: 'c', state: 'active' }, 'friendly')).toEqual([]);
	});

	test('a join/leave op passes untouched at every tier', () => {
		expect(tier.createTierErrors({ op: 'join', challenge_id: 'c' }, 'friendly')).toEqual([]);
		expect(tier.createTierErrors({ op: 'leave', challenge_id: 'c' }, 'friendly')).toEqual([]);
	});
});

describe('arena_tier.resolveTier — server-side derivation', () => {
	const OFFICIAL = 'actifit';

	test('official account resolves to official', async () => {
		expect(await tier.resolveTier(OFFICIAL, { officialAccount: OFFICIAL })).toBe('official');
	});

	test('extra official-role accounts resolve to official', async () => {
		expect(await tier.resolveTier('admin1', { officialAccount: OFFICIAL, officialAccounts: ['admin1'] })).toBe('official');
	});

	test('a moderator (isCommunity=true) resolves to community', async () => {
		const isCommunity = async (u) => u === 'mod1';
		expect(await tier.resolveTier('mod1', { officialAccount: OFFICIAL, isCommunity })).toBe('community');
		expect(await tier.resolveTier('joe', { officialAccount: OFFICIAL, isCommunity })).toBe('friendly');
	});

	test('a throwing isCommunity hook FAILS SAFE to friendly (never upgrades)', async () => {
		const isCommunity = async () => { throw new Error('rank service down'); };
		expect(await tier.resolveTier('joe', { officialAccount: OFFICIAL, isCommunity })).toBe('friendly');
	});

	test('empty/invalid username resolves to friendly', async () => {
		expect(await tier.resolveTier(null, { officialAccount: OFFICIAL })).toBe('friendly');
		expect(await tier.resolveTier('', { officialAccount: OFFICIAL })).toBe('friendly');
		expect(await tier.resolveTier(42, { officialAccount: OFFICIAL })).toBe('friendly');
	});

	test('the official account wins even if it would also match isCommunity', async () => {
		const isCommunity = async () => true;
		expect(await tier.resolveTier(OFFICIAL, { officialAccount: OFFICIAL, isCommunity })).toBe('official');
	});
});
