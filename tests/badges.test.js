/**
 * badges.js: first-wave badge catalog, stats and claim rules.
 */

const b = require('../badges');

const post = (day, md = {}, date) => ({
	date: date ? new Date(date) : new Date(Date.UTC(+day.slice(0, 4), +day.slice(4, 6) - 1, +day.slice(6, 8), 12)),
	json_metadata: Object.assign({ activityDate: [day], step_count: ['6000'] }, md),
});

describe('catalog', () => {
	test('every family has ordered tiers, ids and art', () => {
		const c = b.catalog();
		expect(c.families.map((f) => f.id)).toEqual(['on_fire', 'million_stepper', 'big_day', 'director',
			'explorer', 'contender', 'podium', 'champion', 'big_heart']);
		for (const f of c.families) {
			const targets = f.tiers.map((t) => t.target);
			expect([...targets].sort((x, y) => x - y)).toEqual(targets);
			f.tiers.forEach((t, i) => {
				expect(t.badge).toBe(f.id + '_lev_' + (i + 1));
				expect(t.art).toBe('/img/badges/' + t.badge + '.png');
			});
		}
		expect(c.limited[0]).toMatchObject({ id: 'endorphin_rush', target: 20 });
	});
});

describe('parseBadge', () => {
	test('reads tiered and limited ids, refuses the rest', () => {
		expect(b.parseBadge('on_fire_lev_2')).toMatchObject({ level: 2 });
		expect(b.parseBadge('on_fire_lev_2').family.id).toBe('on_fire');
		expect(b.parseBadge('endorphin_rush').limited.id).toBe('endorphin_rush');
		for (const bad of ['on_fire_lev_0', 'on_fire_lev_6', 'champion_lev_3', 'nope_lev_1',
			'rewarded_activity_lev_3', 'iso', 'charity_badge', '', null, ['on_fire_lev_1'], { $ne: 1 }]) {
			expect(b.parseBadge(bad)).toBeNull();
		}
	});
});

describe('longestStreak', () => {
	test('counts the longest run of consecutive days, across months and years', () => {
		expect(b.longestStreak([])).toBe(0);
		expect(b.longestStreak(['20261130', '20261201', '20261202', '20261205'])).toBe(3);
		expect(b.longestStreak(['20261231', '20270101', '20261231'])).toBe(2);
		expect(b.longestStreak(['20240228', '20240229', '20240301'])).toBe(3);
	});
});

describe('reportStats', () => {
	const NOW = Date.parse('2026-12-10T00:00:00Z');

	test('a day counts once (its biggest report) and huge values are capped', () => {
		const s = b.reportStats([
			post('20261101', { step_count: ['8000'] }),
			post('20261101', { step_count: ['12000'] }),
			post('20261102', { step_count: ['999999'] }),
			post('20261103', { step_count: ['abc'] }),
		], NOW);
		expect(s.lifetimeSteps).toBe(12000 + b.MAX_DAY_STEPS);
		expect(s.bestDay).toBe(b.MAX_DAY_STEPS);
		expect(s.longestStreak).toBe(3);
	});

	test('activity types are counted once each, case and spaces ignored', () => {
		const s = b.reportStats([
			post('20261101', { activity_type: ['Walking, Running'] }),
			post('20261102', { activity_type: ['running,Cycling ,  '] }),
			post('20261103', { activity_type: 'Yoga' }),
		], NOW);
		expect(s.activityTypes).toBe(4);
	});

	test('video and charity reports', () => {
		const s = b.reportStats([
			post('20261101', { video: { info: { author: 'a', permlink: 'p1' } } }),
			post('20261102', { video: { info: {} } }),
			post('20261103', { video: 'x', charity: ['actifit.charity'] }),
			post('20261104', { charity: [''] }),
		], NOW);
		expect(s.videoReports).toBe(1);
		expect(s.charityReports).toBe(1);
	});

	test('the limited window uses the server receive time, not the report date', () => {
		const s = b.reportStats([
			post('20261125'),
			post('20261126'),
			post('20261126', {}, '2026-11-26T18:00:00Z'),
			// backdated: says Nov 25 but arrived before the window opened
			post('20261125', {}, '2026-11-20T10:00:00Z'),
			// arrived after "now"
			post('20261215', {}, '2026-12-15T10:00:00Z'),
		], NOW);
		expect(s.endorphinReports).toBe(2);
	});

	test('falls back to the server date when the report has no activity date', () => {
		const s = b.reportStats([{ date: new Date('2026-11-05T10:00:00Z'), json_metadata: { step_count: '7000' } }], NOW);
		expect(s.lifetimeSteps).toBe(7000);
		expect(s.longestStreak).toBe(1);
	});
});

describe('arenaStats', () => {
	const challenges = new Map([
		['pub', { id: 'pub', visibility: 'public' }],
		['small', { id: 'small', visibility: 'public' }],
		['priv', { id: 'priv', visibility: 'private' }],
	]);
	const finishers = new Map([['pub', 8], ['small', 2], ['priv', 9]]);

	test('only public challenges count, podiums and wins need a field of 5', () => {
		const s = b.arenaStats([
			{ challenge_id: 'pub', state: 'settled', result: { rank: 1 } },
			{ challenge_id: 'small', state: 'settled', result: { rank: 1 } },
			{ challenge_id: 'priv', state: 'settled', result: { rank: 1 } },
			{ challenge_id: 'gone', state: 'enrolled' },
		], challenges, finishers);
		expect(s).toEqual({ arenaJoined: 2, arenaPodiums: 1, arenaWins: 1 });
	});

	test('leaving does not count; 3rd place is a podium, not a win', () => {
		const s = b.arenaStats([
			{ challenge_id: 'pub', state: 'left' },
			{ challenge_id: 'pub', state: 'settled', result: { rank: 3 } },
			{ challenge_id: 'pub', state: 'settled', result: { rank: 4 } },
			{ challenge_id: 'pub', state: 'enrolled', result: null },
		], challenges, finishers);
		expect(s).toEqual({ arenaJoined: 3, arenaPodiums: 1, arenaWins: 0 });
	});
});

describe('canClaim', () => {
	const stats = { longestStreak: 35, lifetimeSteps: 0, bestDay: 0, videoReports: 0, activityTypes: 0,
		arenaJoined: 0, arenaPodiums: 0, arenaWins: 0, charityReports: 0, endorphinReports: 20 };
	const IN = Date.parse('2026-12-01T00:00:00Z');

	test('tiers go in order', () => {
		expect(b.canClaim('on_fire_lev_1', stats, new Set(), IN)).toEqual({ known: true, ok: true });
		expect(b.canClaim('on_fire_lev_2', stats, new Set(), IN)).toMatchObject({ ok: false, reason: 'previous_level' });
		expect(b.canClaim('on_fire_lev_2', stats, new Set(['on_fire_lev_1']), IN)).toMatchObject({ ok: true });
		expect(b.canClaim('on_fire_lev_3', stats, new Set(['on_fire_lev_1', 'on_fire_lev_2']), IN))
			.toMatchObject({ ok: false, reason: 'requirements' });
	});

	test('a held badge is not claimed again', () => {
		expect(b.canClaim('on_fire_lev_1', stats, new Set(['on_fire_lev_1']), IN))
			.toMatchObject({ ok: false, reason: 'already_claimed' });
	});

	test('the limited edition only inside its window', () => {
		expect(b.canClaim('endorphin_rush', stats, new Set(), IN)).toMatchObject({ ok: true });
		expect(b.canClaim('endorphin_rush', stats, new Set(), Date.parse('2027-01-01T00:00:01Z')))
			.toMatchObject({ ok: false, reason: 'closed' });
		expect(b.canClaim('endorphin_rush', Object.assign({}, stats, { endorphinReports: 19 }), new Set(), IN))
			.toMatchObject({ ok: false, reason: 'requirements' });
	});

	test('older badges are left to the existing code', () => {
		expect(b.canClaim('rewarded_activity_lev_2', stats, new Set(), IN)).toEqual({ known: false });
	});
});

describe('progress', () => {
	test('next level per family and the limited edition state', () => {
		const stats = { longestStreak: 35, lifetimeSteps: 1200000, bestDay: 0, videoReports: 0, activityTypes: 0,
			arenaJoined: 0, arenaPodiums: 0, arenaWins: 0, charityReports: 0, endorphinReports: 3 };
		const p = b.progress(stats, new Set(['on_fire_lev_1']), Date.parse('2026-12-01T00:00:00Z'));
		const fire = p.families.find((f) => f.id === 'on_fire');
		expect(fire).toMatchObject({ value: 35, claimedLevel: 1, next: { level: 2, target: 30, claimable: true } });
		const steps = p.families.find((f) => f.id === 'million_stepper');
		expect(steps).toMatchObject({ claimedLevel: 0, next: { level: 1, claimable: true } });
		expect(p.limited[0]).toMatchObject({ value: 3, target: 20, open: true, claimed: false, claimable: false });
	});

	test('a fully claimed family has no next level', () => {
		const p = b.progress({ arenaWins: 50 }, new Set(['champion_lev_1', 'champion_lev_2']));
		expect(p.families.find((f) => f.id === 'champion')).toMatchObject({ claimedLevel: 2, next: null });
	});
});

describe('userStats (fake db)', () => {
	function fakeDb() {
		const calls = [];
		const data = {
			verified_posts: [post('20261101', { video: { info: { permlink: 'v' } } }), post('20261102')],
			challenge_participants: [{ entity: 'alice', challenge_id: 'pub', state: 'settled', result: { rank: 2 } }],
			challenges: [{ id: 'pub', visibility: 'public' }],
		};
		return {
			calls,
			collection(name) {
				return {
					find: (q) => {
						calls.push([name, q]);
						const rows = name === 'verified_posts' ? (q.author === 'alice' ? data.verified_posts : [])
							: name === 'challenge_participants' ? data.challenge_participants.filter((r) => r.entity === q.entity)
								: data.challenges.filter((c) => q.id.$in.includes(c.id));
						return { toArray: async () => rows };
					},
					aggregate: () => ({ toArray: async () => [{ _id: 'pub', n: 6 }] }),
				};
			},
		};
	}

	beforeEach(() => b.resetForTests());

	test('combines report and Arena stats, and caches per user', async () => {
		const db = fakeDb();
		const s = await b.userStats(db, 'alice', Date.parse('2026-12-01T00:00:00Z'));
		expect(s).toMatchObject({ longestStreak: 2, lifetimeSteps: 12000, videoReports: 1,
			arenaJoined: 1, arenaPodiums: 1, arenaWins: 0 });
		const n = db.calls.length;
		await b.userStats(db, 'alice', Date.parse('2026-12-01T00:05:00Z'));
		expect(db.calls.length).toBe(n);
		await b.userStats(db, 'alice', Date.parse('2026-12-01T00:11:00Z'));
		expect(db.calls.length).toBeGreaterThan(n);
	});

	test('reports are read only by the indexed author field', async () => {
		const db = fakeDb();
		await b.userStats(db, 'bob');
		expect(db.calls.find((c) => c[0] === 'verified_posts')[1]).toEqual({ author: 'bob' });
	});
});
