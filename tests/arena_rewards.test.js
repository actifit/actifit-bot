/**
 * Challenge Engine — official-contest AFIT reward schedules (arena_rewards.js).
 */

const rewards = require('../arena_rewards');
const afit = require('../arena_afit');

const standings = (n) => Array.from({ length: n }, (_, i) => ({ entity: `u${i + 1}`, rank: i + 1, score_verified: 1000 - i }));
// An OFFICIAL contest doc (system emission is official-only).
const official = (id, extra = {}) => ({ id, origin_tier: 'official', ...extra });

describe('arena_rewards.prizesForStandings', () => {
	test('weekly step league: top-3 tiered + participation for the rest (AFIT)', () => {
		const p = rewards.prizesForStandings(official('def_weekly_step_league'), standings(5));
		expect(p).toEqual([
			{ rank: 1, afit: 100 }, { rank: 2, afit: 60 }, { rank: 3, afit: 40 },
			{ rank: 4, afit: 10 }, { rank: 5, afit: 10 },
		]);
	});

	test('daily focus: flat AFIT for every qualifying finisher (rank-agnostic)', () => {
		const p = rewards.prizesForStandings(official('def_daily_focus'), standings(3));
		expect(p).toEqual([{ rank: 1, afit: 5 }, { rank: 2, afit: 5 }, { rank: 3, afit: 5 }]);
	});

	test('a finisher with zero verified score earns nothing', () => {
		const s = [{ entity: 'a', rank: 1, score_verified: 500 }, { entity: 'b', rank: 2, score_verified: 0 }];
		const p = rewards.prizesForStandings(official('def_weekly_step_league'), s);
		expect(p).toEqual([{ rank: 1, afit: 100 }]);
	});

	test('an official recurrence instance (parent_id) uses the base schedule', () => {
		const p = rewards.prizesForStandings(official('def_daily_focus@2026-09-10', { parent_id: 'def_daily_focus' }), standings(2));
		expect(p).toEqual([{ rank: 1, afit: 5 }, { rank: 2, afit: 5 }]);
	});

	test('FARM VECTOR BLOCKED — a friendly challenge spoofing parent_id gets NO system AFIT', () => {
		// A user broadcasts a friendly challenge with parent_id pointing at an official
		// schedule. origin_tier is set from the signer at ingest (only @actifit can be
		// official), so this must earn zero system emission.
		const spoof = { id: 'ch_evil', origin_tier: 'friendly', parent_id: 'def_monthly_liveops' };
		expect(rewards.scheduleFor(spoof)).toBeNull();
		expect(rewards.prizesForStandings(spoof, standings(3))).toEqual([]);
		// community-tier likewise earns no system AFIT (its prize comes from its pool)
		expect(rewards.prizesForStandings({ id: 'ch_c', origin_tier: 'community', parent_id: 'def_weekly_step_league' }, standings(2))).toEqual([]);
	});

	test('a plain user-created challenge earns NO system AFIT', () => {
		expect(rewards.prizesForStandings({ id: 'ch_usermade', origin_tier: 'friendly' }, standings(4))).toEqual([]);
		expect(rewards.prizesForStandings({ id: 'ch_x', origin_tier: 'friendly', rewards: { afit: 500 } }, standings(2))).toEqual([]);
	});

	test('scheduleFor returns null unless the challenge is an official def_* contest', () => {
		expect(rewards.scheduleFor(official('def_daily_focus'))).toBeTruthy();
		expect(rewards.scheduleFor({ id: 'def_daily_focus', origin_tier: 'friendly' })).toBeNull(); // right id, wrong tier
		expect(rewards.scheduleFor(official('ch_usermade'))).toBeNull(); // official but not a scheduled default
		expect(rewards.scheduleFor(null)).toBeNull();
	});

	test('every official top prize sits at or under the per-user daily AFIT cap', () => {
		for (const id of Object.keys(rewards.SCHEDULES)) {
			const p = rewards.prizesForStandings(official(id), standings(12));
			const max = Math.max(0, ...p.map((x) => x.afit));
			expect(max).toBeLessThanOrEqual(afit.DEFAULT_DAILY_CAP); // so a single win is never clipped
		}
	});
});

describe('arena_rewards.badgePrizes (user-created badge awards)', () => {
	const badgeCh = (rule) => ({ id: 'ch_b', origin_tier: 'friendly', rewards: { badges: ['October Sprinter'] }, badge_rule: rule });

	test('no badge on the challenge → no badge prizes', () => {
		expect(rewards.badgePrizes({ id: 'x', origin_tier: 'friendly', rewards: { afit: 500 } }, standings(5))).toEqual([]);
		expect(rewards.badgePrizes({ id: 'x', rewards: { badges: [] } }, standings(5))).toEqual([]);
	});

	test('winner (default) → the badge goes to rank 1 only', () => {
		expect(rewards.badgePrizes(badgeCh('winner'), standings(5))).toEqual([{ rank: 1, badges: ['October Sprinter'] }]);
		// missing/invalid rule falls back to winner
		expect(rewards.badgePrizes({ ...badgeCh(undefined) }, standings(5))).toEqual([{ rank: 1, badges: ['October Sprinter'] }]);
		expect(rewards.badgePrizes({ ...badgeCh('bogus') }, standings(5))).toEqual([{ rank: 1, badges: ['October Sprinter'] }]);
	});

	test('top3 → ranks 1-3 earn the badge', () => {
		expect(rewards.badgePrizes(badgeCh('top3'), standings(5)).map((p) => p.rank)).toEqual([1, 2, 3]);
	});

	test('all → every finisher with a positive score earns it (zero-score excluded)', () => {
		const s = [
			{ entity: 'a', rank: 1, score_verified: 100 },
			{ entity: 'b', rank: 2, score_verified: 50 },
			{ entity: 'c', rank: 3, score_verified: 0 }, // did nothing → no badge
		];
		expect(rewards.badgePrizes(badgeCh('all'), s).map((p) => p.rank)).toEqual([1, 2]);
	});

	test('trims + drops non-string/blank badge names', () => {
		const ch = { id: 'ch', origin_tier: 'friendly', rewards: { badges: ['  Champ  ', 42, '  ', null] }, badge_rule: 'winner' };
		expect(rewards.badgePrizes(ch, standings(2))).toEqual([{ rank: 1, badges: ['Champ'] }]);
	});
});

describe('arena_rewards.withBadgePrizes (merge into the AFIT prize table)', () => {
	test('a badge-only contest (no AFIT prizes) yields badge-only prize rows', () => {
		const ch = { id: 'ch', origin_tier: 'friendly', rewards: { badges: ['Winner'] }, badge_rule: 'winner' };
		expect(rewards.withBadgePrizes([], ch, standings(3))).toEqual([{ rank: 1, badges: ['Winner'] }]);
	});

	test('badges merge onto the SAME rank as an AFIT prize (rank keeps both)', () => {
		const ch = { id: 'ch', origin_tier: 'friendly', rewards: { badges: ['Ace'] }, badge_rule: 'top3' };
		const afitPrizes = [{ rank: 1, afit: 100 }, { rank: 2, afit: 60 }];
		const merged = rewards.withBadgePrizes(afitPrizes, ch, standings(3));
		const byRank = Object.fromEntries(merged.map((p) => [p.rank, p]));
		expect(byRank[1]).toEqual({ rank: 1, afit: 100, badges: ['Ace'] });
		expect(byRank[2]).toEqual({ rank: 2, afit: 60, badges: ['Ace'] });
		expect(byRank[3]).toEqual({ rank: 3, badges: ['Ace'] }); // badge-only rank
	});

	test('no badge → the AFIT prize table passes through unchanged', () => {
		const afitPrizes = [{ rank: 1, afit: 100 }];
		expect(rewards.withBadgePrizes(afitPrizes, { id: 'x', rewards: { afit: 1 } }, standings(2))).toEqual(afitPrizes);
	});
});
