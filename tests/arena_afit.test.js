/**
 * Challenge Engine — off-chain AFIT reward crediting (arena_afit.js) — tests.
 */

const { createMockDb } = require('./helpers/mock-db');
const afit = require('../arena_afit');

const AT = '2026-08-26T10:00:00Z';

// The cap/budget readers used to pull unbounded row sets into Node and filter in
// JS: arenaEmittedOn read the user's ENTIRE platform ledger (3,205 rows for a real
// participant) and arenaEmittedWeek read every arena row ever written - both once
// per credit, inside the payout loop. They now bound by date in the query and sum
// server-side. These tests pin the SEMANTICS that bounding must not change.
describe('arena_afit — bounded cap/budget reads', () => {
	const AT = '2026-08-26T10:00:00Z';
	const arenaRow = (user, challengeId, tokens, dateISO) => ({
		user,
		reward_activity: 'arena_challenge:' + challengeId,
		token_count: tokens,
		challenge_id: challengeId,
		date: new Date(dateISO),
	});

	test('the daily cap counts only THIS user\'s arena rows on THIS day', async () => {
		const db = createMockDb();
		db.collection('token_transactions').__seed([
			arenaRow('alice', 'chA', 100, '2026-08-26T01:00:00Z'),   // same day  -> counts
			arenaRow('alice', 'chB', 200, '2026-08-25T23:00:00Z'),   // day before -> must NOT count
			arenaRow('bob',   'chC', 400, '2026-08-26T02:00:00Z'),   // other user -> must NOT count
			// ordinary non-arena ledger rows for the same user on the same day
			{ user: 'alice', reward_activity: 'Post', token_count: 5000, date: new Date('2026-08-26T03:00:00Z') },
			{ user: 'alice', reward_activity: 'Comment', token_count: 9000, date: new Date('2026-08-26T04:00:00Z') },
		]);

		// dailyCap 300, already 100 used today -> only 200 of a 500 request lands
		const res = await afit.creditAfitReward(db, { user: 'alice', challengeId: 'chNew', amount: 500, at: AT, dailyCap: 300 });
		expect(res.credited).toBe(200);
		expect(res.capped).toBe(true);
	});

	test('the weekly budget counts only rows inside the same week bucket', async () => {
		const db = createMockDb();
		db.collection('token_transactions').__seed([
			arenaRow('bob', 'chA', 1000, '2026-08-26T01:00:00Z'),    // same week -> counts
			arenaRow('bob', 'chOld', 40000, '2026-07-01T01:00:00Z'), // long past -> must NOT count
		]);
		// 1200 budget - 1000 already emitted this week = 200 of room, but the prize is
		// 500. A treasury that can only cover PART of a prize must not pay part of it:
		// that figure is settled on-chain and never revisited. Refuse and let the
		// resolution retry once the budget frees. (The 40000 from a past week is
		// correctly ignored - if it counted, there would be no room at all.)
		const res = await afit.creditAfitReward(db, { user: 'carol', challengeId: 'chNew', amount: 500, at: AT, weeklyBudget: 1200 });
		expect(res).toMatchObject({ ok: false, capped: true, credited: 0, cappedBy: 'weekly_budget' });
		expect(res.shortfall).toMatchObject({ requested: 500, available: 200, unsatisfiable: false });

		// and a prize that DOES fit in the remaining room is paid in full
		const fits = await afit.creditAfitReward(db, { user: 'carol', challengeId: 'chFits', amount: 200, at: AT, weeklyBudget: 1200 });
		expect(fits).toMatchObject({ ok: true, credited: 200 });
	});

	test('a re-credit of the SAME (user, challenge) recomputes the same room', async () => {
		const db = createMockDb();
		const first = await afit.creditAfitReward(db, { user: 'dave', challengeId: 'chX', amount: 250, at: AT, dailyCap: 300, weeklyBudget: 1000 });
		expect(first.credited).toBe(250);
		// replaying must not count its own row against its own room
		const again = await afit.creditAfitReward(db, { user: 'dave', challengeId: 'chX', amount: 250, at: AT, dailyCap: 300, weeklyBudget: 1000 });
		expect(again.credited).toBe(250);
		expect(await afit.balanceOf(db, 'dave')).toBe(250);   // never doubled
	});

	// THE most money-critical property in this module: a creator-funded (pooled)
	// credit must NEVER count against the TREASURY budget - the creator already paid
	// for it. The old code tested the namespace with indexOf(prefix) === 0; the new
	// code uses a $gte/$lt string range whose upper bound is the prefix with ':'
	// replaced by ';' (adjacent codepoints, 0x3A -> 0x3B). That is exact, but nothing
	// pinned it, so a future edit to ARENA_ACTIVITY_HI could silently pull pooled or
	// fund rows into the treasury total with every test still green.
	test('pooled / fund / refund namespaces never count toward the TREASURY budget', async () => {
		const db = createMockDb();
		db.collection('token_transactions').__seed([
			// all in the same week, all large enough to blow a small budget
			{ user: 'x', reward_activity: 'arena_pool:chP',    token_count: 40000, challenge_id: 'chP', date: new Date('2026-08-26T01:00:00Z') },
			{ user: 'x', reward_activity: 'arena_fund:chF',    token_count: -9000, challenge_id: 'chF', date: new Date('2026-08-26T01:00:00Z') },
			{ user: 'x', reward_activity: 'arena_refund:chF',  token_count: 9000,  challenge_id: 'chF', date: new Date('2026-08-26T01:00:00Z') },
			// a treasury row, which DOES count
			{ user: 'x', reward_activity: 'arena_challenge:chT', token_count: 100, challenge_id: 'chT', date: new Date('2026-08-26T01:00:00Z') },
		]);
		// budget 1000; only the 100 treasury row counts, so 900 of room remains
		// dailyCap raised out of the way so the WEEKLY budget is what binds here.
		// Only the 100 treasury row counts, leaving 900 of room - so a 5000 prize is
		// refused (not part-paid), while a prize that fits the 900 is paid in full.
		// If the pooled/fund/refund rows leaked into the treasury total there would be
		// no room at all and even the small prize would be refused.
		const res = await afit.creditAfitReward(db, { user: 'y', challengeId: 'chNew', amount: 5000, at: AT, dailyCap: 100000, weeklyBudget: 1000 });
		expect(res).toMatchObject({ ok: false, cappedBy: 'weekly_budget' });
		// 5000 exceeds the ENTIRE 1000 budget, so this one can never be satisfied by
		// waiting - the guard says so rather than looping on it forever
		expect(res.shortfall).toMatchObject({ requested: 5000, available: 900, unsatisfiable: true });

		const fits = await afit.creditAfitReward(db, { user: 'y', challengeId: 'chFits', amount: 900, at: AT, dailyCap: 100000, weeklyBudget: 1000 });
		expect(fits).toMatchObject({ ok: true, credited: 900 });
	});

	test('a pooled credit is written to its own namespace and is not treasury-capped', async () => {
		const db = createMockDb();
		// pooled credits pass weeklyBudget 0 / an effectively infinite daily cap
		const res = await afit.creditAfitReward(db, {
			user: 'z', challengeId: 'chP', amount: 5000, at: AT, pooled: true,
			dailyCap: Number.MAX_SAFE_INTEGER, weeklyBudget: 0,
		});
		expect(res.credited).toBe(5000);
		const row = await db.collection('token_transactions').findOne({ user: 'z' });
		expect(row.reward_activity).toBe('arena_pool:chP');
		// and it must not show up in the treasury weekly total afterwards
		const next = await afit.creditAfitReward(db, { user: 'w', challengeId: 'chT', amount: 100, at: AT, dailyCap: 100000, weeklyBudget: 1000 });
		expect(next.credited).toBe(100);   // the 5000 pooled row did not eat the budget
	});

	// The daily cap is deliberately NOT treated like the treasury. It is per-user
	// policy - you may earn 500 a day - so a clip is the rule working as intended and
	// must still pay, and must still let the contest settle for everyone else.
	test('a DAILY-cap clip still pays the reduced amount', async () => {
		const db = createMockDb();
		db.collection('token_transactions').__seed([
			arenaRow('dan', 'chEarlier', 300, '2026-08-26T01:00:00Z'),
		]);
		const res = await afit.creditAfitReward(db, { user: 'dan', challengeId: 'chNew', amount: 400, at: AT, dailyCap: 500, weeklyBudget: 100000 });
		expect(res).toMatchObject({ ok: true, credited: 200, capped: true });
		expect(await afit.balanceOf(db, 'dan')).toBe(500);
	});

	// A re-credit must never LOWER what is already banked. This became reachable when
	// resolution went from "resolve once" to "retry until the budget fits": the write
	// is a replaceOne and the caps are recomputed on every attempt, so a retry landing
	// on a different UTC day (or after an operator lowers a cap) can compute a smaller
	// number. Spends are negative ledger rows, so reducing a credit the user has
	// ALREADY SPENT drives their balance negative. Measured before the fix: a banked
	// 400 rewritten to 200.
	test('a retry never reduces an already-banked credit', async () => {
		const db = createMockDb();
		const DAY1 = '2026-08-26T10:00:00Z';
		const DAY2 = '2026-08-27T10:00:00Z';

		const first = await afit.creditAfitReward(db, { user: 'A', challengeId: 'chBig', amount: 400, at: DAY1, dailyCap: 500, weeklyBudget: 50000 });
		expect(first.credited).toBe(400);

		// the user spends it
		await db.collection('token_transactions').insertOne({
			user: 'A', reward_activity: 'market_purchase', token_count: -400, date: new Date(DAY1),
		});
		await afit.reconcileBalance(db, 'A');
		expect(await afit.balanceOf(db, 'A')).toBe(0);

		// and earns elsewhere on the day the retry lands, eating their daily room
		await db.collection('token_transactions').insertOne({
			user: 'A', reward_activity: 'arena_challenge:chOther', token_count: 300,
			challenge_id: 'chOther', date: new Date(DAY2),
		});

		const retry = await afit.creditAfitReward(db, { user: 'A', challengeId: 'chBig', amount: 400, at: DAY2, dailyCap: 500, weeklyBudget: 50000 });
		expect(retry.ok).toBe(true);
		expect(retry.credited).toBe(400);                       // NOT the recomputed 200
		expect(retry.heldAtBanked).toEqual({ recomputed: 200, banked: 400 });

		const row = await db.collection('token_transactions').findOne({ user: 'A', reward_activity: 'arena_challenge:chBig' });
		expect(row.token_count).toBe(400);
		expect(await afit.balanceOf(db, 'A')).toBe(300);        // never negative
	});

	// A fully drained budget must still report a shortfall, or the caller cannot tell
	// "wait for next week" from "this prize is bigger than the entire budget and will
	// never fit". The zero path used to return before the shortfall was built.
	test('a fully drained budget still reports a shortfall, and flags the unsatisfiable case', async () => {
		const db = createMockDb();
		db.collection('token_transactions').__seed([
			{ user: 'x', reward_activity: 'arena_challenge:chEarlier', token_count: 50000,
			  challenge_id: 'chEarlier', date: new Date(AT) },
		]);
		// ordinary exhaustion: the prize would fit a fresh budget
		const ordinary = await afit.creditAfitReward(db, { user: 'y', challengeId: 'chA', amount: 400, at: AT, dailyCap: 500, weeklyBudget: 50000 });
		expect(ordinary).toMatchObject({ ok: false, credited: 0, cappedBy: 'weekly_budget' });
		expect(ordinary.shortfall).toMatchObject({ requested: 400, available: 0, unsatisfiable: false });

		// misconfiguration: the prize exceeds the WHOLE budget, so waiting never helps
		const never = await afit.creditAfitReward(db, { user: 'y', challengeId: 'chB', amount: 60000, at: AT, dailyCap: 500, weeklyBudget: 50000 });
		expect(never.shortfall).toMatchObject({ requested: 60000, unsatisfiable: true });
	});

	// Product decision (2026-09-27): the per-user daily cap does not apply to contest
	// prizes. It was anti-farming for ACTIVITY rewards; a prize cannot be farmed, each
	// contest's schedule already bounds it, and all six defaults settle in the same
	// sweep - so the cap only ever clipped a legitimate multi-contest winner, and that
	// clipped figure went on-chain as the prize, permanently.
	test('dailyCap 0 disables the per-user cap entirely', async () => {
		const db = createMockDb();
		db.collection('token_transactions').__seed([
			arenaRow('ace', 'chEarlier', 480, '2026-08-26T01:00:00Z'),
		]);
		// with a 500 cap this would clip to 20; with the cap off it pays in full
		const res = await afit.creditAfitReward(db, { user: 'ace', challengeId: 'chBig', amount: 400, at: AT, dailyCap: 0, weeklyBudget: 50000 });
		expect(res).toMatchObject({ ok: true, credited: 400, capped: false });
		expect(await afit.balanceOf(db, 'ace')).toBe(880);
	});

	test('the weekly treasury budget still binds when the daily cap is off', async () => {
		const db = createMockDb();
		db.collection('token_transactions').__seed([
			arenaRow('ace', 'chEarlier', 49800, '2026-08-26T01:00:00Z'),
		]);
		// the treasury guard is untouched: 200 left, 400 asked for -> refuse, not clip
		const res = await afit.creditAfitReward(db, { user: 'ace', challengeId: 'chBig', amount: 400, at: AT, dailyCap: 0, weeklyBudget: 50000 });
		expect(res).toMatchObject({ ok: false, cappedBy: 'weekly_budget', credited: 0 });
	});

	test('an ABSENT dailyCap still falls back to the 500 default', async () => {
		const db = createMockDb();
		db.collection('token_transactions').__seed([
			arenaRow('ace', 'chEarlier', 480, '2026-08-26T01:00:00Z'),
		]);
		// a direct caller that forgets the param must not get an uncapped credit
		const res = await afit.creditAfitReward(db, { user: 'ace', challengeId: 'chBig', amount: 400, at: AT, weeklyBudget: 50000 });
		expect(res.credited).toBe(20);
	});

	// The weekly treasury budget is bucketed by the ledger row's `date`. Because the
	// write is a replaceOne, a re-credit used to MOVE that date to the retry time - so
	// a challenge credited in week 1 but healed in week 2 had its week-1 emission
	// re-charged against week 2's budget, for money already paid and possibly spent.
	test('a re-credit keeps the ORIGINAL credit date, so weeks are not re-charged', async () => {
		const db = createMockDb();
		const WEEK1 = '2026-08-26T10:00:00Z';
		const WEEK2 = '2026-09-03T10:00:00Z';

		await afit.creditAfitReward(db, { user: 'A', challengeId: 'chBig', amount: 400, at: WEEK1, dailyCap: 0, weeklyBudget: 50000 });
		const before = await db.collection('token_transactions').findOne({ user: 'A', reward_activity: 'arena_challenge:chBig' });
		expect(new Date(before.date).getTime()).toBe(Date.parse(WEEK1));

		// the challenge stalls and is retried a week later
		await afit.creditAfitReward(db, { user: 'A', challengeId: 'chBig', amount: 400, at: WEEK2, dailyCap: 0, weeklyBudget: 50000 });
		const after = await db.collection('token_transactions').findOne({ user: 'A', reward_activity: 'arena_challenge:chBig' });
		expect(new Date(after.date).getTime()).toBe(Date.parse(WEEK1));   // NOT moved to WEEK2
		expect(after.token_count).toBe(400);                       // and not doubled

		// so week 2's budget is untouched by week 1's payout: a fresh 50,000 is available
		const fresh = await afit.creditAfitReward(db, { user: 'B', challengeId: 'chNew', amount: 49999, at: WEEK2, dailyCap: 0, weeklyBudget: 50000 });
		expect(fresh).toMatchObject({ ok: true, credited: 49999 });
	});

	test('a FIRST credit is stamped with the time it actually happened', async () => {
		const db = createMockDb();
		const AT2 = '2026-08-26T10:00:00Z';
		await afit.creditAfitReward(db, { user: 'C', challengeId: 'chX', amount: 10, at: AT2, dailyCap: 0, weeklyBudget: 50000 });
		const row = await db.collection('token_transactions').findOne({ user: 'C', reward_activity: 'arena_challenge:chX' });
		expect(new Date(row.date).getTime()).toBe(Date.parse(AT2));
	});

	test('reconcileBalance still sums the users WHOLE ledger, arena and not', async () => {
		const db = createMockDb();
		db.collection('token_transactions').__seed([
			arenaRow('erin', 'chA', 10, '2026-08-26T01:00:00Z'),
			{ user: 'erin', reward_activity: 'Post', token_count: 90, date: new Date('2026-01-01T00:00:00Z') },
			{ user: 'erin', reward_activity: 'Comment', token_count: 5, date: new Date('2025-06-01T00:00:00Z') },
			{ user: 'frank', reward_activity: 'Post', token_count: 999, date: new Date('2026-08-26T01:00:00Z') },
		]);
		expect(await afit.reconcileBalance(db, 'erin')).toBe(105);
		expect(await afit.balanceOf(db, 'erin')).toBe(105);
	});
});

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

	// The `arena_credit_unique` index turns the loser of a genuine race from a silent
	// double-insert into an E11000. That throw MUST NOT escape: creditAfitReward runs
	// inside arena_pools.resolveChallenge's payout loop, so escaping would abandon a
	// resolution mid-payout with some winners paid, pools.paid un-updated and no
	// settle broadcast. The mock cannot enforce a unique index, so force the raise.
	test('a duplicate-key race reports the amount ALREADY banked instead of throwing', async () => {
		const db = createMockDb();
		// the row the racing writer already committed
		await afit.creditAfitReward(db, { user: 'a', challengeId: 'chR', amount: 60, at: AT });

		const ledger = db.collection('token_transactions');
		const real = ledger.replaceOne;
		ledger.replaceOne = async () => {
			const e = new Error('E11000 duplicate key error collection: token_transactions index: arena_credit_unique');
			e.code = 11000;
			throw e;
		};
		const res = await afit.creditAfitReward(db, { user: 'a', challengeId: 'chR', amount: 60, at: AT });
		ledger.replaceOne = real;

		expect(res.ok).toBe(true);
		expect(res.raced).toBe(true);
		expect(res.credited).toBe(60);          // what is actually banked, not what we intended
		expect(await afit.balanceOf(db, 'a')).toBe(60);   // never doubled
		const rows = await ledger.find({ user: 'a', reward_activity: 'arena_challenge:chR' }).toArray();
		expect(rows.length).toBe(1);
	});

	test('a NON-duplicate write error still propagates — we must not swallow real failures', async () => {
		const db = createMockDb();
		const ledger = db.collection('token_transactions');
		ledger.replaceOne = async () => { throw new Error('connection reset'); };
		await expect(
			afit.creditAfitReward(db, { user: 'a', challengeId: 'chE', amount: 10, at: AT })
		).rejects.toThrow('connection reset');
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
			// only 30 of the 100 weekly budget remains, so a 70 prize no longer fits.
			// It is REFUSED rather than part-paid at 30 - a reduced figure would be
			// settled on-chain permanently for a winner who earned the full amount.
			const r2 = await afit.creditAfitReward(db, { user: 'b', challengeId: 'chB', amount: 70, at: AT, weeklyBudget: 100 });
			expect(r2).toMatchObject({ ok: false, capped: true, credited: 0, cappedBy: 'weekly_budget' });
			expect(r2.shortfall).toMatchObject({ requested: 70, available: 30, unsatisfiable: false });
			// a prize that fits the remaining 30 still pays, so the budget is not wasted
			const r2b = await afit.creditAfitReward(db, { user: 'b', challengeId: 'chB2', amount: 30, at: AT, weeklyBudget: 100 });
			expect(r2b).toMatchObject({ ok: true, credited: 30 });
			// now genuinely exhausted
			const r3 = await afit.creditAfitReward(db, { user: 'c', challengeId: 'chC', amount: 50, at: AT, weeklyBudget: 100 });
			expect(r3).toMatchObject({ ok: false, capped: true, credited: 0, cappedBy: 'weekly_budget' });
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
		expect(calls[0].opts.partialFilterExpression).toEqual({ challenge_id: { $type: 'string' } });
	});

	test('is a safe no-op where createIndex is unavailable (test mock / old driver)', async () => {
		const db = { collection: () => ({}) };
		await expect(afit.ensureAfitIndexes(db)).resolves.toBeUndefined();
	});
});
