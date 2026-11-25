/**
 * badges.js: first-wave badge catalog, stats and claim rules.
 */

const b = require('../badges');

const dayMs = (day, hour = 12) => Date.UTC(+day.slice(0, 4), +day.slice(4, 6) - 1, +day.slice(6, 8), hour);
// a report received at noon UTC on `day` (or at `date`), claiming `day` as its activity date
const post = (day, md = {}, date) => ({
	date: new Date(date ? Date.parse(date) : dayMs(day)),
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
		expect(c.limited[0]).toMatchObject({ id: 'endorphin_rush', target: 20, claim_until: '2027-01-07T23:59:59.000Z' });
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

describe('days', () => {
	test('validDay accepts real dates only', () => {
		expect(b.validDay('20240229')).toBe(true);
		for (const bad of ['20230229', '20261399', '20261131', '2026-11-01', '2026111', 'abcdefgh', '']) {
			expect(b.validDay(bad)).toBe(false);
		}
	});

	test('reportDay trusts the activity date only near the receive day', () => {
		const at = '2026-11-20T12:00:00Z';
		expect(b.reportDay(post('20261120', {}, at))).toBe('20261120');
		expect(b.reportDay(post('20261119', {}, at))).toBe('20261119'); // yesterday's report
		expect(b.reportDay(post('20261118', {}, at))).toBe('20261118'); // 2 days, the limit
		expect(b.reportDay(post('20261121', {}, at))).toBe('20261121'); // ahead of UTC
		// backdated, future, impossible or missing: the receive day counts
		for (const d of ['20261117', '20261101', '20261123', '29991231', '20261399', '']) {
			expect(b.reportDay(post(d, {}, at))).toBe('20261120');
		}
		expect(b.reportDay({ json_metadata: { activityDate: ['20261120'] } })).toBeNull();
	});

	test('longestStreak counts the longest run of consecutive days, across months and years', () => {
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

	test('a streak cannot be built in one sitting with made-up dates', () => {
		const posts = [];
		for (let i = 1; i <= 30; i++) {
			posts.push(post('202610' + String(i).padStart(2, '0'), { step_count: ['100000'] }, '2026-11-20T10:00:00Z'));
		}
		const s = b.reportStats(posts, NOW);
		expect(s.longestStreak).toBe(1);
		expect(s.lifetimeSteps).toBe(100000);
	});

	test('a type counts once reported again a day later; at most 3 per report', () => {
		const s = b.reportStats([
			post('20261101', { activity_type: ['Walking, Running, Cycling, Yoga, Hiking'] }),
			post('20261102', { activity_type: ['running,Cycling ,  ,walking, yoga'] }),
			post('20261103', { activity_type: 'Yoga' }),
			post('20261104', { activity_type: ['Yoga'] }),
		], NOW);
		// walking, running, cycling: 24 h apart; yoga: first seen 11-03 (11-02 was its 4th slot), again 11-04
		expect(s.activityTypes).toBe(4);
	});

	test('the same type twice within a day does not count yet', () => {
		const s = b.reportStats([
			post('20261101', { activity_type: ['Walking'] }, '2026-11-01T01:00:00Z'),
			post('20261101', { activity_type: ['Walking'] }, '2026-11-01T23:00:00Z'),
		], NOW);
		expect(s.activityTypes).toBe(0);
	});

	test('a 70-minute sitting with made-up dates and types earns no Explorer tier', () => {
		// round-2 scenario: 14 reports alternating two dates, 3 made-up types each
		const posts = [];
		for (let i = 0; i < 14; i++) {
			const types = [0, 1, 2].map((k) => 'fake' + (((i >> 1) * 3 + k) % 21)).join(',');
			posts.push(post(i % 2 ? '20261124' : '20261123', { activity_type: [types] },
				new Date(Date.parse('2026-11-24T10:00:00Z') + i * 5 * 60000).toISOString()));
		}
		expect(b.reportStats(posts, NOW).activityTypes).toBe(0);
	});

	test('only 3 new types count per day, so 20 types take a week or more', () => {
		const posts = [];
		for (let d = 0; d < 8; d++) {
			const day = '202611' + String(d + 1).padStart(2, '0');
			// every day lists 3 new types and repeats 3 older ones
			const fresh = [0, 1, 2].map((k) => 't' + (d * 3 + k));
			posts.push(post(day, { activity_type: [fresh.join(',')] }));
			if (d > 0) posts.push(post(day, { activity_type: [[0, 1, 2].map((k) => 't' + ((d - 1) * 3 + k)).join(',')] },
				new Date(dayMs(day, 20)).toISOString()));
		}
		// types from days 1..7 were repeated a day later; day 8's are not confirmed yet
		expect(b.reportStats(posts, NOW).activityTypes).toBe(21);
		const quick = [post('20261101', { activity_type: ['a,b,c'] }), post('20261101', { activity_type: ['d,e,f'] },
			'2026-11-01T13:00:00Z'), post('20261102', { activity_type: ['a,b,c'] }), post('20261102', { activity_type: ['d,e,f'] },
			'2026-11-02T13:00:00Z')];
		// d,e,f were the 4th-6th new types on 11-01, so they only start counting on 11-02
		expect(b.reportStats(quick, NOW).activityTypes).toBe(3);
	});

	test('one report listing 20 types earns nothing', () => {
		const many = Array.from({ length: 20 }, (_, i) => 'type' + i).join(',');
		expect(b.reportStats([post('20261101', { activity_type: [many] })], NOW).activityTypes).toBe(0);
	});

	test('only the user\'s own videos count; charity reports', () => {
		const s = b.reportStats([
			post('20261101', { video: { info: { author: 'alice', permlink: 'p1' } } }),
			post('20261102', { video: { info: { author: 'bob', permlink: 'p2' } } }),
			post('20261103', { video: { info: {} } }),
			post('20261104', { video: 'x', charity: ['actifit.charity'] }),
			post('20261105', { charity: [''] }),
		], NOW, 'alice');
		expect(s.videoReports).toBe(1);
		expect(s.charityReports).toBe(1);
	});

	test('the limited window counts the days reports were received', () => {
		const s = b.reportStats([
			post('20261125'),
			post('20261126'),
			post('20261126', {}, '2026-11-26T18:00:00Z'),
			// says Nov 25 but arrived before the window opened
			post('20261125', {}, '2026-11-20T10:00:00Z'),
			// arrived after "now"
			post('20261215', {}, '2026-12-15T10:00:00Z'),
		], NOW);
		expect(s.endorphinReports).toBe(2);
	});

	test('reports either side of midnight UTC are one day for the limited edition', () => {
		const s = b.reportStats([
			post('20261125', {}, '2026-11-25T23:55:00Z'),
			post('20261126', {}, '2026-11-26T00:05:00Z'),
			post('20261126', {}, '2026-11-26T21:00:00Z'),
		], NOW);
		expect(s.endorphinReports).toBe(2);
	});

	test('20 reports sent in one sitting are one day for the limited edition', () => {
		const posts = [];
		for (let i = 1; i <= 20; i++) {
			posts.push(post('202611' + String(i).padStart(2, '0'), {}, '2026-11-25T10:0' + (i % 10) + ':00Z'));
		}
		expect(b.reportStats(posts, NOW).endorphinReports).toBe(1);
	});
});

describe('arenaStats', () => {
	const challenges = new Map([
		['off', { id: 'off', origin_tier: 'official', state: 'settled' }],
		['com', { id: 'com', origin_tier: 'community', state: 'settled' }],
		['small', { id: 'small', origin_tier: 'official', state: 'settled' }],
		['friend', { id: 'friend', origin_tier: 'friendly', state: 'settled' }],
		['gone', { id: 'gone', origin_tier: 'official', state: 'cancelled' }],
	]);
	const finishers = new Map([['off', 8], ['com', 6], ['small', 2], ['friend', 9]]);
	const settled = (id, rank, score = 100) => ({ challenge_id: id, state: 'settled', result: { rank, score_verified: score } });

	test('only official and community challenges count; friendly and cancelled do not', () => {
		const s = b.arenaStats([
			settled('off', 1), settled('com', 2), settled('small', 1), settled('friend', 1),
			{ challenge_id: 'gone', state: 'enrolled' }, { challenge_id: 'unknown', state: 'enrolled' },
		], challenges, finishers);
		expect(s).toEqual({ arenaJoined: 3, arenaPodiums: 2, arenaWins: 1 });
	});

	test('a zero score, leaving, or 4th place is no podium; 3rd is a podium, not a win', () => {
		const s = b.arenaStats([
			{ challenge_id: 'off', state: 'left' },
			settled('off', 1, 0),
			settled('off', 3),
			settled('off', 4),
			{ challenge_id: 'off', state: 'enrolled', result: null },
			settled('com', '1'),
		], challenges, finishers);
		expect(s).toEqual({ arenaJoined: 5, arenaPodiums: 2, arenaWins: 1 });
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

	test('the limited edition: during the window and a week after', () => {
		expect(b.canClaim('endorphin_rush', stats, new Set(), IN)).toMatchObject({ ok: true });
		expect(b.canClaim('endorphin_rush', stats, new Set(), Date.parse('2027-01-05T00:00:00Z'))).toMatchObject({ ok: true });
		expect(b.canClaim('endorphin_rush', stats, new Set(), Date.parse('2027-01-08T00:00:00Z')))
			.toMatchObject({ ok: false, reason: 'closed' });
		expect(b.canClaim('endorphin_rush', stats, new Set(), Date.parse('2026-11-20T00:00:00Z')))
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

	test('after the window the limited edition is still claimable during the grace week', () => {
		const p = b.progress({ endorphinReports: 20 }, new Set(), Date.parse('2027-01-03T00:00:00Z'));
		expect(p.limited[0]).toMatchObject({ open: false, claimable: true });
	});

	test('a fully claimed family has no next level', () => {
		const p = b.progress({ arenaWins: 50 }, new Set(['champion_lev_1', 'champion_lev_2']));
		expect(p.families.find((f) => f.id === 'champion')).toMatchObject({ claimedLevel: 2, next: null });
	});
});

describe('userStats (fake db)', () => {
	function fakeDb(delayMs = 0) {
		const calls = [];
		const data = {
			verified_posts: [post('20261101', { video: { info: { author: 'alice', permlink: 'v' } } }), post('20261102')],
			challenge_participants: [
				{ entity: 'alice', challenge_id: 'off', state: 'settled', result: { rank: 2, score_verified: 50 } },
				{ entity: 'alice', challenge_id: 'friend', state: 'settled', result: { rank: 1, score_verified: 50 } },
				{ entity: 'alice', challenge_id: 'off2', state: 'enrolled', result: null },
			],
			challenges: [
				{ id: 'off', origin_tier: 'official', state: 'settled' },
				{ id: 'friend', origin_tier: 'friendly', state: 'settled' },
				{ id: 'off2', origin_tier: 'official', state: 'open' },
			],
		};
		const wait = () => new Promise((r) => setTimeout(r, delayMs));
		return {
			calls,
			collection(name) {
				return {
					find: (q) => {
						calls.push([name, q]);
						const rows = name === 'verified_posts' ? (q.author === 'alice' ? data.verified_posts : [])
							: name === 'challenge_participants' ? data.challenge_participants.filter((r) => r.entity === q.entity)
								: data.challenges.filter((c) => q.id.$in.includes(c.id));
						return { toArray: async () => { await wait(); return rows; } };
					},
					aggregate: (pipeline) => {
						calls.push([name + '.aggregate', pipeline[0].$match]);
						return { toArray: async () => [{ _id: 'off', n: 6 }] };
					},
				};
			},
		};
	}

	beforeEach(() => b.resetForTests());

	test('combines report and Arena stats, and caches per user', async () => {
		const db = fakeDb();
		const s = await b.userStats(db, 'alice', Date.parse('2026-12-01T00:00:00Z'));
		expect(s).toMatchObject({ longestStreak: 2, lifetimeSteps: 12000, videoReports: 1,
			arenaJoined: 2, arenaPodiums: 1, arenaWins: 0 });
		const n = db.calls.length;
		await b.userStats(db, 'alice', Date.parse('2026-12-01T00:05:00Z'));
		expect(db.calls.length).toBe(n);
		await b.userStats(db, 'alice', Date.parse('2026-12-01T00:05:00Z'), { fresh: true });
		expect(db.calls.length).toBeGreaterThan(n);
		const m = db.calls.length;
		await b.userStats(db, 'alice', Date.parse('2026-12-01T00:20:00Z'));
		expect(db.calls.length).toBeGreaterThan(m);
	});

	test('field sizes are only counted for the user\'s own scored podiums in counting challenges', async () => {
		const db = fakeDb();
		await b.userStats(db, 'alice');
		const agg = db.calls.filter((c) => c[0] === 'challenge_participants.aggregate');
		expect(agg).toHaveLength(1);
		expect(agg[0][1]).toEqual({ challenge_id: { $in: ['off'] }, state: 'settled', 'result.score_verified': { $gt: 0 } });
	});

	test('parallel calls for one user share one read', async () => {
		const db = fakeDb(20);
		const [a, c] = await Promise.all([b.userStats(db, 'alice'), b.userStats(db, 'alice')]);
		expect(a).toBe(c);
		expect(db.calls.filter((x) => x[0] === 'verified_posts')).toHaveLength(1);
	});

	test('reports are read only by the indexed author field', async () => {
		const db = fakeDb();
		await b.userStats(db, 'bob');
		expect(db.calls.find((c) => c[0] === 'verified_posts')[1]).toEqual({ author: 'bob' });
	});
});
