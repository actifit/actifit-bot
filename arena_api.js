/**
 * Challenge Engine — F6 read API + notifications + default-contest seeding
 * (Trello #180, epic #171). The client-facing surface: the last mile before
 * web / Android / iOS build against a frozen API. Spec §8, §9, §7.5.
 *
 * Three concerns, one cohesive "consumer surface" module:
 *   - READ models (mostly public, cache-friendly): browse/spectate challenges,
 *     standings, a user's Merits, the shop, a pool's status.
 *   - NOTIFICATIONS: an append-only `arena_events` stream each client renders in
 *     its own channel (emit + list).
 *   - SEED the §7.5 default contest set (incl. Weekend Warrior) — via official
 *     `challenge_create` ops through the F1 indexer, so it reuses all of F1's
 *     validation + I1/I6 enforcement + idempotency (re-seeding is safe).
 *
 * The HTTP routes in app.js are thin wrappers over these functions; keeping the
 * logic here makes it testable without the config/Firebase-bound server.
 *
 * Load-time safe: requires only ./arena (config/Firebase-free).
 */

'use strict';

const arena = require('./arena');

const COLLECTIONS = {
	CHALLENGES: 'challenges',
	PARTICIPANTS: 'challenge_participants',
	STANDINGS: 'standings',
	LEDGER: 'merits_ledger',
	SHOP: 'rewards_shop',
	POOLS: 'pools',
	EVENTS: 'arena_events',
};

// The notification event types clients subscribe to (§9).
const EVENT_TYPES = [
	'challenge_opening', 'you_were_matched', 'fixture_today', 'window_closing',
	'results_settled', 'promoted', 'relegated', 'chest_awarded', 'squad_goal_progress',
];

// ---- READ models (§8) ----------------------------------------------------

/** Browse challenges by optional type / state / community / entity filters. */
async function listChallenges(db, filter = {}) {
	const q = {};
	for (const k of ['type', 'state', 'community', 'origin_tier']) if (filter[k]) q[k] = filter[k];
	let rows = await db.collection(COLLECTIONS.CHALLENGES).find(q).toArray();
	if (filter.entity) {
		const parts = await db.collection(COLLECTIONS.PARTICIPANTS).find({ entity: filter.entity }).toArray();
		const ids = new Set(parts.map((p) => p.challenge_id));
		rows = rows.filter((c) => ids.has(c.id));
	}
	return rows;
}

/** One challenge + its current participant standings snapshot. */
async function getChallenge(db, id) {
	const challenge = await db.collection(COLLECTIONS.CHALLENGES).findOne({ id });
	if (!challenge) return null;
	const participants = await db.collection(COLLECTIONS.PARTICIPANTS).find({ challenge_id: id }).toArray();
	return { challenge, participants };
}

/** A materialized standings table (weekly/season) by scope/window/cohort. */
async function getStandings(db, params = {}) {
	if (params.id) return db.collection(COLLECTIONS.STANDINGS).findOne({ id: params.id });
	const q = {};
	for (const k of ['scope', 'cohort']) if (params[k]) q[k] = params[k];
	return db.collection(COLLECTIONS.STANDINGS).find(q).toArray();
}

/** A user's Merit balance + a page of their ledger. */
async function getMerits(db, user, opts = {}) {
	const rows = await db.collection(COLLECTIONS.LEDGER).find({ user }).toArray();
	const balance = rows.reduce((s, r) => s + (Number(r.delta) || 0), 0);
	const sorted = rows.slice().sort((a, b) => String(a.at).localeCompare(String(b.at)));
	const limit = opts.limit || 50;
	return { user, balance, ledger: sorted.slice(-limit) };
}

/** The rewards-shop catalog (optionally only in-stock items). */
async function getShop(db, opts = {}) {
	let items = await db.collection(COLLECTIONS.SHOP).find({}).toArray();
	if (opts.inStockOnly) items = items.filter((i) => i.stock === 'unlimited' || Number(i.stock) > 0);
	return items;
}

/** A pool's public status (budget/committed/paid) — funding transparency. */
async function getPool(db, id) {
	return db.collection(COLLECTIONS.POOLS).findOne({ id });
}

// ---- NOTIFICATIONS (§9) --------------------------------------------------

/** Append one arena event to the stream. Unknown event types are rejected. */
async function emitEvent(db, event) {
	if (!event || !EVENT_TYPES.includes(event.type)) return { ok: false, reason: `unknown event type "${event && event.type}"` };
	const doc = {
		type: event.type,
		user: event.user || null,
		challenge_id: event.challenge_id || null,
		data: event.data || null,
		at: event.at || new Date().toISOString(),
	};
	await db.collection(COLLECTIONS.EVENTS).insertOne(doc);
	return { ok: true, event: doc };
}

/** List a user's recent arena events (their notification feed). */
async function listEvents(db, user, opts = {}) {
	const rows = await db.collection(COLLECTIONS.EVENTS).find({ user }).toArray();
	const sorted = rows.slice().sort((a, b) => String(b.at).localeCompare(String(a.at)));
	return sorted.slice(0, opts.limit || 50);
}

// ---- SEED default contest set (§7.5) -------------------------------------

const DAY = 24 * 60 * 60 * 1000;

function windowFrom(startMs, days) {
	return { start: new Date(startMs).toISOString(), end: new Date(startMs + days * DAY).toISOString(), tz: 'UTC' };
}

/**
 * The §7.5 default contest set as official `challenge_create` op bodies, anchored
 * at `nowMs` (epoch millis — passed in so this stays deterministic/testable).
 * All are skill/goal-based and free-entry (I1/I6 clean).
 */
function defaultContests(nowMs) {
	const base = { origin_tier: 'official', entry: { mode: 'free' } };
	return [
		{ op: 'challenge_create', v: 1, id: 'def_weekly_step_league', type: 'league_fixture',
			title: 'Weekly Step League', window: windowFrom(nowMs, 7),
			scoring: { metric: 'activity_count', rule: 'max' }, ...base },
		{ op: 'challenge_create', v: 1, id: 'def_daily_focus', type: 'daily_focus',
			title: 'Daily Focus Goal', window: windowFrom(nowMs, 1),
			scoring: { metric: 'goal_hit', rule: 'threshold', threshold: 10000 }, ...base },
		{ op: 'challenge_create', v: 1, id: 'def_season_ladder', type: 'league_fixture',
			title: 'Season Ladder', window: windowFrom(nowMs, 14),
			scoring: { metric: 'activity_count', rule: 'max' }, ...base },
		{ op: 'challenge_create', v: 1, id: 'def_weekly_top_n', type: 'liveops',
			title: 'Weekly Global Top-N', window: windowFrom(nowMs, 7),
			scoring: { metric: 'activity_count', rule: 'max' }, ...base },
		{ op: 'challenge_create', v: 1, id: 'def_weekend_warrior', type: 'liveops',
			title: 'Weekend Warrior', window: windowFrom(nowMs, 2),
			scoring: { metric: 'activity_count', rule: 'max' }, ...base },
		{ op: 'challenge_create', v: 1, id: 'def_monthly_liveops', type: 'liveops',
			title: 'Monthly Live-Ops Event', window: windowFrom(nowMs, 30),
			scoring: { metric: 'activity_count', rule: 'max' }, ...base },
	];
}

/**
 * Seed the default contests by applying official `challenge_create` ops through
 * the F1 indexer — reusing its validation, I1/I6 enforcement, and idempotency
 * (a re-seed is a no-op, since the challenge ids already exist). Returns per-op
 * results.
 */
async function seedDefaultContests(db, opts = {}) {
	const officialAccount = opts.officialAccount || 'actifit';
	if (!Number.isFinite(opts.nowMs)) return { ok: false, reason: 'nowMs (epoch millis) is required' };
	const at = opts.at || new Date().toISOString();
	const results = [];
	for (const body of defaultContests(opts.nowMs)) {
		const chainOp = {
			id: arena.ARENA_JSON_ID,
			json: JSON.stringify(body),
			required_posting_auths: [officialAccount],
			required_auths: [],
			trx_id: `seed_${body.id}`,
			block_num: opts.blockNum || 0,
			timestamp: at,
		};
		const res = await arena.indexArenaOp(db, chainOp, { officialAccount });
		results.push({ id: body.id, ...res });
	}
	return { ok: true, seeded: results.filter((r) => r.ok && !r.noop).length, results };
}

module.exports = {
	COLLECTIONS,
	EVENT_TYPES,
	listChallenges,
	getChallenge,
	getStandings,
	getMerits,
	getShop,
	getPool,
	emitEvent,
	listEvents,
	defaultContests,
	seedDefaultContests,
};
