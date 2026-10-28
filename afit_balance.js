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

// A token quantity as Hive-Engine writes it: plain decimal digits, at most 8 decimals
// (the engine's maximum precision). No sign, exponent, hex, spaces or empty parts, which
// Number() would otherwise accept ("1e5", "0x10", " 5").
const TOKEN_QUANTITY = /^\d+(\.\d{1,8})?$/;

/** A deposit quantity (string as the engine sends it, or a finite number) > 0, or null. */
function depositQuantity(value) {
	if (typeof value === 'string') return TOKEN_QUANTITY.test(value) ? positiveAmount(value) : null;
	if (typeof value === 'number') return positiveAmount(value);
	return null;
}

/**
 * Why a Hive-Engine account-history entry is NOT a creditable AFIT deposit, or null when it
 * is. A deposit is a plain `tokens_transfer` of AFIT, from the user being credited, to the
 * Actifit receiving account, with a transaction id and a well-formed positive quantity.
 * Anything else that shows up in that account's history (stakes, delegations, transfers to
 * other accounts, other tokens, outgoing transfers) is not credited.
 *
 * @param {object} entry   one row of the engine's accountHistory
 * @param {object} expect
 * @param {string} expect.receivingAccount  the configured Actifit account; when it is
 *                                          missing or empty every entry is refused
 * @param {string} [expect.user]            the user being credited (must be the sender)
 * @returns {string|null}
 */
function depositError(entry, expect = {}) {
	if (!entry || typeof entry !== 'object') return 'invalid_deposit';
	const receiving = expect.receivingAccount;
	if (typeof receiving !== 'string' || receiving.length === 0) return 'no_receiving_account';
	if (entry.operation !== 'tokens_transfer') return 'not_a_transfer';
	if (entry.symbol !== 'AFIT') return 'not_afit';
	if (entry.to !== receiving) return 'wrong_recipient';
	if (!validUser(entry.from) || entry.from === receiving) return 'invalid_sender';
	if (expect.user !== undefined && entry.from !== expect.user) return 'sender_mismatch';
	const ref = entry.transactionId;
	if (!((typeof ref === 'string' && ref.length > 0) || Number.isFinite(ref))) return 'invalid_deposit';
	if (depositQuantity(entry.quantity) === null) return 'invalid_amount';
	return null;
}

/** The ledger sum of one user's real-number rows (0 when there are none). */
async function ledgerSum(db, user) {
	const agg = await db.collection(LEDGER).aggregate([
		{ $match: { user, token_count: FINITE_AMOUNT } },
		{ $group: { _id: null, total: { $sum: '$token_count' } } },
	]).toArray();
	const n = agg[0] ? finiteAmount(agg[0].total) : null;
	return n === null ? 0 : n;
}

// Two balances are "the same" when they differ only by floating-point noise (the cache is
// built by many $inc, the ledger sum by one $sum, in a different order).
function sameAmount(a, b) {
	if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
	return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

/**
 * The daily rebuild of every cached balance from the ledger, safe while the API is
 * spending and crediting.
 *
 * It used to be one aggregation with `$out: 'user_tokens'`: the ledger was summed (minutes,
 * over the whole ledger) and the result then REPLACED the collection. Any debit or credit
 * that changed a cached balance in the meantime was overwritten with a sum read before it
 * happened - a spend made during the rebuild was undone (the user got the AFIT back), and
 * a deposit could be counted twice or not at all depending on when its ledger row was read.
 *
 * Now nothing is written from the bulk sum itself:
 *   1. sum the ledger per user (one read-only pass, as before);
 *   2. compare each sum with the cached balance; a user whose cache already matches is
 *      left alone (no write, so nothing can be clobbered);
 *   3. for each user that differs (or has no cache row, or a cache row but no ledger rows),
 *      take that user's AFIT lock - the same lock every spend and credit holds - and, under
 *      it, re-sum THAT user's ledger fresh (indexed on user) and $set the result.
 * Step 3 is what makes it safe: the value written is read under the lock, so no spend or
 * credit can be half-done (cache changed but ledger row not yet written, or the reverse)
 * and none can land between the read and the write. The bulk sum in step 1 only decides
 * WHO to look at. A user whose lock stays busy is retried once at the end, then left for
 * the next run (their cache is still kept current by the incremental writes).
 *
 * Writers that only add ledger rows and leave the cache to this rebuild (the daily reward
 * jobs in delegations.js) need no lock: step 3 reads their rows like any other.
 *
 * Never throws for one user's failure (counted in `failed`); rejects only when the ledger
 * or the cache cannot be read at all.
 *
 * @param {object} db
 * @param {object} [opts]
 * @param {number} [opts.lockWaitMs=5000]   per-user lock wait in the main pass
 * @param {number} [opts.retryWaitMs=30000] lock wait for the end-of-run retry of busy users
 * @param {number} [opts.concurrency=8]     users processed in parallel in step 3
 * @param {function} [opts.log]
 * @returns {Promise<{users:number, cached:number, candidates:number, updated:number, busy:string[], failed:number}>}
 */
async function rebuildCachedBalances(db, opts = {}) {
	const lockWaitMs = Number.isFinite(opts.lockWaitMs) ? opts.lockWaitMs : 5000;
	const retryWaitMs = Number.isFinite(opts.retryWaitMs) ? opts.retryWaitMs : 30000;
	const concurrency = Number.isInteger(opts.concurrency) && opts.concurrency > 0 ? opts.concurrency : 8;
	const say = (m) => { try { (opts.log || logLoud)(m); } catch (_) { /* logging must not throw */ } };

	// 1. ledger sums - read only
	const sums = new Map();
	const agg = db.collection(LEDGER).aggregate([
		{ $match: { token_count: FINITE_AMOUNT } },
		{ $group: { _id: '$user', tokens: { $sum: '$token_count' } } },
	], { allowDiskUse: true });
	for await (const row of agg) {
		if (validUser(row._id)) sums.set(row._id, row.tokens);
	}

	// 2. compare with the cache
	const candidates = [];
	let cached = 0;
	const seen = new Set();
	for await (const doc of db.collection(BALANCES).find({}, { projection: { tokens: 1 } })) {
		if (!validUser(doc._id)) continue;
		cached += 1;
		seen.add(doc._id);
		const expected = sums.has(doc._id) ? sums.get(doc._id) : 0;
		// only a stored NUMBER counts as matching: a numeric string is rewritten as a number
		// (debitAfit's conditional update never matches a string balance)
		if (typeof doc.tokens !== 'number' || !sameAmount(doc.tokens, expected)) candidates.push(doc._id);
	}
	for (const [user, tokens] of sums) {
		if (!seen.has(user) && !sameAmount(tokens, 0)) candidates.push(user);
	}

	// 3. fix each differing user under their lock, from a fresh read
	let updated = 0;
	let failed = 0;
	const fixOne = async (user, waitMs) => {
		let lock;
		try {
			lock = await acquireAfitLock(db, user, { waitMs });
		} catch (err) {
			failed += 1;
			say('balance rebuild: lock error for ' + user + ' - ' + (err && err.message));
			return 'failed';
		}
		if (!lock) return 'busy';
		try {
			const tokens = await ledgerSum(db, user);
			// $set only the balance (other fields of the document are kept), like /recalculateUserTokens
			await db.collection(BALANCES).updateOne({ _id: user }, { $set: { tokens, user } }, { upsert: true });
			updated += 1;
			return 'done';
		} catch (err) {
			failed += 1;
			say('balance rebuild: could not rebuild ' + user + ' - ' + (err && err.message));
			return 'failed';
		} finally {
			await lock.release();
		}
	};
	const runAll = async (users, waitMs) => {
		const busy = [];
		let next = 0;
		const worker = async () => {
			while (next < users.length) {
				const user = users[next++];
				if ((await fixOne(user, waitMs)) === 'busy') busy.push(user);
			}
		};
		await Promise.all(Array.from({ length: Math.min(concurrency, users.length) }, worker));
		return busy;
	};
	let busy = await runAll(candidates, lockWaitMs);
	if (busy.length) busy = await runAll(busy, retryWaitMs);
	if (busy.length) say('balance rebuild: AFIT lock stayed busy for ' + busy.length + ' user(s), left for the next run: ' + busy.join(', '));
	return { users: sums.size, cached, candidates: candidates.length, updated, busy, failed };
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

// verified_tx is the replay guard for signed on-chain payments (utils.findVerifyTrx): one row
// per chain transaction. Without a unique index two requests racing with the same
// transaction can both pass the "already used?" lookup and both be stored. PARTIAL on a
// string tx_id so rows without one (older broadcast results) are left out. Like the ledger
// indexes it is NOT built at startup - see scripts/build_ledger_indexes.md.
const VERIFIED_TX = 'verified_tx';
const VERIFIED_TX_INDEX = {
	key: { tx_id: 1 },
	options: { name: 'verified_tx_unique', unique: true, partialFilterExpression: { tx_id: { $type: 'string' } } },
};

async function indexesOf(db, name) {
	const col = db.collection(name);
	if (!col || typeof col.indexes !== 'function') return null;
	try {
		return await col.indexes();
	} catch (err) {
		// a collection that does not exist yet has no indexes
		if (err && (err.code === 26 || /ns does not exist|NamespaceNotFound/i.test(String(err.message)))) return [];
		throw err;
	}
}

/**
 * Startup check. NEVER builds the ledger or verified_tx indexes and NEVER rejects: it lists
 * their indexes and logs a loud warning for each one that is missing. It does create the
 * TTL index on the small request_locks collection.
 * @returns {Promise<{name: string, present: boolean}[]>}  the checked indexes' status
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
	try {
		const ledgerIdx = await indexesOf(db, LEDGER);
		if (ledgerIdx) {
			const names = ledgerIdx.map((i) => i.name);
			for (const idx of LEDGER_INDEXES) {
				const present = names.includes(idx.options.name);
				if (!present) {
					say('!!! token_transactions index ' + idx.options.name + ' is MISSING: the database-level double-credit guard for these rows is not in place (the code-level check still applies). Build it off-peak - see scripts/build_ledger_indexes.md.');
				}
				out.push({ name: idx.options.name, present });
			}
		}
	} catch (err) {
		say('could not list token_transactions indexes: ' + ((err && err.message) || err));
	}
	try {
		const txIdx = await indexesOf(db, VERIFIED_TX);
		if (txIdx) {
			// any unique index on exactly {tx_id: 1} does the job, whatever its name
			const present = txIdx.some((i) => i.unique === true && i.key && Object.keys(i.key).length === 1 && i.key.tx_id === 1);
			if (!present) {
				say('!!! verified_tx unique index on tx_id is MISSING: two requests racing with the same signed transaction can both be accepted (the lookup check still applies). Build it off-peak - see scripts/build_ledger_indexes.md.');
			}
			out.push({ name: VERIFIED_TX_INDEX.options.name, present });
		}
	} catch (err) {
		say('could not list verified_tx indexes: ' + ((err && err.message) || err));
	}
	return out;
}

/** Build the ledger indexes (ops procedure / tests - NOT called at startup). Rejects on failure. */
async function createLedgerIndexes(db) {
	for (const idx of LEDGER_INDEXES) await db.collection(LEDGER).createIndex(idx.key, idx.options);
}

/** Build the verified_tx unique index (ops procedure / tests - NOT called at startup). Rejects on failure. */
async function createVerifiedTxIndex(db) {
	await db.collection(VERIFIED_TX).createIndex(VERIFIED_TX_INDEX.key, VERIFIED_TX_INDEX.options);
}

module.exports = {
	LEDGER_INDEXES,
	WEB_REWARD_UNIQUE_FROM,
	REQUEST_LOCKS_TTL,
	ensureLedgerIndexes,
	createLedgerIndexes,
	VERIFIED_TX_INDEX,
	createVerifiedTxIndex,
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
	depositQuantity,
	depositError,
	rebuildCachedBalances,
};
