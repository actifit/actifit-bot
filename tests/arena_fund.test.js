/**
 * Challenge Engine — creator-funded challenge pools (arena_fund.js) + the funded
 * create path through indexArenaOp.
 */

const { createMockDb } = require('./helpers/mock-db');
const fund = require('../arena_fund');
const afit = require('../arena_afit');
const arena = require('../arena');

const AT = '2026-08-26T10:00:00Z';

// Give a user an off-chain AFIT balance via the ledger, then materialize it.
async function seedBalance(db, user, amount) {
	db.collection('token_transactions').__seed([{ user, reward_activity: 'seed', token_count: amount, date: new Date('2026-08-01T00:00:00Z') }]);
	await afit.reconcileBalance(db, user);
}

describe('arena_fund.fundChallenge', () => {
	test('debits the creator (prize + 5% fee), burns the fee, and creates a sponsor pool', async () => {
		const db = createMockDb();
		await seedBalance(db, 'creator', 200);
		const res = await fund.fundChallenge(db, { creator: 'creator', challengeId: 'ch1', prize: 100, at: AT });
		expect(res).toMatchObject({ ok: true, poolId: 'poolch_ch1', prize: 100, fee: 5 });
		// creator debited 105 (100 prize + 5 fee); fee is burned (not credited anywhere)
		expect(await afit.balanceOf(db, 'creator')).toBe(95);
		const pool = await db.collection('pools').findOne({ id: 'poolch_ch1' });
		expect(pool).toMatchObject({ funding: 'sponsor', sponsor_id: 'creator', budget: 100, funders: ['creator'] });
	});

	test('refuses when the creator cannot cover prize + fee (nothing debited, no pool)', async () => {
		const db = createMockDb();
		await seedBalance(db, 'creator', 100); // needs 105
		const res = await fund.fundChallenge(db, { creator: 'creator', challengeId: 'ch1', prize: 100, at: AT });
		expect(res.ok).toBe(false);
		expect(res.reason).toMatch(/insufficient/);
		expect(await afit.balanceOf(db, 'creator')).toBe(100); // untouched
		expect(await db.collection('pools').findOne({ id: 'poolch_ch1' })).toBeNull();
	});

	test('idempotent — re-funding the same challenge does not double-debit', async () => {
		const db = createMockDb();
		await seedBalance(db, 'creator', 500);
		await fund.fundChallenge(db, { creator: 'creator', challengeId: 'ch1', prize: 200, at: AT });
		const again = await fund.fundChallenge(db, { creator: 'creator', challengeId: 'ch1', prize: 200, at: AT });
		expect(again).toMatchObject({ ok: true, noop: true });
		expect(await afit.balanceOf(db, 'creator')).toBe(290); // 500 - 210, once
	});

	test('rejects a dust prize below the minimum pool', async () => {
		const db = createMockDb();
		await seedBalance(db, 'creator', 1000);
		const res = await fund.fundChallenge(db, { creator: 'creator', challengeId: 'ch1', prize: 10, at: AT });
		expect(res.ok).toBe(false);
		expect(res.reason).toMatch(/at least/);
	});

	test('fee honors a configured cut percentage', () => {
		expect(fund.feeFor(100, 5)).toBe(5);
		expect(fund.feeFor(250, 10)).toBe(25);
		expect(fund.feeFor(100, 0)).toBe(0);
	});
});

describe('indexArenaOp — funded create path', () => {
	const chainOp = (body, signer) => ({
		id: arena.ARENA_JSON_ID,
		json: JSON.stringify(body),
		required_posting_auths: [signer],
		required_auths: [],
		trx_id: 'trx_' + Math.random().toString(36).slice(2),
		block_num: 100,
		timestamp: '2026-08-25T00:00:00',
	});
	const fundedCreate = (over = {}) => ({
		op: 'challenge_create', v: 1, id: 'ch_funded', type: 'duel',
		origin_tier: 'community',
		window: { start: '2026-08-25T00:00:00Z', end: '2026-08-26T00:00:00Z' },
		entry: { mode: 'free' },
		scoring: { metric: 'activity_count', rule: 'head_to_head' },
		rewards: { afit: 100 },
		...over,
	});
	// community-tier resolver + the real funder against this db.
	const opts = (db) => ({
		resolveTier: async () => 'community',
		fundChallenge: (params) => fund.fundChallenge(db, params),
	});

	test('a funded community create locks the creator AFIT and stores pool_ref', async () => {
		const db = createMockDb();
		await seedBalance(db, 'rich', 1000);
		const res = await arena.indexArenaOp(db, chainOp(fundedCreate(), 'rich'), opts(db));
		expect(res.ok).toBe(true);
		const ch = await db.collection('challenges').findOne({ id: 'ch_funded' });
		expect(ch.pool_ref).toBe('poolch_ch_funded');
		expect(ch.created_by).toBe('rich');
		expect(await afit.balanceOf(db, 'rich')).toBe(895); // 1000 - 105
		expect((await db.collection('pools').findOne({ id: 'poolch_ch_funded' })).budget).toBe(100);
	});

	test('an underfunded creator has the WHOLE create rejected (no orphan challenge)', async () => {
		const db = createMockDb();
		await seedBalance(db, 'broke', 50); // needs 105
		const res = await arena.indexArenaOp(db, chainOp(fundedCreate(), 'broke'), opts(db));
		expect(res.ok).toBe(false);
		expect(res.reason).toMatch(/funding failed/);
		expect(await db.collection('challenges').findOne({ id: 'ch_funded' })).toBeNull();
		expect(await afit.balanceOf(db, 'broke')).toBe(50); // untouched
	});

	test('SECURITY — a client-set pool_ref is IGNORED (cannot point at another pool)', async () => {
		const db = createMockDb();
		await seedBalance(db, 'rich', 1000);
		// community create with no funding but a spoofed pool_ref at a victim pool
		const res = await arena.indexArenaOp(db, chainOp(fundedCreate({ id: 'ch_hijack', rewards: null, pool_ref: 'poolch_victim' }), 'rich'), opts(db));
		expect(res.ok).toBe(true);
		expect((await db.collection('challenges').findOne({ id: 'ch_hijack' })).pool_ref).toBeNull();
	});

	test('an official contest is NOT creator-funded (rewards:null → no debit)', async () => {
		const db = createMockDb();
		const res = await arena.indexArenaOp(db, chainOp(fundedCreate({ id: 'def_x', origin_tier: 'official', rewards: null }), 'actifit'), {
			resolveTier: async () => 'official',
			fundChallenge: () => { throw new Error('should not fund an official contest'); },
		});
		expect(res.ok).toBe(true);
		expect((await db.collection('challenges').findOne({ id: 'def_x' })).pool_ref).toBeNull();
	});
});

describe('creator-funded challenge — full resolution + refund', () => {
	const jobs = require('../arena_jobs');
	const CLOSED = { start: '2026-08-01T00:00:00Z', end: '2026-08-08T00:00:00Z', tz: 'UTC' };
	const NOW = '2026-08-10T00:00:00Z';
	const post = (author, dateISO, step_count) => ({ author, permlink: `p-${author}-${dateISO}`, date: new Date(dateISO), json_metadata: { step_count } });

	test('pays winners from the pool (uncapped by the treasury cap) and refunds the remainder', async () => {
		const db = createMockDb();
		await seedBalance(db, 'creator', 1000);
		const f = await fund.fundChallenge(db, { creator: 'creator', challengeId: 'ch_f', prize: 100, at: NOW });
		expect(f.ok).toBe(true);
		db.collection('challenges').__seed([{ id: 'ch_f', state: 'open', type: 'league_fixture', window: CLOSED, scoring: { metric: 'activity_count', rule: 'max' }, origin_tier: 'community', created_by: 'creator', pool_ref: 'poolch_ch_f' }]);
		db.collection('challenge_participants').__seed([
			{ challenge_id: 'ch_f', entity: 'alice', flags: [], state: 'enrolled' },
			{ challenge_id: 'ch_f', entity: 'bob', flags: [], state: 'enrolled' },
		]);
		db.collection('verified_posts').__seed([post('alice', '2026-08-03T10:00:00Z', 9000), post('bob', '2026-08-03T10:00:00Z', 5000)]);

		// A tiny treasury cap is set — but must NOT clip a pool-funded prize.
		await jobs.resolveDueChallenges(db, { now: NOW, afitDailyCap: 10, broadcastOp: async (op) => ({ id: 'trx_' + op.op }) });

		expect(await afit.balanceOf(db, 'alice')).toBe(50); // rank 1: 50% of 100 (not clipped to 10)
		expect(await afit.balanceOf(db, 'bob')).toBe(30);   // rank 2: 30%
		// creator: 1000 − 105 (fund) + 20 (refund of the unpaid rank-3 slot) = 915
		expect(await afit.balanceOf(db, 'creator')).toBe(915);
		expect((await db.collection('pools').findOne({ id: 'poolch_ch_f' })).state).toBe('settled');
	});

	test('a funded challenge with no eligible finishers refunds the entire prize (only the fee is lost)', async () => {
		const db = createMockDb();
		await seedBalance(db, 'creator', 1000);
		await fund.fundChallenge(db, { creator: 'creator', challengeId: 'ch_empty', prize: 200, at: NOW });
		db.collection('challenges').__seed([{ id: 'ch_empty', state: 'open', type: 'duel', window: CLOSED, scoring: { metric: 'activity_count', rule: 'max' }, origin_tier: 'community', created_by: 'creator', pool_ref: 'poolch_ch_empty' }]);
		await jobs.resolveDueChallenges(db, { now: NOW, broadcastOp: async (op) => ({ id: 'trx_' + op.op }) });
		// 1000 − 210 (fund: 200 + 10 fee) + 200 (full refund) = 990 (the 10 fee is burned)
		expect(await afit.balanceOf(db, 'creator')).toBe(990);
	});

	test('refundUnpaid is idempotent — a second pass does not double-refund', async () => {
		const db = createMockDb();
		await seedBalance(db, 'creator', 500);
		await fund.fundChallenge(db, { creator: 'creator', challengeId: 'ch_r', prize: 100, at: NOW });
		await db.collection('pools').updateOne({ id: 'poolch_ch_r' }, { $set: { paid: 60 } }); // pretend 60 paid
		const r1 = await fund.refundUnpaid(db, { challengeId: 'ch_r', poolId: 'poolch_ch_r', creator: 'creator', at: NOW });
		expect(r1.refunded).toBe(40);
		const r2 = await fund.refundUnpaid(db, { challengeId: 'ch_r', poolId: 'poolch_ch_r', creator: 'creator', at: NOW });
		expect(r2).toMatchObject({ noop: true });
		// 500 − 105 + 40 = 435, once
		expect(await afit.balanceOf(db, 'creator')).toBe(435);
	});
});

describe('arena_rewards.poolPrizes', () => {
	const rewards = require('../arena_rewards');
	test('splits a pool 50/30/20 across the top three', () => {
		expect(rewards.poolPrizes(100)).toEqual([{ rank: 1, afit: 50 }, { rank: 2, afit: 30 }, { rank: 3, afit: 20 }]);
		expect(rewards.poolPrizes(0)).toEqual([]);
	});
});
