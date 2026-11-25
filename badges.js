/**
 * Badge catalog (first wave) and the rules that decide who can claim what.
 *
 * Every rule is computed here from data the bot already stores, so a claim is checked on
 * the server, never trusted from the app:
 * - verified_posts (one scan of the user's own reports, {author, date} index): streak,
 *   lifetime steps, best day, activity types, video and charity reports, the limited window.
 * - challenge_participants / challenges (Arena): joined, podiums, wins.
 *
 * Badges are cosmetic: they never pay AFIT and never change rewards. No rule depends on
 * luck, location or body measurement values.
 *
 * Badge ids: "<family>_lev_<n>" for tiered families (n starts at 1), the plain id for a
 * limited edition. Tiers must be claimed in order.
 */

// steps above this in one report are treated as this much (sanity cap, cosmetic badges only)
const MAX_DAY_STEPS = 100000;
// a report's own activity date is trusted only if it is at most this many days before the
// day the server received it (yesterday's report is normal); otherwise the receive day counts
const MAX_DAY_SKEW = 2;
// Explorer: only the first few types of a report count, and a type counts once it shows up
// in reports on this many different days, so one report listing 20 types earns nothing
const MAX_TYPES_PER_REPORT = 3;
const TYPE_MIN_DAYS = 2;
// Arena badges only count challenges run by Actifit or a moderator: anyone can create a
// friendly challenge and fill it with their own accounts
const ARENA_TIERS = ['official', 'community'];
// podiums and wins also need this many finishers who actually scored
const MIN_ARENA_FIELD = 5;
// a limited edition can still be claimed this long after its window closes
const CLAIM_GRACE_MS = 7 * 24 * 3600 * 1000;
const STATS_TTL_MS = 10 * 60 * 1000;
const STATS_CACHE_MAX = 5000;

const FAMILIES = [
	{ id: 'on_fire', name: 'On Fire', stat: 'longestStreak', unit: 'days in a row', tiers: [7, 30, 100, 200, 365],
		desc: 'Post a report on consecutive days.' },
	{ id: 'million_stepper', name: 'Million Stepper', stat: 'lifetimeSteps', unit: 'lifetime steps',
		tiers: [1000000, 5000000, 10000000, 25000000, 50000000], desc: 'Add up steps across all your reports.' },
	{ id: 'big_day', name: 'Big Day', stat: 'bestDay', unit: 'steps in one day', tiers: [20000, 30000, 50000],
		desc: 'Report a huge day of activity.' },
	{ id: 'director', name: 'Director', stat: 'videoReports', unit: 'video reports', tiers: [1, 10, 50],
		desc: 'Add a 3Speak video to your reports.' },
	{ id: 'explorer', name: 'Explorer', stat: 'activityTypes', unit: 'activity types', tiers: [5, 10, 20],
		desc: 'Try different activity types: each counts once you report it on 2 different days.' },
	{ id: 'contender', name: 'Contender', stat: 'arenaJoined', unit: 'Arena challenges joined', tiers: [1, 10, 50],
		desc: 'Join official or community Arena challenges.' },
	{ id: 'podium', name: 'Podium', stat: 'arenaPodiums', unit: 'top-3 finishes', tiers: [1, 5, 20],
		desc: 'Finish in the top 3 of an official or community Arena challenge with at least '
			+ MIN_ARENA_FIELD + ' active finishers.' },
	{ id: 'champion', name: 'Champion', stat: 'arenaWins', unit: 'Arena wins', tiers: [1, 10],
		desc: 'Win an official or community Arena challenge with at least ' + MIN_ARENA_FIELD + ' active finishers.' },
	{ id: 'big_heart', name: 'Big Heart', stat: 'charityReports', unit: 'charity reports', tiers: [1, 10, 50],
		desc: 'Send your report rewards to charity.' },
];

const LIMITED = [
	{ id: 'endorphin_rush', name: 'Endorphin Rush', stat: 'endorphinReports', unit: 'report days', target: 20,
		from: '2026-11-21T00:00:00Z', until: '2026-12-31T23:59:59Z',
		desc: 'Limited edition: post reports on 20 different days before the end of 2026.'
			+ ' Claimable until a week after.' },
];

const TIER_NAMES = ['bronze', 'silver', 'gold', 'platinum', 'diamond'];

/** The public catalog the apps render (names, tiers, art paths). */
function catalog() {
	return {
		families: FAMILIES.map((f) => ({
			id: f.id, name: f.name, desc: f.desc, unit: f.unit,
			tiers: f.tiers.map((target, i) => ({
				level: i + 1, badge: f.id + '_lev_' + (i + 1), target, tier: TIER_NAMES[i],
				art: '/img/badges/' + f.id + '_lev_' + (i + 1) + '.png',
			})),
		})),
		limited: LIMITED.map((l) => ({
			id: l.id, badge: l.id, name: l.name, desc: l.desc, unit: l.unit, target: l.target, from: l.from, until: l.until,
			claim_until: new Date(Date.parse(l.until) + CLAIM_GRACE_MS).toISOString(),
			art: '/img/badges/' + l.id + '.png',
		})),
	};
}

const one = (v) => (Array.isArray(v) ? v[0] : v);

function dayIndex(yyyymmdd) {
	return Date.UTC(+yyyymmdd.slice(0, 4), +yyyymmdd.slice(4, 6) - 1, +yyyymmdd.slice(6, 8)) / 86400000;
}

function utcDay(ms) {
	return new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');
}

/** A real calendar date as YYYYMMDD ("20261399" or "2026-11-01" are not). */
function validDay(d) {
	if (!/^\d{8}$/.test(d)) return false;
	const ms = dayIndex(d) * 86400000;
	return Number.isFinite(ms) && utcDay(ms) === d;
}

/**
 * The report's day as YYYYMMDD. The app's activity date (the user's local day) is used when
 * it is a real date from the day after the receive day (time zones ahead of UTC) to
 * MAX_DAY_SKEW days before it (yesterday's report is normal); otherwise the day the server
 * received the report (UTC). Null without a receive time.
 */
function reportDay(post) {
	const at = post.date ? new Date(post.date).getTime() : NaN;
	if (!Number.isFinite(at)) return null;
	const received = utcDay(at);
	const d = String(one((post.json_metadata || {}).activityDate) || '');
	if (validDay(d)) {
		const gap = dayIndex(received) - dayIndex(d);
		if (gap >= -1 && gap <= MAX_DAY_SKEW) return d;
	}
	return received;
}

/** Longest run of consecutive days in a set of YYYYMMDD strings. */
function longestStreak(days) {
	const idx = [...new Set(days)].map(dayIndex).filter(Number.isFinite).sort((a, b) => a - b);
	let best = 0;
	let run = 0;
	for (let i = 0; i < idx.length; i++) {
		run = i > 0 && idx[i] === idx[i - 1] + 1 ? run + 1 : 1;
		if (run > best) best = run;
	}
	return best;
}

/** Report-based stats from `user`'s verified_posts documents (pure, for tests). */
function reportStats(posts, now = Date.now(), user = null) {
	const daySteps = new Map();
	const typeDays = new Map();
	let videoReports = 0;
	let charityReports = 0;
	const rushDays = new Set();
	const rush = LIMITED[0];
	const rushFrom = Date.parse(rush.from);
	const rushUntil = Math.min(Date.parse(rush.until), now);
	for (const p of posts) {
		const md = p.json_metadata || {};
		const day = reportDay(p);
		if (!day) continue;
		let steps = parseInt(one(md.step_count), 10);
		steps = Number.isFinite(steps) && steps > 0 ? Math.min(steps, MAX_DAY_STEPS) : 0;
		// one report day counts once: keep its biggest report
		daySteps.set(day, Math.max(daySteps.get(day) || 0, steps));
		const names = [...new Set(String(one(md.activity_type) || '').split(',')
			.map((t) => t.trim().toLowerCase()).filter(Boolean))].slice(0, MAX_TYPES_PER_REPORT);
		for (const name of names) {
			if (!typeDays.has(name)) typeDays.set(name, new Set());
			typeDays.get(name).add(day);
		}
		const v = md.video;
		// only the user's own video counts
		if (v && typeof v === 'object' && v.info && v.info.permlink && (!user || v.info.author === user)) videoReports++;
		if (one(md.charity)) charityReports++;
		// the limited window counts the days the server received reports: no backdating into it
		const at = new Date(p.date).getTime();
		if (at >= rushFrom && at <= rushUntil) rushDays.add(utcDay(at));
	}
	let lifetimeSteps = 0;
	let bestDay = 0;
	for (const s of daySteps.values()) {
		lifetimeSteps += s;
		if (s > bestDay) bestDay = s;
	}
	return {
		longestStreak: longestStreak([...daySteps.keys()]),
		lifetimeSteps, bestDay,
		activityTypes: [...typeDays.values()].filter((days) => days.size >= TYPE_MIN_DAYS).length,
		videoReports, charityReports,
		endorphinReports: rushDays.size,
	};
}

const arenaCounts = (ch) => !!ch && ARENA_TIERS.includes(ch.origin_tier) && ch.state !== 'cancelled';

/** A settled top-3 finish with a real score: the only results podiums and wins can use. */
const scoredPodium = (p) => p.state === 'settled' && !!p.result && Number(p.result.rank) >= 1
	&& Number(p.result.rank) <= 3 && Number(p.result.score_verified) > 0;

/**
 * Arena stats from the user's participations and their challenges (pure, for tests).
 * finishersById: settled participants with a score above 0, per challenge.
 */
function arenaStats(participations, challengesById, finishersById) {
	let arenaJoined = 0;
	let arenaPodiums = 0;
	let arenaWins = 0;
	for (const p of participations) {
		if (!arenaCounts(challengesById.get(p.challenge_id)) || p.state === 'left') continue;
		arenaJoined++;
		if (!scoredPodium(p) || (finishersById.get(p.challenge_id) || 0) < MIN_ARENA_FIELD) continue;
		arenaPodiums++;
		if (Number(p.result.rank) === 1) arenaWins++;
	}
	return { arenaJoined, arenaPodiums, arenaWins };
}

const cache = new Map();
const inFlight = new Map();

async function computeStats(db, user, now) {
	const posts = await db.collection('verified_posts').find({ author: user }, {
		projection: {
			_id: 0, date: 1, 'json_metadata.step_count': 1, 'json_metadata.activity_type': 1,
			'json_metadata.activityDate': 1, 'json_metadata.video.info.author': 1,
			'json_metadata.video.info.permlink': 1, 'json_metadata.charity': 1,
		},
	}).toArray();
	const participations = await db.collection('challenge_participants').find({ entity: user }, {
		projection: { _id: 0, challenge_id: 1, state: 1, result: 1 },
	}).toArray();
	const ids = [...new Set(participations.map((p) => p.challenge_id))];
	const challengesById = new Map();
	const finishersById = new Map();
	if (ids.length) {
		const chs = await db.collection('challenges').find({ id: { $in: ids } }, {
			projection: { _id: 0, id: 1, origin_tier: 1, state: 1 },
		}).toArray();
		for (const c of chs) challengesById.set(c.id, c);
		// field sizes only where they can matter: the user's own scored top-3 finishes
		const podiumIds = [...new Set(participations.filter((p) => scoredPodium(p)
			&& arenaCounts(challengesById.get(p.challenge_id))).map((p) => p.challenge_id))];
		if (podiumIds.length) {
			const counts = await db.collection('challenge_participants').aggregate([
				{ $match: { challenge_id: { $in: podiumIds }, state: 'settled', 'result.score_verified': { $gt: 0 } } },
				{ $group: { _id: '$challenge_id', n: { $sum: 1 } } },
			]).toArray();
			for (const c of counts) finishersById.set(c._id, c.n);
		}
	}
	return Object.assign(reportStats(posts, now, user), arenaStats(participations, challengesById, finishersById));
}

/**
 * Every stat the rules need for `user`, cached for 10 minutes; parallel calls for one user
 * share one read. `fresh` skips the cache (a claim must see the latest reports).
 */
async function userStats(db, user, now = Date.now(), { fresh = false } = {}) {
	const hit = cache.get(user);
	if (!fresh && hit && now - hit.at < STATS_TTL_MS) return hit.stats;
	if (inFlight.has(user)) return inFlight.get(user);
	const job = computeStats(db, user, now).then((stats) => {
		cache.delete(user);
		if (cache.size >= STATS_CACHE_MAX) cache.delete(cache.keys().next().value);
		cache.set(user, { at: now, stats });
		return stats;
	}).finally(() => inFlight.delete(user));
	inFlight.set(user, job);
	return job;
}

/** { family, level } for a tiered badge id, { limited } for a limited one, else null. */
function parseBadge(badge) {
	if (typeof badge !== 'string') return null;
	const m = /^([a-z_]+)_lev_(\d+)$/.exec(badge);
	if (m) {
		const family = FAMILIES.find((f) => f.id === m[1]);
		const level = parseInt(m[2], 10);
		if (family && level >= 1 && level <= family.tiers.length) return { family, level };
		return null;
	}
	const limited = LIMITED.find((l) => l.id === badge);
	return limited ? { limited } : null;
}

/**
 * Can `user` claim `badge` now? Unknown ids return { known: false } so the caller can fall
 * back to the older badges (iso, rewarded_activity_lev_N, doubledup, charity).
 * @param claimed Set of badge ids the user already holds
 */
function canClaim(badge, stats, claimed, now = Date.now()) {
	const b = parseBadge(badge);
	if (!b) return { known: false };
	if (claimed.has(badge)) return { known: true, ok: false, reason: 'already_claimed' };
	if (b.limited) {
		if (now < Date.parse(b.limited.from) || now > Date.parse(b.limited.until) + CLAIM_GRACE_MS) {
			return { known: true, ok: false, reason: 'closed' };
		}
		return stats[b.limited.stat] >= b.limited.target ? { known: true, ok: true }
			: { known: true, ok: false, reason: 'requirements' };
	}
	if (b.level > 1 && !claimed.has(b.family.id + '_lev_' + (b.level - 1))) {
		return { known: true, ok: false, reason: 'previous_level' };
	}
	return stats[b.family.stat] >= b.family.tiers[b.level - 1] ? { known: true, ok: true }
		: { known: true, ok: false, reason: 'requirements' };
}

/** Per-family progress for the apps: value, highest claimed level, next target. */
function progress(stats, claimed, now = Date.now()) {
	return {
		families: FAMILIES.map((f) => {
			let claimedLevel = 0;
			while (claimedLevel < f.tiers.length && claimed.has(f.id + '_lev_' + (claimedLevel + 1))) claimedLevel++;
			const next = claimedLevel < f.tiers.length ? claimedLevel + 1 : null;
			return {
				id: f.id, value: stats[f.stat], claimedLevel,
				next: next && { level: next, badge: f.id + '_lev_' + next, target: f.tiers[next - 1],
					claimable: stats[f.stat] >= f.tiers[next - 1] },
			};
		}),
		limited: LIMITED.map((l) => {
			const from = Date.parse(l.from);
			const open = now >= from && now <= Date.parse(l.until);
			const claimOpen = now >= from && now <= Date.parse(l.until) + CLAIM_GRACE_MS;
			return {
				id: l.id, value: stats[l.stat], target: l.target, open, claimed: claimed.has(l.id),
				claimable: claimOpen && !claimed.has(l.id) && stats[l.stat] >= l.target,
			};
		}),
	};
}

async function claimedSet(db, user) {
	const rows = await db.collection('user_badges').find({ user }, { projection: { _id: 0, badge: 1 } }).toArray();
	return new Set(rows.map((r) => r.badge));
}

let indexReady = null;

/** Unique {user, badge}: a badge can be held once. Older duplicates make this fail; logged. */
function ensureIndexes(db) {
	if (!indexReady) {
		indexReady = db.collection('user_badges').createIndex({ user: 1, badge: 1 }, { unique: true })
			.catch((err) => console.log('user_badges unique index not created (older duplicates?): '
				+ (err && err.message ? err.message : err)));
	}
	return indexReady;
}

function resetForTests() {
	cache.clear();
	inFlight.clear();
	indexReady = null;
}

module.exports = {
	FAMILIES, LIMITED, MAX_DAY_STEPS, MIN_ARENA_FIELD, CLAIM_GRACE_MS,
	catalog, reportDay, validDay, longestStreak, reportStats, arenaStats, userStats, parseBadge, canClaim, progress,
	claimedSet, ensureIndexes, resetForTests,
};
