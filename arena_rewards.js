/**
 * Challenge Engine — official-contest AFIT reward schedules (epic #171, §7.5).
 *
 * The six OFFICIAL default contests are rewarded in off-chain AFIT, system-funded
 * from the treasury and bounded by the per-user daily cap (see arena_afit.js).
 * Amounts are a starting draft, tunable to the weekly challenge budget.
 *
 * IMPORTANT — no system emission for user-created challenges. Only the def_*
 * official contests carry a schedule here. A user-created challenge earns AFIT
 * ONLY from its creator-funded pool (handled in the pools module), never minted
 * by the system — that's what stops a real-value farm via alt-created challenges.
 *
 * Load-time safe: pure, requires nothing.
 */

'use strict';

// Per-official-contest AFIT schedule. `flat` (if > 0) pays EVERY qualifying
// finisher the same amount and ignores rank (goal/participation contests).
// Otherwise `top` pays the named ranks and `participation` pays every other
// qualifying finisher. AFIT amounts.
const SCHEDULES = {
	def_daily_focus:        { flat: 5 },
	def_weekly_step_league: { top: { 1: 100, 2: 60, 3: 40 }, participation: 10 },
	def_season_ladder:      { top: { 1: 250, 2: 150, 3: 100 }, participation: 20 },
	def_weekly_top_n:       { top: { 1: 80, 2: 60, 3: 45, 4: 25, 5: 25, 6: 25, 7: 25, 8: 25, 9: 25, 10: 25 }, participation: 10 },
	def_weekend_warrior:    { top: { 1: 50, 2: 35, 3: 25 }, participation: 8 },
	def_monthly_liveops:    { top: { 1: 400, 2: 250, 3: 150 }, participation: 25 },
};

/**
 * The AFIT schedule for a challenge, or null if it has none (user-created).
 * A recurrence instance chains from its base id via parent_id.
 */
function scheduleFor(challenge) {
	if (!challenge) return null;
	const base = challenge.parent_id || challenge.id;
	if (base && SCHEDULES[base]) return SCHEDULES[base];
	if (challenge.id && SCHEDULES[challenge.id]) return SCHEDULES[challenge.id];
	return null; // user-created / unknown → NO system AFIT emission
}

/** AFIT for a finishing rank under a schedule (0 if none). */
function afitForRank(schedule, rank) {
	if (!schedule) return 0;
	if (Number(schedule.flat) > 0) return Number(schedule.flat);
	if (schedule.top && schedule.top[rank] != null) return Number(schedule.top[rank]) || 0;
	return Number(schedule.participation) || 0;
}

/**
 * Build the rank-keyed AFIT prize table for resolveChallenge from an OFFICIAL
 * contest's schedule and the ranks present in its verified standings. Returns []
 * for a challenge with no schedule (user-created) — no system emission. A
 * finisher with a non-positive verified score earns nothing (no reward for zero
 * effort — also blocks farming via an empty alt).
 * @param {object} challenge
 * @param {Array<{entity, rank, score_verified}>} standings
 * @returns {Array<{rank, afit}>}
 */
function prizesForStandings(challenge, standings) {
	const schedule = scheduleFor(challenge);
	if (!schedule) return [];
	const prizes = [];
	for (const row of standings || []) {
		if (!(Number(row.score_verified) > 0)) continue; // no reward for zero score
		const afit = afitForRank(schedule, row.rank);
		if (afit > 0) prizes.push({ rank: row.rank, afit });
	}
	return prizes;
}

module.exports = {
	SCHEDULES,
	scheduleFor,
	afitForRank,
	prizesForStandings,
};
