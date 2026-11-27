/**
 * Challenge Engine — F2 verification service (Trello #176, epic #171).
 *
 * The engine's core value: turn a participant's on-chain-verified Actifit
 * activity into a TRUSTED per-challenge score, server-side, so leagues are
 * meaningful and pools can't be drained by self-reported numbers. See the spec
 * `tasks/challenge-engine-spec.md` §4.
 *
 * Root of trust: the `verified_posts` collection — Actifit's already-verified,
 * reward-eligible activity posts (author, date, json_metadata.step_count). It is
 * exactly what `trackedActivity/:user` reads, so this inherits Actifit's
 * existing activity verification + manual-entry filtering. A participant's score
 * is computed from that feed for the challenge window — NEVER from a client- or
 * op-reported number.
 *
 * Structure (pure core → orchestration):
 *   - computeWindowScore(records, scoring) — aggregate a participant's verified
 *     activity across the window (pure)
 *   - flagAnomalies(score, opts)           — anti-cheat flags (pure)
 *   - fetchVerifiedActivity(db, entity, w) — the one impure read (verified_posts)
 *   - verifyParticipant / verifyChallenge  — materialize participants.score +
 *     flags; idempotent & replayable (recomputes from source each run)
 *
 * Idempotent/replayable: verifyChallenge recomputes every participant from the
 * source feed and overwrites score + anomalies, and re-derives the
 * `anticheat_review` flag fresh — so a late correction (e.g. a revoked post)
 * re-settles cleanly, and re-running never duplicates flags.
 *
 * F2 scope: window score + anti-cheat hooks. Cross-participant sybil /
 * duplicate-signer detection is DEFERRED to Vertical B (squads); the signed-join
 * anti-sybil is already enforced at F1 ingest. Anti-cheat here is SUPPLEMENTARY
 * to the root of trust — a patient under-cap, evenly-spread fabricator is caught
 * by Actifit's upstream reward-eligibility / manual-entry filter on
 * verified_posts, not by these flags. NOT resolution/payout (F5) — this only
 * produces the trusted score the resolver reads.
 *
 * Non-step source (Trello #186, epic #184 — Movement Challenges Phase A): the
 * `routine_completion` metric scores from `routine_completions` (one row per
 * participant per challenge per UTC day, written by the check-in endpoint) instead
 * of verified_posts, so mobility / stretching / strength routines — which produce
 * ~no steps — can be scored. That source is SELF-REPORTED (honor system), so it is
 * NOT a root of trust: `isSelfReportedMetric` lets ingest refuse an AFIT prize on
 * such a challenge and settlement zero any AFIT for it. Badges/Merits only until a
 * verified completion source exists (Phase C).
 *
 * Load-time safe: requires nothing (no config/Firebase); dependency-injected db.
 */

'use strict';

const COLLECTIONS = {
	VERIFIED_POSTS: 'verified_posts',
	CHALLENGES: 'challenges',
	PARTICIPANTS: 'challenge_participants',
	ROUTINE_COMPLETIONS: 'routine_completions',
};

// Metrics scored from a SELF-REPORTED source rather than verified_posts. They must
// never carry AFIT (ingest rejects it; settlement zeroes it) — see the header.
const SELF_REPORTED_METRICS = ['routine_completion'];

/** True when `metric` is scored from a self-reported (non-verified) source. */
function isSelfReportedMetric(metric) {
	return SELF_REPORTED_METRICS.includes(metric);
}

const ANTICHEAT_FLAG = 'anticheat_review';

// Anti-cheat defaults (overridable via opts).
const DEFAULT_SPIKE_FACTOR = 5;       // a day > N× the participant's own median = spike
const DEFAULT_MAX_DAILY_STEPS = 200000; // implausible single-day activity (hard cap)
const DEFAULT_DAY_RATIO = 30;         // max/min active-day ratio that trips a short-window spike

/** Coerce a metadata value to a number, taking the first element of an array
 *  (production stores step_count as ['5055']). Non-numeric → 0. */
function firstNumber(v) {
	const x = Array.isArray(v) ? v[0] : v;
	const n = Number(x);
	return Number.isFinite(n) ? n : 0;
}

function toDayKey(date) {
	// UTC calendar day — a user may post more than once a day. Consistent with the
	// rest of the app, which buckets on moment().utc().startOf('date').
	return new Date(date).toISOString().slice(0, 10);
}

/** A usable challenge window: both bounds present, parseable, and start < end. */
function hasValidWindow(window) {
	if (!window) return false;
	const start = Date.parse(window.start);
	const end = Date.parse(window.end);
	return !Number.isNaN(start) && !Number.isNaN(end) && start < end;
}

function median(values) {
	if (!values.length) return 0;
	const s = [...values].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** The activity value of one verified post for the requested metric. */
function metricValue(record, metric) {
	switch (metric) {
		// UNCONFIRMED source field: workout_minutes is not present on production
		// verified_posts today (only step_count is), so this yields 0 until
		// confirmed with the backend owner. Do NOT ship a challenge scored on this
		// metric until the field exists — the safe 0 default would zero everyone.
		case 'workout_minutes':
			return Number(record.workout_minutes) || 0;
		case 'goal_hit':
			return (Number(record.step_count) || 0) > 0 ? 1 : 0;
		// One completion record = one completed day. computeWindowScore clamps the
		// day to 1, so duplicate rows for a day can never count twice.
		case 'routine_completion':
			return 1;
		case 'steps':
		case 'activity_count':
		default:
			return Number(record.step_count) || 0;
	}
}

/** Day after `day` ('YYYY-MM-DD', UTC) as 'YYYY-MM-DD'. */
function nextDayKey(day) {
	return new Date(Date.parse(`${day}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
}

/** Longest run of consecutive UTC calendar days with a positive value. Pure. */
function longestStreak(per_day) {
	let best = 0;
	let run = 0;
	let prev = null;
	for (const d of per_day) {
		if (!(d.value > 0)) { run = 0; prev = null; continue; }
		run = prev && nextDayKey(prev) === d.day ? run + 1 : 1;
		prev = d.day;
		if (run > best) best = run;
	}
	return best;
}

/**
 * Aggregate a participant's verified activity across the challenge window.
 * Pure. Returns { metric, total, days, best_day, streak, per_day:[{day,value}] }.
 *
 * The `goal_hit` metric is judged against the challenge's daily THRESHOLD (in the
 * underlying units — steps): a day counts (value 1) only when that day's TOTAL
 * verified steps meet `scoring.threshold`. This is what makes a goal challenge a
 * real GOAL — without it a single 1-step post would "hit" a 10,000-step target
 * and farm the flat reward. Absent/zero threshold falls back to 1 (any activity),
 * preserving prior behavior for goal challenges that don't set one. Other metrics
 * accumulate their own value; the max/head_to_head rule is applied by the ranker.
 *
 * `routine_completion` is boolean per day too: a day with any completion record
 * is 1, never more (so total = number of completed days). `streak` is the longest
 * run of consecutive UTC days with a positive value (any metric).
 */
function computeWindowScore(records, scoring) {
	const metric = (scoring && scoring.metric) || 'activity_count';
	const isGoal = metric === 'goal_hit';
	const isCompletion = metric === 'routine_completion';
	const threshold = Number(scoring && scoring.threshold) > 0 ? Number(scoring.threshold) : 1;
	const byDay = new Map();
	for (const r of records || []) {
		const day = toDayKey(r.date);
		// For goal_hit accumulate the RAW daily quantity (steps) so the threshold can
		// be applied to the day's total; other metrics accumulate their metric value.
		const add = isGoal ? (Number(r.step_count) || 0) : metricValue(r, metric);
		byDay.set(day, (byDay.get(day) || 0) + add);
	}
	const per_day = [...byDay.entries()]
		// goal_hit is boolean per day — 1 only when the day's total meets the goal.
		// routine_completion is boolean per day — duplicates for a day collapse to 1.
		.map(([day, value]) => {
			if (isGoal) return { day, value: value >= threshold ? 1 : 0 };
			if (isCompletion) return { day, value: value > 0 ? 1 : 0 };
			return { day, value };
		})
		.sort((a, b) => (a.day < b.day ? -1 : 1));
	const total = per_day.reduce((s, d) => s + d.value, 0);
	const best_day = per_day.reduce((m, d) => Math.max(m, d.value), 0);
	return { metric, total, days: per_day.length, best_day, streak: longestStreak(per_day), per_day };
}

/**
 * Anti-cheat: flag implausible activity in a participant's window score. Pure.
 * Returns an array of anomaly objects (empty = clean).
 */
function flagAnomalies(score, opts = {}) {
	const spikeFactor = opts.spikeFactor || DEFAULT_SPIKE_FACTOR;
	const maxDaily = opts.maxDailySteps || DEFAULT_MAX_DAILY_STEPS;
	const flags = [];

	for (const d of score.per_day) {
		if (d.value > maxDaily) flags.push({ type: 'implausible_daily', day: d.day, value: d.value });
	}

	// Spike vs the participant's OWN median (needs a few days to be meaningful).
	const values = score.per_day.map((d) => d.value).filter((v) => v > 0);
	if (values.length >= 3) {
		const med = median(values);
		if (med > 0) {
			for (const d of score.per_day) {
				if (d.value > spikeFactor * med) {
					flags.push({ type: 'spike', day: d.day, value: d.value, median: med });
				}
			}
		}
	}

	// Short-window guard: the median-spike check is bypassed with < 3 active days
	// (duels / daily_focus / weekend events), so also flag an extreme max/min
	// active-day ratio, which is meaningful from 2 active days up.
	if (values.length >= 2) {
		const dayRatio = opts.dayRatioFactor || DEFAULT_DAY_RATIO;
		const max = Math.max(...values);
		const min = Math.min(...values);
		if (min > 0 && max / min > dayRatio) {
			flags.push({ type: 'day_ratio', max, min, ratio: max / min });
		}
	}
	return flags;
}

/**
 * Read a participant's verified activity posts for the window. The one impure
 * function — queries `verified_posts` (author + date range) and normalizes each
 * post to { date, step_count, workout_minutes, permlink }.
 */
async function fetchVerifiedActivity(db, entity, window) {
	// Fail CLOSED: an unbounded (or half-bounded) query would sum the
	// participant's ENTIRE post history into one challenge — a pool-draining
	// score. Never issue it; require a complete window.
	if (!hasValidWindow(window)) {
		throw new Error('fetchVerifiedActivity: challenge window is missing or invalid');
	}
	const query = {
		author: entity,
		date: { $gte: new Date(window.start), $lte: new Date(window.end) },
	};
	const posts = await db.collection(COLLECTIONS.VERIFIED_POSTS).find(query).toArray();
	return posts.map((p) => {
		const meta = p.json_metadata || {};
		return {
			date: p.date,
			// Production stores step_count as a single-element array of a numeric
			// string, e.g. ['5055']; take the first element so a stray extra element
			// can't collapse the whole day's activity to a silent 0.
			step_count: firstNumber(meta.step_count),
			workout_minutes: firstNumber(meta.workout_minutes),
			permlink: p.permlink,
		};
	});
}

/**
 * Read a participant's routine completions for ONE challenge's window — the
 * source for `routine_completion`. Scoped by challenge_id (a check-in for one
 * challenge never counts toward another) and fails CLOSED on an invalid window,
 * exactly like fetchVerifiedActivity. Normalized to { date } records.
 */
async function fetchRoutineCompletions(db, challengeId, entity, window) {
	if (!hasValidWindow(window)) {
		throw new Error('fetchRoutineCompletions: challenge window is missing or invalid');
	}
	const rows = await db.collection(COLLECTIONS.ROUTINE_COMPLETIONS).find({
		challenge_id: challengeId,
		entity,
		at: { $gte: new Date(window.start), $lte: new Date(window.end) },
	}).toArray();
	return rows.map((r) => ({ date: r.at }));
}

/**
 * Record one routine completion (a daily check-in). Idempotent per
 * (challenge, entity, UTC day): the first call for a day creates the row, later
 * calls that day are no-ops. Concurrent duplicates are settled by the unique index
 * (ensureCompletionIndexes) — a duplicate-key error is reported as "already done".
 *
 * NOT an authorization check: the caller (check-in route, #187) must verify the
 * signer, that the entity is an active participant, and that the challenge is
 * live and uses the routine_completion metric before calling this.
 * @returns {Promise<{ok:boolean, created?:boolean, day?:string, reason?:string}>}
 */
async function recordCompletion(db, { challengeId, entity, at } = {}) {
	if (typeof challengeId !== 'string' || !challengeId) return { ok: false, reason: 'missing challengeId' };
	if (typeof entity !== 'string' || !entity) return { ok: false, reason: 'missing entity' };
	const when = at ? new Date(at) : new Date();
	if (Number.isNaN(when.getTime())) return { ok: false, reason: 'invalid at' };
	const day = toDayKey(when);
	try {
		const res = await db.collection(COLLECTIONS.ROUTINE_COMPLETIONS).updateOne(
			{ challenge_id: challengeId, entity, day },
			{ $setOnInsert: { challenge_id: challengeId, entity, day, at: when } },
			{ upsert: true }
		);
		return { ok: true, created: !!(res && res.upsertedCount), day };
	} catch (e) {
		if (e && e.code === 11000) return { ok: true, created: false, day };
		throw e;
	}
}

/** Indexes for routine_completions: the unique per-day key is what makes
 *  recordCompletion safe under concurrent check-ins. */
function ensureCompletionIndexes(db) {
	const c = db.collection(COLLECTIONS.ROUTINE_COMPLETIONS);
	return Promise.all([
		c.createIndex({ challenge_id: 1, entity: 1, day: 1 }, { unique: true }),
		c.createIndex({ challenge_id: 1, entity: 1, at: 1 }),
	]);
}

/**
 * Verify ONE participant: fetch their verified activity, compute the window
 * score, run anti-cheat. Returns the score object + anomalies (no DB write).
 */
async function verifyParticipant(db, challenge, participant, opts = {}) {
	const metric = challenge.scoring && challenge.scoring.metric;
	const selfReported = isSelfReportedMetric(metric);
	const records = selfReported
		? await fetchRoutineCompletions(db, challenge.id, participant.entity, challenge.window)
		: await fetchVerifiedActivity(db, participant.entity, challenge.window);
	const score = computeWindowScore(records, challenge.scoring);
	const anomalies = flagAnomalies(score, opts);
	return {
		verified: score.total,
		best_day: score.best_day,
		days: score.days,
		streak: score.streak,
		// raw == verified until an advisory, client-submitted score exists (F5);
		// then raw carries the reported number and verified the engine-computed one.
		raw: score.total,
		metric: score.metric,
		source: selfReported ? COLLECTIONS.ROUTINE_COMPLETIONS : COLLECTIONS.VERIFIED_POSTS,
		anomalies,
	};
}

/**
 * Verify EVERY participant of a challenge and materialize the results onto the
 * index: participants.score + participants.anomalies, and (re-)derive the
 * `anticheat_review` flag. Idempotent — recomputes from source, so re-running
 * or a late correction re-settles without duplicating flags.
 * @returns {Promise<{ok:boolean, participants?:number, flagged?:number, reason?:string}>}
 */
async function verifyChallenge(db, challengeId, opts = {}) {
	const challenges = db.collection(COLLECTIONS.CHALLENGES);
	const participantsC = db.collection(COLLECTIONS.PARTICIPANTS);

	const challenge = await challenges.findOne({ id: challengeId });
	if (!challenge) return { ok: false, reason: 'unknown challenge' };
	// Fail closed on a windowless challenge — never score against unbounded history.
	if (!hasValidWindow(challenge.window)) return { ok: false, reason: 'challenge has no valid window' };

	const asOf = opts.asOf || new Date().toISOString();
	// Exclude participants who LEFT — they must not be scored (and so are never
	// ranked or paid). A rejoin is impossible (the join op rejects a duplicate),
	// so state:'left' is terminal for that entity in this challenge.
	const parts = await participantsC.find({ challenge_id: challengeId, state: { $ne: 'left' } }).toArray();
	let flagged = 0;

	for (const p of parts) {
		const v = await verifyParticipant(db, challenge, p, opts);
		// Re-derive anticheat_review fresh so replays don't accumulate it.
		const base = (p.flags || []).filter((f) => f !== ANTICHEAT_FLAG);
		const flags = v.anomalies.length ? [...base, ANTICHEAT_FLAG] : base;
		if (v.anomalies.length) flagged++;

		await participantsC.updateOne(
			{ challenge_id: challengeId, entity: p.entity },
			{ $set: {
				score: {
					verified: v.verified,
					best_day: v.best_day,
					days: v.days,
					streak: v.streak,
					raw: v.raw,
					metric: v.metric,
					source: v.source,
					as_of: asOf,
				},
				anomalies: v.anomalies,
				flags,
			} }
		);
	}

	return { ok: true, participants: parts.length, flagged };
}

module.exports = {
	COLLECTIONS,
	ANTICHEAT_FLAG,
	isSelfReportedMetric,
	metricValue,
	computeWindowScore,
	longestStreak,
	flagAnomalies,
	fetchVerifiedActivity,
	fetchRoutineCompletions,
	recordCompletion,
	ensureCompletionIndexes,
	verifyParticipant,
	verifyChallenge,
};
