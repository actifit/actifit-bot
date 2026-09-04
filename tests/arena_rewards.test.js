/**
 * Challenge Engine — default Merit reward schedules (arena_rewards.js) — tests.
 */

const rewards = require('../arena_rewards');

const standings = (n) => Array.from({ length: n }, (_, i) => ({ entity: `u${i + 1}`, rank: i + 1, score_verified: 1000 - i }));

describe('arena_rewards.prizesForStandings', () => {
	test('weekly step league: top-3 tiered + participation for the rest', () => {
		const p = rewards.prizesForStandings({ id: 'def_weekly_step_league' }, standings(5));
		expect(p).toEqual([
			{ rank: 1, merits: 200 }, { rank: 2, merits: 150 }, { rank: 3, merits: 100 },
			{ rank: 4, merits: 25 }, { rank: 5, merits: 25 },
		]);
	});

	test('daily focus: flat merits for every qualifying finisher (rank-agnostic)', () => {
		const p = rewards.prizesForStandings({ id: 'def_daily_focus' }, standings(3));
		expect(p).toEqual([{ rank: 1, merits: 20 }, { rank: 2, merits: 20 }, { rank: 3, merits: 20 }]);
	});

	test('a finisher with zero verified score earns nothing', () => {
		const s = [{ entity: 'a', rank: 1, score_verified: 500 }, { entity: 'b', rank: 2, score_verified: 0 }];
		const p = rewards.prizesForStandings({ id: 'def_weekly_step_league' }, s);
		expect(p).toEqual([{ rank: 1, merits: 200 }]);
	});

	test('a recurrence instance (parent_id) uses the base schedule', () => {
		const p = rewards.prizesForStandings({ id: 'def_daily_focus@2026-09-10', parent_id: 'def_daily_focus' }, standings(2));
		expect(p).toEqual([{ rank: 1, merits: 20 }, { rank: 2, merits: 20 }]);
	});

	test('unknown challenge falls back to the modest default schedule', () => {
		const p = rewards.prizesForStandings({ id: 'ch_usermade' }, standings(4));
		expect(p).toEqual([
			{ rank: 1, merits: 50 }, { rank: 2, merits: 30 }, { rank: 3, merits: 20 }, { rank: 4, merits: 10 },
		]);
	});

	test('unknown challenge with a creator-set rewards.merits uses it as the top prize', () => {
		const p = rewards.prizesForStandings({ id: 'ch_x', rewards: { merits: 5 } }, standings(2));
		expect(p).toEqual([{ rank: 1, merits: 5 }]); // rank2 participation is 0 → dropped
	});

	test('all default schedules keep the top prize under the daily emission cap (1000)', () => {
		for (const id of Object.keys(rewards.SCHEDULES)) {
			const p = rewards.prizesForStandings({ id }, standings(12));
			const max = Math.max(0, ...p.map((x) => x.merits));
			expect(max).toBeLessThanOrEqual(1000);
		}
	});
});
