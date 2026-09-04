/**
 * Challenge Engine — AUTHORITATIVE ingest tier gate (Trello #180).
 *
 * The security-critical half of #180: indexArenaOp must reject a challenge_create
 * the op's SIGNER isn't entitled to, using a server-derived tier (opts.resolveTier)
 * — never a client-asserted one. Complements the advisory validate-endpoint tests
 * in arena_write.test.js.
 */

const { createMockDb } = require('./helpers/mock-db');
const arena = require('../arena');

const chainOp = (body, signer, extra = {}) => ({
	id: arena.ARENA_JSON_ID,
	json: JSON.stringify(body),
	required_posting_auths: [signer],
	required_auths: [],
	trx_id: extra.trx_id || 'trx_' + Math.random().toString(36).slice(2),
	block_num: extra.block_num || 100,
	timestamp: extra.timestamp || '2026-08-25T00:00:00',
});

const createBody = (over = {}) => ({
	op: 'challenge_create', v: 1, id: over.id || 'ch_1', type: 'duel',
	origin_tier: 'friendly',
	window: { start: '2026-08-25T00:00:00Z', end: '2026-08-26T00:00:00Z' },
	entry: { mode: 'free' },
	scoring: { metric: 'activity_count', rule: 'head_to_head' },
	...over,
});

// A resolver that treats 'mod1' as community and 'actifit' as official.
const resolveTier = async (u) => (u === 'actifit' ? 'official' : u === 'mod1' ? 'community' : 'friendly');

describe('indexArenaOp — authoritative §7.4 tier gate on ingest', () => {
	let db;
	beforeEach(() => { db = createMockDb(); });

	test('a friendly signer CANNOT create a community challenge (with resolver)', async () => {
		const res = await arena.indexArenaOp(db, chainOp(createBody({ origin_tier: 'community' }), 'joe'), { resolveTier });
		expect(res.ok).toBe(false);
		expect(res.reason).toMatch(/tier gate/);
		expect(await db.collection('challenges').findOne({ id: 'ch_1' })).toBeNull();
	});

	test('a community signer (moderator) CAN create a community challenge with a pool', async () => {
		const res = await arena.indexArenaOp(db, chainOp(createBody({ id: 'ch_c', origin_tier: 'community', pool_ref: 'p1' }), 'mod1'), { resolveTier });
		expect(res.ok).toBe(true);
		expect(await db.collection('challenges').findOne({ id: 'ch_c' })).toMatchObject({ origin_tier: 'community', created_by: 'mod1' });
	});

	test('a friendly signer CANNOT attach a pool to a friendly challenge', async () => {
		const res = await arena.indexArenaOp(db, chainOp(createBody({ pool_ref: 'p1' }), 'joe'), { resolveTier });
		expect(res.ok).toBe(false);
		expect(res.reason).toMatch(/pool/);
	});

	test('a friendly signer CANNOT reward AFIT (badge/Merit only)', async () => {
		const res = await arena.indexArenaOp(db, chainOp(createBody({ rewards: { afit: 100 } }), 'joe'), { resolveTier });
		expect(res.ok).toBe(false);
	});

	test('a friendly signer CAN create a plain friendly challenge', async () => {
		const res = await arena.indexArenaOp(db, chainOp(createBody({ id: 'ch_f' }), 'joe'), { resolveTier });
		expect(res.ok).toBe(true);
	});

	test('WITHOUT a resolver, a non-official signer is floored to friendly (community create rejected)', async () => {
		const res = await arena.indexArenaOp(db, chainOp(createBody({ origin_tier: 'community' }), 'joe'));
		expect(res.ok).toBe(false);
		expect(res.reason).toMatch(/tier gate/);
	});

	test('WITHOUT a resolver, the official account still creates official (signer === officialAccount)', async () => {
		const res = await arena.indexArenaOp(db, chainOp(createBody({ id: 'ch_o', origin_tier: 'official' }), 'actifit'));
		expect(res.ok).toBe(true);
	});

	test('official challenge by a non-official signer is rejected with the precise reason', async () => {
		const res = await arena.indexArenaOp(db, chainOp(createBody({ origin_tier: 'official' }), 'mod1'), { resolveTier });
		expect(res.ok).toBe(false);
		expect(res.reason).toMatch(/official challenge must be signed by the official account/);
	});

	test('re-tailing an indexed community create is a NO-OP even if the signer was since demoted', async () => {
		const op = chainOp(createBody({ id: 'ch_re', origin_tier: 'community' }), 'mod1', { trx_id: 'trx_fixed' });
		const first = await arena.indexArenaOp(db, op, { resolveTier });
		expect(first.ok).toBe(true);
		// Same trx re-tailed, but mod1 no longer resolves to community (demoted).
		const demoted = async () => 'friendly';
		const replay = await arena.indexArenaOp(db, op, { resolveTier: demoted });
		expect(replay).toMatchObject({ ok: true, noop: true });
	});

	test('a resolver that THROWS never upgrades — create is floored to friendly', async () => {
		const boom = async () => { throw new Error('rank service down'); };
		const res = await arena.indexArenaOp(db, chainOp(createBody({ id: 'ch_boom', origin_tier: 'community' }), 'mod1'), { resolveTier: boom });
		expect(res.ok).toBe(false);
		expect(res.reason).toMatch(/tier gate/);
	});
});
