/**
 * Challenge Engine — off-chain AFIT reward crediting (epic #171).
 *
 * The Arena rewards challenges in Actifit's own **off-chain AFIT** — the internal
 * balance the marketplace already spends and that users can cash out through the
 * existing rails — instead of a separate Merits currency. This module is the
 * credit primitive the resolver calls.
 *
 * Money path (mirrors the bot's own reward accounting):
 *   - `token_transactions` is the append/upsert ledger; each row's `token_count`
 *     is the credit. The authoritative balance is the `$sum` of a user's rows.
 *   - `user_tokens` is the materialized balance ({_id:user, user, tokens}) the
 *     rest of the app reads (market spend gate, wallet, cash-out).
 * A challenge reward writes ONE ledger row keyed per (user, challenge) — so
 * re-resolving a challenge REPLACES the same row (never double-credits) — then
 * reconciles that user's `user_tokens` so the balance is spendable immediately
 * (the bot's periodic full re-aggregation later re-derives the same total).
 *
 * Compliance / anti-abuse:
 *   - A per-user, per-UTC-day AFIT cap bounds system-funded emission (treasury
 *     protection + anti-farm), analogous to the old Merit daily cap.
 *   - Only the resolver credits AFIT; there is no client-reachable credit path.
 *
 * Load-time safe: requires nothing (no config/Firebase); dependency-injected db.
 */

'use strict';

const COL = {
	LEDGER: 'token_transactions',   // append/upsert ledger; token_count = credit
	BALANCES: 'user_tokens',        // materialized {_id:user, user, tokens}
};

const AFIT_CHAIN = 'HIVE';
const OFFICIAL_ACCOUNT = 'actifit';
// reward_activity prefix for a TREASURY/system-funded reward row (per challenge).
// The daily/weekly emission budget counts ONLY rows with this prefix.
const ARENA_ACTIVITY_PREFIX = 'arena_challenge:';
// reward_activity prefix for a CREATOR/POOL-funded payout — deliberately a
// different namespace so it is NOT counted against the treasury emission budget
// (the funder already paid; only the pool budget bounds it).
const ARENA_POOL_PREFIX = 'arena_pool:';
// Default per-user daily AFIT cap on challenge rewards (config-overridable).
// Set at the free daily cash-out anchor (500) so a day's challenge winnings can't
// exceed a normal free withdrawal, and so a single top prize is never clipped.
const DEFAULT_DAILY_CAP = 500;

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
// Upper bound of the reward_activity prefix range, for an index-friendly scan of
// arena reward rows: 'arena_challenge:' <= x < 'arena_challenge;'  (';' = ':' + 1).
const ARENA_ACTIVITY_HI = ARENA_ACTIVITY_PREFIX.slice(0, -1) + ';';

function dayKey(iso) {
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** A stable 7-day bucket index for the weekly emission budget (UTC, epoch-based). */
function weekBucket(iso) {
	const ms = Date.parse(iso);
	return Number.isFinite(ms) ? Math.floor(ms / WEEK_MS) : null;
}

/** The per-(user, challenge) ledger key that makes a re-credit idempotent.
 *  `pooled` selects the creator-funded namespace (excluded from the treasury
 *  budget); default is the treasury namespace. */
/** Mongo duplicate-key (E11000). Mirrors the helper in arena.js; duplicated
 *  deliberately so this module keeps its no-arena-dependency load-time safety. */
function isDuplicateKeyError(e) {
	return !!e && (e.code === 11000 || e.code === 11001 || /E11000/.test(String(e && e.message)));
}

function activityFor(challengeId, pooled) {
	return (pooled ? ARENA_POOL_PREFIX : ARENA_ACTIVITY_PREFIX) + challengeId;
}

/**
 * Total AFIT emitted from ALL Arena challenge rewards in the same weekly bucket as
 * `at` (across all users), EXCLUDING the one (user, challenge) row being written —
 * so a re-credit recomputes the same weekly room (idempotent), while other winners
 * of the same run are counted. Backs the global weekly emission budget. Uses the
 * reward_activity prefix range so it scans only arena rows, not the whole ledger.
 */
async function arenaEmittedWeek(db, at, excludeUser, excludeChallengeId) {
	const bucket = weekBucket(at);
	if (bucket === null) return 0;
	// Bounded by the week window in the QUERY, and summed server-side. This used to
	// pull EVERY arena ledger row ever written into Node and filter by week in JS -
	// on every single credit, inside the payout loop.
	//
	// Be precise about what this does and does not fix. Measured with explain() on
	// production: the plan is IXSCAN [reward_activity_1_date_1] -> FETCH, 4 keys /
	// 3 docs / 1ms - NOT a collection scan. But `reward_activity` leads that index
	// under a RANGE predicate, so MongoDB cannot use `date` as a tight index bound;
	// the week filter is applied after the key walk. The ROWS RETURNED are bounded,
	// and nothing crosses the wire any more, but the keys walked still grow with the
	// number of arena credits ever made. Free today (3 rows); worth revisiting with
	// a date-leading index or a small running-total document once this is thousands.
	const start = new Date(bucket * WEEK_MS);
	const end = new Date((bucket + 1) * WEEK_MS);
	const match = {
		reward_activity: { $gte: ARENA_ACTIVITY_PREFIX, $lt: ARENA_ACTIVITY_HI },
		date: { $gte: start, $lt: end },
	};
	const rows = await db.collection(COL.LEDGER).aggregate([
		{ $match: match },
		{ $group: { _id: null, total: { $sum: '$token_count' } } },
	]).toArray();
	let total = (rows[0] && Number(rows[0].total)) || 0;
	// Subtract the one (user, challenge) row being rewritten, so a re-credit
	// recomputes the SAME weekly room (idempotent) while still counting every other
	// winner in this run. Read as a single indexed document, not a scan.
	if (excludeUser && excludeChallengeId) {
		// Subtract EVERY row on this key, not just the first. `arena_credit_unique`
		// makes duplicates impossible, but it is a hand-created production index, so
		// this must not quietly under-subtract anywhere it has not been built yet -
		// that would shrink the room and under-pay the winner.
		const own = await db.collection(COL.LEDGER).aggregate([
			{ $match: {
				user: excludeUser,
				reward_activity: activityFor(excludeChallengeId),
				date: { $gte: start, $lt: end },
			} },
			{ $group: { _id: null, total: { $sum: '$token_count' } } },
		]).toArray();
		total -= (own[0] && Number(own[0].total)) || 0;
	}
	return total > 0 ? total : 0;
}

/** Current off-chain AFIT balance (the materialized counter; 0 if none). */
async function balanceOf(db, user) {
	const b = await db.collection(COL.BALANCES).findOne({ _id: user });
	return (b && Number.isFinite(b.tokens)) ? b.tokens : 0;
}

/**
 * AFIT already credited to a user from Arena challenge rewards on the given UTC
 * day — EXCLUDING one challenge, so a re-credit of that same challenge doesn't
 * count against its own room (keeps the capped amount idempotent on retry).
 */
async function arenaEmittedOn(db, user, at, excludeChallengeId) {
	const day = dayKey(at);
	if (day === null) return 0;
	// Bounded to this user's ARENA rows on this DAY. It used to pull the user's
	// ENTIRE platform ledger - measured at 3,205 rows for a real participant, on
	// every credit - and throw almost all of it away in JS.
	// UTC day bounds, matching dayKey() exactly (it keys off toISOString()).
	// new Date(at), NOT Date.parse(at): dayKey() uses new Date(), and the two
	// disagree on non-string input (Date.parse(1756200000000) is NaN while
	// new Date(1756200000000) is valid). That divergence would fail OPEN - a NaN
	// here returns 0 emitted, handing back the FULL daily cap.
	const ms = new Date(at).getTime();
	if (!Number.isFinite(ms)) return 0;
	const start = new Date(Math.floor(ms / DAY_MS) * DAY_MS);
	const end = new Date(start.getTime() + DAY_MS);
	const rows = await db.collection(COL.LEDGER).aggregate([
		{ $match: {
			user,
			reward_activity: { $gte: ARENA_ACTIVITY_PREFIX, $lt: ARENA_ACTIVITY_HI },
			date: { $gte: start, $lt: end },
		} },
		{ $group: { _id: null, total: { $sum: '$token_count' } } },
	]).toArray();
	let total = (rows[0] && Number(rows[0].total)) || 0;
	if (excludeChallengeId) {
		// All rows on this key (see the note in arenaEmittedWeek), and bounded to the
		// same day window so a row outside it is never subtracted.
		const own = await db.collection(COL.LEDGER).aggregate([
			{ $match: {
				user,
				reward_activity: activityFor(excludeChallengeId),
				date: { $gte: start, $lt: end },
			} },
			{ $group: { _id: null, total: { $sum: '$token_count' } } },
		]).toArray();
		total -= (own[0] && Number(own[0].total)) || 0;
	}
	return total > 0 ? total : 0;
}

/** Re-derive a single user's materialized balance from their ledger rows.
 *
 *  This legitimately has to consider the user's WHOLE ledger - it is the full
 *  balance, so there is nothing to bound it by. What it must not do is ship every
 *  one of those rows to Node just to add up one field: a real participant already
 *  has 3,205 ledger rows, and this runs once per credit inside the payout loop.
 *  The sum happens server-side on the {user:1, date:-1} index instead (confirmed
 *  present on production and chosen by the planner: IXSCAN [user_1_date_-1]), so
 *  the documents never cross the wire.
 *
 *  This is NOT a pure refactor, and the difference is worth stating: `Number(x)||0`
 *  coerced a numeric STRING token_count, whereas MongoDB's $sum ignores non-numeric
 *  values outright. That moves this function INTO agreement with the two pipelines
 *  that already own this balance in production - delegations.js updateUserTokens
 *  (which $out's straight over user_tokens) and app.js /recalculateUserTokens, both
 *  of which already use $sum. Previously this function was the odd one out and
 *  could inflate a balance that the next sweep silently clawed back. */
async function reconcileBalance(db, user) {
	const agg = await db.collection(COL.LEDGER).aggregate([
		{ $match: { user } },
		{ $group: { _id: null, total: { $sum: '$token_count' } } },
	]).toArray();
	const tokens = (agg[0] && Number(agg[0].total)) || 0;
	await db.collection(COL.BALANCES).replaceOne(
		{ _id: user },
		{ _id: user, user, tokens },
		{ upsert: true }
	);
	return tokens;
}

/**
 * Credit an off-chain AFIT challenge reward to a user — idempotent per
 * (user, challenge), bounded by the per-user daily cap AND the optional GLOBAL
 * weekly emission budget (treasury protection).
 * @param {object} db
 * @param {object} params { user, challengeId, amount, at?, dailyCap?, weeklyBudget? }
 * @returns {Promise<{ok, credited, capped?, cappedBy?, balance, ref?, reason?}>}
 *   `cappedBy` is set when a credit was clamped to ZERO: 'daily_cap' (that user has
 *   had their allowance today - normal) or 'weekly_budget' (the treasury budget for
 *   the week is exhausted - NOT normal, and must not be settled as a zero).
 */
async function creditAfitReward(db, params) {
	const { user, challengeId, amount } = params;
	const at = params.at || new Date().toISOString();
	const dailyCap = Number.isFinite(params.dailyCap) ? params.dailyCap : DEFAULT_DAILY_CAP;
	if (!user || !challengeId) return { ok: false, reason: 'missing user/challengeId' };
	if (!(Number(amount) > 0)) return { ok: false, reason: 'amount must be positive' };
	if (dayKey(at) === null) return { ok: false, reason: 'invalid at timestamp' };

	// Per-user daily room — excludes this challenge's own row so a retry re-credits
	// the SAME amount (idempotent) rather than being double-counted against room.
	const dailyAlready = await arenaEmittedOn(db, user, at, challengeId);
	const dailyRoom = Math.max(0, dailyCap - dailyAlready);
	// Optional GLOBAL weekly emission budget across all users (treasury protection).
	// 0 / undefined = disabled (per-user cap only). Same own-row exclusion keeps it
	// idempotent on retry while still counting other winners in the same run.
	let weeklyRoom = Infinity;
	if (Number.isFinite(params.weeklyBudget) && params.weeklyBudget > 0) {
		const weekAlready = await arenaEmittedWeek(db, at, user, challengeId);
		weeklyRoom = Math.max(0, params.weeklyBudget - weekAlready);
	}
	const credited = Math.min(Number(amount), dailyRoom, weeklyRoom);
	if (credited <= 0) {
		// WHY we capped to nothing matters to the caller, and used to be unknowable.
		// A per-user daily cap is normal, expected policy: that user has already had
		// their 500 today and the contest should still settle. The GLOBAL weekly
		// budget running dry is a different thing entirely - it is the treasury being
		// empty, it affects every winner, and settling a zero for it writes a
		// permanent on-chain record that a real winner earned nothing. The caller has
		// to be able to tell those apart, so name the binding constraint.
		return {
			ok: false,
			capped: true,
			credited: 0,
			cappedBy: weeklyRoom <= 0 ? 'weekly_budget' : 'daily_cap',
			balance: await balanceOf(db, user),
		};
	}

	const activity = activityFor(challengeId, params.pooled);
	// Idempotent: same (user, reward_activity) row is REPLACED, never duplicated.
	// Once `arena_credit_unique` exists, the loser of a genuine race no longer
	// double-inserts - it raises E11000 here. That must NOT escape: this runs inside
	// arena_pools.resolveChallenge's payout loop, so an unhandled throw would abandon
	// the resolution mid-payout with some winners credited, `pools.paid` un-updated
	// and no settle broadcast. A duplicate key means the row we were about to write
	// already exists, which is exactly the outcome we wanted, so read it back and
	// report what is actually banked rather than what we intended to credit.
	try {
		await db.collection(COL.LEDGER).replaceOne(
			{ user, reward_activity: activity },
			{
				user,
				reward_activity: activity,
				token_count: credited,
				chain: AFIT_CHAIN,
				orig_account: OFFICIAL_ACCOUNT,
				challenge_id: challengeId,
				date: new Date(at),
			},
			{ upsert: true }
		);
	} catch (e) {
		if (!isDuplicateKeyError(e)) throw e;
		const existing = await db.collection(COL.LEDGER).findOne({ user, reward_activity: activity });
		const already = Number(existing && existing.token_count) || 0;
		return {
			ok: true,
			credited: already,
			capped: already < Number(amount),
			raced: true,
			balance: await reconcileBalance(db, user),
			ref: activity,
		};
	}
	const balance = await reconcileBalance(db, user);
	return { ok: true, credited, capped: credited < Number(amount), balance, ref: activity };
}

/**
 * Index the arena credit path relies on for correctness.
 *
 * `creditAfitReward` is idempotent by REPLACING the (user, reward_activity) row,
 * but a read-then-write upsert is only retry-safe, not race-safe: two concurrent
 * runs can both miss the existing row and both insert, double-crediting. The
 * unique `challenge_resolutions.challenge_id` is the backstop, but it is written
 * LAST - after the credits - so it cannot prevent that.
 *
 * This makes the database enforce it. The index is PARTIAL: token_transactions is
 * the whole platform's AFIT ledger (~23M rows at the time of writing) and
 * legitimately holds many rows sharing a (user, reward_activity) pair for
 * non-arena activity. Only arena credit rows carry `challenge_id`, so only those
 * are indexed and constrained - verified against production before adding this
 * (3 rows carried it, 0 duplicates).
 *
 * The filter tests `$type: 'string'` rather than `$exists: true` on purpose:
 * `$exists` also matches an explicit `challenge_id: null`, so a single careless
 * `challenge_id: maybeNull` in some future non-arena writer would drag that whole
 * class of ordinary ledger rows into a UNIQUE index and start rejecting
 * legitimate inserts. `$type` cannot be tripped that way, at no extra cost.
 *
 * OPERATIONAL NOTE - do not deploy this blind. `background` is accepted but
 * IGNORED by MongoDB 4.2+, and a partial index cannot be seeded from another
 * index: the server must examine all ~23M documents to decide membership, which
 * is real IO on the primary plus a brief exclusive lock as the build commits.
 * Create it by hand off-peak (`mongosh`, then verify with `getIndexes()`) BEFORE
 * shipping the code; this call then finds it and is a no-op. Note also that flags
 * such as `arena_jobs_enabled` do NOT gate it, so a flags-off rollback does not
 * remove it - that needs a `dropIndex('arena_credit_unique')`.
 *
 * Safe no-op where createIndex is unavailable (the in-memory test mock).
 */
async function ensureAfitIndexes(db) {
	const ledger = db.collection(COL.LEDGER);
	if (typeof ledger.createIndex !== 'function') return;
	await ledger.createIndex(
		{ user: 1, reward_activity: 1 },
		{
			unique: true,
			partialFilterExpression: { challenge_id: { $type: 'string' } },
			name: 'arena_credit_unique',
			background: true,
		}
	);
}

module.exports = {
	COL,
	AFIT_CHAIN,
	ARENA_ACTIVITY_PREFIX,
	ARENA_POOL_PREFIX,
	DEFAULT_DAILY_CAP,
	activityFor,
	weekBucket,
	balanceOf,
	arenaEmittedOn,
	arenaEmittedWeek,
	reconcileBalance,
	creditAfitReward,
	ensureAfitIndexes,
};
