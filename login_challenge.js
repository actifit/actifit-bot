/**
 * Signed-challenge login.
 *
 * The server issues a random, single-use nonce. The client signs
 * `actifit-login:<username>:<nonce>` with the account's posting key (Hive Keychain
 * requestSignBuffer, HiveAuth, or locally in the browser/app) and sends back only the
 * signature. The server checks that the signature recovers a key in the account's
 * current posting authority, as read from the chain. The private key never reaches us.
 */

const crypto = require('crypto');
const dhive = require('@hiveio/dhive');

const CHALLENGE_TTL_MS = 2 * 60 * 1000;
const USERNAME_RE = /^[a-z][a-z0-9.-]{2,15}$/;

function loginMessage(username, nonce) {
	return 'actifit-login:' + username + ':' + nonce;
}

function validUsername(username) {
	return typeof username === 'string' && USERNAME_RE.test(username);
}

let ttlIndexReady = null;

/**
 * Store a new nonce for `username` and return what the client must sign.
 * @returns {Promise<{nonce, message, expires_in}>}
 */
async function createChallenge(db, username, now = Date.now) {
	// expired challenges are removed by MongoDB (TTL index), created once per process
	if (!ttlIndexReady) {
		ttlIndexReady = db.collection('login_challenges').createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 })
			.catch((err) => { ttlIndexReady = null; console.log('login_challenges TTL index: ' + (err && err.message ? err.message : err)); });
	}
	const nonce = crypto.randomBytes(32).toString('hex');
	await db.collection('login_challenges').insertOne({
		_id: nonce,
		user: username,
		expires_at: new Date(now() + CHALLENGE_TTL_MS),
		created_at: new Date(now()),
	});
	return { nonce, message: loginMessage(username, nonce), expires_in: Math.floor(CHALLENGE_TTL_MS / 1000) };
}

/**
 * Atomically remove and return the nonce if it belongs to `username` and has not
 * expired. A nonce can be consumed at most once, whatever the outcome of the login.
 * @returns {Promise<boolean>}
 */
async function consumeChallenge(db, username, nonce, now = Date.now) {
	if (typeof nonce !== 'string' || !/^[0-9a-f]{64}$/.test(nonce)) return false;
	const res = await db.collection('login_challenges').findOneAndDelete({
		_id: nonce, user: username, expires_at: { $gt: new Date(now()) },
	});
	// driver 5 returns { value }; driver 6 returns the document itself
	const doc = res && Object.prototype.hasOwnProperty.call(res, 'value') ? res.value : res;
	return !!doc;
}

/**
 * The public key that produced `signatureHex` over `message`, if it is one of the
 * account's current posting keys with enough weight on its own; otherwise null.
 */
function verifyPostingSignature(account, message, signatureHex) {
	if (!account || !account.posting || !Array.isArray(account.posting.key_auths)) return null;
	if (typeof signatureHex !== 'string' || !/^[0-9a-f]{130}$/i.test(signatureHex)) return null;
	let pub;
	try {
		const digest = dhive.cryptoUtils.sha256(Buffer.from(message, 'utf8'));
		pub = dhive.Signature.fromString(signatureHex).recover(digest).toString();
	} catch (err) {
		return null;
	}
	const threshold = Number(account.posting.weight_threshold) || 1;
	const match = account.posting.key_auths.find(([key, weight]) => key === pub && Number(weight) >= threshold);
	return match ? pub : null;
}

const LOGIN_METHODS = ['keychain', 'hiveauth', 'posting'];

/**
 * Express handlers for POST /loginChallenge and POST /loginVerify.
 * @param {object} deps
 * @param {() => object} deps.getDb
 * @param {(username) => Promise<object|null>} deps.getAccount  the Hive account from chain
 * @param {(username) => Promise<boolean>} deps.isDeleted
 * @param {(req, res, username, account, loginsrc) => any} deps.completeLogin  issues the session
 */
function createHandlers({ getDb, getAccount, isDeleted, completeLogin, log = console.log }) {
	async function challenge(req, res) {
		const username = req.body && req.body.username;
		if (!validUsername(username)) {
			return res.status(400).json({ success: false, message: 'Invalid username' });
		}
		try {
			const c = await createChallenge(getDb(), username);
			return res.json(Object.assign({ success: true }, c));
		} catch (err) {
			log('loginChallenge failed for ' + username + ' - ' + (err && err.message ? err.message : err));
			return res.status(503).json({ success: false, message: 'Please try again shortly.' });
		}
	}

	async function verify(req, res) {
		const body = req.body || {};
		const username = body.username;
		const fail = (status, reason, message) => {
			log('loginVerify refused for ' + (validUsername(username) ? username : '(invalid)') + ': ' + reason);
			return res.status(status).json({ success: false, message });
		};
		if (!validUsername(username) || typeof body.nonce !== 'string' || typeof body.signature !== 'string') {
			return fail(400, 'bad request', 'Authentication failed! Please check the request');
		}
		try {
			// the challenge is consumed first, so it can never be tried twice
			if (!(await consumeChallenge(getDb(), username, body.nonce))) {
				return fail(403, 'unknown or expired challenge', 'Login request expired. Please try again.');
			}
			if (await isDeleted(username)) {
				return fail(403, 'deleted account', 'Login failed');
			}
			const account = await getAccount(username);
			if (!account || !account.posting) {
				return fail(503, 'account lookup failed', 'Please try again shortly.');
			}
			if (!verifyPostingSignature(account, loginMessage(username, body.nonce), body.signature)) {
				return fail(403, 'signature does not match a current posting key', 'Login failed');
			}
			const method = LOGIN_METHODS.includes(body.method) ? body.method : 'unknown';
			return await completeLogin(req, res, username, account, 'signed-' + method);
		} catch (err) {
			log('loginVerify error for ' + username + ' - ' + (err && err.message ? err.message : err));
			return res.status(503).json({ success: false, message: 'Please try again shortly.' });
		}
	}

	return { challenge, verify };
}

module.exports = {
	createHandlers,
	CHALLENGE_TTL_MS, loginMessage, validUsername, createChallenge, consumeChallenge, verifyPostingSignature,
};
