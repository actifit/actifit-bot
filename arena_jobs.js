/**
 * Challenge Engine — scheduled aggregation job (Trello #176/#177, epic #171).
 *
 * Wires the F2 verification + F3 standings library functions into a periodic
 * sweep so the Arena is LIVE: participant scores and the public standings board
 * are (re)materialized from the trusted `verified_posts` feed on a schedule,
 * without any client action.
 *
 * What it does each run, for every non-terminal challenge with a valid window:
 *   1. verifyChallenge  — recompute each participant's verified score + anti-cheat
 *      flags from `verified_posts` (idempotent; recomputes from source).
 *   2. buildStandings   — rank the verified scores into a PER-CHALLENGE standings
 *      doc keyed by the challenge id, which is exactly what the web detail page
 *      queries (/arena/standings?id=<challengeId>).
 *
 * Idempotent + safe to re-run: both underlying functions recompute from source,
 * so a missed tick or an overlapping run only converges. One challenge failing
 * (e.g. a transient read) never aborts the sweep — it's logged and skipped.
 *
 * NOT resolution/payout — that is the separate settlement job (F5). This sweep
 * never emits Merits, moves funds, or broadcasts anything; it only reads
 * `verified_posts` and writes the `challenge_participants.score` +
 * `standings` read models.
 *
 * Load-time safe: requires only the config/Firebase-free arena libs. The caller
 * (app.js) owns scheduling + the single-instance (BOT_THREAD==MAIN) guard.
 */

'use strict';

const arenaVerify = require('./arena_verify');
const arenaStandings = require('./arena_standings');

// States a challenge can be aggregated in — everything that isn't terminal.
// (draft challenges have no participants yet; open/active/resolving do.)
const AGGREGATABLE_STATES = ['open', 'active', 'resolving'];

function hasWindow(w) {
	if (!w) return false;
	const s = Date.parse(w.start);
	const e = Date.parse(w.end);
	return !Number.isNaN(s) && !Number.isNaN(e) && s < e;
}

/**
 * Run one aggregation sweep over the currently-aggregatable challenges.
 *
 * @param {object} db
 * @param {object} [opts]
 *   asOf   {string}  ISO timestamp stamped on scores/standings (default now)
 *   limit  {number}  max challenges to process this tick (default 200)
 *   log    {(msg)=>void}
 *   verifyOpts {object} passthrough anti-cheat thresholds for verifyChallenge
 * @returns {Promise<{ok, processed, verified, standings, failed, skipped}>}
 */
async function aggregateActiveChallenges(db, opts = {}) {
	const log = typeof opts.log === 'function' ? opts.log : () => {};
	const asOf = opts.asOf || new Date().toISOString();
	const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : 200;

	const challenges = await db.collection('challenges')
		.find({ state: { $in: AGGREGATABLE_STATES } })
		.limit(limit)
		.toArray();

	let verified = 0;
	let standings = 0;
	let failed = 0;
	let skipped = 0;

	for (const ch of challenges) {
		// Skip (don't fail) a challenge with no usable window — scoring against
		// unbounded history is refused by verifyChallenge anyway (fail-closed).
		if (!hasWindow(ch.window)) { skipped++; continue; }
		try {
			const v = await arenaVerify.verifyChallenge(db, ch.id, { ...(opts.verifyOpts || {}), asOf });
			if (v && v.ok) verified++;

			const s = await arenaStandings.buildStandings(db, {
				challengeIds: [ch.id],
				id: ch.id,              // key the doc by the challenge id (web reads by id)
				scope: 'challenge',
				window: ch.window,
				asOf,
			});
			if (s && s.ok) standings++;
		} catch (e) {
			failed++;
			log(`arena aggregate: challenge ${ch.id} failed: ${e && e.message}`);
		}
	}

	const summary = { ok: true, processed: challenges.length, verified, standings, failed, skipped };
	log(`arena aggregate: processed=${summary.processed} verified=${verified} standings=${standings} skipped=${skipped} failed=${failed}`);
	return summary;
}

module.exports = {
	AGGREGATABLE_STATES,
	aggregateActiveChallenges,
};
