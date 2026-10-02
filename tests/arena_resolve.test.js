/**
 * Challenge Engine — resolution/settlement sweep + recurrence (F5) — tests.
 */

const { createMockDb } = require('./helpers/mock-db');
const jobs = require('../arena_jobs');
const afit = require('../arena_afit');

const post = (author, dateISO, step_count) => ({
	author, permlink: `p-${author}-${dateISO}`, date: new Date(dateISO), json_metadata: { step_count },
});

// A window that has already CLOSED relative to the test's `now`.
const CLOSED = { start: '2026-08-01T00:00:00Z', end: '2026-08-08T00:00:00Z', tz: 'UTC' };
const NOW = '2026-08-10T00:00:00Z';

function seed() {
	const db = createMockDb();
	db.collection('challenges').__seed([
		{ id: 'def_weekly_step_league', state: 'open', type: 'league_fixture', window: CLOSED,
		  scoring: { metric: 'activity_count', rule: 'max' }, recurrence: 'Weekly', art: 'step-league',
		  origin_tier: 'official', title: 'Weekly Step League' },
		{ id: 'ch_future', state: 'open', type: 'duel',
		  window: { start: '2026-08-05T00:00:00Z', end: '2026-08-20T00:00:00Z' },
		  scoring: { metric: 'activity_count', rule: 'max' } },
	]);
	db.collection('challenge_participants').__seed([
		{ challenge_id: 'def_weekly_step_league', entity: 'alice', flags: [], state: 'enrolled' },
		{ challenge_id: 'def_weekly_step_league', entity: 'bob', flags: [], state: 'enrolled' },
		{ challenge_id: 'def_weekly_step_league', entity: 'quit', flags: [], state: 'left' },
	]);
	db.collection('verified_posts').__seed([
		post('alice', '2026-08-03T10:00:00Z', 9000),
		post('bob', '2026-08-03T10:00:00Z', 5000),
		post('quit', '2026-08-03T10:00:00Z', 99999), // would win — but they left
	]);
	return db;
}

describe('arena_jobs.resolveDueChallenges', () => {
	test('resolves a due challenge: AFIT credited, results recorded, events fired', async () => {
		const db = seed();
		const sent = [];
		const res = await jobs.resolveDueChallenges(db, { now: NOW, broadcastOp: async (op) => { sent.push(op); return { id: 'trx_' + op.op }; } });

		expect(res.resolved).toBe(1);      // only the due one (ch_future is skipped)
		expect(res.skipped).toBe(1);       // ch_future window still open
		expect(res.failed).toBe(0);

		// alice (rank 1) gets 100 AFIT, bob (rank 2) gets 60; 'quit' (left) gets nothing.
		expect(await afit.balanceOf(db, 'alice')).toBe(100);
		expect(await afit.balanceOf(db, 'bob')).toBe(60);
		expect(await afit.balanceOf(db, 'quit')).toBe(0);

		// resolution marker written (idempotent guard)
		expect(await db.collection('challenge_resolutions').findOne({ challenge_id: 'def_weekly_step_league' })).toBeTruthy();

		// F6 events for the rewarded finishers
		const aliceEvents = await db.collection('arena_events').find({ user: 'alice', type: 'results_settled' }).toArray();
		expect(aliceEvents.length).toBe(1);
		expect(aliceEvents[0].data).toMatchObject({ rank: 1, afit: 100 });
	});

	test('broadcasts the settle op AND a rolled next-occurrence for a recurring default', async () => {
		const db = seed();
		const sent = [];
		await jobs.resolveDueChallenges(db, { now: NOW, broadcastOp: async (op) => { sent.push(op); return { id: 'trx_' + op.op + '_' + (op.id || '') }; } });

		const settle = sent.find((o) => o.op === 'settle');
		expect(settle).toBeTruthy();
		expect(settle.challenge_id).toBe('def_weekly_step_league');

		const create = sent.find((o) => o.op === 'challenge_create');
		expect(create).toBeTruthy();
		expect(create.origin_tier).toBe('official');
		expect(create.parent_id).toBe('def_weekly_step_league');
		expect(create.id).toMatch(/^def_weekly_step_league@/);
		expect(create.art).toBe('step-league');          // presentation carried
		// next window starts where the old one ended, same 7-day length
		expect(create.window.start).toBe('2026-08-08T00:00:00.000Z');
		expect(create.window.end).toBe('2026-08-15T00:00:00.000Z');
	});

	test('idempotent: a second run does not re-credit AFIT, re-broadcast settle, or re-roll', async () => {
		const db = seed();
		const mk = () => { const sent = []; return { sent, fn: async (op) => { sent.push(op); return { id: 'trx_' + op.op }; } }; };
		const first = mk();
		await jobs.resolveDueChallenges(db, { now: NOW, broadcastOp: first.fn });
		const second = mk();
		const res2 = await jobs.resolveDueChallenges(db, { now: NOW, broadcastOp: second.fn });

		// balances unchanged
		expect(await afit.balanceOf(db, 'alice')).toBe(100);
		expect(res2.resolved).toBe(0);          // prior resolution → noop
		// settle not re-sent (marker has settle_trx); recurrence next-id now exists → not re-rolled
		expect(second.sent.find((o) => o.op === 'settle')).toBeFalsy();
		expect(second.sent.find((o) => o.op === 'challenge_create')).toBeFalsy();
	});

	test('goal challenge: only finishers who met the daily threshold are paid (anti-farm)', async () => {
		const db = createMockDb();
		db.collection('challenges').__seed([
			{ id: 'def_daily_focus', state: 'open', type: 'daily_focus', window: CLOSED,
			  scoring: { metric: 'goal_hit', rule: 'threshold', threshold: 10000 }, recurrence: 'Daily',
			  origin_tier: 'official', title: 'Daily Focus Goal', art: 'daily-focus' },
		]);
		db.collection('challenge_participants').__seed([
			{ challenge_id: 'def_daily_focus', entity: 'achiever', flags: [], state: 'enrolled' },
			{ challenge_id: 'def_daily_focus', entity: 'farmer', flags: [], state: 'enrolled' },
		]);
		db.collection('verified_posts').__seed([
			post('achiever', '2026-08-03T10:00:00Z', 12000), // met the 10k goal
			post('farmer', '2026-08-03T10:00:00Z', 1),       // 1 step — did not
		]);
		await jobs.resolveDueChallenges(db, { now: NOW, broadcastOp: async (op) => ({ id: 'trx_' + op.op }) });
		expect(await afit.balanceOf(db, 'achiever')).toBe(50); // def_daily_focus flat 50 AFIT
		expect(await afit.balanceOf(db, 'farmer')).toBe(0);
	});

	test('crash-retry on a CAPPED reward keeps the recorded AFIT at the capped amount (no re-inflation, no double-credit)', async () => {
		const db = seed();
		// alice would earn 100 (rank 1) but has already earned 250 arena AFIT today,
		// so only 50 can land (300/day cap).
		await afit.creditAfitReward(db, { user: 'alice', challengeId: 'earlier', amount: 250, at: NOW });
		await jobs.resolveDueChallenges(db, { now: NOW, afitDailyCap: 300, broadcastOp: async (op) => ({ id: 'trx_' + op.op }) });
		const p1 = await db.collection('challenge_participants').findOne({ challenge_id: 'def_weekly_step_league', entity: 'alice' });
		expect(p1.result.reward.afit).toBe(50);   // capped, recorded accurately
		expect(await afit.balanceOf(db, 'alice')).toBe(300);
		// Simulate a crash BEFORE the resolution marker persisted: wipe it, re-resolve.
		await db.collection('challenge_resolutions').deleteMany({});
		await jobs.resolveDueChallenges(db, { now: NOW, afitDailyCap: 300, broadcastOp: async (op) => ({ id: 'trx2_' + op.op }) });
		const p2 = await db.collection('challenge_participants').findOne({ challenge_id: 'def_weekly_step_league', entity: 'alice' });
		expect(p2.result.reward.afit).toBe(50);   // STILL 50 — not re-inflated to 100
		expect(await afit.balanceOf(db, 'alice')).toBe(300); // not double-credited
	});

	test('without a broadcaster: AFIT still credited, no settle/recurrence', async () => {
		const db = seed();
		const res = await jobs.resolveDueChallenges(db, { now: NOW });
		expect(res.resolved).toBe(1);
		expect(res.settled).toBe(0);
		expect(res.recurred).toBe(0);
		expect(await afit.balanceOf(db, 'alice')).toBe(100);
	});
});

describe('arena_jobs.nextOccurrence / isRecurringDefault', () => {
	test('isRecurringDefault only for def_* with a known recurrence', () => {
		expect(jobs.isRecurringDefault({ id: 'def_daily_focus', recurrence: 'Daily' })).toBe(true);
		expect(jobs.isRecurringDefault({ id: 'ch_user', recurrence: 'Weekly' })).toBe(false);
		expect(jobs.isRecurringDefault({ id: 'def_x', recurrence: 'Never' })).toBe(false);
		expect(jobs.isRecurringDefault({ id: 'def_daily_focus@2026-09-10', parent_id: 'def_daily_focus', recurrence: 'Daily' })).toBe(true);
	});

	test('nextOccurrence skips ahead past a long outage so the new window is current', () => {
		const ch = { id: 'def_daily_focus', parent_id: undefined, recurrence: 'Daily',
			window: { start: '2026-08-01T00:00:00Z', end: '2026-08-02T00:00:00Z', tz: 'UTC' }, type: 'daily_focus', scoring: {} };
		const next = jobs.nextOccurrence(ch, Date.parse('2026-08-10T00:00:00Z'));
		// window length 1 day; rolled forward to contain "now"
		expect(Date.parse(next.window.end)).toBeGreaterThanOrEqual(Date.parse('2026-08-10T00:00:00Z'));
		expect(next.parent_id).toBe('def_daily_focus');
	});

	test('cadence comes from recurrence, NOT window length (Weekend Warrior regression)', () => {
		// def_weekend_warrior is a 2-DAY window that recurs WEEKLY. Rolling by window
		// length made it repeat every 2 days and walk off the weekend permanently
		// (seen in production 2026-09-25). It must roll +7d and stay 2 days long.
		const ch = {
			id: 'def_weekend_warrior', recurrence: 'Weekly', type: 'liveops', scoring: {},
			window: { start: '2026-09-25T13:06:00Z', end: '2026-09-27T13:06:00Z', tz: 'UTC' },
		};
		const next = jobs.nextOccurrence(ch, Date.parse('2026-09-27T14:00:00Z'));
		expect(next.window.start).toBe('2026-10-02T13:06:00.000Z'); // +7d, still a Friday
		expect(next.window.end).toBe('2026-10-04T13:06:00.000Z');   // still 2 days long
		expect(Date.parse(next.window.end) - Date.parse(next.window.start)).toBe(2 * 24 * 3600 * 1000);
		expect(next.id).toBe('def_weekend_warrior@2026-10-02');
	});

	test('the other five defaults are unchanged (cadence == window length)', () => {
		const cases = [
			['def_daily_focus', 'Daily', '2026-09-25T13:06:00Z', '2026-09-26T13:06:00Z', '2026-09-26T13:06:00.000Z'],
			['def_weekly_step_league', 'Weekly', '2026-09-23T13:06:00Z', '2026-09-30T13:06:00Z', '2026-09-30T13:06:00.000Z'],
			['def_weekly_top_n', 'Weekly', '2026-09-23T13:06:00Z', '2026-09-30T13:06:00Z', '2026-09-30T13:06:00.000Z'],
			['def_season_ladder', 'Seasonal', '2026-09-23T13:06:00Z', '2026-10-07T13:06:00Z', '2026-10-07T13:06:00.000Z'],
			['def_monthly_liveops', 'Monthly', '2026-09-23T13:06:00Z', '2026-10-23T13:06:00Z', '2026-10-23T13:06:00.000Z'],
		];
		for (const [id, recurrence, start, end, expectedStart] of cases) {
			const next = jobs.nextOccurrence({ id, recurrence, type: 'liveops', scoring: {}, window: { start, end, tz: 'UTC' } }, Date.parse(end) + 1000);
			// next window starts exactly where the old one ended, as before the fix
			expect([id, next.window.start]).toEqual([id, expectedStart]);
		}
	});

	test('an unknown recurrence falls back to window length and never loops forever', () => {
		const ch = { id: 'def_odd', recurrence: 'Fortnightly', type: 'liveops', scoring: {},
			window: { start: '2026-09-01T00:00:00Z', end: '2026-09-03T00:00:00Z', tz: 'UTC' } };
		// isRecurringDefault gates on a KNOWN recurrence, so this is null rather than a hang
		expect(jobs.isRecurringDefault(ch)).toBe(false);
		expect(jobs.nextOccurrence(ch, Date.now())).toBeNull();
	});
});

// End-to-end cover for the branch the reviewers flagged as untested: what the
// SWEEP does when the weekly treasury is dry. The unit tests prove resolveChallenge
// refuses; this proves the consequences that refusal has at the sweep level - no
// settle op broadcast, no recurrence roll, no marker - because those are the
// product decision, not an implementation detail.
describe('arena_jobs.resolveDueChallenges — weekly budget exhausted', () => {
	function seedDry() {
		const db = createMockDb();
		db.collection('challenges').__seed([
			{ id: 'def_weekly_step_league', state: 'open', type: 'league_fixture', window: CLOSED,
			  scoring: { metric: 'activity_count', rule: 'max' }, recurrence: 'Weekly',
			  origin_tier: 'official', title: 'Weekly Step League' },
		]);
		db.collection('challenge_participants').__seed([
			{ challenge_id: 'def_weekly_step_league', entity: 'alice', state: 'enrolled', flags: [] },
		]);
		db.collection('verified_posts').__seed([
			post('alice', '2026-08-02T10:00:00Z', 12000),
			post('alice', '2026-08-03T10:00:00Z', 11000),
		]);
		// the week's entire treasury budget is already spent
		db.collection('token_transactions').__seed([
			{ user: 'someoneelse', reward_activity: 'arena_challenge:chEarlier', token_count: 50000,
			  challenge_id: 'chEarlier', date: new Date('2026-08-09T00:00:00Z') },
		]);
		return db;
	}

	test('broadcasts NO settle op, rolls NO recurrence, writes NO marker', async () => {
		const db = seedDry();
		const sent = [];
		const res = await jobs.resolveDueChallenges(db, {
			now: NOW,
			afitDailyCap: 500,
			afitWeeklyBudget: 50000,
			broadcastOp: async (op) => { sent.push(op); return { id: 'trx_' + op.op }; },
		});

		expect(res.failed).toBe(1);
		expect(res.settled).toBe(0);
		expect(res.recurred).toBe(0);
		// nothing at all went to the chain - not a settle, not a next occurrence
		expect(sent).toHaveLength(0);
		expect(await db.collection('challenge_resolutions')
			.findOne({ challenge_id: 'def_weekly_step_league' })).toBeFalsy();
		// and the challenge stays live so a later sweep picks it up again
		const ch = await db.collection('challenges').findOne({ id: 'def_weekly_step_league' });
		expect(ch.state).toBe('open');
	});

	test('the very same sweep settles and rolls once the budget is there', async () => {
		const db = seedDry();
		// clear the pre-spend: this is the only difference from the test above
		await db.collection('token_transactions').deleteMany({ user: 'someoneelse' });

		const sent = [];
		const res = await jobs.resolveDueChallenges(db, {
			now: NOW,
			afitDailyCap: 500,
			afitWeeklyBudget: 50000,
			broadcastOp: async (op) => { sent.push(op); return { id: 'trx_' + op.op }; },
		});

		expect(res.failed).toBe(0);
		expect(res.settled).toBe(1);
		expect(sent.some((o) => o.op === 'settle')).toBe(true);
		expect(await db.collection('challenge_resolutions')
			.findOne({ challenge_id: 'def_weekly_step_league' })).toBeTruthy();
	});
});

// A stalled Arena used to be indistinguishable from a healthy idle one: the sweep
// summary was discarded by the caller, the only trace was a line in arena.log on one
// box, and every documented health check kept passing. Worse, when the treasury is
// dry the recurrence roll is skipped too, so not even the challenge list changes.
describe('arena_jobs.recordResolveHealth', () => {
	const AT = (n) => '2026-08-10T0' + n + ':35:00Z';
	const stalledSweep = (extra = {}) => ({ ok: true, processed: 1, resolved: 0, settled: 0, recurred: 0, failed: 1, skipped: 0, budgetExhausted: 0, ...extra });
	const goodSweep = { ok: true, processed: 1, resolved: 1, settled: 1, recurred: 1, failed: 0, skipped: 0, budgetExhausted: 0 };
	const idleSweep = { ok: true, processed: 0, resolved: 0, settled: 0, recurred: 0, failed: 0, skipped: 0, budgetExhausted: 0 };

	test('a sweep with nothing due is IDLE, not stalled — no alarm', async () => {
		const db = createMockDb();
		const r = await jobs.recordResolveHealth(db, idleSweep, { asOf: AT(1) });
		expect(r.alert).toBeNull();
		expect(r.health.stalled_ticks).toBe(0);
		expect(r.health.alerting).toBe(false);
	});

	test('one failing sweep does not page — two does, and only once', async () => {
		const db = createMockDb();

		const first = await jobs.recordResolveHealth(db, stalledSweep(), { asOf: AT(1) });
		expect(first.alert).toBeNull();            // could be a transient RPC blip
		expect(first.health.stalled_ticks).toBe(1);

		const second = await jobs.recordResolveHealth(db, stalledSweep({ budgetExhausted: 1 }), { asOf: AT(2) });
		expect(second.alert).not.toBeNull();
		expect(second.alert.kind).toBe('budget_exhausted');
		expect(second.alert.subject).toMatch(/budget exhausted/i);
		expect(second.alert.body).toMatch(/No wrong reward has been written/);

		// still stuck an hour later: state recorded, but NOT paged again
		const third = await jobs.recordResolveHealth(db, stalledSweep({ budgetExhausted: 1 }), { asOf: AT(3) });
		expect(third.alert).toBeNull();
		expect(third.health.stalled_ticks).toBe(3);
		expect(third.health.alerting).toBe(true);
		expect(third.health.stalled_since).toBe(AT(1));   // when it ACTUALLY started
	});

	test('recovery pages exactly once, then goes quiet', async () => {
		const db = createMockDb();
		await jobs.recordResolveHealth(db, stalledSweep(), { asOf: AT(1) });
		await jobs.recordResolveHealth(db, stalledSweep(), { asOf: AT(2) });

		const recovered = await jobs.recordResolveHealth(db, goodSweep, { asOf: AT(3) });
		expect(recovered.alert.kind).toBe('recovered');
		expect(recovered.health.alerting).toBe(false);
		expect(recovered.health.stalled_ticks).toBe(0);
		expect(recovered.health.last_success_at).toBe(AT(3));

		const quiet = await jobs.recordResolveHealth(db, goodSweep, { asOf: AT(4) });
		expect(quiet.alert).toBeNull();
	});

	test('a non-budget failure is reported as NOT self-healing', async () => {
		const db = createMockDb();
		await jobs.recordResolveHealth(db, stalledSweep(), { asOf: AT(1) });
		const r = await jobs.recordResolveHealth(db, stalledSweep(), { asOf: AT(2) });
		expect(r.alert.kind).toBe('settlement_stalled');
		expect(r.alert.body).toMatch(/will not clear on its own/);
	});

	// A stuck challenge used to be MASKED by any other challenge settling in the same
	// sweep: five due, four settle, one fails forever -> never alerts, while that
	// contest's winners are never paid. It also made the alarm's sensitivity depend on
	// what else coincidentally closed that hour.
	test('a failing challenge still alarms even when others settle', async () => {
		const db = createMockDb();
		const mixed = { ok: true, processed: 5, resolved: 4, settled: 4, recurred: 4, failed: 1, skipped: 0, budgetExhausted: 0 };
		await jobs.recordResolveHealth(db, mixed, { asOf: AT(1) });
		const r = await jobs.recordResolveHealth(db, mixed, { asOf: AT(2) });
		expect(r.alert).not.toBeNull();
		expect(r.alert.kind).toBe('settlement_stalled');
	});

	// `settled` only counts successful BROADCASTS. With no posting key the sweep
	// credits AFIT and writes resolutions but nothing reaches the chain, reporting
	// failed:0 settled:0 - which read as perfectly healthy.
	test('no broadcaster alarms immediately, and is its own diagnosis', async () => {
		const db = createMockDb();
		const looksFine = { ok: true, processed: 1, resolved: 1, settled: 0, recurred: 0, failed: 0, skipped: 0, budgetExhausted: 0 };

		const quiet = await jobs.recordResolveHealth(db, looksFine, { asOf: AT(1) });
		expect(quiet.alert).toBeNull();          // with a broadcaster this is just idle

		const db2 = createMockDb();
		const r = await jobs.recordResolveHealth(db2, looksFine, { asOf: AT(1), canBroadcast: false });
		expect(r.alert.kind).toBe('cannot_broadcast');
		expect(r.alert.body).toMatch(/POSTING key/);
		expect(r.health.can_broadcast).toBe(false);
		// and it does not wait two ticks - it never fixes itself
		expect(r.health.alerting).toBe(true);
	});

	// An all-clear must be EARNED. Clearing on any non-stalled sweep meant an IDLE
	// sweep mailed "settlement has recovered" with nothing settled.
	test('an idle sweep does NOT mail a false all-clear', async () => {
		const db = createMockDb();
		const stalled = { ok: true, processed: 1, resolved: 0, settled: 0, recurred: 0, failed: 1, skipped: 0, budgetExhausted: 0 };
		const idle = { ok: true, processed: 0, resolved: 0, settled: 0, recurred: 0, failed: 0, skipped: 0, budgetExhausted: 0 };
		await jobs.recordResolveHealth(db, stalled, { asOf: AT(1) });
		await jobs.recordResolveHealth(db, stalled, { asOf: AT(2) });

		const stillNothing = await jobs.recordResolveHealth(db, idle, { asOf: AT(3) });
		expect(stillNothing.alert).toBeNull();   // NOT "recovered"

		const real = await jobs.recordResolveHealth(db, { ...idle, settled: 1 }, { asOf: AT(4) });
		expect(real.alert.kind).toBe('recovered');
	});

	test('checkResolveHeartbeat catches the sweep not running at all', async () => {
		const db = createMockDb();
		await jobs.recordResolveHealth(db, { ok: true, processed: 0, resolved: 0, settled: 0, recurred: 0, failed: 0, skipped: 0 }, { asOf: '2026-08-10T01:35:00Z' });

		// an hour later: normal
		const fine = await jobs.checkResolveHeartbeat(db, { now: Date.parse('2026-08-10T02:40:00Z') });
		expect(fine.stale).toBe(false);
		expect(fine.alert).toBeNull();

		// four hours later: two ticks missed
		const dead = await jobs.checkResolveHeartbeat(db, { now: Date.parse('2026-08-10T05:40:00Z') });
		expect(dead.stale).toBe(true);
		expect(dead.alert.kind).toBe('resolve_not_running');
		// and it does not re-page every 15 minutes
		const again = await jobs.checkResolveHeartbeat(db, { now: Date.parse('2026-08-10T05:55:00Z') });
		expect(again.alert).toBeNull();
	});

	test('checkResolveHeartbeat does not alarm on a box that has never run a sweep', async () => {
		const db = createMockDb();
		const r = await jobs.checkResolveHeartbeat(db, { now: Date.now() });
		expect(r.stale).toBe(false);
		expect(r.alert).toBeNull();
	});

	test('the health record is queryable — the check on-call can actually run', async () => {
		const db = createMockDb();
		await jobs.recordResolveHealth(db, goodSweep, { asOf: AT(1) });
		const doc = await db.collection(jobs.HEALTH_COLLECTION).findOne({ _id: jobs.HEALTH_ID });
		expect(doc).toMatchObject({ _id: 'resolve_sweep', last_run_at: AT(1), alerting: false });
		expect(doc.last_summary.settled).toBe(1);
	});
});

// and the sweep itself now reports budget exhaustion in its summary, so the health
// recorder can tell "treasury dry" from "something else broke"
describe('resolveDueChallenges reports budgetExhausted in its summary', () => {
	test('counts the exhausted challenge', async () => {
		const db = createMockDb();
		db.collection('challenges').__seed([
			{ id: 'def_weekly_step_league', state: 'open', type: 'league_fixture', window: CLOSED,
			  scoring: { metric: 'activity_count', rule: 'max' }, recurrence: 'Weekly',
			  origin_tier: 'official', title: 'Weekly Step League' },
		]);
		db.collection('challenge_participants').__seed([
			{ challenge_id: 'def_weekly_step_league', entity: 'alice', state: 'enrolled', flags: [] },
		]);
		db.collection('verified_posts').__seed([post('alice', '2026-08-02T10:00:00Z', 12000)]);
		db.collection('token_transactions').__seed([
			{ user: 'x', reward_activity: 'arena_challenge:chEarlier', token_count: 50000,
			  challenge_id: 'chEarlier', date: new Date('2026-08-09T00:00:00Z') },
		]);

		const res = await jobs.resolveDueChallenges(db, {
			now: NOW, afitDailyCap: 500, afitWeeklyBudget: 50000,
			broadcastOp: async (op) => ({ id: 'trx_' + op.op }),
		});
		expect(res.budgetExhausted).toBe(1);
		expect(res.settled).toBe(0);
	});
});
