/**
 * Challenge Engine — F5 pools + resolution/payout (Trello #179, epic #171).
 *
 * Where prizes actually pay out. A challenge resolves from its VERIFIED standings
 * (F3) → payouts are drawn against a sponsor/DHF/treasury POOL → Merits are
 * emitted via the F4 ledger, AFIT payout intents + badge grants are recorded, and
 * a `settle` payload is produced for the on-chain settle op (F1). Spec §7, §3.6.
 *
 * Compliance invariants enforced HERE (§10):
 *   I2 — a reward pool's funding is sponsor / DHF / treasury ONLY. There is no
 *        participant-stake funding source (the enum has none).
 *   I7 — a pool's FUNDERS cannot be paid participants of a challenge that pool
 *        rewards. Every funder is excluded from the payout at resolution.
 *
 * Trust boundary: resolution only pays ENROLLED, non-anti-cheat-held participants
 * of the challenge — the caller-supplied standings are re-validated against
 * `challenge_participants`, so a fabricated or flagged entity is never paid.
 *
 * Pool custody is on-chain (real AFIT held in an Actifit-controlled account); the
 * `pools` doc is the off-chain accounting (budget → committed → paid), and the
 * invariant `paid + committed <= budget` is preserved so a reservation can't be
 * over-drawn at payout.
 *
 * Idempotent: a challenge is resolved ONCE. A `challenge_resolutions` record
 * makes a re-run a no-op that returns the prior settle payload — so a retry never
 * double-emits Merits or double-pays AFIT.
 *
 * F5 slice scope; note the F4 ledger is still single-writer (see arena_merits
 * header) — run resolution as ONE sequential sweep until the ledger moves to
 * atomic counters (tracked on #178). DEFERRED to a later slice: the tiered
 * `POST challenges` / `POST /:id/sponsor` HTTP endpoints (§7.4) and the actual
 * Hive-Engine AFIT broadcast (here `he_tx` is null until the transfer lands).
 *
 * Load-time safe: requires only ./arena_merits + ./arena_verify (both
 * config/Firebase-free).
 */

'use strict';

const merits = require('./arena_merits');
const arenaVerify = require('./arena_verify'); // ANTICHEAT_FLAG only

const COLLECTIONS = {
	POOLS: 'pools',
	SPONSORS: 'sponsors',
	PARTICIPANTS: 'challenge_participants',
	RESOLUTIONS: 'challenge_resolutions',
};

// I2 — the ONLY funding sources. No participant-stake / entry-fee source exists.
const POOL_FUNDING = ['sponsor', 'dhf', 'treasury'];
const POOL_CURRENCIES = ['AFIT', 'MERITS', 'BADGE'];

/**
 * Create a reward pool. I2 — funding must be sponsor/DHF/treasury; there is no
 * way to fund a pool from participant stakes. A sponsor-funded pool must name its
 * sponsor (so I7 can exclude it). Refuses to overwrite an existing pool.
 */
async function createPool(db, params) {
	const { id, funding, budget } = params;
	if (!id) return { ok: false, reason: 'missing pool id' };
	// I2 — reject any funding source that is not sponsor/DHF/treasury.
	if (!POOL_FUNDING.includes(funding)) return { ok: false, reason: `pool funding "${funding}" not allowed (invariant I2)` };
	if (funding === 'sponsor' && !params.sponsor) return { ok: false, reason: 'a sponsor-funded pool must name its sponsor' };
	if (!(Number(budget) >= 0)) return { ok: false, reason: 'budget must be >= 0' };
	const currency = params.currency || 'AFIT';
	if (!POOL_CURRENCIES.includes(currency)) return { ok: false, reason: `invalid currency "${currency}"` };

	if (await db.collection(COLLECTIONS.POOLS).findOne({ id })) {
		return { ok: false, reason: 'pool id already exists' };
	}

	const funders = params.sponsor ? [params.sponsor] : [];
	const pool = {
		id,
		funding,
		sponsor_id: params.sponsor || null,
		funders, // every funder — excluded from payout (I7)
		currency,
		budget: Number(budget),
		committed: 0,
		paid: 0,
		window: params.window || null,
		state: 'open',
	};
	await db.collection(COLLECTIONS.POOLS).insertOne(pool);
	if (params.sponsor) {
		await db.collection(COLLECTIONS.SPONSORS).replaceOne(
			{ id: params.sponsor },
			{ id: params.sponsor, name: params.sponsorName || params.sponsor, funded_total: Number(budget), attribution: params.attribution || null },
			{ upsert: true }
		);
	}
	return { ok: true, pool };
}

/**
 * Commit (reserve) an amount against a pool's FREE budget (budget − committed −
 * paid), preserving `paid + committed <= budget`.
 */
async function commitToPool(db, poolId, amount) {
	const pool = await db.collection(COLLECTIONS.POOLS).findOne({ id: poolId });
	if (!pool) return { ok: false, reason: 'unknown pool' };
	const free = pool.budget - pool.committed - pool.paid;
	if (!(Number(amount) >= 0)) return { ok: false, reason: 'amount must be >= 0' };
	if (Number(amount) > free) return { ok: false, reason: 'exceeds remaining pool budget' };
	await db.collection(COLLECTIONS.POOLS).updateOne({ id: poolId }, { $set: { committed: pool.committed + Number(amount) } });
	return { ok: true, committed: pool.committed + Number(amount) };
}

/**
 * Map ranked standings rows to prize awards. Pure.
 * `prizes`: [{ rank, afit, merits, badges }]. `opts.excludeEntities`: a Set of
 * entities to skip (funders — I7). Negative prize amounts are rejected; a row
 * with no prize, or an all-empty prize, yields nothing.
 */
function allocatePayouts(standings, prizes, opts = {}) {
	const exclude = opts.excludeEntities || new Set();
	const byRank = new Map((prizes || []).map((p) => [p.rank, p]));
	const payouts = [];
	for (const row of standings || []) {
		if (exclude.has(row.entity)) continue;
		const prize = byRank.get(row.rank);
		if (!prize) continue;
		const afit = Number(prize.afit) || 0;
		const meritAmt = Number(prize.merits) || 0;
		const badges = Array.isArray(prize.badges) ? prize.badges : [];
		if (afit < 0 || meritAmt < 0) continue; // negative prizes are never valid
		if (afit === 0 && meritAmt === 0 && badges.length === 0) continue;
		payouts.push({ entity: row.entity, rank: row.rank, afit, merits: meritAmt, badges });
	}
	return payouts;
}

function isHeld(participant) {
	return Array.isArray(participant.flags) && participant.flags.includes(arenaVerify.ANTICHEAT_FLAG);
}

/**
 * Resolve a challenge: draw prizes for its verified standings from a pool, emit
 * Merits (F4), record AFIT payout intents + badge grants, update the pool
 * accounting, write participant results, and return the on-chain `settle`
 * payload. Idempotent per challenge (a `challenge_resolutions` marker).
 *
 * @param {object} params { challengeId, poolId, standings:[{entity,rank,score_verified|score}],
 *   prizes:[{rank,afit,merits,badges}], asOf }
 * @returns {Promise<{ok, settlePayload?, paidAfit?, excludedFunders?, rewarded?, noop?, reason?}>}
 */
async function resolveChallenge(db, params) {
	const { challengeId, poolId, standings, prizes } = params;
	const at = params.asOf || new Date().toISOString();
	const poolsC = db.collection(COLLECTIONS.POOLS);
	const participantsC = db.collection(COLLECTIONS.PARTICIPANTS);
	const resolutionsC = db.collection(COLLECTIONS.RESOLUTIONS);

	if (!Array.isArray(standings)) return { ok: false, reason: 'missing standings' };

	// Idempotent: a challenge is resolved once. Re-run returns the prior result.
	const prior = await resolutionsC.findOne({ challenge_id: challengeId });
	if (prior) {
		return { ok: true, noop: true, settlePayload: prior.settlePayload, paidAfit: prior.paidAfit, excludedFunders: prior.excludedFunders || [] };
	}

	const pool = poolId ? await poolsC.findOne({ id: poolId }) : null;
	if (poolId && !pool) return { ok: false, reason: 'unknown pool' };

	// Trust boundary — only ENROLLED, non-held participants of THIS challenge are
	// payable; the caller-supplied standings are re-validated against the index.
	const parts = await participantsC.find({ challenge_id: challengeId }).toArray();
	// Payable = enrolled, not anti-cheat-held, and did NOT leave the challenge.
	const eligible = new Map(parts.filter((p) => !isHeld(p) && p.state !== 'left').map((p) => [p.entity, p]));
	const validStandings = standings.filter((r) => eligible.has(r.entity));

	// I7 — exclude every funder of the pool from its own payout.
	const funders = (pool && Array.isArray(pool.funders)) ? pool.funders : [];
	const exclude = new Set(funders);
	const excludedFunders = funders.filter((f) => standings.some((r) => r.entity === f));

	const payouts = allocatePayouts(validStandings, prizes, { excludeEntities: exclude });

	// AFIT is capped by the pool's remaining budget whenever any AFIT is paid.
	const totalAfit = payouts.reduce((s, p) => s + p.afit, 0);
	if (totalAfit > 0) {
		if (!pool) return { ok: false, reason: 'AFIT payout requires a pool' };
		if (totalAfit > pool.budget - pool.paid) return { ok: false, reason: 'payout exceeds remaining pool budget' };
	}

	const rewards = [];
	for (const p of payouts) {
		let reward_ref = null;
		let emitted = 0;
		if (p.merits > 0) {
			// idempotent by (user, challenge): a retry after a crash before the
			// resolution marker lands re-enters here but never double-emits (#178).
			const res = await merits.award(db, { user: p.entity, amount: p.merits, reason: 'challenge_reward', ref: challengeId, at, idempotent: true });
			if (res.ok && res.entry) {
				reward_ref = res.entry.id;
				emitted = res.emitted != null ? res.emitted : p.merits; // record what was ACTUALLY emitted
			}
		}
		// Whole-object $set on `result` so it nests correctly (dotted paths don't
		// in the mock). Record `emitted`, not the requested amount (M1).
		const part = eligible.get(p.entity);
		const priorResult = (part && part.result) || {};
		const rewardObj = { afit: p.afit, merits: emitted, badges: p.badges, reward_ref, he_tx: null };
		await participantsC.updateOne(
			{ challenge_id: challengeId, entity: p.entity },
			{ $set: { result: { ...priorResult, rank: p.rank, reward: rewardObj } } }
		);
		rewards.push({ entity: p.entity, afit: p.afit, merits: emitted, badges: p.badges, reward_ref, he_tx: null });
	}

	if (pool) {
		const newPaid = pool.paid + totalAfit;
		const newCommitted = Math.max(0, pool.committed - totalAfit); // release the reservation as it is paid
		const state = newPaid >= pool.budget ? 'exhausted' : pool.state;
		await poolsC.updateOne({ id: pool.id }, { $set: { paid: newPaid, committed: newCommitted, state } });
	}

	// settle standings carry score_verified so the F1 settle op indexes them (§3.10).
	const settleStandings = validStandings.map((r) => ({
		entity: r.entity,
		rank: r.rank,
		score_verified: r.score_verified != null ? r.score_verified : (r.score != null ? r.score : null),
	}));
	const settlePayload = { op: 'settle', v: 1, challenge_id: challengeId, standings: settleStandings, rewards };

	await resolutionsC.insertOne({ challenge_id: challengeId, pool_id: poolId || null, settlePayload, paidAfit: totalAfit, excludedFunders, at });
	return { ok: true, settlePayload, paidAfit: totalAfit, excludedFunders, rewarded: payouts.length };
}

/** Indexes the pools/sponsors/resolutions rely on. Safe no-op where absent. */
async function ensurePoolsIndexes(db) {
	const poolsC = db.collection(COLLECTIONS.POOLS);
	const sponsorsC = db.collection(COLLECTIONS.SPONSORS);
	const resolutionsC = db.collection(COLLECTIONS.RESOLUTIONS);
	if (typeof poolsC.createIndex === 'function') await poolsC.createIndex({ id: 1 }, { unique: true });
	if (typeof sponsorsC.createIndex === 'function') await sponsorsC.createIndex({ id: 1 }, { unique: true });
	if (typeof resolutionsC.createIndex === 'function') await resolutionsC.createIndex({ challenge_id: 1 }, { unique: true });
}

module.exports = {
	COLLECTIONS,
	POOL_FUNDING,
	POOL_CURRENCIES,
	createPool,
	commitToPool,
	allocatePayouts,
	isHeld,
	resolveChallenge,
	ensurePoolsIndexes,
};
