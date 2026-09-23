/**
 * Challenge Engine — creator-funded challenge pools (epic #171, §7.4).
 *
 * A user with the holdings gate (community-tier eligibility = moderator OR
 * ≥ arena_funded_min_afit AFIT) can create a challenge whose prize they fund from
 * their OWN off-chain AFIT. This module locks that AFIT into a sponsor-funded pool
 * at ingest:
 *   - Debit the creator (prize + platform fee) from their off-chain balance.
 *   - The prize is held as the pool budget (paid to winners at resolution).
 *   - The platform fee (default 5% of the prize) is BURNED — removed from the
 *     off-chain supply (deflationary; simpler + no privileged treasury credit).
 *     Switch to a treasury credit later by crediting `treasury` instead.
 *   - Create a `sponsor`-funded pool with the creator as sponsor, so I7 excludes
 *     the creator from winning their own prize.
 *
 * Compliance: this is SPONSORSHIP, not a wager — the funder cannot be paid from
 * the pool (I7), entry stays free (I1), and funding is sponsor/treasury (I2). Zero
 * treasury cost (the creator pays); no system minting.
 *
 * Idempotent per challenge, safely ordered for crash-safety WITHOUT a transaction:
 * the creator is debited at most once (guarded by the keyed debit row), and the
 * pool is the completion marker. A crash between debit and pool-create re-enters
 * and completes without re-debiting.
 *
 * Load-time safe: requires only ./arena_afit + ./arena_pools (both config-free).
 */

'use strict';

const arenaAfit = require('./arena_afit');
const arenaPools = require('./arena_pools');

// token_transactions reward_activity keys (one row per challenge).
const FUND_ACTIVITY = 'arena_fund:';   // creator debit (negative): prize + fee
const DEFAULT_CUT_PCT = 5;             // platform fee, % of the prize
const DEFAULT_MIN_POOL = 50;           // minimum prize AFIT (blocks dust prizes)

/** Deterministic pool id for a challenge's self-funded prize. */
function poolIdFor(challengeId) {
	return 'poolch_' + challengeId;
}

/** The 5% (default) platform fee on a prize, rounded to 2 decimals. */
function feeFor(prize, cutPct) {
	const pct = Number.isFinite(cutPct) ? cutPct : DEFAULT_CUT_PCT;
	return Math.round(Number(prize) * pct) / 100;
}

/**
 * Fund a creator's challenge prize pool from their off-chain AFIT.
 * @param {object} db
 * @param {object} params { creator, challengeId, prize, at?, cutPct?, minPool?, window? }
 * @returns {Promise<{ok, poolId?, prize?, fee?, noop?, reason?}>}
 */
async function fundChallenge(db, params) {
	const { creator, challengeId, prize } = params;
	const at = params.at || new Date().toISOString();
	const cutPct = Number.isFinite(params.cutPct) ? params.cutPct : DEFAULT_CUT_PCT;
	const minPool = Number.isFinite(params.minPool) ? params.minPool : DEFAULT_MIN_POOL;
	if (!creator || !challengeId) return { ok: false, reason: 'missing creator/challengeId' };
	if (!(Number(prize) >= minPool)) return { ok: false, reason: `prize must be at least ${minPool} AFIT` };

	const fee = feeFor(prize, cutPct);
	const total = Number(prize) + fee;
	const poolId = poolIdFor(challengeId);

	// Idempotent: already fully funded (pool exists) → no-op success.
	const existingPool = await db.collection('pools').findOne({ id: poolId });
	if (existingPool) return { ok: true, noop: true, poolId, prize: existingPool.budget, fee };

	// Debit the creator ONCE. Guarded by the keyed row so a crash-retry (pool not
	// yet created) doesn't re-check-and-re-debit against the already-reduced balance.
	const fundRow = await db.collection('token_transactions').findOne({ user: creator, reward_activity: FUND_ACTIVITY + challengeId });
	if (!fundRow) {
		const bal = await arenaAfit.balanceOf(db, creator);
		if (bal < total) return { ok: false, reason: 'insufficient AFIT to fund the prize + fee' };
		await db.collection('token_transactions').replaceOne(
			{ user: creator, reward_activity: FUND_ACTIVITY + challengeId },
			{
				user: creator,
				reward_activity: FUND_ACTIVITY + challengeId,
				token_count: -total,           // prize funds winners; fee is burned
				chain: 'HIVE',
				orig_account: 'actifit',
				challenge_id: challengeId,
				prize: Number(prize),
				fee,
				date: new Date(at),
			},
			{ upsert: true }
		);
	}
	// Reconcile unconditionally (idempotent) — so a crash-retry that skipped the
	// debit block still refreshes the materialized balance to reflect the debit,
	// closing an over-spend window before the periodic full re-aggregation.
	await arenaAfit.reconcileBalance(db, creator);

	// Create the sponsor-funded pool (the completion marker). Creator = sponsor →
	// excluded from their own payout (I7). Idempotent: "already exists" is success.
	const created = await arenaPools.createPool(db, {
		id: poolId, funding: 'sponsor', sponsor: creator, budget: Number(prize), currency: 'AFIT', window: params.window,
	});
	if (!created.ok && !/already exists/i.test(created.reason || '')) {
		return { ok: false, reason: created.reason };
	}
	return { ok: true, poolId, prize: Number(prize), fee };
}

const REFUND_ACTIVITY = 'arena_refund:'; // creator credit (positive): unpaid pool

/**
 * Return a creator-funded pool's UNPAID balance (budget − paid to winners) to the
 * creator after resolution — so a challenge that draws fewer than the funded ranks
 * (or none) never burns the creator's prize. Idempotent per challenge (keyed row)
 * and safe to call on every resolution pass. The fee is NOT refunded (platform cut).
 * @returns {Promise<{ok, refunded, noop?, reason?}>}
 */
async function refundUnpaid(db, params) {
	const { challengeId, poolId, creator } = params;
	const at = params.at || new Date().toISOString();
	if (!challengeId || !poolId || !creator) return { ok: false, reason: 'missing challengeId/poolId/creator' };

	const activity = REFUND_ACTIVITY + challengeId;
	const existing = await db.collection('token_transactions').findOne({ user: creator, reward_activity: activity });
	if (existing) return { ok: true, noop: true, refunded: Number(existing.token_count) || 0 };

	const pool = await db.collection('pools').findOne({ id: poolId });
	if (!pool) return { ok: false, reason: 'unknown pool' };
	const unpaid = Math.max(0, (Number(pool.budget) || 0) - (Number(pool.paid) || 0));

	if (unpaid > 0) {
		await db.collection('token_transactions').replaceOne(
			{ user: creator, reward_activity: activity },
			{ user: creator, reward_activity: activity, token_count: unpaid, chain: 'HIVE', orig_account: 'actifit', challenge_id: challengeId, date: new Date(at) },
			{ upsert: true }
		);
		await arenaAfit.reconcileBalance(db, creator);
	}
	await db.collection('pools').updateOne({ id: poolId }, { $set: { state: 'settled' } });
	return { ok: true, refunded: unpaid };
}

module.exports = {
	FUND_ACTIVITY,
	REFUND_ACTIVITY,
	DEFAULT_CUT_PCT,
	DEFAULT_MIN_POOL,
	poolIdFor,
	feeFor,
	fundChallenge,
	refundUnpaid,
};
