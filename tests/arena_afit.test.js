/**
 * Challenge Engine — off-chain AFIT reward crediting (arena_afit.js) — tests.
 */

const { createMockDb } = require('./helpers/mock-db');
const afit = require('../arena_afit');

const AT = '2026-08-26T10:00:00Z';

describe('arena_afit.creditAfitReward', () => {
	test('credits AFIT into token_transactions and reconciles user_tokens (spendable balance)', async () => {
		const db = createMockDb();
		const res = await afit.creditAfitReward(db, { user: 'alice', challengeId: 'ch1', amount: 100, at: AT });
		expect(res).toMatchObject({ ok: true, credited: 100, balance: 100 });
		// ledger row keyed per (user, challenge)
		const row = await db.collection('token_transactions').findOne({ user: 'alice', reward_activity: 'arena_challenge:ch1' });
		expect(row).toMatchObject({ user: 'alice', token_count: 100, challenge_id: 'ch1' });
		// materialized balance the market/wallet reads
		expect(await afit.balanceOf(db, 'alice')).toBe(100);
	});

	test('idempotent per (user, challenge) — a re-credit replaces the same row, never doubles', async () => {
		const db = createMockDb();
		await afit.creditAfitReward(db, { user: 'a', challengeId: 'chX', amount: 40, at: AT });
		await afit.creditAfitReward(db, { user: 'a', challengeId: 'chX', amount: 40, at: AT });
		const rows = await db.collection('token_transactions').find({ user: 'a', reward_activity: 'arena_challenge:chX' }).toArray();
		expect(rows.length).toBe(1);
		expect(await afit.balanceOf(db, 'a')).toBe(40); // not 80
	});

	test('distinct challenges each credit; balance sums them', async () => {
		const db = createMockDb();
		await afit.creditAfitReward(db, { user: 'a', challengeId: 'chA', amount: 30, at: AT });
		await afit.creditAfitReward(db, { user: 'a', challengeId: 'chB', amount: 25, at: AT });
		expect(await afit.balanceOf(db, 'a')).toBe(55);
	});

	test('per-user daily cap clamps the credit and reports capped=true', async () => {
		const db = createMockDb();
		await afit.creditAfitReward(db, { user: 'a', challengeId: 'chA', amount: 280, at: AT, dailyCap: 300 });
		const res = await afit.creditAfitReward(db, { user: 'a', challengeId: 'chB', amount: 100, at: AT, dailyCap: 300 });
		expect(res).toMatchObject({ ok: true, credited: 20, capped: true }); // only 20 room left
		expect(await afit.balanceOf(db, 'a')).toBe(300);
	});

	test('a credit at the cap is idempotent — re-crediting the capped challenge stays at the capped amount', async () => {
		const db = createMockDb();
		await afit.creditAfitReward(db, { user: 'a', challengeId: 'seed', amount: 280, at: AT, dailyCap: 300 });
		const first = await afit.creditAfitReward(db, { user: 'a', challengeId: 'chB', amount: 100, at: AT, dailyCap: 300 });
		expect(first.credited).toBe(20);
		const retry = await afit.creditAfitReward(db, { user: 'a', challengeId: 'chB', amount: 100, at: AT, dailyCap: 300 });
		expect(retry.credited).toBe(20);              // excludes its own row from the cap → same room
		expect(await afit.balanceOf(db, 'a')).toBe(300); // 280 + 20, not double-counted
	});

	test('a fully-capped credit (no room) does not write a row', async () => {
		const db = createMockDb();
		await afit.creditAfitReward(db, { user: 'a', challengeId: 'seed', amount: 300, at: AT, dailyCap: 300 });
		const res = await afit.creditAfitReward(db, { user: 'a', challengeId: 'chB', amount: 50, at: AT, dailyCap: 300 });
		expect(res).toMatchObject({ ok: false, capped: true, credited: 0 });
		expect(await db.collection('token_transactions').findOne({ user: 'a', reward_activity: 'arena_challenge:chB' })).toBeNull();
	});

	test('rejects bad input', async () => {
		const db = createMockDb();
		expect((await afit.creditAfitReward(db, { user: 'a', challengeId: 'c', amount: 0, at: AT })).ok).toBe(false);
		expect((await afit.creditAfitReward(db, { user: 'a', challengeId: 'c', amount: -5, at: AT })).ok).toBe(false);
		expect((await afit.creditAfitReward(db, { challengeId: 'c', amount: 5, at: AT })).ok).toBe(false);
		expect((await afit.creditAfitReward(db, { user: 'a', amount: 5, at: AT })).ok).toBe(false);
	});

	test('does not count a DIFFERENT day toward the cap', async () => {
		const db = createMockDb();
		await afit.creditAfitReward(db, { user: 'a', challengeId: 'chA', amount: 300, at: '2026-08-25T12:00:00Z', dailyCap: 300 });
		const res = await afit.creditAfitReward(db, { user: 'a', challengeId: 'chB', amount: 100, at: '2026-08-26T12:00:00Z', dailyCap: 300 });
		expect(res.credited).toBe(100); // fresh day, full room
	});

	describe('global weekly emission budget', () => {
		test('clamps total emission across ALL users, not just one', async () => {
			const db = createMockDb();
			const r1 = await afit.creditAfitReward(db, { user: 'a', challengeId: 'chA', amount: 70, at: AT, weeklyBudget: 100 });
			expect(r1.credited).toBe(70);
			const r2 = await afit.creditAfitReward(db, { user: 'b', challengeId: 'chB', amount: 70, at: AT, weeklyBudget: 100 });
			expect(r2.credited).toBe(30); // only 30 of the 100 weekly budget remains
			const r3 = await afit.creditAfitReward(db, { user: 'c', challengeId: 'chC', amount: 50, at: AT, weeklyBudget: 100 });
			expect(r3).toMatchObject({ ok: false, capped: true }); // budget exhausted
		});

		test('idempotent per (user,challenge) — a re-credit stays at the same amount', async () => {
			const db = createMockDb();
			await afit.creditAfitReward(db, { user: 'a', challengeId: 'chA', amount: 70, at: AT, weeklyBudget: 100 });
			const retry = await afit.creditAfitReward(db, { user: 'a', challengeId: 'chA', amount: 70, at: AT, weeklyBudget: 100 });
			expect(retry.credited).toBe(70);          // excludes its own row → same room
			expect(await afit.balanceOf(db, 'a')).toBe(70);
		});

		test('resets in a different week bucket', async () => {
			const db = createMockDb();
			await afit.creditAfitReward(db, { user: 'a', challengeId: 'chA', amount: 100, at: '2026-08-01T00:00:00Z', weeklyBudget: 100 });
			const next = await afit.creditAfitReward(db, { user: 'a', challengeId: 'chB', amount: 100, at: '2026-08-20T00:00:00Z', weeklyBudget: 100 });
			expect(next.credited).toBe(100); // different week
		});

		test('unset (0/undefined) budget = disabled (per-user cap only)', async () => {
			const db = createMockDb();
			const r = await afit.creditAfitReward(db, { user: 'a', challengeId: 'chA', amount: 400, at: AT }); // no weeklyBudget
			expect(r.credited).toBe(400); // only the default per-user cap (500) applies
		});
	});
});

describe('arena_afit.ensureAfitIndexes', () => {
	test('creates a PARTIAL unique index scoped to arena credit rows only', async () => {
		const calls = [];
		const db = { collection: () => ({ createIndex: async (keys, opts) => { calls.push({ keys, opts }); } }) };
		await afit.ensureAfitIndexes(db);
		expect(calls).toHaveLength(1);
		expect(calls[0].keys).toEqual({ user: 1, reward_activity: 1 });
		expect(calls[0].opts.unique).toBe(true);
		// token_transactions is the WHOLE platform's AFIT ledger and legitimately has
		// many rows sharing (user, reward_activity) for non-arena activity. Only arena
		// credit rows carry challenge_id, so the constraint must be scoped to those.
		expect(calls[0].opts.partialFilterExpression).toEqual({ challenge_id: { $exists: true } });
	});

	test('is a safe no-op where createIndex is unavailable (test mock / old driver)', async () => {
		const db = { collection: () => ({}) };
		await expect(afit.ensureAfitIndexes(db)).resolves.toBeUndefined();
	});
});
