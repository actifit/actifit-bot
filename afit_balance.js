/**
 * Off-chain AFIT balance writes, safe under concurrency.
 *
 * Data model:
 *   - `token_transactions` is the ledger and the source of truth. Each row's
 *     `token_count` is a signed amount; a user's balance is the $sum of their rows.
 *   - `user_tokens` ({_id: user, user, tokens}) is a cached balance that the app
 *     reads for every "enough AFIT" check. delegations.updateUserTokens rebuilds it
 *     from the ledger every day.
 *
 * The old pattern everywhere was read balance -> check in JS -> replaceOne the whole
 * document with the new number. Two concurrent requests both pass the check against
 * the same balance and both write their own result back: the balance is spent twice,
 * and any credit that landed in between is overwritten. These helpers replace that
 * with single-document atomic updates:
 *
 *   debitAfit  - take the AFIT first with ONE conditional $inc that only matches while
 *                the stored balance still covers it, then write the ledger row. If the
 *                ledger write fails the AFIT is given back.
 *   creditAfit - write the ledger row first (optionally de-duplicated by a key, so a
 *                repeated call credits once), then $inc the cached balance.
 *
 * Neither helper can make the cache and the ledger change together (no transactions),
 * so anything that REBUILDS a balance from the ledger (/recalculateUserTokens, arena
 * reconcileBalance) must not run in the middle of one of these. acquireLock below is
 * the per-user lock those paths share with the spenders: key AFIT_LOCK + ':' + user.
 *
 * Load-time safe: requires nothing from config or Firebase; the db is injected.
 */

'use strict';

const crypto = require('crypto');

const LEDGER = 'token_transactions';
const BALANCES = 'user_tokens';
const LOCKS = 'request_locks';

// The shared per-user lock action for every path that writes a user's AFIT balance.
const AFIT_LOCK = 'afit';
// A lock older than this is from a crashed request and may be replaced.
const LOCK_STALE_MS = 2 * 60 * 1000;

// Query filter for a token_count that is a real number. Used before every SUM of
// token_count: a NaN (or a string) in one row would otherwise make the user's whole
// balance NaN. Range-matching numbers excludes NaN, non-numeric types and missing values
// (verified against a real MongoDB in tests/afit_amounts.test.js).
const FINITE_AMOUNT = { $gte: -Number.MAX_VALUE, $lte: Number.MAX_VALUE };

// An AFIT amount from a request or a stored balance, as a real number - or null when it
// is missing, empty, NaN, Infinity or not numeric. The ONE rule for "is this an amount",
// so a NaN can never pass a balance check (NaN < x is false) or be written to the ledger.
function finiteAmount(value) {
	if (typeof value !== 'number' && typeof value !== 'string') return null;   // not true, [5], {}
	if (typeof value === 'string' && value.trim() === '') return null;
	const n = Number(value);
	return Number.isFinite(n) ? n : null;
}

/** A strictly positive finite amount, or null. */
function positiveAmount(value) {
	const n = finiteAmount(value);
	return n !== null && n > 0 ? n : null;
}

function isDuplicateKeyError(e) {
	return !!e && (e.code === 11000 || e.code === 11001 || /E11000/.test(String(e && e.message)));
}

function validUser(user) {
	return typeof user === 'string' && user.length > 0;
}

function logLoud(msg) {
	try { console.log('[afit_balance] ' + msg); } catch (_) { /* logging must not throw */ }
}

/** The cached balance as a number (0 when missing or not a real number). */
async function readBalance(db, user) {
	const doc = await db.collection(BALANCES).findOne({ _id: user });
	const n = doc ? finiteAmount(doc.tokens) : null;
	return n === null ? 0 : n;
}

/**
 * Put `amount` back on the cached balance. Used to undo a debit whose ledger row was
 * never written (or has been removed). Never throws; returns true when it worked.
 */
async function restoreAfit(db, user, amount, context) {
	const amt = positiveAmount(amount);
	if (!validUser(user) || amt === null) return false;
	try {
		await db.collection(BALANCES).updateOne({ _id: user }, { $inc: { tokens: amt } });
		return true;
	} catch (err) {
		logLoud('REFUND FAILED (manual fix needed) for ' + user + ' ' + amt + ' AFIT' + (context ? ' [' + context + ']' : '') + ' - ' + (err && err.message));
		return false;
	}
}

/**
 * Take `amount` AFIT from `user`, atomically.
 *
 * @param {object} db
 * @param {string} user
 * @param {number|string} amount  must be a finite number > 0
 * @param {object} [opts]
 * @param {number} [opts.minBalance=0]  the balance must be >= max(minBalance, amount)
 *                                      at the instant of the debit
 * @param {object} [opts.ledgerRow]     ledger row to insert after the debit; `user`
 *                                      and `token_count` (= -amount) are set here.
 *                                      Without it only the cache is debited (the caller
 *                                      writes its own rows, e.g. one per item).
 * @param {boolean} [opts.allowNegative] admin claw-back only: take the amount even if the
 *                                      balance goes negative (the user's balance row must
 *                                      exist; minBalance is ignored)
 * @param {string} [opts.context]       label for log lines
 * @returns {Promise<{ok:true, amount, balance, ledgerId}|{ok:false, reason, error?}>}
 *          reason: 'invalid_amount' | 'insufficient_funds' | 'ledger_failed'
 */
async function debitAfit(db, user, amount, opts = {}) {
	const amt = positiveAmount(amount);
	if (!validUser(user) || amt === null) return { ok: false, reason: 'invalid_amount' };
	const minBalance = opts.minBalance === undefined || opts.minBalance === null ? 0 : finiteAmount(opts.minBalance);
	if (minBalance === null) return { ok: false, reason: 'invalid_amount' };

	// Matches only while the stored balance is a number >= the floor, so a NaN or
	// string balance never matches (MongoDB type bracketing) and fails closed.
	const filter = opts.allowNegative ? { _id: user } : { _id: user, tokens: { $gte: Math.max(minBalance, amt) } };
	const taken = await db.collection(BALANCES).updateOne(filter, { $inc: { tokens: -amt } });
	if (!taken || taken.matchedCount !== 1) return { ok: false, reason: 'insufficient_funds' };

	let ledgerId = null;
	if (opts.ledgerRow) {
		const row = Object.assign({}, opts.ledgerRow, { user, token_count: -amt });
		if (!row.date) row.date = new Date();
		try {
			const r = await db.collection(LEDGER).insertOne(row);
			ledgerId = r && r.insertedId;
		} catch (err) {
			logLoud('debit ledger write failed for ' + user + ' ' + amt + ' AFIT' + (opts.context ? ' [' + opts.context + ']' : '') + ' - ' + (err && err.message) + '; giving the AFIT back');
			await restoreAfit(db, user, amt, opts.context);
			return { ok: false, reason: 'ledger_failed', error: err };
		}
	}
	let balance = null;
	try { balance = await readBalance(db, user); } catch (_) { /* display only */ }
	return { ok: true, amount: amt, balance, ledgerId };
}

/**
 * Undo a successful debitAfit: remove its ledger row (if it wrote one) and give the
 * AFIT back. Never throws; logs loudly when a step fails.
 */
async function undoDebit(db, user, debit, context) {
	if (!debit || !debit.ok) return false;
	let ok = true;
	if (debit.ledgerId) {
		try {
			await db.collection(LEDGER).deleteOne({ _id: debit.ledgerId });
		} catch (err) {
			// this orphan row would charge the user at the next daily rebuild
			logLoud('LEDGER ROW NOT REMOVED (manual fix needed) for ' + user + ' token_transactions _id ' + debit.ledgerId + (context ? ' [' + context + ']' : '') + ' - ' + (err && err.message));
			ok = false;
		}
	}
	return (await restoreAfit(db, user, debit.amount, context)) && ok;
}

/**
 * Give `amount` AFIT to `user`: ledger row first, then the cached balance.
 *
 * @param {object} db
 * @param {string} user
 * @param {number|string} amount  must be a finite number > 0
 * @param {object} ledgerRow      `user` and `token_count` (= amount) are set here
 * @param {object} [opts]
 * @param {object} [opts.dedupe]  a filter identifying this credit (e.g. {user, se_trx_ref}).
 *                                The row is only written when no row matches it, and a
 *                                repeated or concurrent call is reported as a duplicate and
 *                                does NOT touch the balance. Back it with a unique index:
 *                                without one, two truly simultaneous upserts can both insert.
 * @param {string} [opts.context] label for log lines
 * @returns {Promise<{ok:true, amount, balance, ledgerId, balanceUpdated}|{ok:false, reason, duplicate?, error?}>}
 *          reason: 'invalid_amount' | 'already_credited' | 'ledger_failed'
 */
async function creditAfit(db, user, amount, ledgerRow, opts = {}) {
	const amt = positiveAmount(amount);
	if (!validUser(user) || amt === null) return { ok: false, reason: 'invalid_amount' };
	const row = Object.assign({}, ledgerRow || {}, { user, token_count: amt });
	if (!row.date) row.date = new Date();

	let ledgerId = null;
	try {
		if (opts.dedupe) {
			const r = await db.collection(LEDGER).updateOne(opts.dedupe, { $setOnInsert: row }, { upsert: true });
			if (!r || r.upsertedCount !== 1) return { ok: false, duplicate: true, reason: 'already_credited' };
			ledgerId = r.upsertedId || null;
		} else {
			const r = await db.collection(LEDGER).insertOne(row);
			ledgerId = r && r.insertedId;
		}
	} catch (err) {
		if (isDuplicateKeyError(err)) return { ok: false, duplicate: true, reason: 'already_credited' };
		return { ok: false, reason: 'ledger_failed', error: err };
	}

	try {
		await db.collection(BALANCES).updateOne(
			{ _id: user },
			{ $inc: { tokens: amt }, $setOnInsert: { user } },
			{ upsert: true }
		);
	} catch (err) {
		// The ledger row stands (it is the truth), so the daily rebuild will show the
		// credit; only the cached balance is behind until then.
		logLoud('credit recorded but cached balance NOT updated for ' + user + ' ' + amt + ' AFIT' + (opts.context ? ' [' + opts.context + ']' : '') + ' - ' + (err && err.message));
		return { ok: true, amount: amt, balance: null, ledgerId, balanceUpdated: false };
	}
	let balance = null;
	try { balance = await readBalance(db, user); } catch (_) { /* display only */ }
	return { ok: true, amount: amt, balance, ledgerId, balanceUpdated: true };
}

/**
 * One holder at a time per key: insertOne on a fixed _id is atomic, so a second
 * concurrent caller gets a duplicate-key error. A lock older than LOCK_STALE_MS is
 * from a crashed request and is replaced. `owner` stops a request that outlived the
 * stale window (its lock taken over by a newer one) from deleting the newer lock.
 *
 * @param {object} db
 * @param {string} key          e.g. AFIT_LOCK + ':' + user
 * @param {object} [opts]
 * @param {number} [opts.waitMs=0]  keep retrying for up to this long before giving up
 * @param {number} [opts.pollMs=100]
 * @returns {Promise<{release: function(): Promise}|null>}  null when the lock is busy
 */
async function acquireLock(db, key, opts = {}) {
	const col = db.collection(LOCKS);
	const waitMs = Number.isFinite(opts.waitMs) ? opts.waitMs : 0;
	const pollMs = Number.isFinite(opts.pollMs) ? opts.pollMs : 100;
	const deadline = Date.now() + waitMs;
	const owner = crypto.randomBytes(12).toString('hex');
	for (;;) {
		await col.deleteOne({ _id: key, at: { $lt: new Date(Date.now() - LOCK_STALE_MS) } });
		try {
			await col.insertOne({ _id: key, owner, at: new Date() });
			return {
				release: () => col.deleteOne({ _id: key, owner })
					.catch((err) => logLoud('lock release failed for ' + key + ' - ' + (err && err.message))),
			};
		} catch (err) {
			if (!isDuplicateKeyError(err)) throw err;
		}
		if (Date.now() + pollMs > deadline) return null;
		await new Promise((r) => setTimeout(r, pollMs));
	}
}

/** The shared per-user AFIT lock. */
function acquireAfitLock(db, user, opts) {
	return acquireLock(db, AFIT_LOCK + ':' + user, opts);
}

/**
 * Unique ledger indexes that make credits idempotent at the database level. Both are
 * PARTIAL, so only the rows they are about are indexed and constrained (the ledger is
 * the whole platform's AFIT history, ~23M rows):
 *
 *   afit_deposit_unique     {user, se_trx_ref}                  rows with a string se_trx_ref
 *                           (Hive-Engine deposits into the Actifit wallet: one credit per
 *                           chain transaction, however many requests race for it)
 *   afit_web_reward_unique  {user, reward_activity, reward_date} rows with reward_date on or
 *                           after WEB_REWARD_UNIQUE_FROM (web vote/edit/comment rewards: one
 *                           per activity per day). Older rows are left out on purpose: the
 *                           ledger has historical duplicates from before the per-user lock,
 *                           long since spent, which are kept as they are.
 *
 * The filters use $type rather than $exists so a stray `field: null` in some other
 * writer cannot drag ordinary rows into a unique index (see arena_afit.ensureAfitIndexes).
 *
 * These are NOT built at startup: even a partial index has to examine every ledger
 * document, which is real IO on the primary. They are created by hand, off-peak, after a
 * duplicate check - see scripts/build_ledger_indexes.md (createLedgerIndexes below runs
 * the same definitions, for that procedure and the tests).
 *
 * Without them the code-level de-duplication still holds for the paths that use it: the
 * deposit credit runs under the per-user AFIT lock with an upsert keyed on
 * {user, se_trx_ref}, and the web reward under the same lock with an upsert keyed on
 * {user, reward_activity, reward_date}, so concurrent requests for one user are
 * serialised and the second finds the row. The indexes are the database-level backstop.
 */
// $gte on a Date only matches dates, so it also keeps null / non-date values out.
const WEB_REWARD_UNIQUE_FROM = new Date('2026-10-29T00:00:00Z');

const LEDGER_INDEXES = [
	{
		key: { user: 1, se_trx_ref: 1 },
		options: { name: 'afit_deposit_unique', unique: true, partialFilterExpression: { se_trx_ref: { $type: 'string' } } },
	},
	{
		key: { user: 1, reward_activity: 1, reward_date: 1 },
		options: { name: 'afit_web_reward_unique', unique: true, partialFilterExpression: { reward_date: { $gte: WEB_REWARD_UNIQUE_FROM } } },
	},
];

// Stale request locks are already replaced after LOCK_STALE_MS; this only sweeps leftovers
// from crashed requests. request_locks is tiny, so building it at startup is cheap.
const REQUEST_LOCKS_TTL = { key: { at: 1 }, options: { name: 'request_locks_ttl', expireAfterSeconds: 3600 } };

/**
 * Startup check. NEVER builds the ledger indexes and NEVER rejects: it lists the ledger's
 * indexes and logs a loud warning for each one that is missing. It does create the TTL
 * index on the small request_locks collection.
 * @returns {Promise<{name: string, present: boolean}[]>}  the ledger indexes' status
 */
async function ensureLedgerIndexes(db, log) {
	const out = [];
	const say = (m) => { try { (log || console.log)(m); } catch (_) { /* logging must not throw */ } };
	try {
		const locks = db.collection(LOCKS);
		if (locks && typeof locks.createIndex === 'function') await locks.createIndex(REQUEST_LOCKS_TTL.key, REQUEST_LOCKS_TTL.options);
	} catch (err) {
		say('request_locks TTL index not created: ' + ((err && err.message) || err));
	}
	let names;
	try {
		const ledger = db.collection(LEDGER);
		if (!ledger || typeof ledger.indexes !== 'function') return out;
		names = (await ledger.indexes()).map((i) => i.name);
	} catch (err) {
		say('could not list token_transactions indexes: ' + ((err && err.message) || err));
		return out;
	}
	for (const idx of LEDGER_INDEXES) {
		const present = names.includes(idx.options.name);
		if (!present) {
			say('!!! token_transactions index ' + idx.options.name + ' is MISSING: the database-level double-credit guard for these rows is not in place (the code-level check still applies). Build it off-peak - see scripts/build_ledger_indexes.md.');
		}
		out.push({ name: idx.options.name, present });
	}
	return out;
}

/** Build the ledger indexes (ops procedure / tests - NOT called at startup). Rejects on failure. */
async function createLedgerIndexes(db) {
	for (const idx of LEDGER_INDEXES) await db.collection(LEDGER).createIndex(idx.key, idx.options);
}

module.exports = {
	LEDGER_INDEXES,
	WEB_REWARD_UNIQUE_FROM,
	REQUEST_LOCKS_TTL,
	ensureLedgerIndexes,
	createLedgerIndexes,
	LEDGER,
	BALANCES,
	AFIT_LOCK,
	LOCK_STALE_MS,
	FINITE_AMOUNT,
	finiteAmount,
	positiveAmount,
	isDuplicateKeyError,
	readBalance,
	debitAfit,
	undoDebit,
	restoreAfit,
	creditAfit,
	acquireLock,
	acquireAfitLock,
};
