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
 * that SOME app showed SOME ad: the ad unit must be ours. And express-admob-ssv verifies
 * only the text before the first "signature", so nothing may follow the signature and
 * key_id, and no parameter may repeat (Express turns a repeated parameter into an array,
 * the first copy signed and the second not).
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
		if (!SSV_KEYS.has(key) || Object.prototype.hasOwnProperty.call(params, key)) return fail('unexpected or repeated parameter');
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

/**
 * Pays a verified v1 SSV callback. `query` is the AdMob callback query, `banned(user)` the
 * ban-list check, `notify(user, amount, tier)` the user notification.
 * @returns {Promise<{status: 'success', user, amount}|{error: string}>}
 */
async function payIntent(db, query, banned, notify, now = Date.now) {
	const intent = await consumeIntent(db, parseV1(query.custom_data), now);
	if (!intent) return { error: 'Unknown or expired reward' };
	if (banned(intent.user)) return { error: 'Account banned from rewards' };
	if (await rewardedToday(db, intent.user, intent.tier, now())) {
		return { error: 'Account already rewarded today for this tier' };
	}
	const claim = { user: intent.user, tier: intent.tier, day: utcDay(now()) };
	try {
		await db.collection('ad_reward_claims').insertOne(Object.assign({ intent: intent._id }, claim));
	} catch (err) {
		if (err && err.code === 11000) return { error: 'Account already rewarded today for this tier' };
		throw err;
	}
	const amount = rewardAmount(intent.tier);
	try {
		await db.collection('token_transactions').insertOne({
			user: intent.user,
			reward_activity: 'Ad Reward',
			token_count: amount,
			note: 'Rewarded ' + amount + ' AFIT in app gadget prize for tier ' + intent.tier,
			tier: String(intent.tier),
			custom_data: query.custom_data,
			ad_network: query.ad_network,
			ad_unit: query.ad_unit,
			transaction_id: query.transaction_id,
			date: new Date(now()),
		});
	} catch (err) {
		// the ad was watched but not paid: free the day's slot and leave a trace to fix by hand
		console.log('ad reward NOT paid', intent._id, intent.user, intent.tier, amount, err && err.message ? err.message : err);
		await db.collection('ad_reward_claims').deleteOne(claim).catch(() => {});
		return { error: 'Error performing buy action. DB storing issue' };
	}
	notify(intent.user, amount, intent.tier);
	return { status: 'success', user: intent.user, amount };
}

module.exports = {
	TIERS, INTENT_TTL_MS, checkCallback, firstSeen, rewardAmount, capLegacyAmount, parseV1, rewardedToday, createIntent, consumeIntent, payIntent,
};
