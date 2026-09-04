/**
 * Challenge Engine — default Merit reward schedules (epic #171, §7.5).
 *
 * Merits are the earned-only, NON-TRANSFERABLE spend currency (§3.5, I3/I4). This
 * module maps a resolved challenge's verified standings to a rank-keyed Merit
 * prize table for arena_pools.resolveChallenge. Merit-only by design — the six
 * default contests promise "Actifit Merits" (no AFIT), so no pool is involved and
 * no compliance-sensitive AFIT funding path is touched here.
 *
 * Amounts are deliberately modest and sit under the per-user daily emission cap
 * (arena_merits.DEFAULT_DAILY_EMISSION_CAP = 1000/UTC-day); award() enforces that
 * cap regardless, so a busy day is clamped, never overdrawn. Tune freely.
 *
 * Load-time safe: pure, requires nothing.
 */

'use strict';

// Per-default schedule. `flat` (if > 0) pays EVERY qualifying finisher the same
// amount and ignores rank (goal/participation contests). Otherwise `top` pays the
// named ranks and `participation` pays every other qualifying finisher.
const SCHEDULES = {
	def_daily_focus:        { flat: 20 },
	def_weekly_step_league: { top: { 1: 200, 2: 150, 3: 100 }, participation: 25 },
	def_season_ladder:      { top: { 1: 300, 2: 200, 3: 150 }, participation: 40 },
	def_weekly_top_n:       { top: { 1: 150, 2: 120, 3: 90, 4: 50, 5: 50, 6: 50, 7: 50, 8: 50, 9: 50, 10: 50 }, participation: 20 },
	def_weekend_warrior:    { top: { 1: 100, 2: 75, 3: 50 }, participation: 15 },
	def_monthly_liveops:    { top: { 1: 500, 2: 300, 3: 200 }, participation: 50 },
};

// Fallback for a challenge with no named schedule (user-created, or a rolled
// recurrence instance that carries parent_id). Honors an explicit, non-negative
// creator-set `rewards.merits` as the top prize; else a modest default so a
// resolved challenge still rewards its finishers.
const DEFAULT_SCHEDULE = { top: { 1: 50, 2: 30, 3: 20 }, participation: 10 };

function scheduleFor(challenge) {
	if (!challenge) return DEFAULT_SCHEDULE;
	// A recurrence instance chains from its base id via parent_id.
	const base = challenge.parent_id || challenge.id;
	if (base && SCHEDULES[base]) return SCHEDULES[base];
	if (challenge.id && SCHEDULES[challenge.id]) return SCHEDULES[challenge.id];
	const rw = challenge.rewards;
	if (rw && typeof rw === 'object' && Number(rw.merits) >= 0 && rw.merits !== undefined) {
		return { top: { 1: Number(rw.merits) }, participation: 0 };
	}
	return DEFAULT_SCHEDULE;
}

/** Merits for a finishing rank under a schedule (0 if none). */
function meritsForRank(schedule, rank) {
	if (!schedule) return 0;
	if (Number(schedule.flat) > 0) return Number(schedule.flat);
	if (schedule.top && schedule.top[rank] != null) return Number(schedule.top[rank]) || 0;
	return Number(schedule.participation) || 0;
}

/**
 * Build the rank-keyed prize table for resolveChallenge from a challenge's
 * schedule and the ranks present in its verified standings. Merit-only. A
 * finisher with a non-positive verified score earns nothing (no reward for zero
 * effort — also blocks a Merit-farm via an empty alt).
 * @param {object} challenge
 * @param {Array<{entity, rank, score_verified}>} standings
 * @returns {Array<{rank, merits}>}
 */
function prizesForStandings(challenge, standings) {
	const schedule = scheduleFor(challenge);
	const prizes = [];
	for (const row of standings || []) {
		if (!(Number(row.score_verified) > 0)) continue; // no reward for zero score
		const merits = meritsForRank(schedule, row.rank);
		if (merits > 0) prizes.push({ rank: row.rank, merits });
	}
	return prizes;
}

module.exports = {
	SCHEDULES,
	DEFAULT_SCHEDULE,
	scheduleFor,
	meritsForRank,
	prizesForStandings,
};
