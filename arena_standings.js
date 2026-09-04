/**
 * Challenge Engine — F3 aggregation / standings (Trello #177, epic #171).
 *
 * Turns the per-participant verified scores that F2 materializes
 * (participants.score.verified) into time-windowed STANDINGS: ranked tables per
 * cohort with points, rank, and promote/hold/relegate movement — the layer the
 * daily leaderboard (today-only) can't provide and that Leagues & Seasons
 * (Vertical A, #172) build on. See the spec `tasks/challenge-engine-spec.md`
 * §5 + §3.3–3.4.
 *
 * Two league scoring modes (both skill/goal-based):
 *   - 'score'        — rank by summed verified activity over the window
 *                      (weekly step-league / Top-N).
 *   - 'head_to_head' — POLIAC: each fixture is a duel; higher verified score that
 *                      day wins (3 pts / draw 1 / loss 0); the league table is the
 *                      sum of fixture points.
 *
 * Structure (pure core → orchestration):
 *   - rankRows(rows, opts)          — rank + promote/relegate movement (pure)
 *   - fixturePoints(fixtures)       — POLIAC W/D/L → points per entity (pure)
 *   - computeStandings(rows, opts)  — build the standings rows for one cohort
 *   - buildStandings(db, params)    — read participant scores, compute, upsert a
 *                                     `standings` doc (idempotent)
 *
 * Excludes any ENTITY held for anti-cheat review (a flag in any of its legs)
 * from the ranked table, so a flagged score never takes a prize slot before it's
 * cleared — exclusion is per-entity, not per-challenge-leg.
 *
 * Idempotent: buildStandings recomputes from the current participant scores and
 * upserts the one standings doc for (scope, window, cohort) — safe to re-run
 * (relies on the unique index from ensureStandingsIndexes).
 *
 * F3 slice scope / DEFERRED (follow-ups): the scheduled daily rollup (immutable
 * per-day audit rows), the season aggregator (close → tiers → reward chests) and
 * the `seasons` collection (§3.4), a `head_to_head` PERSISTENCE path in
 * buildStandings (it is score-mode only here; POLIAC fixtures are assembled by
 * the caller and only computeStandings ranks them), and the `delta` row field
 * (rank change vs the prior window — needs prior-window lookback).
 *
 * Load-time safe: requires nothing (no config/Firebase); dependency-injected db.
 */

'use strict';

const arenaVerify = require('./arena_verify'); // ANTICHEAT_FLAG only

const COLLECTIONS = {
	PARTICIPANTS: 'challenge_participants',
	STANDINGS: 'standings',
};

const POINTS = { win: 3, draw: 1, loss: 0 };

/**
 * Stable id for a standings read-model row (one per program+scope+window+cohort).
 * Includes `window.program` so two programs (leagues / poliac / squads) with
 * independent season numbering don't collide on the same (scope, index, cohort).
 */
function standingsId(scope, window, cohort) {
	const w = window || {};
	const prog = w.program || 'default';
	const win = w.index != null ? `i${w.index}` : (w.start || 'w');
	return `std_${scope || 'league'}_${prog}_${w.kind || 'window'}_${win}_${cohort || 'all'}`;
}

/**
 * Rank rows by `key` (desc) and stamp rank + promote/hold/relegate movement.
 * Pure. `rows`: [{ entity, score, ...metrics }]. `opts.key` the sort field
 * (default 'score'); `opts.promotion` = { up, down } cohort promote/relegate
 * counts. Tie-break order: `key` desc, then aggregate `score` desc (the
 * documented "goals-for" tiebreak for a points tie), then `entity` ascending —
 * so ties still get DISTINCT ranks and a promotion cutoff is never ambiguous.
 * When the promote/relegate zones overlap (up + down > n), promote takes
 * precedence and a row is never both.
 */
function rankRows(rows, opts = {}) {
	const key = opts.key || 'score';
	const up = (opts.promotion && opts.promotion.up) || 0;
	const down = (opts.promotion && opts.promotion.down) || 0;

	const sorted = [...rows].sort((a, b) => {
		const d = (b[key] || 0) - (a[key] || 0);
		if (d !== 0) return d;
		const s = (b.score || 0) - (a.score || 0);
		if (s !== 0) return s;
		return a.entity < b.entity ? -1 : (a.entity > b.entity ? 1 : 0);
	});

	const n = sorted.length;
	return sorted.map((row, i) => {
		let movement = 'hold';
		if (up && i < up) movement = 'promote';
		else if (down && i >= n - down) movement = 'relegate';
		return { ...row, rank: i + 1, movement };
	});
}

/**
 * POLIAC head-to-head: reduce fixtures to per-entity W/D/L + points. Pure.
 * `fixtures`: [{ a:{entity,score}, b:{entity,score} }]. A fixture with a missing
 * side, or either side flagged, can be pre-filtered by the caller.
 */
function fixturePoints(fixtures) {
	const table = new Map();
	const ensure = (e) => {
		if (!table.has(e)) table.set(e, { entity: e, played: 0, won: 0, drawn: 0, lost: 0, points: 0, score: 0 });
		return table.get(e);
	};
	for (const f of fixtures || []) {
		if (!f || !f.a || !f.b) continue;
		if (!f.a.entity || !f.b.entity || f.a.entity === f.b.entity) continue; // no self-fixtures
		const A = ensure(f.a.entity);
		const B = ensure(f.b.entity);
		A.played++; B.played++;
		const sa = Number(f.a.score) || 0;
		const sb = Number(f.b.score) || 0;
		A.score += sa; B.score += sb;
		if (sa > sb) { A.won++; A.points += POINTS.win; B.lost++; B.points += POINTS.loss; }
		else if (sb > sa) { B.won++; B.points += POINTS.win; A.lost++; A.points += POINTS.loss; }
		else { A.drawn++; B.drawn++; A.points += POINTS.draw; B.points += POINTS.draw; }
	}
	return [...table.values()];
}

/**
 * Build the ranked standings rows for one cohort. Pure.
 * `mode` = 'score' (rank by summed verified score) | 'head_to_head' (rank by
 * fixture points, score as tiebreak). Returns ranked rows with movement.
 */
function computeStandings(input, opts = {}) {
	const mode = opts.mode || 'score';
	if (mode === 'head_to_head') {
		const rows = fixturePoints(input);
		return rankRows(rows, { key: 'points', promotion: opts.promotion });
	}
	// score mode: input is [{ entity, score }]. Mirror `score` into `points` so
	// the standings row shape is uniform with head_to_head and matches §3.3.
	const rows = (input || []).map((r) => ({ ...r, points: r.score || 0 }));
	return rankRows(rows, { key: 'score', promotion: opts.promotion });
}

/** Is a participant excluded from the ranked table (held for anti-cheat)? */
function isHeld(participant) {
	return Array.isArray(participant.flags) && participant.flags.includes(arenaVerify.ANTICHEAT_FLAG);
}

/**
 * Read the participants of the given challenges, rank them into a standings
 * table for (scope, window, cohort), and upsert the `standings` read model.
 * Score-mode only (fixtures are assembled by the caller for head_to_head).
 *
 * @param {object} params { challengeIds:[], scope, window, cohort, promotion,
 *                          includeHeld }
 * @returns {Promise<{ok:boolean, id?:string, ranked?:number, held?:number, reason?:string}>}
 */
async function buildStandings(db, params = {}) {
	const { challengeIds, scope = 'league', window, cohort, promotion, includeHeld = false } = params;
	if (!Array.isArray(challengeIds) || challengeIds.length === 0) {
		return { ok: false, reason: 'no challengeIds' };
	}

	const parts = await db.collection(COLLECTIONS.PARTICIPANTS)
		.find({ challenge_id: { $in: challengeIds } }).toArray();

	// A participant who LEFT is not ranked (their in-window score must not hold a
	// leaderboard/prize slot).
	const isActive = (p) => p.state !== 'left';
	const inCohort = (p) => (!cohort || p.cohort === cohort) && isActive(p);
	// Anti-cheat hold is per-ENTITY: a flag in ANY leg suppresses the whole entity
	// (its clean legs must not take a prize slot while a hold is open).
	const heldEntities = new Set(parts.filter((p) => inCohort(p) && isHeld(p)).map((p) => p.entity));

	// Aggregate a participant's verified score across the given challenges,
	// keyed by entity (a season spans many fixture-challenges).
	const byEntity = new Map();
	for (const p of parts) {
		if (!inCohort(p)) continue;
		if (!includeHeld && heldEntities.has(p.entity)) continue;
		const verified = (p.score && Number(p.score.verified)) || 0;
		byEntity.set(p.entity, (byEntity.get(p.entity) || 0) + verified);
	}
	const held = includeHeld ? 0 : heldEntities.size;

	const rows = [...byEntity.entries()].map(([entity, score]) => ({ entity, score }));
	const ranked = computeStandings(rows, { mode: 'score', promotion });

	// Per-challenge standings are keyed by the challenge id (params.id) so the
	// public detail page — which queries /arena/standings?id=<challengeId> — finds
	// them. Omit params.id for scope/season boards to use the derived standingsId.
	const id = (typeof params.id === 'string' && params.id) ? params.id : standingsId(scope, window, cohort);
	await db.collection(COLLECTIONS.STANDINGS).replaceOne(
		{ id },
		{ id, scope, window: window || null, cohort: cohort || null, rows: ranked, computed_at: params.asOf || new Date().toISOString() },
		{ upsert: true }
	);

	return { ok: true, id, ranked: ranked.length, held };
}

/**
 * Ensure the unique index the standings upsert relies on. Without it, two
 * concurrent rebuilds of the same (scope, window, cohort) could both upsert and
 * create duplicate docs. Safe no-op where createIndex is unavailable (mock).
 */
async function ensureStandingsIndexes(db) {
	const col = db.collection(COLLECTIONS.STANDINGS);
	if (typeof col.createIndex === 'function') {
		await col.createIndex({ id: 1 }, { unique: true });
		await col.createIndex({ scope: 1, cohort: 1 });
	}
}

module.exports = {
	COLLECTIONS,
	POINTS,
	standingsId,
	rankRows,
	fixturePoints,
	computeStandings,
	isHeld,
	buildStandings,
	ensureStandingsIndexes,
};
