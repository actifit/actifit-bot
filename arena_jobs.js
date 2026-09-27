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
 * (app.js) owns scheduling + the single-instance (BOT_THREAD=='SECOND_API') guard.
 */

'use strict';

const arenaVerify = require('./arena_verify');
const arenaStandings = require('./arena_standings');
const arenaPools = require('./arena_pools');
const arenaRewards = require('./arena_rewards');
const arenaFund = require('./arena_fund');
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
 * across periods and the web can group a series by parent_id.
 *
 * CADENCE vs WINDOW LENGTH are different things and must not be conflated:
 *   - cadence       = RECURRENCE_MS[ch.recurrence] - how often the contest REPEATS
 *   - window length = end - start                  - how long each period RUNS
 * They coincide for five of the six defaults (Daily/1d, Weekly/7d, Seasonal/14d,
 * Monthly/30d), which is why using the window length as the period went unnoticed.
 * Weekend Warrior is `recurrence: 'Weekly'` with a 2-DAY window: rolling by window
 * length made it repeat every 2 days and walk off the weekend permanently
 * (observed in production 2026-09-25). The next window therefore starts one
 * CADENCE after this one started, and keeps this one's length.
 */
function nextOccurrence(ch, nowMs) {
	if (!isRecurringDefault(ch) || !hasWindow(ch.window)) return null;
	const base = ch.parent_id || ch.id;
	const start = Date.parse(ch.window.start);
	const end = Date.parse(ch.window.end);
	const len = end - start;                            // how long each period RUNS
	const period = RECURRENCE_MS[ch.recurrence] || len; // how often it REPEATS
	// Roll forward one cadence from this window's start; if we're already past
	// several periods (a long outage), skip ahead so the new window is current,
	// not stale. Guard the loop: a non-positive period would spin forever.
	let nextStart = start + period;
	if (Number.isFinite(nowMs) && period > 0) {
		while (nextStart + len < nowMs) nextStart += period;
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

	// Oldest-closing first, so under a backlog the longest-overdue challenges are
	// resolved before the limit is reached (avoids starving due challenges).
	const candidates = await challengesC
		.find({ state: { $in: AGGREGATABLE_STATES } })
		.sort({ 'window.end': 1 })
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
				// Prizes: an OFFICIAL contest uses its system schedule (treasury-funded,
				// capped); a CREATOR-FUNDED challenge distributes its own pool (top-3
				// split, bounded by the pool budget, no treasury cap).
				let prizes, poolId = null;
				if (ch.pool_ref) {
					const pool = await db.collection('pools').findOne({ id: ch.pool_ref });
					poolId = ch.pool_ref;
					prizes = arenaRewards.poolPrizes(pool ? pool.budget : 0);
				} else {
					prizes = arenaRewards.prizesForStandings(ch, standings);
				}
				// Award the creator-defined badge(s) to the finishers named by the
				// challenge's badge_rule (winner / top3 / all) — the step that turns a
				// badge-only contest's rewards.badges into an actual grant at settlement.
				prizes = arenaRewards.withBadgePrizes(prizes, ch, standings);
				// Settlement credits off-chain AFIT, records participant results + an
				// idempotent resolution marker, and returns the settle payload.
				resolution = await arenaPools.resolveChallenge(db, { challengeId: ch.id, poolId, standings, prizes, asOf, dailyCap: opts.afitDailyCap, weeklyBudget: opts.afitWeeklyBudget });
				if (!resolution.ok) { failed++; log(`arena resolve: ${ch.id} failed: ${resolution.reason}`); continue; }
				resolved++;
				// F6 — notify each rewarded finisher. Reward objects don't carry rank,
				// so read it from the settle standings (entity -> rank).
				const rankByEntity = new Map(
					((resolution.settlePayload && resolution.settlePayload.standings) || []).map((s) => [s.entity, s.rank])
				);
				for (const rw of (resolution.settlePayload && resolution.settlePayload.rewards) || []) {
					if (rw && rw.entity && (Number(rw.afit) > 0 || (Array.isArray(rw.badges) && rw.badges.length > 0))) {
						// One bad event must not drop the rest (or mark the whole
						// resolution failed after AFIT was already credited).
						try {
							await arenaApi.emitEvent(db, {
								type: 'results_settled', user: rw.entity, challenge_id: ch.id,
								data: { rank: rankByEntity.has(rw.entity) ? rankByEntity.get(rw.entity) : null, afit: rw.afit, badges: Array.isArray(rw.badges) ? rw.badges : [] }, at: asOf,
							});
						} catch (e) {
							log(`arena resolve: event for ${rw.entity} on ${ch.id} failed: ${e && e.message}`);
						}
					}
				}
			}

			// Refund any UNPAID balance of a CREATOR-FUNDED pool back to the creator
			// (idempotent, safe on every pass — including a crash-retry where the
			// resolution marker landed but the refund hadn't). A challenge that drew
			// fewer than the funded ranks never burns the creator's prize.
			if (ch.pool_ref) {
				try {
					await arenaFund.refundUnpaid(db, { challengeId: ch.id, poolId: ch.pool_ref, creator: ch.created_by, at: asOf });
				} catch (e) {
					log(`arena resolve: refund ${ch.id} failed: ${e && e.message}`);
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
					// Guard against a double-roll: skip if the exact next id exists, OR
					// if ANY successor of this base already covers a window at/after this
					// one's end (the next id is now-derived via skip-ahead, so a crash-
					// retry across a period boundary could otherwise compute a new id).
					const base = ch.parent_id || ch.id;
					const siblings = await challengesC.find({ parent_id: base }).toArray();
					const alreadyRolled = next && (
						siblings.some((s) => s.id === next.id) ||
						siblings.some((s) => s.window && Date.parse(s.window.start) >= Date.parse(ch.window.end))
					);
					if (next && !alreadyRolled) {
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

// ---- auto-enrolment of a rolled recurrence (F5b) ---------------------------

/** How many entities one `enroll` op may carry. Hive caps a custom_json payload
 *  at 8192 bytes; at ~20 bytes per account name plus the envelope, 200 stays an
 *  order of magnitude inside that even for long names. A bigger roster is split
 *  across several ops, which the indexer applies additively. */
const AUTO_ENROLL_CHUNK = 200;

/** A carried-forward participant must show REAL recent activity, otherwise a
 *  one-time joiner who stopped using Actifit would be re-enrolled into every
 *  future occurrence forever. 7 days, measured back from the roll: the production
 *  roster (2026-09-27) posts 2-8 reports a week, so a 1-2 day lookback would have
 *  dropped a genuine weekly participant. */
const AUTO_ENROLL_LOOKBACK_DAYS = 7;

/**
 * Carry a recurring default's roster into the occurrence it just rolled into.
 *
 * WHY: joining is a user-signed on-chain act, scoped to ONE challenge id. A
 * recurring contest rolls into a brand-new id, so every occurrence started with
 * an EMPTY roster and nobody realised they had to re-join. In production
 * `def_daily_focus@2026-09-25` ran, resolved and broadcast an on-chain settle for
 * nobody, and the two occurrences after it were empty too.
 *
 * The roster is sourced from the WHOLE SERIES (the base challenge plus every
 * sibling sharing its parent_id) - not just the occurrence that closed. Sourcing
 * only from the previous occurrence would perpetuate the hole rather than heal
 * it: once one occurrence is empty, every later one inherits emptiness forever.
 *
 * Chain-first, and NOT a forged join: we hold only @actifit's posting key, and a
 * `join` is the user's own assertion to make. We broadcast the official-signed
 * `enroll` op instead, which the indexer already accepts from the official
 * account alone. An auto-enrolment is therefore visibly distinct on-chain from a
 * user's own join, and just as auditable.
 *
 * Runs as its OWN deferred pass rather than inline after the recurrence
 * broadcast: `enroll` is rejected as "unknown challenge" until the tailer has
 * indexed the new challenge. A target that has not appeared yet is left alone and
 * retried next tick, so the pass self-heals instead of silently losing a roster.
 *
 * I1 is untouched - `enroll` carries no entry fee, and the target's entry mode is
 * whatever its create op set (`free` for every default). I7 is preserved by
 * excluding the funder from the carried roster, so a funded contest can never
 * auto-enrol the person paying for it.
 *
 * Idempotent: the resolution is stamped `auto_enrolled_at` once handled, and
 * anyone already on the target roster (a manual joiner, or a re-run) is excluded.
 *
 * @param {object} db
 * @param {object} [opts] { asOf, now, limit, broadcastOp, lookbackDays, log }
 * @returns {Promise<{ok, processed, enrolled, ops, skipped, failed}>}
 */
async function autoEnrollRecurrences(db, opts = {}) {
	const log = typeof opts.log === 'function' ? opts.log : () => {};
	const asOf = opts.asOf || new Date().toISOString();
	const nowMs = Number.isFinite(opts.now) ? opts.now : Date.parse(asOf);
	const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : 50;
	const broadcast = typeof opts.broadcastOp === 'function' ? opts.broadcastOp : null;
	const lookbackDays = Number.isFinite(opts.lookbackDays) && opts.lookbackDays > 0
		? opts.lookbackDays
		: AUTO_ENROLL_LOOKBACK_DAYS;

	const resolutionsC = db.collection('challenge_resolutions');
	const challengesC = db.collection('challenges');
	const participantsC = db.collection('challenge_participants');
	const verifiedC = db.collection('verified_posts');

	// No broadcaster = nothing we can do. Leave every marker UNSET so the work is
	// picked up whole once one exists, rather than marked done-and-empty.
	if (!broadcast) {
		log('arena auto-enroll: no broadcaster - skipped');
		return { ok: true, processed: 0, enrolled: 0, ops: 0, skipped: 0, failed: 0 };
	}

	const pending = await resolutionsC
		.find({ recurred_to: { $exists: true, $ne: null }, auto_enrolled_at: { $exists: false } })
		.limit(limit)
		.toArray();

	let enrolled = 0;
	let ops = 0;
	let skipped = 0;
	let failed = 0;

	for (const r of pending) {
		try {
			const target = await challengesC.findOne({ id: r.recurred_to });
			// The tailer has not indexed the rolled challenge yet - leave the marker
			// unset and retry on the next tick.
			if (!target) { skipped++; continue; }

			// Stamp the resolution so a dead end is never retried forever. Carries a
			// reason so the decision stays legible without re-deriving it.
			const mark = (reason, extra) => resolutionsC.updateOne(
				{ challenge_id: r.challenge_id },
				{ $set: { auto_enrolled_at: asOf, auto_enroll_reason: reason, ...(extra || {}) } }
			);

			// Only enrol into a roster that can still actually play.
			if (!['open', 'active'].includes(target.state)) {
				await mark('target state ' + target.state);
				skipped++;
				continue;
			}
			if (hasWindow(target.window) && Date.parse(target.window.end) <= nowMs) {
				await mark('target window already closed');
				skipped++;
				continue;
			}

			// ---- assemble the series roster ----------------------------------
			// Two queries plus a union, because the base challenge is identified by its
			// own id while the occurrences are identified by parent_id (and the
			// in-memory test mock supports no $or).
			const base = target.parent_id || target.id;
			const seriesIds = new Set([base]);
			for (const s of await challengesC.find({ parent_id: base }).toArray()) seriesIds.add(s.id);
			seriesIds.delete(target.id);   // never source from the target itself

			const candidates = new Set();
			for (const cid of seriesIds) {
				// state:'left' is an explicit on-chain opt-out and MUST survive the roll,
				// otherwise leaving a recurring contest would achieve nothing.
				for (const p of await participantsC.find({ challenge_id: cid, state: { $ne: 'left' } }).toArray()) {
					if (typeof p.entity === 'string' && p.entity) candidates.add(p.entity);
				}
			}

			// Already on the target roster (a manual re-join, or an earlier partial run).
			for (const p of await participantsC.find({ challenge_id: target.id }).toArray()) {
				candidates.delete(p.entity);
			}
			// I7 - the funder of a prize can never be enrolled to win it.
			const funder = (target.rewards && target.rewards.funder) || target.creator || null;
			if (funder) candidates.delete(funder);

			// ---- prune the dormant -------------------------------------------
			// A squad has no `verified_posts` author, so the activity test can only be
			// applied to user rosters; a squad series carries forward unfiltered.
			const isUserRoster = (target.participants_kind || 'user') === 'user';
			const since = new Date(nowMs - lookbackDays * DAY_MS);
			const entities = [];
			for (const entity of candidates) {
				if (!isUserRoster) { entities.push(entity); continue; }
				// find+limit(1) rather than countDocuments: it short-circuits on the
				// {author,date} index, and the in-memory test mock has no countDocuments.
				const recent = await verifiedC.find({ author: entity, date: { $gte: since } }).limit(1).toArray();
				if (recent.length) entities.push(entity);
			}

			if (!entities.length) {
				await mark('no active carry-forward candidates', { auto_enrolled_count: 0 });
				skipped++;
				continue;
			}

			// ---- broadcast ----------------------------------------------------
			// Chunked, and counted per successful op: a mid-roster failure leaves the
			// marker unset so the remainder is retried next tick (the already-enrolled
			// are filtered out by the target-roster exclusion above).
			entities.sort();
			for (let i = 0; i < entities.length; i += AUTO_ENROLL_CHUNK) {
				const chunk = entities.slice(i, i + AUTO_ENROLL_CHUNK);
				await broadcast({
					op: 'enroll', v: 1,
					challenge_id: target.id,
					entities: chunk,
					reason: 'recurrence_carry_forward',
					from: r.challenge_id,
				});
				ops++;
				enrolled += chunk.length;
			}
			await mark('carried forward', { auto_enrolled_count: entities.length });
			log('arena auto-enroll: ' + r.challenge_id + ' -> ' + target.id + ' carried ' + entities.length + ' participant(s) in ' + Math.ceil(entities.length / AUTO_ENROLL_CHUNK) + ' op(s)');
		} catch (e) {
			failed++;
			log('arena auto-enroll: ' + r.challenge_id + ' error: ' + (e && e.message));
		}
	}

	const summary = { ok: true, processed: pending.length, enrolled, ops, skipped, failed };
	log('arena auto-enroll: processed=' + summary.processed + ' enrolled=' + enrolled + ' ops=' + ops + ' skipped=' + skipped + ' failed=' + failed);
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
	autoEnrollRecurrences,
	AUTO_ENROLL_CHUNK,
	AUTO_ENROLL_LOOKBACK_DAYS,
	ensureArenaJobIndexes,
};
