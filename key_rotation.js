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
 * @param {string} loginPubKey  the public posting key the user just proved
 * @param {Date} since  keys in effect at this moment are treated as exposed
 * @returns {{allowed: boolean, reason: string}}
 */
function decideRotation(history, username, loginPubKey, since) {
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
	if (lastBefore.keys.includes(loginPubKey)) return { allowed: false, reason: 'old_key' };
	return { allowed: true, reason: 'rotated' };
}

/**
 * @param {object} hiveClient  dhive Client
 * @param {string} username
 * @param {string} loginPubKey
 * @param {Date} since
 * @returns {Promise<{allowed: boolean, reason: string}>}  reason 'chain_error' when the
 *          history could not be read in time; callers must treat that as not allowed.
 */
async function checkRotation(hiveClient, username, loginPubKey, since) {
	let timer;
	const deadline = new Promise((resolve) => {
		timer = setTimeout(() => resolve('timeout'), DEADLINE_MS);
	});
	try {
		const history = await Promise.race([fetchHistory(hiveClient, username, since), deadline]);
		if (history === 'timeout') throw new Error('timed out after ' + DEADLINE_MS + 'ms');
		return decideRotation(history, username, loginPubKey, since);
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

const KEY_ROTATION_MESSAGE = 'As a security precaution, please change your Hive posting key. '
	+ 'Use your master password or owner key only on a trusted wallet such as PeakD or Hive Keychain, and never share your keys. '
	+ 'Some account actions are paused until your posting key has been changed.';
const TRY_AGAIN_MESSAGE = 'We could not complete a security check. Please try again shortly.';
const CACHE_MS = 10 * 60 * 1000;

/**
 * @param {object} deps
 * @param {() => object} deps.getCollection  the key_rotation_required collection
 * @param {(username: string) => Promise<object|null>} deps.getAccount  chain account
 * @param {(username, loginPubKey, since) => Promise<{allowed, reason}>} deps.checkRotation
 */
function createTracker({ getCollection, getAccount, checkRotation: check, now = Date.now }) {
	const cache = new Map(); // user -> { at, reason } while not yet rotated

	// { flagged:false } | { flagged:true, rotated:true } | { flagged:true, rotated:false, reason }
	async function status(username, account) {
		const flag = await getCollection().findOne({ user: username });
		if (!flag) return { flagged: false };
		if (!(flag.since instanceof Date) || isNaN(flag.since.getTime())) return { flagged: true, rotated: false, reason: 'bad_flag' };
		const cached = cache.get(username);
		if (cached && now() - cached.at < CACHE_MS) return { flagged: true, rotated: false, reason: cached.reason };
		if (!account) account = await getAccount(username);
		if (!account || !account.posting || !Array.isArray(account.posting.key_auths) || !account.posting.key_auths.length) {
			return { flagged: true, rotated: false, reason: 'chain_error' };
		}
		// login verifies the first posting key (utils.validateAccountLogin)
		const result = await check(username, account.posting.key_auths[0][0], flag.since);
		if (result.allowed) {
			await getCollection().deleteOne({ user: username });
			cache.delete(username);
			return { flagged: true, rotated: true };
		}
		if (result.reason !== 'chain_error') cache.set(username, { at: now(), reason: result.reason });
		return { flagged: true, rotated: false, reason: result.reason };
	}

	// Express middleware, used after checkHdrs. Fails closed.
	async function gate(req, res, next) {
		const username = req.user && req.user._id;
		let st;
		try {
			st = await status(username);
		} catch (err) {
			console.log('key rotation status failed for ' + username + ' - ' + (err && err.message ? err.message : err));
			st = { flagged: true, rotated: false, reason: 'chain_error' };
		}
		if (!st.flagged || st.rotated) return next();
		if (st.reason === 'chain_error') {
			return res.status(503).json({ success: false, code: 'TRY_AGAIN', error: TRY_AGAIN_MESSAGE, message: TRY_AGAIN_MESSAGE });
		}
		return res.status(403).json({ success: false, code: 'KEY_ROTATION_REQUIRED', error: KEY_ROTATION_MESSAGE, message: KEY_ROTATION_MESSAGE });
	}

	return { status, gate };
}

module.exports = { decideRotation, checkRotation, createTracker, KEY_ROTATION_MESSAGE, HISTORY_FILTER_LOW, POSTING_AUTHORITY_OPS };
