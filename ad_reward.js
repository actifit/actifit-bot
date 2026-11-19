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
		indexesReady = Promise.all([
			db.collection('ad_reward_intents').createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 }),
			db.collection('ad_reward_intents').createIndex({ user: 1, tier: 1 }),
			// one v1 payment per user, tier and UTC day, enforced by the database
			db.collection('ad_reward_claims').createIndex({ user: 1, tier: 1, day: 1 }, { unique: true }),
			db.collection('token_transactions').createIndex({ user: 1, reward_activity: 1, tier: 1, date: -1 }),
		]).catch((err) => { indexesReady = null; console.log('ad_reward indexes: ' + (err && err.message ? err.message : err)); });
	}
	return indexesReady;
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
	TIERS, INTENT_TTL_MS, rewardAmount, capLegacyAmount, parseV1, rewardedToday, createIntent, consumeIntent, payIntent,
};
