/**
 * Challenge Engine — user notifications (results + closing-soon reminders).
 */

const { createMockDb } = require('./helpers/mock-db');
const notify = require('../arena_notify');
const jobs = require('../arena_jobs');

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-08-10T12:00:00Z');

const post = (author, dateISO, step_count) => ({
	author, permlink: `p-${author}-${dateISO}`, date: new Date(dateISO), json_metadata: { step_count },
});

function recorder() {
	const sent = [];
	return { sent, hook: async (n) => { sent.push(n); return true; } };
}

describe('arena_notify messages', () => {
	const official = (title) => ({ id: 'ch_x', title, origin_tier: 'official', visibility: 'public' });

	test('results message names rank, AFIT and a single badge', () => {
		expect(notify.resultsMessage(official('Weekly Step League'), { rank: 2, afit: 60, badges: [] }))
			.toBe('You finished #2 in "Weekly Step League" and earned 60 AFIT.');
		expect(notify.resultsMessage(official('Sprint'), { rank: 1, afit: 0, badges: ['Champ'] }))
			.toBe('You finished #1 in "Sprint" and earned the "Champ" badge.');
	});

	test('results message without a rank still says what was earned', () => {
		expect(notify.resultsMessage(official(''), { rank: null, afit: 12.5 }))
			.toBe('Results are in for "ch_x": you earned 12.5 AFIT.');
	});

	test('user-created titles are never quoted (phishing), only official public ones', () => {
		const phish = { id: 'ch_p', title: 'Your account is suspended, verify keys at evil.example',
			origin_tier: 'community', visibility: 'public' };
		expect(notify.resultsMessage(phish, { rank: 1, afit: 50 }))
			.toBe('You finished #1 in an Arena challenge and earned 50 AFIT.');
		expect(notify.closingMessage(phish, 3))
			.toBe('An Arena challenge you joined ends in about 3 hours. Post today\'s report so your activity counts.');
	});

	test('a non-public challenge is never named (the inbox is readable without login)', () => {
		expect(notify.quotableTitle({ id: 'x', title: 'Secret', origin_tier: 'official', visibility: 'private' })).toBeNull();
	});

	test('quoted titles are single-line, trimmed and capped', () => {
		expect(notify.quotableTitle(official('a\n\tb   c'))).toBe('a b c');
		const long = notify.quotableTitle(official('x'.repeat(200)));
		expect(long.length).toBe(80);
		expect(long.endsWith('…')).toBe(true);
		expect(notify.quotableTitle(official({ evil: true }))).toBe('ch_x');
	});

	test('challenge URL encodes rolled-over ids', () => {
		expect(notify.challengeUrl('def_daily_focus@2026-10-13'))
			.toBe('https://actifit.io/arena/def_daily_focus%402026-10-13');
	});
});

describe('arena_notify.notifyClosingSoon', () => {
	function seed() {
		const db = createMockDb();
		db.collection('challenges').__seed([
			// weekly, closes in 6h -> eligible
			{ id: 'weekly', state: 'open', title: 'Weekly Step League', origin_tier: 'official', visibility: 'public',
			  window: { start: new Date(NOW - 7 * 24 * HOUR + 6 * HOUR).toISOString(), end: new Date(NOW + 6 * HOUR).toISOString() } },
			// daily, closes in 6h -> excluded (would nag every day)
			{ id: 'daily', state: 'open', title: 'Daily Focus',
			  window: { start: new Date(NOW - 18 * HOUR).toISOString(), end: new Date(NOW + 6 * HOUR).toISOString() } },
			// weekly, closes in 3 days -> not yet
			{ id: 'later', state: 'open', title: 'Later',
			  window: { start: new Date(NOW - 4 * 24 * HOUR).toISOString(), end: new Date(NOW + 72 * HOUR).toISOString() } },
			// already settled -> ignored
			{ id: 'done', state: 'settled', title: 'Done',
			  window: { start: new Date(NOW - 7 * 24 * HOUR).toISOString(), end: new Date(NOW + 2 * HOUR).toISOString() } },
		]);
		db.collection('challenge_participants').__seed([
			{ challenge_id: 'weekly', entity: 'alice', state: 'enrolled' },
			{ challenge_id: 'weekly', entity: 'bob', state: 'enrolled' },
			{ challenge_id: 'weekly', entity: 'quit', state: 'left' },
			{ challenge_id: 'daily', entity: 'alice', state: 'enrolled' },
			{ challenge_id: 'later', entity: 'alice', state: 'enrolled' },
			{ challenge_id: 'done', entity: 'alice', state: 'enrolled' },
		]);
		// bob already posted today
		db.collection('verified_posts').__seed([post('bob', '2026-08-10T08:00:00Z', 9000)]);
		return db;
	}

	test('reminds only joined, not-yet-posted participants of a multi-day challenge closing soon', async () => {
		const db = seed();
		const r = recorder();
		const res = await notify.notifyClosingSoon(db, { notify: r.hook, now: NOW });

		expect(res.notified).toBe(1);
		expect(res.postedToday).toBe(1);
		expect(r.sent).toHaveLength(1);
		expect(r.sent[0]).toMatchObject({
			user: 'alice', type: 'arena_closing', category: 'arena',
			url: 'https://actifit.io/arena/weekly',
		});
		expect(r.sent[0].details).toBe('"Weekly Step League" ends in about 6 hours. Post today\'s report so your activity counts.');
	});

	test('sends each reminder once, however many sweeps run', async () => {
		const db = seed();
		const r = recorder();
		await notify.notifyClosingSoon(db, { notify: r.hook, now: NOW });
		const second = await notify.notifyClosingSoon(db, { notify: r.hook, now: NOW + HOUR });
		expect(r.sent).toHaveLength(1);
		expect(second.alreadySent).toBe(1);
	});

	test('a failing push is recorded, not retried on every tick', async () => {
		const db = seed();
		let calls = 0;
		const failing = async () => { calls++; throw new Error('fcm down'); };
		await notify.notifyClosingSoon(db, { notify: failing, now: NOW });
		await notify.notifyClosingSoon(db, { notify: failing, now: NOW + HOUR });
		expect(calls).toBe(1);
	});

	test('squad challenges are skipped (a squad id is not a user)', async () => {
		const db = seed();
		db.collection('challenges').__seed([
			{ id: 'squads', state: 'open', title: 'Squads', participants_kind: 'squad',
			  window: { start: new Date(NOW - 7 * 24 * HOUR).toISOString(), end: new Date(NOW + 3 * HOUR).toISOString() } },
		]);
		db.collection('challenge_participants').__seed([{ challenge_id: 'squads', entity: 'team_red', state: 'enrolled' }]);
		const r = recorder();
		await notify.notifyClosingSoon(db, { notify: r.hook, now: NOW });
		expect(r.sent.map((n) => n.user)).toEqual(['alice']);
	});

	test('does nothing without a notify hook', async () => {
		const res = await notify.notifyClosingSoon(seed(), { now: NOW });
		expect(res.ok).toBe(false);
	});
});

describe('resolution sends results notifications', () => {
	const CLOSED = { start: '2026-08-01T00:00:00Z', end: '2026-08-08T00:00:00Z', tz: 'UTC' };

	function seed() {
		const db = createMockDb();
		db.collection('challenges').__seed([
			{ id: 'def_weekly_step_league', state: 'open', type: 'league_fixture', window: CLOSED,
			  scoring: { metric: 'activity_count', rule: 'max' }, recurrence: 'Weekly', art: 'step-league',
			  origin_tier: 'official', visibility: 'public', title: 'Weekly Step League' },
		]);
		db.collection('challenge_participants').__seed([
			{ challenge_id: 'def_weekly_step_league', entity: 'alice', flags: [], state: 'enrolled' },
			{ challenge_id: 'def_weekly_step_league', entity: 'bob', flags: [], state: 'enrolled' },
		]);
		db.collection('verified_posts').__seed([
			post('alice', '2026-08-03T10:00:00Z', 9000),
			post('bob', '2026-08-03T10:00:00Z', 5000),
		]);
		return db;
	}

	test('each rewarded finisher is notified once, with rank and AFIT', async () => {
		const db = seed();
		const r = recorder();
		const opts = { now: '2026-08-10T00:00:00Z', notify: r.hook, broadcastOp: async (op) => ({ id: 'trx_' + op.op }) };
		await jobs.resolveDueChallenges(db, opts);
		// A second sweep finds the resolution marker and must not notify again.
		await jobs.resolveDueChallenges(db, opts);

		const byUser = Object.fromEntries(r.sent.map((n) => [n.user, n]));
		expect(r.sent).toHaveLength(2);
		expect(byUser.alice).toMatchObject({ type: 'arena_results', category: 'arena', url: 'https://actifit.io/arena/def_weekly_step_league' });
		expect(byUser.alice.details).toBe('You finished #1 in "Weekly Step League" and earned 100 AFIT.');
		expect(byUser.bob.details).toBe('You finished #2 in "Weekly Step League" and earned 60 AFIT.');
	});

	test('daily challenges get no results push (they pay every day)', async () => {
		const db = createMockDb();
		db.collection('challenges').__seed([
			{ id: 'def_daily_focus', state: 'open', type: 'daily_focus', title: 'Daily Focus Goal', origin_tier: 'official',
			  window: { start: '2026-08-08T00:00:00Z', end: '2026-08-09T00:00:00Z', tz: 'UTC' },
			  scoring: { metric: 'goal_hit', rule: 'threshold', threshold: 5000 } },
		]);
		db.collection('challenge_participants').__seed([
			{ challenge_id: 'def_daily_focus', entity: 'alice', flags: [], state: 'enrolled' },
		]);
		db.collection('verified_posts').__seed([post('alice', '2026-08-08T10:00:00Z', 9000)]);
		const r = recorder();
		await jobs.resolveDueChallenges(db, { now: '2026-08-10T00:00:00Z', notify: r.hook, broadcastOp: async (op) => ({ id: 'trx_' + op.op }) });
		expect(r.sent).toHaveLength(0);
	});

	test('winners are still told when a read after settlement throws', async () => {
		const db = seed();
		const r = recorder();
		// Fail the first read that happens AFTER the resolution record exists, i.e. once
		// AFIT is credited (the broadcast step's marker read).
		const resC = db.collection('challenge_resolutions');
		const realFindOne = resC.findOne.bind(resC);
		let thrown = false;
		resC.findOne = async (q) => {
			const doc = await realFindOne(q);
			if (doc && !thrown) { thrown = true; throw new Error('mongo blip'); }
			return doc;
		};
		const res = await jobs.resolveDueChallenges(db, {
			now: '2026-08-10T00:00:00Z', notify: r.hook, broadcastOp: async (op) => ({ id: 'trx_' + op.op }),
		});
		expect(res.failed).toBe(1);
		expect(r.sent.map((n) => n.user).sort()).toEqual(['alice', 'bob']);
	});

	test('a failing notification does not fail the resolution', async () => {
		const db = seed();
		const res = await jobs.resolveDueChallenges(db, {
			now: '2026-08-10T00:00:00Z',
			notify: async () => { throw new Error('fcm down'); },
			broadcastOp: async (op) => ({ id: 'trx_' + op.op }),
		});
		expect(res.resolved).toBe(1);
		expect(res.failed).toBe(0);
	});
});
