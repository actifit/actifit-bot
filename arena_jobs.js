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
const arenaPools = require('./arena_pools');
const arenaRewards = require('./arena_rewards');
const arenaApi = require('./arena_api');

// States a challenge can be aggregated in — everything that isn't terminal.
// (draft challenges have no participants yet; open/active/resolving do.)
const AGGREGATABLE_STATES = ['open', 'active', 'resolving'];

// Recurrence period lengths (ms) keyed by the presentation `recurrence` label.
const DAY_MS = 24 * 60 * 60 * 1000;
const RECURRENCE_MS = {
	Daily: 1 * DAY_MS,
	Weekly: 7 * DAY_MS,
	Seasonal: 14 * DAY_MS,
	Monthly: 30 * DAY_MS,
};

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

	const nowMs = Date.parse(asOf);
	let verified = 0;
	let standings = 0;
	let failed = 0;
	let skipped = 0;

	for (const ch of challenges) {
		// Skip (don't fail) a challenge with no usable window — scoring against
		// unbounded history is refused by verifyChallenge anyway (fail-closed).
		if (!hasWindow(ch.window)) { skipped++; continue; }
		// Skip a challenge whose window has not STARTED yet — otherwise we publish a
		// premature all-zero board (nobody has any in-window activity). It picks up
		// automatically on the first tick after the window opens.
		if (Number.isFinite(nowMs) && Date.parse(ch.window.start) > nowMs) { skipped++; continue; }
		try {
			const v = await arenaVerify.verifyChallenge(db, ch.id, { ...(opts.verifyOpts || {}), asOf });
			const s = await arenaStandings.buildStandings(db, {
				challengeIds: [ch.id],
				id: ch.id,              // key the doc by the challenge id (web reads by id)
				scope: 'challenge',
				window: ch.window,
				asOf,
			});
			// Count only after BOTH steps complete, so a throw partway through lands
			// solely in `failed` (never double-counted in verified/standings too).
			if (v && v.ok) verified++;
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

// ---- resolution / settlement (F5) + recurrence -----------------------------

/** A recurring OFFICIAL default challenge (def_* family) whose window rolls
 *  forward. Restricted to defaults so user challenges never auto-proliferate. */
function isRecurringDefault(ch) {
	if (!ch) return false;
	const base = ch.parent_id || ch.id || '';
	return base.indexOf('def_') === 0 && !!RECURRENCE_MS[ch.recurrence];
}

/** Whitelisted presentation fields to copy onto a rolled recurrence instance. */
function presentationOf(ch) {
	const out = {};
	for (const k of ['tagline', 'how_it_works', 'prize_summary', 'recurrence', 'art']) {
		if (typeof ch[k] === 'string' && ch[k]) out[k] = ch[k];
	}
	return out;
}

/**
 * Build the next-occurrence `challenge_create` op body for a recurring default,
 * or null if it isn't recurring / has no usable window. The new id chains from
 * the ORIGINAL base via parent_id (`<base>@<nextStartDate>`), so ids stay clean
 * across periods and the web can group a series by parent_id. Window length is
 * preserved; the next window starts where this one ended.
 */
function nextOccurrence(ch, nowMs) {
	if (!isRecurringDefault(ch) || !hasWindow(ch.window)) return null;
	const base = ch.parent_id || ch.id;
	const start = Date.parse(ch.window.start);
	const end = Date.parse(ch.window.end);
	const len = end - start;
	// Roll forward from this window's end; if we're already past several periods
	// (a long outage), skip ahead so the new window is current, not stale.
	let nextStart = end;
	if (Number.isFinite(nowMs)) {
		while (nextStart + len < nowMs) nextStart += len;
	}
	const nextEnd = nextStart + len;
	const startIso = new Date(nextStart).toISOString();
	const nextId = `${base}@${startIso.slice(0, 10)}`;
	return {
		op: 'challenge_create', v: 1,
		id: nextId,
		type: ch.type,
		origin_tier: 'official',
		title: ch.title || null,
		visibility: ch.visibility || 'public',
		community: ch.community || null,
		participants_kind: ch.participants_kind || 'user',
		window: { start: startIso, end: new Date(nextEnd).toISOString(), tz: (ch.window && ch.window.tz) || 'UTC' },
		entry: { mode: 'free' },
		scoring: ch.scoring,
		rewards: ch.rewards || null,
		parent_id: base,
		...presentationOf(ch),
	};
}

/**
 * Resolve every DUE challenge (window ended, non-terminal, not yet resolved):
 * finalize scores/standings, draw the Merit prize table, emit Merits + record the
 * result (F5 resolveChallenge), broadcast the on-chain `settle` op as @actifit
 * (the authoritative record — the tailer then flips the challenge to settled),
 * fire per-winner F6 events, and roll a recurring default into its next window.
 *
 * REQUIRES the tailer to be enabled to complete the chain-first loop (state →
 * settled, and the rolled next-occurrence indexed). Merit emission + the local
 * resolution record happen regardless (idempotent per challenge). `opts.broadcastOp`
 * (injected by app.js — signs with @actifit's posting key) is optional; without
 * it, settle/recurrence are skipped and only Merits/results/events are written.
 *
 * @param {object} db
 * @param {object} [opts] { now, asOf, limit, officialAccount, broadcastOp, log }
 * @returns {Promise<{ok, processed, resolved, settled, recurred, failed, skipped}>}
 */
async function resolveDueChallenges(db, opts = {}) {
	const log = typeof opts.log === 'function' ? opts.log : () => {};
	const nowMs = opts.now ? Date.parse(opts.now) : Date.now();
	const asOf = opts.asOf || new Date(nowMs).toISOString();
	const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : 200;
	const broadcast = typeof opts.broadcastOp === 'function' ? opts.broadcastOp : null;
	const challengesC = db.collection('challenges');
	const resolutionsC = db.collection('challenge_resolutions');

	const candidates = await challengesC
		.find({ state: { $in: AGGREGATABLE_STATES } })
		.limit(limit)
		.toArray();

	let resolved = 0, settled = 0, recurred = 0, failed = 0, skipped = 0;

	for (const ch of candidates) {
		try {
			if (!hasWindow(ch.window)) { skipped++; continue; }
			// Not DUE until the window has closed.
			if (Date.parse(ch.window.end) > nowMs) { skipped++; continue; }

			const prior = await resolutionsC.findOne({ challenge_id: ch.id });
			let resolution;
			if (prior) {
				resolution = { ok: true, noop: true, settlePayload: prior.settlePayload };
			} else {
				// Final aggregation against the (now stable) verified feed.
				await arenaVerify.verifyChallenge(db, ch.id, { asOf });
				await arenaStandings.buildStandings(db, {
					challengeIds: [ch.id], id: ch.id, scope: 'challenge', window: ch.window, asOf,
				});
				const board = await db.collection('standings').findOne({ id: ch.id });
				const rows = (board && Array.isArray(board.rows)) ? board.rows : [];
				const standings = rows.map((r) => ({
					entity: r.entity,
					rank: r.rank,
					score_verified: r.score != null ? r.score : (r.points != null ? r.points : 0),
				}));
				const prizes = arenaRewards.prizesForStandings(ch, standings);
				// Merit-only settlement (no pool) → resolveChallenge emits Merits,
				// records participant results + an idempotent resolution marker, and
				// returns the settle payload.
				resolution = await arenaPools.resolveChallenge(db, { challengeId: ch.id, standings, prizes, asOf });
				if (!resolution.ok) { failed++; log(`arena resolve: ${ch.id} failed: ${resolution.reason}`); continue; }
				resolved++;
				// F6 — notify each rewarded finisher. Reward objects don't carry rank,
				// so read it from the settle standings (entity -> rank).
				const rankByEntity = new Map(
					((resolution.settlePayload && resolution.settlePayload.standings) || []).map((s) => [s.entity, s.rank])
				);
				for (const rw of (resolution.settlePayload && resolution.settlePayload.rewards) || []) {
					if (rw && rw.entity && Number(rw.merits) > 0) {
						await arenaApi.emitEvent(db, {
							type: 'results_settled', user: rw.entity, challenge_id: ch.id,
							data: { rank: rankByEntity.has(rw.entity) ? rankByEntity.get(rw.entity) : null, merits: rw.merits }, at: asOf,
						});
					}
				}
			}

			// Broadcast the authoritative on-chain settle op — once. The resolution
			// record carries settle_trx after a successful broadcast, so a re-run (while
			// the tailer hasn't yet flipped the challenge to settled) never double-sends.
			if (broadcast && resolution.settlePayload) {
				const marker = prior || await resolutionsC.findOne({ challenge_id: ch.id });
				if (!marker || !marker.settle_trx) {
					try {
						const r = await broadcast(resolution.settlePayload);
						settled++;
						await resolutionsC.updateOne(
							{ challenge_id: ch.id },
							{ $set: { settle_trx: (r && (r.id || r.trx_id)) || true, settled_at: asOf } }
						);
					} catch (e) {
						log(`arena resolve: settle broadcast ${ch.id} failed: ${e && e.message}`);
					}
				}
			}

			// Recurrence — roll a recurring default into its next window ONCE. Guarded
			// by a `recurred_to` marker on the resolution record (robust even if the
			// tailer hasn't yet indexed the new challenge), plus a belt-and-suspenders
			// check that the next id doesn't already exist.
			if (broadcast && isRecurringDefault(ch)) {
				const marker = await resolutionsC.findOne({ challenge_id: ch.id });
				if (marker && !marker.recurred_to) {
					const next = nextOccurrence(ch, nowMs);
					if (next && !(await challengesC.findOne({ id: next.id }))) {
						try {
							await broadcast(next);
							recurred++;
							await resolutionsC.updateOne({ challenge_id: ch.id }, { $set: { recurred_to: next.id } });
							log(`arena resolve: rolled ${ch.id} -> ${next.id}`);
						} catch (e) {
							log(`arena resolve: recurrence ${ch.id} failed: ${e && e.message}`);
						}
					}
				}
			}
		} catch (e) {
			failed++;
			log(`arena resolve: ${ch.id} error: ${e && e.message}`);
		}
	}

	const summary = { ok: true, processed: candidates.length, resolved, settled, recurred, failed, skipped };
	log(`arena resolve: processed=${summary.processed} resolved=${resolved} settled=${settled} recurred=${recurred} skipped=${skipped} failed=${failed}`);
	return summary;
}

/**
 * Ensure the index the aggregation hot-path relies on. The per-participant score
 * query is `verified_posts.find({ author, date: {$gte,$lte} })` — without a
 * compound {author:1, date:1} index it scans the whole window's date range across
 * all authors (736k+ docs) per participant, per challenge, every tick. Additive
 * and safe (background); no-op where createIndex is unavailable (mock).
 */
async function ensureArenaJobIndexes(db) {
	const vp = db.collection('verified_posts');
	if (typeof vp.createIndex === 'function') {
		await vp.createIndex({ author: 1, date: 1 });
	}
}

module.exports = {
	AGGREGATABLE_STATES,
	aggregateActiveChallenges,
	resolveDueChallenges,
	isRecurringDefault,
	nextOccurrence,
	ensureArenaJobIndexes,
};
