/**
 * AdMob rewarded ads, format v1.
 *
 * The app asks for a one-time reward id before showing the ad and hands AdMob only
 * "r1_<id>" as the SSV custom data. AdMob (an ad network) therefore never sees the
 * username, the step tier or the amount: the tier is unlocked by the user's step count,
 * which comes from Health Connect / HealthKit, and health-derived data must not reach
 * ad networks. The amount is also picked here instead of by the app.
 *
 * The legacy custom data "user_amount_tier_label" (iOS and older Android builds) is
 * still handled by the /ssv-verify route itself and is not affected by this module.
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

let ttlIndexReady = null;

/** Random amount for `tier`, floored to 3 decimals and never below the tier minimum. */
function rewardAmount(tier, rand = Math.random) {
	const t = TIERS[tier];
	if (!t) return 0;
	const value = Math.floor((t.min + rand() * (t.max - t.min)) * 1000) / 1000;
	return Math.max(t.min, value);
}

/** The reward id from v1 custom data, or null when it is not v1 (legacy format). */
function parseV1(customData) {
	const m = typeof customData === 'string' ? V1_RE.exec(customData) : null;
	return m ? m[1] : null;
}

function startOfUtcDay(nowMs) {
	const d = new Date(nowMs);
	return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Has `user` already been paid an ad reward for `tier` today (UTC)? */
async function rewardedToday(db, user, tier, nowMs) {
	const n = await db.collection('token_transactions').countDocuments({
		user, reward_activity: 'Ad Reward', tier: String(tier), date: { $gte: startOfUtcDay(nowMs) },
	});
	return n > 0;
}

/**
 * Store a one-time reward intent and return its id and amount (the app shows the amount
 * once the ad has been watched).
 * @returns {Promise<{id, amount}|{error: 'bad_tier'|'already_claimed'}>}
 */
async function createIntent(db, user, tier, now = Date.now) {
	tier = parseInt(tier, 10);
	if (!TIERS[tier]) return { error: 'bad_tier' };
	if (!ttlIndexReady) {
		ttlIndexReady = db.collection('ad_reward_intents').createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 })
			.catch((err) => { ttlIndexReady = null; console.log('ad_reward_intents TTL index: ' + (err && err.message ? err.message : err)); });
	}
	if (await rewardedToday(db, user, tier, now())) return { error: 'already_claimed' };
	const id = crypto.randomBytes(16).toString('hex');
	const amount = rewardAmount(tier);
	await db.collection('ad_reward_intents').insertOne({
		_id: id,
		user,
		tier,
		amount,
		expires_at: new Date(now() + INTENT_TTL_MS),
		created_at: new Date(now()),
	});
	return { id, amount };
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

module.exports = { TIERS, INTENT_TTL_MS, rewardAmount, parseV1, rewardedToday, createIntent, consumeIntent };
