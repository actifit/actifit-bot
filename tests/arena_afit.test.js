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
});
