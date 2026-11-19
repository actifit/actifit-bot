/**
 * AdMob rewarded ads, format v1.
 *
 * The app asks for a one-time reward id before showing the ad and hands AdMob only
 * "r1_<id>" as the SSV custom data. AdMob (an ad network) therefore never sees the
 * username or the step tier: the tier is unlocked by the user's step count, which comes
 * from Health Connect / HealthKit, and health-derived data must not reach ad networks.
 * The amount is picked here when the reward is paid, never by the app and never ahead of
 * time (an amount known before the ad could be rerolled by requesting new ids).
 *
 * The legacy custom data "user_amount_tier_label" (iOS and older Android builds) is
 * still handled by the /ssv-verify route itself; see capLegacyAmount.
 */

const crypto = require('crypto');

// AFIT range per tier, the same ranges the apps used (random amount within the range)
const TIERS = {
	1: { min: 0.01, max: 3 },
	2: { min: 0.01, max: 5 },
	3: { min: 0.01, max: 7 },
	4: { min: 0.01, max: 10 },
};
const INTENT_TTL_MS = 30 * 60 * 1000;
const ID_RE = /^[0-9a-f]{32}$/;
const V1_RE = /^r1_([0-9a-f]{32})$/;

let indexesReady = null;

function ensureIndexes(db) {
	if (!indexesReady) {
		indexesReady = Promise.resolve().then(() => Promise.all([
			db.collection('ad_reward_intents').createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 }),
			db.collection('ad_reward_intents').createIndex({ user: 1, tier: 1 }),
			db.collection('ad_ssv_transactions').createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 }),
			// one v1 payment per user, tier and UTC day, enforced by the database
			db.collection('ad_reward_claims').createIndex({ user: 1, tier: 1, day: 1 }, { unique: true }),
			db.collection('token_transactions').createIndex({ user: 1, reward_activity: 1, tier: 1, date: -1 }),
		])).catch((err) => { indexesReady = null; console.log('ad_reward indexes: ' + (err && err.message ? err.message : err)); });
	}
	return indexesReady;
}

// The parameters AdMob sends, in the order it sends them; signature and key_id come last
// and everything before "&signature=" is what Google signed.
const SSV_KEYS = new Set(['ad_network', 'ad_unit', 'custom_data', 'reward_amount', 'reward_item',
	'timestamp', 'transaction_id', 'user_id', 'signature', 'key_id']);
const SSV_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SSV_MAX_SKEW_MS = 5 * 60 * 1000;

/** "ca-app-pub-1/2345" and "2345" name the same ad unit. */
function adUnitId(v) {
	return String(v).split('/').pop().trim();
}

/**
 * Checks the shape of an AdMob SSV callback before its signature is trusted. Google signs
 * every AdMob app's callbacks with the same keys, so a valid signature alone only proves
 * that SOME app showed SOME ad: the ad unit must be ours. Google signs the text before
 * "&signature=", so nothing may follow the signature and key_id, and no parameter may
 * repeat (Express turns a repeated parameter into an array, one copy signed and one not).
 *
 * @param rawQuery the query string exactly as received, without the "?"
 * @param adUnits our rewarded ad unit ids (config.admob_ad_units); empty refuses everything
 * @returns {{ok: true, params: Object}|{ok: false, error: string}}
 */
function checkCallback(rawQuery, adUnits, nowMs = Date.now()) {
	const fail = (error) => ({ ok: false, error });
	const units = new Set((Array.isArray(adUnits) ? adUnits : []).map(adUnitId).filter(Boolean));
	if (!units.size) return fail('ad units not configured');
	if (typeof rawQuery !== 'string') return fail('bad query');
	const sig = rawQuery.indexOf('&signature=');
	// the signed part must not contain "signature", or the library would verify only a prefix
	if (sig < 0 || rawQuery.slice(0, sig).includes('signature')) return fail('bad signature position');
	if (!/^&signature=[^&]+&key_id=[0-9]+$/.test(rawQuery.slice(sig))) return fail('parameters after the signature');
	const params = {};
	for (const pair of rawQuery.split('&')) {
		const eq = pair.indexOf('=');
		const key = eq < 0 ? pair : pair.slice(0, eq);
		if (!SSV_KEYS.has(key) || Object.prototype.hasOwnProperty.call(params, key)) return fail('unexpected or repeated parameter: ' + key.slice(0, 40));
		let value;
		try { value = decodeURIComponent((eq < 0 ? '' : pair.slice(eq + 1)).replace(/\+/g, ' ')); } catch (e) { return fail('bad encoding'); }
		params[key] = value;
	}
	if (!params.ad_unit || !units.has(adUnitId(params.ad_unit))) return fail('not our ad unit');
	if (!params.transaction_id) return fail('no transaction id');
	const ts = Number(params.timestamp);
	if (!(ts > nowMs - SSV_MAX_AGE_MS && ts < nowMs + SSV_MAX_SKEW_MS)) return fail('stale or future timestamp');
	return { ok: true, params };
}

/**
 * Records an AdMob transaction id; false when it was seen before (a replayed callback).
 * Kept a little longer than SSV_MAX_AGE_MS, after which the timestamp check refuses it.
 */
async function firstSeen(db, transactionId, nowMs = Date.now()) {
	ensureIndexes(db);
	try {
		await db.collection('ad_ssv_transactions').insertOne({
			_id: transactionId, expires_at: new Date(nowMs + 2 * SSV_MAX_AGE_MS),
		});
		return true;
	} catch (err) {
		if (err && err.code === 11000) return false;
		throw err;
	}
}

/** Random amount for `tier`, floored to 3 decimals and never below the tier minimum. */
function rewardAmount(tier, rand = Math.random) {
	const t = TIERS[tier];
	if (!t) return 0;
	const value = Math.floor((t.min + rand() * (t.max - t.min)) * 1000) / 1000;
	return Math.max(t.min, value);
}

/**
 * Legacy custom data carries an amount chosen by the client: refuse unknown tiers and cap
 * the amount at the tier's maximum. Null when the tier or amount is invalid.
 */
function capLegacyAmount(tier, amount) {
	const t = TIERS[tier];
	const v = parseFloat(amount);
	if (!t || !/^[1-4]$/.test(String(tier)) || !(v > 0)) return null;
	return Math.min(v, t.max);
}

/** The reward id from v1 custom data, or null when it is not v1 (legacy format). */
function parseV1(customData) {
	const m = typeof customData === 'string' ? V1_RE.exec(customData) : null;
	return m ? m[1] : null;
}

function utcDay(nowMs) {
	return new Date(nowMs).toISOString().slice(0, 10);
}

/** Has `user` already been paid an ad reward for `tier` today (UTC), by either format? */
async function rewardedToday(db, user, tier, nowMs) {
	const n = await db.collection('token_transactions').countDocuments({
		user, reward_activity: 'Ad Reward', tier: String(tier), date: { $gte: new Date(utcDay(nowMs) + 'T00:00:00Z') },
	});
	return n > 0;
}

/**
 * Store a one-time reward intent and return its id. A new intent replaces the user's open
 * intents for that tier, so stored intents stay bounded.
 * @returns {Promise<{id}|{error: 'bad_tier'|'already_claimed'}>}
 */
async function createIntent(db, user, tier, now = Date.now) {
	tier = parseInt(tier, 10);
	if (!TIERS[tier]) return { error: 'bad_tier' };
	ensureIndexes(db);
	if (await rewardedToday(db, user, tier, now())) return { error: 'already_claimed' };
	const id = crypto.randomBytes(16).toString('hex');
	await db.collection('ad_reward_intents').deleteMany({ user, tier });
	await db.collection('ad_reward_intents').insertOne({
		_id: id,
		user,
		tier,
		expires_at: new Date(now() + INTENT_TTL_MS),
		created_at: new Date(now()),
	});
	return { id };
}

/**
 * Atomically remove and return an unexpired intent, so an id pays at most once even when
 * AdMob retries the callback. Null when unknown, expired or already used.
 */
async function consumeIntent(db, id, now = Date.now) {
	if (typeof id !== 'string' || !ID_RE.test(id)) return null;
	const res = await db.collection('ad_reward_intents').findOneAndDelete({
		_id: id, expires_at: { $gt: new Date(now()) },
	});
	// driver 5 returns { value }; driver 6 returns the document itself
	const doc = res && Object.prototype.hasOwnProperty.call(res, 'value') ? res.value : res;
	return doc || null;
}

const ALREADY = { error: 'Account already rewarded today for this tier' };

/**
 * Pays `amount` AFIT once per user, tier and UTC day, for either format. The unique claim
 * row is the guard, so two callbacks arriving together (v1 or legacy) cannot both pay.
 * On a database failure nothing is paid, the day's slot is freed and the error is thrown,
 * so the caller can let AdMob retry.
 */
async function payReward(db, { user, tier, amount, note, ssv, extra }, notify, nowMs) {
	ensureIndexes(db);
	if (await rewardedToday(db, user, tier, nowMs)) return ALREADY;
	const claim = { user, tier: Number(tier), day: utcDay(nowMs) };
	try {
		await db.collection('ad_reward_claims').insertOne(Object.assign({}, extra, claim));
	} catch (err) {
		if (err && err.code === 11000) return ALREADY;
		throw err;
	}
	try {
		await db.collection('token_transactions').insertOne({
			user,
			reward_activity: 'Ad Reward',
			token_count: amount,
			note,
			tier: String(tier),
			custom_data: ssv.custom_data,
			ad_network: ssv.ad_network,
			ad_unit: ssv.ad_unit,
			transaction_id: ssv.transaction_id,
			date: new Date(nowMs),
		});
	} catch (err) {
		await db.collection('ad_reward_claims').deleteOne(claim).catch(() => {});
		throw err;
	}
	notify(user, amount, tier);
	return { status: 'success', user, amount };
}

/**
 * Pays a verified v1 callback (`ssv` = its signed values). `banned(user)` is the ban-list
 * check, `notify(user, amount, tier)` the user notification. Throws on a database failure,
 * after putting the intent back so AdMob's retry can still pay it.
 * @returns {Promise<{status: 'success', user, amount}|{error: string}>}
 */
async function payIntent(db, ssv, banned, notify, now = Date.now) {
	const intent = await consumeIntent(db, parseV1(ssv.custom_data), now);
	if (!intent) return { error: 'Unknown or expired reward' };
	if (banned(intent.user)) return { error: 'Account banned from rewards' };
	const amount = rewardAmount(intent.tier);
	try {
		return await payReward(db, {
			user: intent.user, tier: intent.tier, amount, ssv, extra: { intent: intent._id },
			note: 'Rewarded ' + amount + ' AFIT in app gadget prize for tier ' + intent.tier,
		}, notify, now());
	} catch (err) {
		console.log('ad reward NOT paid', intent._id, intent.user, intent.tier, ssv.transaction_id, err && err.message ? err.message : err);
		await db.collection('ad_reward_intents').insertOne(intent).catch(() => {});
		throw err;
	}
}

// a Hive account name; the legacy format names the user without any proof
const HIVE_USER_RE = /^[a-z][a-z0-9.-]{2,15}$/;

/**
 * Pays a verified legacy "user_amount_tier_label" callback (iOS, older Android). The amount
 * comes from the client, capped at the tier maximum. Throws on a database failure.
 */
async function payLegacy(db, ssv, banned, notify, nowMs = Date.now()) {
	const data = ssv.custom_data.split('_');
	if (data.length < 4 || !HIVE_USER_RE.test(data[0]) || isNaN(data[1])) return { error: 'Error performing action' };
	if (banned(data[0])) return { error: 'Account banned from rewards' };
	const amount = capLegacyAmount(data[2], data[1]);
	if (amount === null) return { error: 'Error performing action' };
	try {
		return await payReward(db, {
			user: data[0], tier: data[2], amount, ssv,
			note: 'Rewarded ' + amount + ' AFIT in app gadget prize for tier ' + data[2] + ' ' + data[3],
		}, notify, nowMs);
	} catch (err) {
		console.log('ad reward NOT paid (legacy)', data[0], data[2], amount, ssv.transaction_id, err && err.message ? err.message : err);
		throw err;
	}
}

// Google's SSV verifier keys, cached: fetching them on every callback would let anyone who
// sends well-formed junk make us hammer gstatic (and fail real callbacks if it throttles us).
const KEYS_URL = 'https://www.gstatic.com/admob/reward/verifier-keys.json';
const KEYS_TTL_MS = 24 * 60 * 60 * 1000;
const KEYS_REFETCH_MS = 60 * 1000;
let keyCache = { keys: new Map(), fetchedAt: 0, triedAt: -Infinity, pending: null };

async function fetchVerifierKeys() {
	const res = await fetch(KEYS_URL);
	if (!res.ok) throw new Error('verifier keys HTTP ' + res.status);
	return res.json();
}

async function verifierKey(keyId, nowMs, fetchKeys) {
	if (nowMs - keyCache.fetchedAt < KEYS_TTL_MS && keyCache.keys.has(keyId)) return keyCache.keys.get(keyId);
	// stale, or a key id we do not know (Google rotates keys): refetch, at most once a minute
	if (!keyCache.pending && nowMs - keyCache.triedAt >= KEYS_REFETCH_MS) {
		keyCache.triedAt = nowMs;
		keyCache.pending = Promise.resolve().then(fetchKeys).then((body) => {
			const keys = new Map();
			for (const k of (body && Array.isArray(body.keys) ? body.keys : [])) {
				keys.set(String(k.keyId), crypto.createPublicKey(k.pem));
			}
			if (keys.size) {
				keyCache.keys = keys;
				keyCache.fetchedAt = nowMs;
			}
		}).catch((err) => console.log('admob verifier keys: ' + (err && err.message ? err.message : err)))
			.then(() => { keyCache.pending = null; });
	}
	if (keyCache.pending) await keyCache.pending;
	// a stale key still verifies while gstatic is unreachable
	return keyCache.keys.get(keyId) || null;
}

/**
 * Shape check, then Google's signature over the raw bytes received (never a re-serialized
 * URL, which could differ from what Google signed).
 */
async function verifyCallback(rawQuery, adUnits, { now = Date.now(), fetchKeys = fetchVerifierKeys } = {}) {
	const shape = checkCallback(rawQuery, adUnits, now);
	if (!shape.ok) return shape;
	const key = await verifierKey(shape.params.key_id, now, fetchKeys);
	if (!key) return { ok: false, error: 'unknown key_id ' + shape.params.key_id };
	const signed = rawQuery.slice(0, rawQuery.indexOf('&signature='));
	let good = false;
	try {
		good = crypto.verify('sha256', Buffer.from(signed, 'utf8'), key, Buffer.from(shape.params.signature, 'base64url'));
	} catch (e) {
		good = false;
	}
	return good ? shape : { ok: false, error: 'bad signature' };
}

/**
 * The whole /ssv-verify callback: verify, refuse replays, pay. A database failure answers
 * 500 and forgets the transaction id, so AdMob's retry is paid instead of refused.
 * @returns {Promise<{status: number, body: Object|string}>}
 */
async function handleCallback(db, rawQuery, { adUnits, banned, notify, now = Date.now, fetchKeys } = {}) {
	const checked = await verifyCallback(rawQuery, adUnits, { now: now(), fetchKeys });
	if (!checked.ok) {
		console.log('ssv-verify refused: ' + checked.error);
		return { status: 400, body: 'Invalid callback' };
	}
	const ssv = checked.params;
	if (!(await firstSeen(db, ssv.transaction_id, now()))) {
		console.log('ssv-verify replayed transaction ' + ssv.transaction_id);
		return { status: 200, body: { error: 'Duplicate callback' } };
	}
	try {
		let out = { status: 'success' };
		if (parseV1(ssv.custom_data)) out = await payIntent(db, ssv, banned, notify, now);
		else if (ssv.custom_data) out = await payLegacy(db, ssv, banned, notify, now());
		return { status: 200, body: out.error ? { error: out.error } : { status: 'success' } };
	} catch (err) {
		await db.collection('ad_ssv_transactions').deleteOne({ _id: ssv.transaction_id }).catch(() => {});
		return { status: 500, body: 'Try again' };
	}
}

function resetKeyCacheForTests() {
	keyCache = { keys: new Map(), fetchedAt: 0, triedAt: -Infinity, pending: null };
}

module.exports = {
	TIERS, INTENT_TTL_MS, checkCallback, firstSeen, verifyCallback, handleCallback, rewardAmount, capLegacyAmount, parseV1,
	rewardedToday, createIntent, consumeIntent, payIntent, payLegacy, resetKeyCacheForTests,
};
