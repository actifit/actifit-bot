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
 * Surface notes / DEFERRED: reads default to PUBLIC challenges (visibility
 * scoping) and sanitize filter values to primitives (no Mongo-operator
 * injection). `seasons/:program/current` (§8) has no reader yet — the `seasons`
 * collection is deferred to F3; the Season-ladder default is typed
 * `league_fixture` because a `season` wrapper is not a challenge type. The
 * scheduled emitters that FIRE notifications from lifecycle (F3/F5), the HTTP
 * routes, and a "refresh" job that rolls the default-contest windows forward
 * (re-seed is a no-op on the fixed ids) are the remaining wiring.
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

/** Only accept a primitive string value into a query — blocks Mongo-operator
 *  injection (e.g. `{$ne:null}`) from request-supplied filters. */
function scalar(v) {
	return typeof v === 'string' ? v : undefined;
}

/** A participant view safe for public reads — strips internal anti-cheat state. */
function publicParticipant(p) {
	const { flags, source, ...rest } = p; // eslint-disable-line no-unused-vars
	return rest;
}

/** Browse challenges by optional type / state / community / entity filters.
 *  Returns PUBLIC challenges only unless `filter.includeNonPublic` is set. */
async function listChallenges(db, filter = {}) {
	const q = {};
	for (const k of ['type', 'state', 'community', 'origin_tier']) {
		const v = scalar(filter[k]);
		if (v !== undefined) q[k] = v;
	}
	if (!filter.includeNonPublic) q.visibility = 'public';
	let rows = await db.collection(COLLECTIONS.CHALLENGES).find(q).toArray();
	const entity = scalar(filter.entity);
	if (entity) {
		const parts = await db.collection(COLLECTIONS.PARTICIPANTS).find({ entity }).toArray();
		const ids = new Set(parts.map((p) => p.challenge_id));
		rows = rows.filter((c) => ids.has(c.id));
	}
	return rows;
}

/** One challenge + its participants (internal flags/source projected out). */
async function getChallenge(db, id) {
	const challenge = await db.collection(COLLECTIONS.CHALLENGES).findOne({ id: scalar(id) });
	if (!challenge) return null;
	const parts = await db.collection(COLLECTIONS.PARTICIPANTS).find({ challenge_id: challenge.id }).toArray();
	return { challenge, participants: parts.map(publicParticipant) };
}

/** A materialized standings table (weekly/season) by id or scope/cohort. */
async function getStandings(db, params = {}) {
	const id = scalar(params.id);
	if (id) return db.collection(COLLECTIONS.STANDINGS).findOne({ id });
	const q = {};
	for (const k of ['scope', 'cohort']) {
		const v = scalar(params[k]);
		if (v !== undefined) q[k] = v;
	}
	return db.collection(COLLECTIONS.STANDINGS).find(q).toArray();
}

// Hard cap on a returned page — bounds the response for public reads.
const MAX_PAGE = 200;
function pageLimit(v) {
	const n = Number(v);
	return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), MAX_PAGE) : 50;
}

/** A user's Merit balance (authoritative counter, ledger-sum fallback) + a page
 *  of their ledger (newest first). */
async function getMerits(db, user, opts = {}) {
	const u = scalar(user);
	const rows = await db.collection(COLLECTIONS.LEDGER).find({ user: u }).toArray();
	const bal = await db.collection('merits_balances').findOne({ user: u });
	const balance = (bal && Number.isFinite(bal.balance)) ? bal.balance : rows.reduce((s, r) => s + (Number(r.delta) || 0), 0);
	const sorted = rows.slice().sort((a, b) => String(b.at).localeCompare(String(a.at)));
	return { user, balance, ledger: sorted.slice(0, pageLimit(opts.limit)) };
}

/** The rewards-shop catalog (optionally only in-stock items). */
async function getShop(db, opts = {}) {
	let items = await db.collection(COLLECTIONS.SHOP).find({}).toArray();
	if (opts.inStockOnly) items = items.filter((i) => i.stock === 'unlimited' || Number(i.stock) > 0);
	return items;
}

/** A pool's public status (budget/committed/paid) — funding transparency. */
async function getPool(db, id) {
	return db.collection(COLLECTIONS.POOLS).findOne({ id: scalar(id) });
}

// ---- NOTIFICATIONS (§9) --------------------------------------------------

const MAX_EVENT_DATA_CHARS = 4096;

/** Append one arena event to the stream. Unknown event types + oversized data
 *  are rejected. */
async function emitEvent(db, event) {
	if (!event || !EVENT_TYPES.includes(event.type)) return { ok: false, reason: `unknown event type "${event && event.type}"` };
	if (event.data !== undefined && event.data !== null) {
		let size = 0;
		try { size = JSON.stringify(event.data).length; } catch (e) { return { ok: false, reason: 'unserializable event data' }; }
		if (size > MAX_EVENT_DATA_CHARS) return { ok: false, reason: 'event data too large' };
	}
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

/** List a user's recent arena events (their notification feed, newest first). */
async function listEvents(db, user, opts = {}) {
	const rows = await db.collection(COLLECTIONS.EVENTS).find({ user: scalar(user) }).toArray();
	const sorted = rows.slice().sort((a, b) => String(b.at).localeCompare(String(a.at)));
	return sorted.slice(0, pageLimit(opts.limit));
}

/** Index the append-only, per-user-polled event stream. Safe no-op if absent. */
async function ensureEventsIndexes(db) {
	const col = db.collection(COLLECTIONS.EVENTS);
	if (typeof col.createIndex === 'function') await col.createIndex({ user: 1, at: -1 });
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
	return { ok: results.every((r) => r.ok), seeded: results.filter((r) => r.ok && !r.noop).length, results };
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
	ensureEventsIndexes,
	defaultContests,
	seedDefaultContests,
};
