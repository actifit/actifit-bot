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
	const rows = await db.collection(COL.LEDGER)
		.find({ reward_activity: { $gte: ARENA_ACTIVITY_PREFIX, $lt: ARENA_ACTIVITY_HI } })
		.toArray();
	const skipActivity = excludeChallengeId ? activityFor(excludeChallengeId) : null;
	return rows
		.filter((r) => weekBucket(r.date) === bucket
			&& !(r.user === excludeUser && r.reward_activity === skipActivity))
		.reduce((s, r) => s + (Number(r.token_count) || 0), 0);
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
	const rows = await db.collection(COL.LEDGER).find({ user }).toArray();
	const skip = excludeChallengeId ? activityFor(excludeChallengeId) : null;
	return rows
		.filter((r) => typeof r.reward_activity === 'string'
			&& r.reward_activity.indexOf(ARENA_ACTIVITY_PREFIX) === 0
			&& r.reward_activity !== skip
			&& dayKey(r.date) === day)
		.reduce((s, r) => s + (Number(r.token_count) || 0), 0);
}

/** Re-derive a single user's materialized balance from their ledger rows. */
async function reconcileBalance(db, user) {
	const rows = await db.collection(COL.LEDGER).find({ user }).toArray();
	const tokens = rows.reduce((s, r) => s + (Number(r.token_count) || 0), 0);
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
 * @returns {Promise<{ok, credited, capped?, balance, ref?, reason?}>}
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
		return { ok: false, capped: true, credited: 0, balance: await balanceOf(db, user) };
	}

	const activity = activityFor(challengeId, params.pooled);
	// Idempotent: same (user, reward_activity) row is REPLACED, never duplicated.
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
 * This makes the database enforce it. The index is PARTIAL, keyed on
 * `challenge_id` existing: token_transactions is the whole platform's AFIT ledger
 * (~23M rows at the time of writing) and legitimately holds many rows sharing a
 * (user, reward_activity) pair for non-arena activity. Only arena credit rows
 * carry `challenge_id`, so only those are indexed and constrained - verified
 * against production before adding this (3 rows carried it, 0 duplicates).
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
			partialFilterExpression: { challenge_id: { $exists: true } },
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
