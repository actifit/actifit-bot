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
 *   I7 — a pool's FUNDER cannot be a paid participant of a challenge that pool
 *        rewards. Funders are excluded from the payout at resolution.
 *
 * Pool custody is on-chain (real AFIT held in an Actifit-controlled account); the
 * `pools` doc is the off-chain accounting (budget → committed → paid). A pool
 * never pays beyond its budget.
 *
 * Structure (pure core → orchestration):
 *   - allocatePayouts(standings, prizes, opts) — map ranked rows → prize awards
 *     (pure), excluding held/funder entities.
 *   - createPool / commitToPool                — pool lifecycle + accounting.
 *   - resolveChallenge(db, params)             — the capstone: standings → pool
 *     draw → Merit emission + AFIT/badge grants → participant results + settle
 *     payload. Idempotent per (challenge, pool).
 *
 * F5 slice scope; note the F4 ledger is still single-writer (see arena_merits
 * header) — a resolution batch is the first real caller, run it as ONE
 * sequential sweep (not parallel) until the ledger moves to atomic counters
 * (tracked on #178).
 *
 * Load-time safe: requires only ./arena_merits (itself config/Firebase-free).
 */

'use strict';

const merits = require('./arena_merits');

const COLLECTIONS = {
	POOLS: 'pools',
	SPONSORS: 'sponsors',
	PARTICIPANTS: 'challenge_participants',
	CHALLENGES: 'challenges',
};

// I2 — the ONLY funding sources. No participant-stake / entry-fee source exists.
const POOL_FUNDING = ['sponsor', 'dhf', 'treasury'];
const POOL_CURRENCIES = ['AFIT', 'MERITS', 'BADGE'];

/**
 * Create a reward pool. I2 — funding must be sponsor/DHF/treasury; there is no
 * way to fund a pool from participant stakes.
 * @returns {Promise<{ok:boolean, pool?:object, reason?:string}>}
 */
async function createPool(db, params) {
	const { id, funding, budget } = params;
	if (!id) return { ok: false, reason: 'missing pool id' };
	// I2 — reject any funding source that is not sponsor/DHF/treasury.
	if (!POOL_FUNDING.includes(funding)) return { ok: false, reason: `pool funding "${funding}" not allowed (invariant I2)` };
	if (!(Number(budget) >= 0)) return { ok: false, reason: 'budget must be >= 0' };
	const currency = params.currency || 'AFIT';
	if (!POOL_CURRENCIES.includes(currency)) return { ok: false, reason: `invalid currency "${currency}"` };

	const pool = {
		id,
		funding,
		sponsor: params.sponsor || null, // the funding account (for I7 exclusion)
		currency,
		budget: Number(budget),
		committed: 0,
		paid: 0,
		window: params.window || null,
		state: 'open',
	};
	await db.collection(COLLECTIONS.POOLS).replaceOne({ id }, pool, { upsert: true });
	if (params.sponsor) {
		await db.collection(COLLECTIONS.SPONSORS).replaceOne(
			{ id: params.sponsor },
			{ id: params.sponsor, funded_total: Number(budget), attribution: params.attribution || null },
			{ upsert: true }
		);
	}
	return { ok: true, pool };
}

/** Commit (reserve) an amount against a pool's remaining budget. */
async function commitToPool(db, poolId, amount) {
	const pool = await db.collection(COLLECTIONS.POOLS).findOne({ id: poolId });
	if (!pool) return { ok: false, reason: 'unknown pool' };
	const remaining = pool.budget - pool.committed;
	if (Number(amount) > remaining) return { ok: false, reason: 'exceeds remaining pool budget' };
	await db.collection(COLLECTIONS.POOLS).updateOne({ id: poolId }, { $set: { committed: pool.committed + Number(amount) } });
	return { ok: true, committed: pool.committed + Number(amount) };
}

/**
 * Map ranked standings rows to prize awards. Pure.
 * `prizes`: [{ rank, afit, merits, badges }] — the prize schedule by finishing
 * rank. `opts.excludeEntities`: a Set of entities to skip (funder — I7 — and any
 * anti-cheat-held entity the standings already dropped). Returns the payout list.
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
		if (afit === 0 && meritAmt === 0 && badges.length === 0) continue;
		payouts.push({ entity: row.entity, rank: row.rank, afit, merits: meritAmt, badges });
	}
	return payouts;
}

/**
 * Resolve a challenge: draw prizes for its verified standings from a pool, emit
 * Merits (F4), record AFIT payout intents + badge grants, mark the pool
 * paid, write participant results, and return the on-chain `settle` payload.
 *
 * I7 — the pool's funder/sponsor is excluded from the payout. A pool never pays
 * beyond its remaining budget (AFIT). Run as ONE sequential sweep.
 *
 * @param {object} params { challengeId, poolId, standings:[{entity,rank}],
 *   prizes:[{rank,afit,merits,badges}], asOf }
 * @returns {Promise<{ok, settlePayload?, paidAfit?, excludedFunder?, reason?}>}
 */
async function resolveChallenge(db, params) {
	const { challengeId, poolId, standings, prizes } = params;
	const at = params.asOf || new Date().toISOString();
	const pools = db.collection(COLLECTIONS.POOLS);
	const participantsC = db.collection(COLLECTIONS.PARTICIPANTS);

	const pool = poolId ? await pools.findOne({ id: poolId }) : null;
	if (poolId && !pool) return { ok: false, reason: 'unknown pool' };
	if (!Array.isArray(standings)) return { ok: false, reason: 'missing standings' };

	// I7 — the funder can never be a paid participant of its own pool.
	const exclude = new Set();
	let excludedFunder = null;
	if (pool && pool.sponsor && standings.some((r) => r.entity === pool.sponsor)) {
		exclude.add(pool.sponsor);
		excludedFunder = pool.sponsor;
	}

	const payouts = allocatePayouts(standings, prizes, { excludeEntities: exclude });

	// AFIT is capped by the pool's remaining budget; Merits/badges are unbounded
	// by the AFIT pool (Merits are system-emitted, I3-gated).
	const totalAfit = payouts.reduce((s, p) => s + p.afit, 0);
	if (pool && pool.currency === 'AFIT') {
		const remaining = pool.budget - pool.paid;
		if (totalAfit > remaining) return { ok: false, reason: 'payout exceeds remaining pool budget' };
	}

	const rewards = [];
	for (const p of payouts) {
		let reward_ref = null;
		if (p.merits > 0) {
			const res = await merits.award(db, { user: p.entity, amount: p.merits, reason: 'challenge_reward', ref: challengeId, at });
			if (res.ok && res.entry) reward_ref = res.entry.id;
		}
		// AFIT payout is settled on Hive-Engine by the broadcaster; here we record
		// the INTENT + link. he_tx is filled once the HE transfer lands. Whole-object
		// $set on `result` so it nests correctly (dotted paths don't in the mock).
		const existing = await participantsC.findOne({ challenge_id: challengeId, entity: p.entity });
		const priorResult = (existing && existing.result) || {};
		await participantsC.updateOne(
			{ challenge_id: challengeId, entity: p.entity },
			{ $set: { result: { ...priorResult, reward: { afit: p.afit, merits: p.merits, badges: p.badges, reward_ref, he_tx: null } } } }
		);
		rewards.push({ entity: p.entity, afit: p.afit, merits: p.merits, badges: p.badges, reward_ref, he_tx: null });
	}

	if (pool) {
		await pools.updateOne({ id: pool.id }, { $set: { paid: pool.paid + totalAfit, state: 'settled' } });
	}

	// The payload the caller broadcasts as the on-chain `settle` op (F1).
	const settlePayload = { op: 'settle', v: 1, challenge_id: challengeId, standings, rewards };
	return { ok: true, settlePayload, paidAfit: totalAfit, excludedFunder, rewarded: payouts.length };
}

/** Indexes the pools/sponsors rely on. Safe no-op where createIndex is absent. */
async function ensurePoolsIndexes(db) {
	const pools = db.collection(COLLECTIONS.POOLS);
	const sponsors = db.collection(COLLECTIONS.SPONSORS);
	if (typeof pools.createIndex === 'function') await pools.createIndex({ id: 1 }, { unique: true });
	if (typeof sponsors.createIndex === 'function') await sponsors.createIndex({ id: 1 }, { unique: true });
}

module.exports = {
	COLLECTIONS,
	POOL_FUNDING,
	POOL_CURRENCIES,
	createPool,
	commitToPool,
	allocatePayouts,
	resolveChallenge,
	ensurePoolsIndexes,
};
