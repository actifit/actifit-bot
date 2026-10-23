/**
 * Posting-key rotation check for accounts flagged in the `key_rotation_required`
 * collection.
 *
 * A flagged account may have had its posting key exposed. It keeps using the service,
 * is shown a notice at login, and actions guarded by the gate wait until its current
 * posting key is one it did NOT have at the flag's `since` date. Changing a posting key
 * needs the active or owner key, so this cannot be satisfied with the old key alone.
 *
 * `decideRotation` is pure; `checkRotation` fetches the account's authority-changing
 * operations from the chain; `createTracker` adds the flag lookup, caching and the
 * Express middleware.
 */

const crypto = require('crypto');

// Hive operation ids that set an account's posting authority.
const POSTING_AUTHORITY_OPS = {
	account_create: 9,
	account_update: 10,
	create_claimed_account: 23,
	account_create_with_delegation: 41,
	account_update2: 43,
};

// operation_filter_low for get_account_history (all ids are < 64). Each bit is a
// power of two below 2^53, so the sum is exact as a Number.
const HISTORY_FILTER_LOW = Object.values(POSTING_AUTHORITY_OPS)
	.reduce((mask, id) => mask + Math.pow(2, id), 0);

const PAGE_LIMIT = 1000;
// Accounts rarely have more than a handful of these operations; this caps the walk
// for a pathological account rather than looping on the chain indefinitely.
const MAX_PAGES = 10;
// Overall deadline for the history walk; a slow node must not hold a login open.
const DEADLINE_MS = 15000;

// Chain timestamps are UTC without a zone suffix.
function chainTime(ts) {
	return new Date(String(ts).endsWith('Z') ? ts : ts + 'Z');
}

// Posting keys an operation sets FOR `username`. An account's history also holds
// accounts it created for others; those set the new account's keys, not its own.
function ownPostingKeys(type, op, username) {
	if (!(type in POSTING_AUTHORITY_OPS)) return null;
	if (!op || (op.account || op.new_account_name) !== username) return null;
	if (!op.posting || !Array.isArray(op.posting.key_auths)) return null;
	return op.posting.key_auths.map((ka) => ka[0]);
}

/**
 * @param {Array} history  [index, {timestamp, op: [type, payload]}] entries, any order,
 *                         limited to (or containing) posting-authority operations
 * @param {string} username
 * @param {string|string[]} currentKeys  the account's current posting key(s); none of
 *                                       them may be a key it held at `since`
 * @param {Date} since  keys in effect at this moment are treated as exposed
 * @returns {{allowed: boolean, reason: string}}
 */
function decideRotation(history, username, currentKeys, since) {
	let lastBefore = null; // latest posting authority set at or before `since`
	let changedAfter = false;
	for (const [, entry] of history || []) {
		if (!entry || !Array.isArray(entry.op)) continue;
		const [type, payload] = entry.op;
		// skips other ops, accounts created for others, and updates that left posting unchanged
		const keys = ownPostingKeys(type, payload, username);
		if (!keys) continue;
		const at = chainTime(entry.timestamp);
		if (isNaN(at.getTime())) continue;
		if (at > since) {
			changedAfter = true;
		} else if (!lastBefore || at >= lastBefore.at) {
			lastBefore = { at, keys };
		}
	}
	if (!changedAfter) return { allowed: false, reason: 'not_rotated' };
	// The posting authority changed, but the key used may have been kept. Without
	// the earlier key set we cannot tell, so refuse rather than guess.
	if (!lastBefore) return { allowed: false, reason: 'unknown_prior_keys' };
	const keys = Array.isArray(currentKeys) ? currentKeys : [currentKeys];
	if (!keys.length || keys.some((k) => lastBefore.keys.includes(k))) return { allowed: false, reason: 'old_key' };
	return { allowed: true, reason: 'rotated' };
}

/**
 * @param {object} hiveClient  dhive Client
 * @param {string} username
 * @param {string|string[]} currentKeys
 * @param {Date} since
 * @returns {Promise<{allowed: boolean, reason: string}>}  reason 'chain_error' when the
 *          history could not be read in time; callers must treat that as not allowed.
 */
async function checkRotation(hiveClient, username, currentKeys, since) {
	let timer;
	const deadline = new Promise((resolve) => {
		timer = setTimeout(() => resolve('timeout'), DEADLINE_MS);
	});
	try {
		const history = await Promise.race([fetchHistory(hiveClient, username, since), deadline]);
		if (history === 'timeout') throw new Error('timed out after ' + DEADLINE_MS + 'ms');
		return decideRotation(history, username, currentKeys, since);
	} catch (err) {
		console.log('key rotation check failed for ' + username + ' - ' + (err && err.message ? err.message : err));
		return { allowed: false, reason: 'chain_error' };
	} finally {
		clearTimeout(timer);
	}
}

async function fetchHistory(hiveClient, username, since) {
	const history = [];
	let start = -1;
	for (let page = 0; page < MAX_PAGES; page++) {
		// with a filter, hived needs start >= limit - 1
		const limit = start === -1 ? PAGE_LIMIT : Math.min(PAGE_LIMIT, start + 1);
		const res = await hiveClient.database.call('get_account_history',
			[username, start, limit, HISTORY_FILTER_LOW, 0]);
		if (!Array.isArray(res) || !res.length) break;
		history.push(...res);
		const oldest = res.reduce((min, e) => Math.min(min, e[0]), Infinity);
		if (res.length < limit || oldest <= 0) break;
		// a page reaching back before `since` already holds the prior key set
		if (res.some((e) => e[1] && Array.isArray(e[1].op) && chainTime(e[1].timestamp) <= since
			&& ownPostingKeys(e[1].op[0], e[1].op[1], username))) break;
		start = oldest - 1;
	}
	return history;
}

const KEY_ROTATION_MESSAGE = 'As a security precaution, please change your Hive password (this replaces your posting key), then log in to Actifit again with the new key. '
	+ 'You can do it at https://actifit.io/password (the change happens in your browser; your password is never sent to Actifit) '
	+ 'or at https://wallet.hive.blog. Never enter your master password anywhere else, and never share your keys. '
	+ 'Some account actions are paused until then.';
const TRY_AGAIN_MESSAGE = 'We could not complete a security check. Please try again shortly.';
const LOGIN_AGAIN_MESSAGE = 'Your posting key has changed. Please log in again with your new key.';
const HOLD_MESSAGE = 'This action is briefly unavailable after a posting key change. Please try again later.';
const CACHE_MS = 10 * 60 * 1000;
const ERROR_CACHE_MS = 30 * 1000;
// After a flag is cleared, sessions issued before the clearing login stay refused for
// the session lifetime (24h JWT), and posting-signed transactions for long enough that
// any signed with the old key have expired (Hive allows up to 1h) and aged out, with margin.
const SESSION_HOLD_MS = 25 * 60 * 60 * 1000;
const SIGNED_TX_HOLD_MS = 10 * 60 * 60 * 1000;

function tokenHash(token) {
	return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/**
 * Flag lookup, caching and Express middleware around checkRotation.
 *
 * A flag is only cleared by a login made with the new key: /loginAuth calls
 * `status(..., { fresh: true })`, saves the new session, removes any other session rows
 * and then calls `clear()`. Elsewhere a detected change does not clear the flag, because
 * the caller's session or signed transaction may predate it.
 *
 * Clearing keeps the entry with `cleared_at` and a hash of the clearing session, so that
 * older sessions and posting-signed transactions stay refused for a while afterwards.
 *
 * @param {object} deps
 * @param {() => object} deps.getCollection  the key_rotation_required collection
 * @param {(username: string) => Promise<object|null>} deps.getAccount  chain account
 * @param {(username, currentKeys, since) => Promise<{allowed, reason}>} deps.checkRotation
 * @param {(username: string) => Promise<void>} deps.endSessions  remove the user's sessions
 */
function createTracker({ getCollection, getAccount, checkRotation: check, endSessions, now = Date.now }) {
	const cache = new Map(); // user -> { until, reason } while not rotated (or briefly after a chain error)
	const inFlight = new Map(); // user|key -> pending chain check

	// The entry that applies to a user: any active one wins over a cleared one. An entry
	// whose `since` is later than its clear was re-flagged and is active again.
	async function findFlag(username) {
		const rows = await getCollection().find({ user: username }).toArray();
		const isActive = (r) => !(r.cleared_at instanceof Date)
			|| (r.since instanceof Date && r.since.getTime() > r.cleared_at.getTime());
		const active = rows.find(isActive);
		if (active) return Object.assign({}, active, { cleared_at: undefined, cleared_session: undefined });
		return rows.sort((a, b) => b.cleared_at - a.cleared_at)[0] || null;
	}

	function chainCheck(username, keys, since) {
		const key = username + '|' + keys.join(',') + '|' + since.getTime();
		if (!inFlight.has(key)) {
			inFlight.set(key, Promise.resolve()
				.then(() => check(username, keys, since))
				.finally(() => inFlight.delete(key)));
		}
		return inFlight.get(key);
	}

	// { flagged:false, cleared? } | { flagged:true, rotated:true } | { flagged:true, rotated:false, reason }
	// `fresh` skips the cache (used at login, where a stale answer would keep the flag).
	async function status(username, account, { fresh = false } = {}) {
		const flag = await findFlag(username);
		if (!flag) return { flagged: false };
		if (flag.cleared_at instanceof Date) return { flagged: false, cleared: flag };
		if (!(flag.since instanceof Date) || isNaN(flag.since.getTime())) {
			console.log('key_rotation_required entry for ' + username + ' has no valid Date in `since`');
			return { flagged: true, rotated: false, reason: 'bad_flag' };
		}
		const cached = cache.get(username);
		if (!fresh && cached && now() < cached.until) return { flagged: true, rotated: false, reason: cached.reason };
		if (!account) account = await getAccount(username);
		if (!account || !account.posting || !Array.isArray(account.posting.key_auths) || !account.posting.key_auths.length) {
			return { flagged: true, rotated: false, reason: 'chain_error' };
		}
		// every current posting key must be new, not just the one login verifies
		const keys = account.posting.key_auths.map((ka) => ka[0]);
		const result = await chainCheck(username, keys, flag.since);
		if (result.allowed) {
			cache.delete(username);
			return { flagged: true, rotated: true };
		}
		cache.set(username, { until: now() + (result.reason === 'chain_error' ? ERROR_CACHE_MS : CACHE_MS), reason: result.reason });
		return { flagged: true, rotated: false, reason: result.reason };
	}

	function deny(res, httpStatus, code, msg) {
		return res.status(httpStatus).json({ success: false, code, error: msg, message: msg });
	}

	// For session routes, after checkHdrs. Fails closed.
	async function gate(req, res, next) {
		const username = req.user && req.user._id;
		let st;
		try {
			st = await status(username);
		} catch (err) {
			console.log('key rotation status failed for ' + username + ' - ' + (err && err.message ? err.message : err));
			st = { flagged: true, rotated: false, reason: 'chain_error' };
		}
		if (!st.flagged) {
			const cleared = st.cleared;
			if (cleared && now() - cleared.cleared_at.getTime() < SESSION_HOLD_MS) {
				// only the clearing session, or one issued after it, is trusted
				const issuedAt = req.decoded && Number(req.decoded.iat) * 1000;
				const token = req.query && req.query.token;
				// iat has whole-second precision: a session from the clear's own second counts
				const clearedSecond = Math.floor(cleared.cleared_at.getTime() / 1000) * 1000;
				const ok = (token && tokenHash(token) === cleared.cleared_session) || (issuedAt >= clearedSecond);
				if (!ok) {
					try { await endSessions(username); } catch (err) {
						console.log('key rotation: ending sessions failed for ' + username + ' - ' + (err && err.message ? err.message : err));
					}
					return deny(res, 401, 'LOGIN_AGAIN', LOGIN_AGAIN_MESSAGE);
				}
			}
			return next();
		}
		if (st.rotated) {
			// The key changed, and this session may have been opened with the old one.
			try { await endSessions(username); } catch (err) {
				console.log('key rotation: ending sessions failed for ' + username + ' - ' + (err && err.message ? err.message : err));
			}
			return deny(res, 401, 'LOGIN_AGAIN', LOGIN_AGAIN_MESSAGE);
		}
		if (st.reason === 'chain_error') return deny(res, 503, 'TRY_AGAIN', TRY_AGAIN_MESSAGE);
		return deny(res, 403, 'KEY_ROTATION_REQUIRED', KEY_ROTATION_MESSAGE);
	}

	// For routes authorised by a posting-signed transaction instead of a session. A flagged
	// account is refused outright: the transaction may have been signed with the old key.
	function gateForUser(getUser) {
		return async function (req, res, next) {
			const username = getUser(req);
			if (!username) return next(); // the route rejects the request itself
			let flag;
			try {
				flag = await findFlag(String(username));
			} catch (err) {
				console.log('key rotation flag lookup failed for ' + username + ' - ' + (err && err.message ? err.message : err));
				return deny(res, 503, 'TRY_AGAIN', TRY_AGAIN_MESSAGE);
			}
			if (!flag) return next();
			if (flag.cleared_at instanceof Date) {
				if (now() - flag.cleared_at.getTime() >= SIGNED_TX_HOLD_MS) return next();
				return deny(res, 403, 'KEY_ROTATION_HOLD', HOLD_MESSAGE);
			}
			return deny(res, 403, 'KEY_ROTATION_REQUIRED', KEY_ROTATION_MESSAGE);
		};
	}

	// Called by /loginAuth once the session made with the new key is saved.
	async function clear(username, token) {
		cache.delete(username);
		await getCollection().updateMany({ user: username },
			{ $set: { cleared_at: new Date(now()), cleared_session: tokenHash(token) } });
	}

	// Undo a clear whose session was overwritten before it could be confirmed.
	async function unclear(username) {
		await getCollection().updateMany({ user: username }, { $unset: { cleared_at: '', cleared_session: '' } });
	}

	return { status, gate, gateForUser, clear, unclear };
}

module.exports = { decideRotation, checkRotation, createTracker, KEY_ROTATION_MESSAGE, HISTORY_FILTER_LOW, POSTING_AUTHORITY_OPS };
