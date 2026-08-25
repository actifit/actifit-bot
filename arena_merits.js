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
 * ⚠️ SINGLE-WRITER for now: balance / emission / stock are read-then-write (no
 * atomic counter or transaction yet), so this is NOT concurrency-safe against
 * parallel spends/purchases of the same user or item. It has no callers yet;
 * BEFORE wiring to concurrent routes (F5/F6), move balance and stock to guarded
 * `$inc` counters / a transaction (tracked on #178). See the deferred follow-ups.
 *
 * F4 slice scope; DEFERRED to F5: pool-funded AFIT payout (I2 pool funding) and
 * I7 (funder ≠ paid participant) live in the pools/resolution module.
 *
 * Load-time safe: requires nothing (no config/Firebase); dependency-injected db.
 */

'use strict';

const COLLECTIONS = {
	LEDGER: 'merits_ledger',
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

/** Current Merit balance = sum of all ledger deltas (double-entry reconciles). */
async function balanceOf(db, user) {
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

async function appendLedger(db, row) {
	const rows = await db.collection(COLLECTIONS.LEDGER).find({ user: row.user }).toArray();
	const balance_before = rows.reduce((s, r) => s + (Number(r.delta) || 0), 0);
	const entry = {
		id: `led_${row.user}_${rows.length}`, // stable per-user sequence (append-only)
		user: row.user,
		delta: row.delta,
		reason: row.reason,
		ref: row.ref || null,
		balance_after: balance_before + row.delta,
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

	// Anti-sybil daily emission cap on system-funded rewards (privileged
	// admin_adjust is exempt).
	if (reason !== 'admin_adjust') {
		const cap = params.dailyCap || DEFAULT_DAILY_EMISSION_CAP;
		const already = await emittedOn(db, user, at);
		if (already + Number(amount) > cap) {
			const room = Math.max(0, cap - already);
			const requested = Number(amount);
			// Emit up to the cap; report the dropped remainder so the caller can log/carry-over.
			if (room <= 0) return { ok: false, capped: true, reason: 'daily emission cap reached', requested, emitted: 0, dropped: requested };
			const entry = await appendLedger(db, { user, delta: room, reason, ref, at });
			return { ok: true, entry, capped: true, requested, emitted: room, dropped: requested - room };
		}
	}
	const entry = await appendLedger(db, { user, delta: Number(amount), reason, ref, at });
	return { ok: true, entry };
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
	const balance = await balanceOf(db, user);
	if (balance < Number(amount)) return { ok: false, reason: 'insufficient merits' };
	const entry = await appendLedger(db, { user, delta: -Number(amount), reason, ref, at });
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
	if (item.stock !== 'unlimited' && !(Number(item.stock) > 0)) return { ok: false, reason: 'out of stock' };

	// Free items (cost_merits === 0) skip the debit — spend() rejects a 0 amount.
	let ledger = null;
	if (Number(item.cost_merits) > 0) {
		const debit = await spend(db, { user, amount: item.cost_merits, reason: 'shop_purchase', ref: item.id, at });
		if (!debit.ok) return debit;
		ledger = debit.entry;
	}

	if (item.stock !== 'unlimited') {
		await shop.updateOne({ id: item.id }, { $set: { stock: Number(item.stock) - 1 } });
	}
	await db.collection(COLLECTIONS.PURCHASES).insertOne({ user, item_id: item.id, cost_merits: Number(item.cost_merits), at });
	return { ok: true, item_id: item.id, ledger };
}

/** Indexes the ledger/shop rely on. Safe no-op where createIndex is unavailable. */
async function ensureMeritsIndexes(db) {
	const ledger = db.collection(COLLECTIONS.LEDGER);
	const shop = db.collection(COLLECTIONS.SHOP);
	if (typeof ledger.createIndex === 'function') {
		await ledger.createIndex({ user: 1, at: 1 });
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
