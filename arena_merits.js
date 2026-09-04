/**
 * Challenge Engine — F4 Merits ledger + rewards shop (Trello #178, epic #171).
 *
 * "Merits" are the earned-only, NON-TRANSFERABLE in-app currency — the
 * anti-gambling spend primitive. Off-chain BY DESIGN (putting them on
 * Hive-Engine would make them a tradeable token and break the guarantee). See
 * spec `tasks/challenge-engine-spec.md` §6, §3.5, §3.7, §10.
 *
 * Compliance invariants enforced HERE (§10):
 *   I3 — no buy/deposit credit path: the only positive-delta reasons are
 *        challenge_reward / season_chest / admin_adjust (a whitelist). There is
 *        no purchase/deposit credit function.
 *   I4 — non-transferable: there is NO user→user transfer. Merits move only
 *        user↔system. (Enforced by the absence of any transfer export.)
 *   I5 — no random shop item: rewards_shop items are fixed-content; `random` is
 *        rejected at creation and refused at purchase.
 *
 * Ledger: `merits_ledger` is append-only + double-entry — every row records a
 * signed `delta`, its `reason`/`ref`, and the derived `balance_after`; rows are
 * immutable (a correction is a new compensating row, never an edit).
 *
 * Anti-sybil emission cap: system-funded Merit emission is capped per user per
 * day, so a sybil can't farm Merits by spawning fake challenges among alts.
 *
 * admin_adjust is a PRIVILEGED reason (requires opts.authorized) — the caller
 * must gate it to an operator. I4 (non-transferable) depends on that, since a
 * privileged +/- pair is the only way value can move between users. `at` must be
 * server-set (never user-controlled) so the daily cap can't be gamed.
 *
 * Concurrency (#178): the live balance is a guarded `$inc` COUNTER in
 * `merits_balances` (the AUTHORITATIVE source), not a ledger scan — so a spend is
 * an atomic conditional decrement
 * (`updateOne({user, balance:{$gte:amount}}, {$inc:{balance:-amount}})`) that
 * cannot overdraw under parallel requests, and shop stock is reserved by the same
 * atomic conditional `$inc` (with a refund if the debit then fails or throws). A
 * user's counter is backfilled from their prior ledger sum on first touch
 * (`ensureCounter`, `$setOnInsert`), so legacy balances are neither lost nor
 * frozen. The `merits_ledger` remains the append-only double-entry audit log; its
 * `balance_after`/`id` are best-effort under true concurrency (two simultaneous
 * succeeding ops may record equal values) and are reconciled by the counter — do
 * NOT read them for decisions. The daily emission cap is a ledger read (a small
 * over-emit race is tolerable; it never overdraws).
 *
 * Idempotent emission (#178): `award({..., idempotent:true, ref})` no-ops if a
 * ledger row with the same (user, reason, ref) already exists — so a once-only
 * credit (challenge/season reward) survives a retry after a crash BETWEEN the
 * emission and the caller's higher-level marker (e.g. challenge_resolutions)
 * without double-crediting. The resolver uses this per (user, challenge).
 *
 * Still deferred (tracked #178, needs a replica set): wrap the single award's
 * counter-$inc + ledger-insert (and reserve+debit+purchase) in a Mongo
 * transaction to close the narrow crash window BETWEEN those two writes, plus a
 * real (mongodb-memory-server) integration test. On a crash there the current
 * order ($inc then ledger) fails SAFE toward a bounded over-credit (one award per
 * crash), never a lost spend or a stuck balance. NB: the daily cap reads the
 * ledger, so it cannot observe a counter-only phantom $inc — the over-credit is
 * bounded per crash, not strictly bounded by the cap.
 *
 * F4 slice scope; DEFERRED to F5: pool-funded AFIT payout (I2 pool funding) and
 * I7 (funder ≠ paid participant) live in the pools/resolution module.
 *
 * Load-time safe: requires nothing (no config/Firebase); dependency-injected db.
 */

'use strict';

const COLLECTIONS = {
	LEDGER: 'merits_ledger',
	BALANCES: 'merits_balances', // guarded $inc counter — the authoritative live balance
	SHOP: 'rewards_shop',
	PURCHASES: 'merits_purchases',
};

// I3 — the ONLY ways Merits are credited. No buy/deposit/transfer-in.
const CREDIT_REASONS = ['challenge_reward', 'season_chest', 'admin_adjust'];
// The only debit reason today (shop spend). admin_adjust may also be negative.
const DEBIT_REASONS = ['shop_purchase', 'admin_adjust'];

// I5 — fixed-content sink kinds; a loot-box / random pull is never one of them.
const SHOP_KINDS = ['cosmetic', 'boost', 'badge', 'fixed_bundle'];

// Anti-sybil default: max system-funded Merits a user can be credited per UTC day.
const DEFAULT_DAILY_EMISSION_CAP = 1000;

function dayKey(iso) {
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** Current Merit balance — the authoritative guarded counter, with a ledger-sum
 *  fallback for users predating the counter (double-entry reconciles either way). */
async function balanceOf(db, user) {
	const bal = await db.collection(COLLECTIONS.BALANCES).findOne({ user });
	if (bal && Number.isFinite(bal.balance)) return bal.balance;
	const rows = await db.collection(COLLECTIONS.LEDGER).find({ user }).toArray();
	return rows.reduce((s, r) => s + (Number(r.delta) || 0), 0);
}

/** System-funded Merits already emitted to a user on the given UTC day. */
async function emittedOn(db, user, at) {
	const day = dayKey(at);
	const rows = await db.collection(COLLECTIONS.LEDGER).find({ user }).toArray();
	return rows
		.filter((r) => Number(r.delta) > 0 && r.reason !== 'admin_adjust' && dayKey(r.at) === day)
		.reduce((s, r) => s + Number(r.delta), 0);
}

/**
 * Ensure a user has a balance counter, BACKFILLING it from their existing ledger
 * sum on first touch (users predating the counter). `$setOnInsert` makes this
 * idempotent + race-safe: only the first upsert seeds the balance; a concurrent
 * caller (or any later call) no-ops once the doc exists. Must run before the
 * first award/spend so a legacy balance is never lost or frozen.
 */
async function ensureCounter(db, user) {
	if (await db.collection(COLLECTIONS.BALANCES).findOne({ user })) return;
	const rows = await db.collection(COLLECTIONS.LEDGER).find({ user }).toArray();
	const seed = rows.reduce((s, r) => s + (Number(r.delta) || 0), 0);
	await db.collection(COLLECTIONS.BALANCES).updateOne({ user }, { $setOnInsert: { user, balance: seed } }, { upsert: true });
}

/** Append one immutable double-entry row. `balance_after` is the authoritative
 *  post-op counter value (best-effort under concurrency — the counter is the
 *  source of truth; two simultaneous succeeding ops may record equal ids /
 *  balance_after, reconciled by the counter). */
async function appendLedger(db, row) {
	const rows = await db.collection(COLLECTIONS.LEDGER).find({ user: row.user }).toArray();
	const entry = {
		id: `led_${row.user}_${rows.length}`,
		user: row.user,
		delta: row.delta,
		reason: row.reason,
		ref: row.ref || null,
		balance_after: row.balance_after,
		at: row.at,
		immutable: true,
	};
	await db.collection(COLLECTIONS.LEDGER).insertOne(entry);
	return entry;
}

/**
 * Credit Merits to a user (earned-only). Enforces the I3 reason whitelist and,
 * for system emission (challenge_reward / season_chest), the per-user daily cap.
 * @returns {Promise<{ok:boolean, entry?:object, reason?:string, capped?:boolean}>}
 */
async function award(db, params) {
	const { user, amount, reason, ref } = params;
	const at = params.at || new Date().toISOString();
	if (!user) return { ok: false, reason: 'missing user' };
	if (!(Number(amount) > 0)) return { ok: false, reason: 'amount must be positive' };
	if (dayKey(at) === null) return { ok: false, reason: 'invalid at timestamp' };
	// I3 — only whitelisted credit reasons; no buy/deposit path exists.
	if (!CREDIT_REASONS.includes(reason)) return { ok: false, reason: `credit reason "${reason}" not allowed (invariant I3)` };
	// admin_adjust is privileged: cap-exempt and able to move value, so the caller
	// MUST assert authorization. Guards the emission cap and I4.
	if (reason === 'admin_adjust' && !params.authorized) {
		return { ok: false, reason: 'admin_adjust requires authorization' };
	}

	// Idempotent emission (#178): when the caller marks a once-only credit keyed by
	// `ref` (a challenge/season reward), a matching prior ledger row means it
	// already landed — return it instead of emitting again. This closes the common
	// crash window where the reward is emitted but the higher-level idempotency
	// marker (e.g. challenge_resolutions) isn't yet written, so a retry re-awards.
	// (The narrower single-award counter-vs-ledger window still needs a Mongo
	// transaction — tracked, requires a replica set; see the header note.)
	if (params.idempotent) {
		if (!ref) return { ok: false, reason: 'idempotent award requires a ref' };
		const existing = await db.collection(COLLECTIONS.LEDGER).findOne({ user, reason, ref });
		// Report the ACTUALLY-credited amount (entry.delta) on the no-op, not the
		// requested one — otherwise a caller recording `emitted` on a retry would
		// over-state a reward that was originally capped (audit divergence vs ledger).
		if (existing) return { ok: true, noop: true, entry: existing, emitted: existing.delta };
	}

	// Anti-sybil daily emission cap on system-funded rewards (privileged
	// admin_adjust is exempt).
	let creditAmount = Number(amount);
	let capMeta = null;
	if (reason !== 'admin_adjust') {
		const cap = params.dailyCap || DEFAULT_DAILY_EMISSION_CAP;
		const already = await emittedOn(db, user, at);
		const requested = Number(amount);
		if (already + requested > cap) {
			const room = Math.max(0, cap - already);
			// Emit up to the cap; report the dropped remainder so the caller can log/carry-over.
			if (room <= 0) return { ok: false, capped: true, reason: 'daily emission cap reached', requested, emitted: 0, dropped: requested };
			creditAmount = room;
			capMeta = { capped: true, requested, emitted: room, dropped: requested - room };
		}
	}
	// Backfill any prior ledger balance into the counter, then atomic credit.
	await ensureCounter(db, user);
	await db.collection(COLLECTIONS.BALANCES).updateOne({ user }, { $inc: { balance: creditAmount } }, { upsert: true });
	const entry = await appendLedger(db, { user, delta: creditAmount, reason, ref, at, balance_after: await balanceOf(db, user) });
	return { ok: true, entry, ...(capMeta || {}) };
}

/**
 * Debit Merits (shop spend). Fails if the balance is insufficient. There is NO
 * user→user transfer (invariant I4) — Merits only move user↔system.
 */
async function spend(db, params) {
	const { user, amount, ref } = params;
	const reason = params.reason || 'shop_purchase';
	const at = params.at || new Date().toISOString();
	if (!user) return { ok: false, reason: 'missing user' };
	if (!(Number(amount) > 0)) return { ok: false, reason: 'amount must be positive' };
	if (dayKey(at) === null) return { ok: false, reason: 'invalid at timestamp' };
	if (!DEBIT_REASONS.includes(reason)) return { ok: false, reason: `debit reason "${reason}" not allowed` };
	if (reason === 'admin_adjust' && !params.authorized) {
		return { ok: false, reason: 'admin_adjust requires authorization' };
	}
	// Backfill any prior ledger balance so a legacy user can spend it.
	await ensureCounter(db, user);
	// Atomic guarded decrement — cannot overdraw under concurrent spends: the
	// {balance:{$gte:amount}} condition + $inc is a single-document atomic update.
	const r = await db.collection(COLLECTIONS.BALANCES).updateOne(
		{ user, balance: { $gte: Number(amount) } },
		{ $inc: { balance: -Number(amount) } }
	);
	if (!r.modifiedCount) return { ok: false, reason: 'insufficient merits' };
	const entry = await appendLedger(db, { user, delta: -Number(amount), reason, ref, at, balance_after: await balanceOf(db, user) });
	return { ok: true, entry };
}

/**
 * Add a rewards-shop item. I5 — a random/loot-box item is refused; only
 * fixed-content kinds are allowed.
 */
async function addShopItem(db, item) {
	if (!item || !SHOP_KINDS.includes(item.kind)) return { ok: false, reason: `invalid shop kind "${item && item.kind}"` };
	if (item.random) return { ok: false, reason: 'random/loot-box items are not allowed (invariant I5)' };
	if (!(Number(item.cost_merits) >= 0)) return { ok: false, reason: 'cost_merits must be >= 0' };
	const doc = {
		id: item.id,
		kind: item.kind,
		title: item.title || null,
		cost_merits: Number(item.cost_merits),
		stock: item.stock == null ? 'unlimited' : item.stock,
		random: false, // hard-set — never a random pull
	};
	await db.collection(COLLECTIONS.SHOP).replaceOne({ id: doc.id }, doc, { upsert: true });
	return { ok: true, item: doc };
}

/**
 * Purchase a shop item: spend its Merit cost, decrement stock, record the
 * purchase. Refuses a (corrupt) random item as a defense-in-depth for I5.
 */
async function purchase(db, params) {
	const { user, itemId } = params;
	const at = params.at || new Date().toISOString();
	const shop = db.collection(COLLECTIONS.SHOP);
	const item = await shop.findOne({ id: itemId });
	if (!item) return { ok: false, reason: 'unknown item' };
	if (item.random) return { ok: false, reason: 'random item cannot be purchased (invariant I5)' };

	// Atomic stock RESERVATION first (skip for unlimited) — a conditional $inc so
	// two concurrent buyers can't oversell a limited item.
	const limited = item.stock !== 'unlimited';
	if (limited) {
		const r = await shop.updateOne({ id: item.id, stock: { $gt: 0 } }, { $inc: { stock: -1 } });
		if (!r.modifiedCount) return { ok: false, reason: 'out of stock' };
	}
	const refundStock = async () => { if (limited) await shop.updateOne({ id: item.id }, { $inc: { stock: 1 } }); };

	try {
		// Free items (cost_merits === 0) skip the debit — spend() rejects a 0 amount.
		let ledger = null;
		if (Number(item.cost_merits) > 0) {
			const debit = await spend(db, { user, amount: item.cost_merits, reason: 'shop_purchase', ref: item.id, at });
			if (!debit.ok) { await refundStock(); return debit; }
			ledger = debit.entry;
		}
		await db.collection(COLLECTIONS.PURCHASES).insertOne({ user, item_id: item.id, cost_merits: Number(item.cost_merits), at });
		return { ok: true, item_id: item.id, ledger };
	} catch (e) {
		// A throw after the reservation (DB error) must not leak the reserved unit.
		await refundStock();
		throw e;
	}
}

/** Indexes the ledger/shop rely on. Safe no-op where createIndex is unavailable. */
async function ensureMeritsIndexes(db) {
	const ledger = db.collection(COLLECTIONS.LEDGER);
	const balances = db.collection(COLLECTIONS.BALANCES);
	const shop = db.collection(COLLECTIONS.SHOP);
	if (typeof ledger.createIndex === 'function') {
		await ledger.createIndex({ user: 1, at: 1 });
		// Backs the idempotent-award dedupe lookup findOne({user, reason, ref}).
		// Non-unique: legacy non-idempotent awards may share (user, reason, ref).
		await ledger.createIndex({ user: 1, reason: 1, ref: 1 });
	}
	if (typeof balances.createIndex === 'function') {
		await balances.createIndex({ user: 1 }, { unique: true });
	}
	if (typeof shop.createIndex === 'function') {
		await shop.createIndex({ id: 1 }, { unique: true });
	}
}

module.exports = {
	COLLECTIONS,
	CREDIT_REASONS,
	DEBIT_REASONS,
	SHOP_KINDS,
	DEFAULT_DAILY_EMISSION_CAP,
	balanceOf,
	emittedOn,
	award,
	spend,
	addShopItem,
	purchase,
	ensureMeritsIndexes,
};
