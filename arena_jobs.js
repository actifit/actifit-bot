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

	let resolved = 0, settled = 0, recurred = 0, failed = 0, skipped = 0, budgetExhausted = 0;

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
				if (!resolution.ok) {
					// NOTE this branch is the GENERIC failure path - it also carries
					// pre-existing reasons like 'unknown pool' or 'payout exceeds remaining
					// pool budget', which have nothing to do with the treasury.
					//
					// For the BUDGET-EXHAUSTED case specifically the skip is DELIBERATE and
					// worth stating, because it is a product decision rather than a side
					// effect of `continue`: skipping here also skips the F6 events,
					// refundUnpaid, the settle broadcast AND the recurrence roll, so while
					// the weekly treasury is dry a recurring default creates no next
					// occurrence at all.
					//
					// That is the behaviour we want. Rolling forward during exhaustion just
					// manufactures more contests we cannot pay for, and each one would have
					// to be unwound later; halting damps the cascade instead. nextOccurrence
					// skip-aheads to the current period when it does resume, so the series
					// picks up at today rather than replaying the missed windows - i.e. the
					// missed periods simply never existed, which is the honest outcome for a
					// contest nobody could have been paid for.
					failed++;
					if (resolution.budgetExhausted) budgetExhausted++;
					if (resolution.budgetExhausted && resolution.shortfall && resolution.shortfall.unsatisfiable) {
						// Never going to clear on its own: one prize is bigger than the
						// whole weekly budget. Retrying looks identical to congestion, so
						// name it as configuration.
						log(`arena resolve: *** MISCONFIGURED BUDGET *** ${ch.id} needs ${resolution.shortfall.requested} AFIT for a single prize but the ENTIRE weekly budget is smaller. This will never settle until arena_afit_weekly_budget is raised or the schedule is lowered. ${resolution.reason}`);
					} else if (resolution.budgetExhausted) {
						// Not a transient error, and not self-healing: the weekly treasury
						// budget is gone and NOTHING will settle until it resets or the
						// budget is raised. Say so unmistakably, because the alternative
						// behaviour (settling zeros) was silent and permanent.
						log(`arena resolve: *** WEEKLY AFIT BUDGET EXHAUSTED *** ${ch.id} NOT settled and NOT rolled - it will retry, and no zero reward has been written or broadcast. ${resolution.reason}`);
					} else {
						log(`arena resolve: ${ch.id} failed: ${resolution.reason}`);
					}
					continue;
				}
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

	const summary = { ok: true, processed: candidates.length, resolved, settled, recurred, failed, skipped, budgetExhausted };
	log(`arena resolve: processed=${summary.processed} resolved=${resolved} settled=${settled} recurred=${recurred} skipped=${skipped} failed=${failed}`);
	return summary;
}

// ---- sweep health + alarm state --------------------------------------------

/** Where the sweep records what it just did, so "is the Arena settling?" is an
 *  answerable question instead of something you infer from a log file. */
const HEALTH_COLLECTION = 'arena_health';
const HEALTH_ID = 'resolve_sweep';

/** How many consecutive stalled sweeps before we page. The resolve cron is hourly,
 *  so 2 means "still stuck an hour later" - long enough not to page on a single
 *  transient RPC failure, short enough to matter. */
const STALL_ALERT_TICKS = 2;

/**
 * Record what this sweep did and decide whether the state CHANGED enough to alarm.
 *
 * Why this exists: a stalled Arena used to be indistinguishable from a healthy idle
 * one. `resolveDueChallenges` returned a summary and the caller threw it away, the
 * only trace was a line in arena.log on one box, and every documented health check
 * - the tailer cursor advancing, /arena/challenges returning rows - kept passing
 * while settlement was completely stuck. Worse, when the treasury is dry the
 * recurrence roll is skipped too, so not even the challenge list changes.
 *
 * Alarms fire on TRANSITIONS, not every tick, so a week of exhaustion is one page
 * and one all-clear rather than 168 identical messages.
 *
 * Returns `{ alert }` where alert is null or { kind, subject, body } for the caller
 * to deliver however it likes (this module stays free of mail/transport deps).
 */
async function recordResolveHealth(db, summary, opts = {}) {
	const at = opts.asOf || new Date().toISOString();
	const col = db.collection(HEALTH_COLLECTION);
	const threshold = Number.isInteger(opts.stallTicks) && opts.stallTicks > 0
		? opts.stallTicks
		: STALL_ALERT_TICKS;

	const prior = (typeof col.findOne === 'function' ? await col.findOne({ _id: HEALTH_ID }) : null) || {};
	// A sweep is STALLED if ANYTHING failed. A sweep with nothing due is idle, not
	// stalled - that is the distinction the old log lacked.
	//
	// It deliberately does NOT also require settled === 0. That extra condition meant
	// one permanently stuck challenge was masked by any other challenge happening to
	// settle in the same sweep: five due, four settle, one fails forever on 'unknown
	// pool' -> never alerts, every hour, while that contest's winners are never paid.
	// It also made the alarm's sensitivity depend on what else coincidentally closed
	// that hour, which is not a property an alarm should have.
	const stalled = (summary.failed || 0) > 0;
	// Settlement can also stop WITHOUT failing: `settled` only counts successful
	// broadcasts, so with no posting key the sweep credits AFIT, writes resolutions,
	// reports failed:0 settled:0 - and the record reads perfectly healthy while
	// nothing has ever reached the chain and no recurrence has rolled.
	const cannotBroadcast = opts.canBroadcast === false;
	const streak = stalled ? (Number(prior.stalled_ticks) || 0) + 1 : 0;
	const wasAlerting = !!prior.alerting;
	const nowStalling = streak >= threshold || cannotBroadcast;
	// Recovery has to be EARNED by something actually settling. An idle sweep is not
	// recovery - the stuck challenge may simply have left the due set.
	const recovered = wasAlerting && !nowStalling && (summary.settled || 0) > 0;
	// So the alert state PERSISTS across idle sweeps in between. Clearing it on any
	// quiet tick would both suppress the all-clear and re-arm the alarm, so a
	// still-broken Arena would page again from scratch every time it went quiet.
	const nowAlerting = nowStalling || (wasAlerting && !recovered);

	const doc = {
		_id: HEALTH_ID,
		last_run_at: at,
		last_summary: summary,
		stalled_ticks: streak,
		alerting: nowAlerting,
		stalled_since: stalled ? (prior.stalled_since || at) : null,
		// "last time a settle op was BROADCAST", not "last time something settled".
		// It is legitimately old during healthy operation - most hourly sweeps have
		// nothing due - so it is not a stall signal on its own. `alerting` is.
		last_success_at: (summary.settled || 0) > 0 ? at : (prior.last_success_at || null),
		can_broadcast: !cannotBroadcast,
	};
	if (typeof col.replaceOne === 'function') {
		await col.replaceOne({ _id: HEALTH_ID }, doc, { upsert: true });
	}

	let alert = null;
	if (cannotBroadcast && !wasAlerting) {
		alert = {
			kind: 'cannot_broadcast',
			subject: 'Actifit Arena: NO settle ops can be broadcast - results are not reaching the chain',
			body: 'The Arena resolution sweep is running, but it has no broadcaster, so NO settle\n'
				+ 'ops are being sent. AFIT is being credited off-chain and resolutions are being\n'
				+ 'recorded, but challenges never flip to settled and recurring contests never roll\n'
				+ 'into their next occurrence.\n\n'
				+ 'This is almost always a missing or malformed @actifit POSTING key in the api2\n'
				+ 'process config. It does NOT fix itself.\n\n'
				+ 'Last sweep: ' + JSON.stringify(summary) + '\n',
		};
	} else if (nowStalling && !wasAlerting) {
		const budget = (summary.budgetExhausted || 0) > 0;
		alert = {
			kind: budget ? 'budget_exhausted' : 'settlement_stalled',
			subject: budget
				? 'Actifit Arena: weekly AFIT budget exhausted - settlement STOPPED'
				: 'Actifit Arena: settlement is failing - nothing is being settled',
			body: (budget
				? 'The Arena weekly AFIT treasury budget is exhausted. Challenges are NOT being settled,\n'
					+ 'NO settle ops are being broadcast, and recurring contests are NOT rolling into their\n'
					+ 'next occurrence. No wrong reward has been written or broadcast - that is the point of\n'
					+ 'the refusal - and everything will settle by itself once the budget frees.\n\n'
					+ 'The budget resets on the weekly bucket boundary. To resume sooner, raise\n'
					+ 'arena_afit_weekly_budget in config.json and restart.\n'
				: 'The Arena resolution sweep has failed repeatedly with nothing settled. This is NOT the\n'
					+ 'treasury budget - see the reason below - so it will not clear on its own.\n')
				+ '\nStalled since: ' + doc.stalled_since
				+ '\nConsecutive failing sweeps: ' + streak
				+ '\nLast successful settlement: ' + (doc.last_success_at || 'none recorded')
				+ '\nLast sweep: ' + JSON.stringify(summary)
				+ '\n\nCheck arena.log on the SECOND_API box for the per-challenge reason.',
		};
	} else if (recovered) {
		// An all-clear must be earned by something ACTUALLY settling. Clearing on any
		// non-stalled sweep meant an IDLE sweep mailed "settlement has recovered" with
		// nothing settled - the stuck challenge had merely left the due set (someone
		// abandoned it, or the tailer flipped it terminal), which is not recovery.
		alert = {
			kind: 'recovered',
			subject: 'Actifit Arena: settlement has recovered',
			body: 'The Arena resolution sweep is settling again.\n\nLast sweep: '
				+ JSON.stringify(summary) + '\n',
		};
	}
	return { ok: true, health: doc, alert };
}

/**
 * Has the resolve sweep stopped running at all?
 *
 * recordResolveHealth can only report on sweeps that HAPPEN. It says nothing when
 * the cron stops firing, when a hung read wedges the in-flight guard, or when the
 * process is up but the schedule was never registered - in every one of those the
 * record simply goes stale and nothing notices, because nothing polls it.
 *
 * So this is called from a DIFFERENT, more frequent job (the aggregation sweep),
 * which is the only in-process vantage point that keeps ticking when resolve does
 * not. It cannot detect the case where the whole Arena block is skipped - an unset
 * BOT_THREAD kills the aggregation sweep too - and that genuinely needs outside
 * monitoring; the runbook says so rather than pretending otherwise.
 *
 * @returns {Promise<{ok, stale, sinceMs, alert}>}
 */
async function checkResolveHeartbeat(db, opts = {}) {
	const nowMs = Number.isFinite(opts.now) ? opts.now : Date.now();
	// The resolve cron is hourly; 3h means two consecutive ticks were missed.
	const maxAgeMs = Number.isFinite(opts.maxAgeMs) && opts.maxAgeMs > 0 ? opts.maxAgeMs : 3 * 60 * 60 * 1000;
	const col = db.collection(HEALTH_COLLECTION);
	const doc = (typeof col.findOne === 'function' ? await col.findOne({ _id: HEALTH_ID }) : null);
	// Never run = nothing to compare against. Not an alarm: a freshly deployed box
	// has not reached its first :35 yet.
	if (!doc || !doc.last_run_at) return { ok: true, stale: false, sinceMs: null, alert: null };

	const sinceMs = nowMs - Date.parse(doc.last_run_at);
	const stale = Number.isFinite(sinceMs) && sinceMs > maxAgeMs;
	let alert = null;
	if (stale && !doc.heartbeat_alerted) {
		alert = {
			kind: 'resolve_not_running',
			subject: 'Actifit Arena: the settlement sweep has STOPPED RUNNING',
			body: 'The Arena resolution sweep has not run for ' + Math.round(sinceMs / 60000) + ' minutes.\n'
				+ 'It is scheduled hourly, so it has missed at least two ticks.\n\n'
				+ 'This is not budget exhaustion - that still runs and reports. Likely causes: the\n'
				+ 'process restarted without the scheduler, a previous sweep is wedged on a hung\n'
				+ 'database read (there is no socket timeout), or the job is disabled.\n\n'
				+ 'Last run: ' + doc.last_run_at + '\nLast sweep: ' + JSON.stringify(doc.last_summary || {}) + '\n',
		};
	}
	if (typeof col.updateOne === 'function' && stale !== !!doc.heartbeat_alerted) {
		await col.updateOne({ _id: HEALTH_ID }, { $set: { heartbeat_alerted: stale } });
	}
	return { ok: true, stale, sinceMs, alert };
}

// ---- auto-enrolment of a rolled recurrence (F5b) ---------------------------

/** How many entities one `enroll` op may carry. Hive caps a custom_json payload at
 *  8192 bytes. A Hive account name is at most 16 chars, so 200 entities is ~3.8 KB
 *  of JSON plus a small envelope — roughly HALF the limit, not (as an earlier
 *  version of this comment wrongly claimed) an order of magnitude inside it. Do not
 *  raise this much without recomputing: 400 would sit right on the ceiling. A
 *  bigger roster is split across several ops, which the indexer applies additively. */
const AUTO_ENROLL_CHUNK = 200;

/** A carried-forward participant must show REAL recent activity, otherwise a
 *  one-time joiner who stopped using Actifit would be re-enrolled into every future
 *  occurrence forever. 7 days, measured back from the moment this pass runs: the
 *  production roster (2026-09-27) posts 2-8 reports a week, so a 1-2 day lookback
 *  would have dropped a genuine weekly participant. */
const AUTO_ENROLL_LOOKBACK_DAYS = 7;

/** Hard ceiling on a carried roster.
 *
 *  This is a TREASURY control, not a performance tweak. The official schedules in
 *  arena_rewards pay per-finisher, not per-winner: `def_daily_focus` is
 *  `{ flat: 5 }`, which pays 5 AFIT to EVERY finisher with a positive score, and
 *  four of the other five defaults carry a `participation` amount (8-25 AFIT). So
 *  emission is O(roster), and `def_daily_focus` alone is 35 AFIT/user/week — about
 *  1,430 carried users would exhaust the entire 50,000 AFIT/week global budget.
 *
 *  Exhaustion is not graceful. creditAfitReward returns `capped: true, credited: 0`,
 *  resolveChallenge records `afit: 0`, and that zero goes into the settle payload
 *  and on-chain; the resolution marker is idempotent, so it is never retried. And
 *  because due challenges resolve oldest-first, the daily contests would drain the
 *  week before the monthly LiveOps closes — the 400/250/150 AFIT top prizes are
 *  exactly the ones that would silently settle at zero, for real players.
 *
 *  So the roster is capped, and when the cap bites we keep the MOST RECENTLY ACTIVE
 *  candidates rather than an arbitrary slice. Anyone dropped can still join by hand;
 *  they are not excluded from the contest, only from being auto-enrolled into it. */
const AUTO_ENROLL_MAX_ROSTER = 250;

/** Ceiling on chain ops per tick, across all resolutions. Each op is a ~4 KB
 *  custom_json signed with @actifit's posting key; after an outage a backlog could
 *  otherwise try to push hundreds back-to-back, exhaust RC, fail, and re-flood on
 *  the next tick. Leftover work simply waits — markers stay unset. */
const AUTO_ENROLL_OPS_PER_TICK = 20;

/** Give up on a target that never gets indexed, so it cannot occupy the pending
 *  window forever and starve live rolls behind it. */
const AUTO_ENROLL_MAX_ATTEMPTS = 48;   // hourly cron => ~2 days

/**
 * Carry a recurring default's roster into the occurrence it just rolled into.
 *
 * WHY: joining is a user-signed on-chain act, scoped to ONE challenge id. A
 * recurring contest rolls into a brand-new id, so every occurrence started with an
 * EMPTY roster and nobody realised they had to re-join. In production
 * `def_daily_focus@2026-09-25` ran, resolved and broadcast an on-chain settle for
 * NOBODY, and the occurrences after it were empty too.
 *
 * The roster is sourced from the WHOLE SERIES (the base challenge plus every sibling
 * sharing its parent_id) — not just the occurrence that closed. Sourcing only from
 * the previous occurrence would perpetuate the hole rather than heal it: once one
 * occurrence is empty, every later one inherits emptiness forever.
 *
 * Chain-first, and NOT a forged join: we hold only @actifit's posting key, and a
 * `join` is the user's own assertion to make. We broadcast the official-signed
 * `enroll` op instead, which the indexer accepts from the official account alone.
 * An auto-enrolment is therefore visibly distinct on-chain from a user's own join.
 *
 * Runs as its OWN deferred pass rather than inline after the recurrence broadcast:
 * `enroll` is rejected as "unknown challenge" until the tailer has indexed the new
 * challenge. An unindexed target is retried (bounded — see AUTO_ENROLL_MAX_ATTEMPTS)
 * rather than silently losing a roster.
 *
 * OPT-OUT IS SERIES-WIDE, and that is load-bearing. `left` must be collected across
 * the WHOLE series and subtracted at the end, never filtered per row: leaving
 * occurrence N does not touch your row on occurrence N-1, and a settled row can
 * never be left at all (`arena.js` refuses `leave` on a terminal challenge). Filtering
 * row-by-row and unioning the results therefore re-enrolled anyone who had ever
 * joined, forever, with no sequence of user actions that could stop it. Reviewers
 * reproduced that; `tests/arena_autoenroll.test.js` now pins it.
 *
 * I1 is untouched — `enroll` carries no fee, and the target's entry mode is whatever
 * its create op set (`free` for every default).
 *
 * @param {object} db
 * @param {object} [opts] { asOf, now, limit, broadcastOp, lookbackDays, maxRoster,
 *                          opsPerTick, log }
 * @returns {Promise<{ok, processed, enrolled, ops, skipped, failed, deferred}>}
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
	const maxRoster = Number.isInteger(opts.maxRoster) && opts.maxRoster > 0
		? opts.maxRoster
		: AUTO_ENROLL_MAX_ROSTER;
	const opsPerTick = Number.isInteger(opts.opsPerTick) && opts.opsPerTick > 0
		? opts.opsPerTick
		: AUTO_ENROLL_OPS_PER_TICK;

	const resolutionsC = db.collection('challenge_resolutions');
	const challengesC = db.collection('challenges');
	const participantsC = db.collection('challenge_participants');
	const verifiedC = db.collection('verified_posts');

	// No broadcaster = nothing we can do. Leave every marker UNSET so the work is
	// picked up whole once one exists, rather than marked done-and-empty.
	if (!broadcast) {
		log('arena auto-enroll: no broadcaster - skipped');
		return { ok: true, processed: 0, enrolled: 0, ops: 0, skipped: 0, failed: 0, deferred: 0 };
	}

	const pendingAll = await resolutionsC
		.find({ recurred_to: { $exists: true, $ne: null }, auto_enrolled_at: { $exists: false } })
		.limit(limit)
		.toArray();

	// Two resolutions can name the SAME target (a crash-retry across a period
	// boundary can double-roll). The already-on-target exclusion below reads Mongo,
	// which cannot yet see an enrolment made earlier in this same tick, so without
	// this the same roster would be broadcast twice. Keep one and mark the rest.
	const pending = [];
	const seenTargets = new Map();
	for (const r of pendingAll) {
		if (seenTargets.has(r.recurred_to)) {
			await resolutionsC.updateOne(
				{ challenge_id: r.challenge_id },
				{ $set: { auto_enrolled_at: asOf, auto_enroll_reason: 'duplicate target, handled by ' + seenTargets.get(r.recurred_to) } }
			);
			continue;
		}
		seenTargets.set(r.recurred_to, r.challenge_id);
		pending.push(r);
	}

	let enrolled = 0;
	let ops = 0;
	let skipped = 0;
	let failed = 0;
	let deferred = 0;

	for (const r of pending) {
		// Per-tick chain-op budget. Stop cleanly, leaving markers unset, so the
		// remainder is picked up next tick instead of flooding the node now.
		if (ops >= opsPerTick) { deferred++; continue; }
		try {
			// Stamp the resolution so a dead end is never retried forever. Carries a
			// reason so the decision stays legible without re-deriving it.
			const mark = (reason, extra) => resolutionsC.updateOne(
				{ challenge_id: r.challenge_id },
				{ $set: { auto_enrolled_at: asOf, auto_enroll_reason: reason, ...(extra || {}) } }
			);

			const target = await challengesC.findOne({ id: r.recurred_to });
			if (!target) {
				// The tailer has not indexed the rolled challenge yet. Retry — but
				// BOUNDED: a `challenge_create` the indexer rejected outright is never
				// going to appear, and an immortal pending row would sit at the front of
				// this (unsorted) window and starve every later roll behind it.
				const attempts = (Number(r.auto_enroll_attempts) || 0) + 1;
				if (attempts >= AUTO_ENROLL_MAX_ATTEMPTS) {
					await mark('target never indexed after ' + attempts + ' attempts', { auto_enroll_attempts: attempts });
					log('arena auto-enroll: GIVING UP on ' + r.challenge_id + ' -> ' + r.recurred_to + ' (never indexed after ' + attempts + ' attempts)');
				} else {
					await resolutionsC.updateOne(
						{ challenge_id: r.challenge_id },
						{ $set: { auto_enroll_attempts: attempts, auto_enroll_last_attempt_at: asOf } }
					);
				}
				skipped++;
				continue;
			}

			// Only enrol into a roster that can still actually play. `resolving` is a
			// LIVE state (see AGGREGATABLE_STATES), so treat it as not-yet-ready and
			// retry rather than burning the roster on a one-way door.
			if (target.state === 'resolving') { skipped++; continue; }
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
			// Cheap belt-and-suspenders: this pass broadcasts an OFFICIAL-signed op, so
			// it must never be pointed at anything but a recurring official default,
			// whatever a future writer of `recurred_to` does.
			if (!isRecurringDefault(target)) {
				await mark('target is not a recurring official default');
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

			// Collect candidates AND opt-outs separately over the whole series. The
			// opt-out set is subtracted at the END — see the note in the doc comment on
			// why a per-row `$ne: 'left'` filter is not equivalent and was a real bug.
			const candidates = new Set();
			const optedOut = new Set();
			for (const cid of seriesIds) {
				for (const p of await participantsC.find({ challenge_id: cid }).toArray()) {
					if (typeof p.entity !== 'string' || !p.entity) continue;
					if (p.state === 'left') optedOut.add(p.entity);
					else candidates.add(p.entity);
				}
			}
			// A `leave` anywhere in the series opts you out of the whole series.
			for (const e of optedOut) candidates.delete(e);

			// Already on the target roster (a manual re-join, or an earlier partial run) —
			// including anyone who has already left the TARGET itself.
			for (const p of await participantsC.find({ challenge_id: target.id }).toArray()) {
				candidates.delete(p.entity);
			}

			// I7 - whoever funds a prize can never be enrolled to win it. The creator is
			// stored as `created_by` (NOT `creator`), and the authoritative funder list
			// lives on the pool, reachable via `pool_ref` — an earlier version read
			// `rewards.funder`/`creator`, neither of which any code path writes, so the
			// exclusion was dead code that only its own test could satisfy.
			if (target.created_by) candidates.delete(target.created_by);
			if (target.pool_ref) {
				const pool = await db.collection('pools').findOne({ id: target.pool_ref });
				for (const f of (pool && pool.funders) || []) candidates.delete(f);
				if (pool && pool.sponsor_id) candidates.delete(pool.sponsor_id);
			}

			// ---- prune the dormant, then cap ---------------------------------
			// A squad has no `verified_posts` author, so the activity test can only be
			// applied to user rosters; a squad series is carried unpruned but still capped.
			const isUserRoster = (target.participants_kind || 'user') === 'user';
			const since = new Date(nowMs - lookbackDays * DAY_MS);
			const active = [];
			for (const entity of candidates) {
				if (!isUserRoster) { active.push({ entity, at: 0 }); continue; }
				// Most recent report inside the lookback: proves activity AND gives the
				// recency key the cap ranks on. Served by {author:1, date:1}.
				const recent = await verifiedC.find({ author: entity, date: { $gte: since } })
					.sort({ date: -1 }).limit(1).toArray();
				if (recent.length) active.push({ entity, at: Date.parse(recent[0].date) || 0 });
			}

			if (!active.length) {
				await mark('no active carry-forward candidates', { auto_enrolled_count: 0 });
				skipped++;
				continue;
			}

			// Cap by MOST RECENT activity, so if the ceiling bites we keep the people
			// most likely to actually be playing. Tie-break on name for determinism.
			active.sort((a, b) => (b.at - a.at) || (a.entity < b.entity ? -1 : 1));
			const overflow = Math.max(0, active.length - maxRoster);
			const entities = active.slice(0, maxRoster).map((a) => a.entity);
			if (overflow > 0) {
				log('arena auto-enroll: ' + target.id + ' roster capped at ' + maxRoster + ' (' + overflow + ' least-recently-active candidate(s) not carried; they can still join manually)');
			}

			// ---- broadcast ----------------------------------------------------
			// Counted per successful op: a mid-roster failure leaves the marker unset so
			// the remainder is retried next tick (the already-enrolled are filtered out
			// by the target-roster exclusion above, once the tailer has caught up).
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
			await mark('carried forward', { auto_enrolled_count: entities.length, auto_enroll_overflow: overflow });
			log('arena auto-enroll: ' + r.challenge_id + ' -> ' + target.id + ' carried ' + entities.length + ' participant(s) in ' + Math.ceil(entities.length / AUTO_ENROLL_CHUNK) + ' op(s)');
		} catch (e) {
			failed++;
			log('arena auto-enroll: ' + r.challenge_id + ' error: ' + (e && e.message));
		}
	}

	const summary = { ok: true, processed: pending.length, enrolled, ops, skipped, failed, deferred };
	log('arena auto-enroll: processed=' + summary.processed + ' enrolled=' + enrolled + ' ops=' + ops + ' skipped=' + skipped + ' deferred=' + deferred + ' failed=' + failed);
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
	recordResolveHealth,
	checkResolveHeartbeat,
	HEALTH_COLLECTION,
	HEALTH_ID,
	STALL_ALERT_TICKS,
	AUTO_ENROLL_CHUNK,
	AUTO_ENROLL_LOOKBACK_DAYS,
	AUTO_ENROLL_MAX_ROSTER,
	AUTO_ENROLL_OPS_PER_TICK,
	AUTO_ENROLL_MAX_ATTEMPTS,
	ensureArenaJobIndexes,
};
