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
 * The AFIT schedule for a challenge, or null if it has none.
 *
 * System AFIT emission is OFFICIAL-only. The origin_tier check is the security
 * gate: it is set at ingest from the op SIGNER's authority (only @actifit can
 * create an official challenge — arena.indexArenaOp rejects an official create by
 * any other signer), so a user CANNOT reach an official schedule by spoofing a
 * client-set `parent_id: "def_monthly_liveops"` on a friendly challenge. A
 * legitimate recurrence instance is broadcast by @actifit as origin_tier:'official'
 * with parent_id chaining to its base def_* id.
 */
function scheduleFor(challenge) {
	if (!challenge) return null;
	if (challenge.origin_tier !== 'official') return null; // only official contests system-emit
	const base = challenge.parent_id || challenge.id;
	if (base && SCHEDULES[base]) return SCHEDULES[base];
	if (challenge.id && SCHEDULES[challenge.id]) return SCHEDULES[challenge.id];
	return null; // official but not a scheduled default → no system emission
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

// Default prize split for a CREATOR-FUNDED pool: top-3 take 50/30/20 of the
// budget. Ranks with no finisher go unpaid → refunded to the creator. Rounding
// remainder likewise stays unpaid and is refunded.
const POOL_SPLIT = { 1: 0.5, 2: 0.3, 3: 0.2 };

/**
 * Rank-keyed AFIT prize table for a creator-funded pool of the given budget.
 * @param {number} budget
 * @returns {Array<{rank, afit}>}
 */
function poolPrizes(budget) {
	const b = Number(budget) || 0;
	if (b <= 0) return [];
	const round2 = (x) => Math.round(x * 100) / 100;
	return Object.entries(POOL_SPLIT)
		.map(([rank, frac]) => ({ rank: Number(rank), afit: round2(b * frac) }))
		.filter((p) => p.afit > 0);
}

module.exports = {
	SCHEDULES,
	POOL_SPLIT,
	scheduleFor,
	afitForRank,
	prizesForStandings,
	poolPrizes,
};
