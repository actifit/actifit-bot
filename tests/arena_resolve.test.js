/**
 * Challenge Engine — resolution/settlement sweep + recurrence (F5) — tests.
 */

const { createMockDb } = require('./helpers/mock-db');
const jobs = require('../arena_jobs');
const meritsLib = require('../arena_merits');

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
	test('resolves a due challenge: Merits emitted, results recorded, events fired', async () => {
		const db = seed();
		const sent = [];
		const res = await jobs.resolveDueChallenges(db, { now: NOW, broadcastOp: async (op) => { sent.push(op); return { id: 'trx_' + op.op }; } });

		expect(res.resolved).toBe(1);      // only the due one (ch_future is skipped)
		expect(res.skipped).toBe(1);       // ch_future window still open
		expect(res.failed).toBe(0);

		// alice (rank 1) gets 200, bob (rank 2) gets 150; 'quit' (left) gets nothing.
		const aliceBal = await db.collection('merits_balances').findOne({ user: 'alice' });
		const bobBal = await db.collection('merits_balances').findOne({ user: 'bob' });
		const quitBal = await db.collection('merits_balances').findOne({ user: 'quit' });
		expect(aliceBal.balance).toBe(200);
		expect(bobBal.balance).toBe(150);
		expect(quitBal).toBeNull();

		// resolution marker written (idempotent guard)
		expect(await db.collection('challenge_resolutions').findOne({ challenge_id: 'def_weekly_step_league' })).toBeTruthy();

		// F6 events for the two rewarded finishers
		const aliceEvents = await db.collection('arena_events').find({ user: 'alice', type: 'results_settled' }).toArray();
		expect(aliceEvents.length).toBe(1);
		expect(aliceEvents[0].data).toMatchObject({ rank: 1, merits: 200 });
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

	test('idempotent: a second run does not re-emit Merits, re-broadcast settle, or re-roll', async () => {
		const db = seed();
		const mk = () => { const sent = []; return { sent, fn: async (op) => { sent.push(op); return { id: 'trx_' + op.op }; } }; };
		const first = mk();
		await jobs.resolveDueChallenges(db, { now: NOW, broadcastOp: first.fn });
		const second = mk();
		const res2 = await jobs.resolveDueChallenges(db, { now: NOW, broadcastOp: second.fn });

		// balances unchanged
		expect((await db.collection('merits_balances').findOne({ user: 'alice' })).balance).toBe(200);
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
		expect((await db.collection('merits_balances').findOne({ user: 'achiever' })).balance).toBe(20);
		expect(await db.collection('merits_balances').findOne({ user: 'farmer' })).toBeNull();
	});

	test('crash-retry on a CAPPED reward keeps the recorded merits at the capped amount (no re-inflation, no double-credit)', async () => {
		const db = seed();
		// alice would earn 200 (rank 1) but has already earned 900 Merits today, so
		// only 100 can land (1000/day cap).
		await meritsLib.award(db, { user: 'alice', amount: 900, reason: 'challenge_reward', ref: 'earlier', at: NOW });
		await jobs.resolveDueChallenges(db, { now: NOW, broadcastOp: async (op) => ({ id: 'trx_' + op.op }) });
		const p1 = await db.collection('challenge_participants').findOne({ challenge_id: 'def_weekly_step_league', entity: 'alice' });
		expect(p1.result.reward.merits).toBe(100);   // capped, recorded accurately
		expect((await db.collection('merits_balances').findOne({ user: 'alice' })).balance).toBe(1000);
		// Simulate a crash BEFORE the resolution marker persisted: wipe it, re-resolve.
		await db.collection('challenge_resolutions').deleteMany({});
		await jobs.resolveDueChallenges(db, { now: NOW, broadcastOp: async (op) => ({ id: 'trx2_' + op.op }) });
		const p2 = await db.collection('challenge_participants').findOne({ challenge_id: 'def_weekly_step_league', entity: 'alice' });
		expect(p2.result.reward.merits).toBe(100);   // STILL 100 — not re-inflated to 200
		expect((await db.collection('merits_balances').findOne({ user: 'alice' })).balance).toBe(1000); // not double-credited
	});

	test('without a broadcaster: Merits still emitted, no settle/recurrence', async () => {
		const db = seed();
		const res = await jobs.resolveDueChallenges(db, { now: NOW });
		expect(res.resolved).toBe(1);
		expect(res.settled).toBe(0);
		expect(res.recurred).toBe(0);
		expect((await db.collection('merits_balances').findOne({ user: 'alice' })).balance).toBe(200);
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
});
