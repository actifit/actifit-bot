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
// reward_activity prefix that marks an Arena challenge reward row (per challenge).
const ARENA_ACTIVITY_PREFIX = 'arena_challenge:';
// Default per-user daily AFIT cap on challenge rewards (config-overridable).
// Set at the free daily cash-out anchor (500) so a day's challenge winnings can't
// exceed a normal free withdrawal, and so a single top prize is never clipped.
const DEFAULT_DAILY_CAP = 500;

function dayKey(iso) {
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** The per-(user, challenge) ledger key that makes a re-credit idempotent. */
function activityFor(challengeId) {
	return ARENA_ACTIVITY_PREFIX + challengeId;
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
 * (user, challenge) and bounded by the per-user daily cap.
 * @param {object} db
 * @param {object} params { user, challengeId, amount, at?, dailyCap? }
 * @returns {Promise<{ok, credited, capped?, balance, ref?, reason?}>}
 */
async function creditAfitReward(db, params) {
	const { user, challengeId, amount } = params;
	const at = params.at || new Date().toISOString();
	const dailyCap = Number.isFinite(params.dailyCap) ? params.dailyCap : DEFAULT_DAILY_CAP;
	if (!user || !challengeId) return { ok: false, reason: 'missing user/challengeId' };
	if (!(Number(amount) > 0)) return { ok: false, reason: 'amount must be positive' };
	if (dayKey(at) === null) return { ok: false, reason: 'invalid at timestamp' };

	// Per-user daily cap — excludes this challenge's own row so a retry re-credits
	// the SAME amount (idempotent) rather than being double-counted against room.
	const already = await arenaEmittedOn(db, user, at, challengeId);
	const room = Math.max(0, dailyCap - already);
	const credited = Math.min(Number(amount), room);
	if (credited <= 0) {
		return { ok: false, capped: true, credited: 0, balance: await balanceOf(db, user) };
	}

	const activity = activityFor(challengeId);
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

module.exports = {
	COL,
	AFIT_CHAIN,
	ARENA_ACTIVITY_PREFIX,
	DEFAULT_DAILY_CAP,
	activityFor,
	balanceOf,
	arenaEmittedOn,
	reconcileBalance,
	creditAfitReward,
};
