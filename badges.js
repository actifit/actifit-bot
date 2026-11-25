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
// Arena podiums and wins only count in public challenges with at least this many finishers,
// so two friends can't farm them in a private 1v1
const MIN_ARENA_FIELD = 5;
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
		desc: 'Try different activity types in your reports.' },
	{ id: 'contender', name: 'Contender', stat: 'arenaJoined', unit: 'Arena challenges joined', tiers: [1, 10, 50],
		desc: 'Join public Arena challenges.' },
	{ id: 'podium', name: 'Podium', stat: 'arenaPodiums', unit: 'top-3 finishes', tiers: [1, 5, 20],
		desc: 'Finish in the top 3 of a public Arena challenge with at least ' + MIN_ARENA_FIELD + ' finishers.' },
	{ id: 'champion', name: 'Champion', stat: 'arenaWins', unit: 'Arena wins', tiers: [1, 10],
		desc: 'Win a public Arena challenge with at least ' + MIN_ARENA_FIELD + ' finishers.' },
	{ id: 'big_heart', name: 'Big Heart', stat: 'charityReports', unit: 'charity reports', tiers: [1, 10, 50],
		desc: 'Send your report rewards to charity.' },
];

const LIMITED = [
	{ id: 'endorphin_rush', name: 'Endorphin Rush', stat: 'endorphinReports', unit: 'report days', target: 20,
		from: '2026-11-21T00:00:00Z', until: '2026-12-31T23:59:59Z',
		desc: 'Limited edition: post reports on 20 different days before the end of 2026.' },
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
			art: '/img/badges/' + l.id + '.png',
		})),
	};
}

const one = (v) => (Array.isArray(v) ? v[0] : v);

/** The report's day as YYYYMMDD: the app's activity date, else the day the server got it (UTC). */
function reportDay(post) {
	const md = post.json_metadata || {};
	const d = String(one(md.activityDate) || '');
	if (/^\d{8}$/.test(d)) return d;
	const at = post.date ? new Date(post.date) : null;
	return at && !isNaN(at) ? at.toISOString().slice(0, 10).replace(/-/g, '') : null;
}

function dayIndex(yyyymmdd) {
	return Date.UTC(+yyyymmdd.slice(0, 4), +yyyymmdd.slice(4, 6) - 1, +yyyymmdd.slice(6, 8)) / 86400000;
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

/** Report-based stats from a user's verified_posts documents (pure, for tests). */
function reportStats(posts, now = Date.now()) {
	const daySteps = new Map();
	const types = new Set();
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
		for (const t of String(one(md.activity_type) || '').split(',')) {
			const name = t.trim().toLowerCase();
			if (name) types.add(name);
		}
		const v = md.video;
		if (v && typeof v === 'object' && v.info && v.info.permlink) videoReports++;
		if (one(md.charity)) charityReports++;
		// the limited window uses the server's receive time, so reports can't be backdated
		const at = p.date ? new Date(p.date).getTime() : NaN;
		if (at >= rushFrom && at <= rushUntil) rushDays.add(day);
	}
	let lifetimeSteps = 0;
	let bestDay = 0;
	for (const s of daySteps.values()) {
		lifetimeSteps += s;
		if (s > bestDay) bestDay = s;
	}
	return {
		longestStreak: longestStreak([...daySteps.keys()]),
		lifetimeSteps, bestDay, activityTypes: types.size, videoReports, charityReports,
		endorphinReports: rushDays.size,
	};
}

/** Arena stats from the user's participations and their challenges (pure, for tests). */
function arenaStats(participations, challengesById, finishersById) {
	let arenaJoined = 0;
	let arenaPodiums = 0;
	let arenaWins = 0;
	for (const p of participations) {
		const ch = challengesById.get(p.challenge_id);
		if (!ch || ch.visibility !== 'public' || p.state === 'left') continue;
		arenaJoined++;
		if (p.state !== 'settled' || !p.result || (finishersById.get(p.challenge_id) || 0) < MIN_ARENA_FIELD) continue;
		const rank = Number(p.result.rank);
		if (rank >= 1 && rank <= 3) arenaPodiums++;
		if (rank === 1) arenaWins++;
	}
	return { arenaJoined, arenaPodiums, arenaWins };
}

const cache = new Map();

/** Every stat the rules need for `user`, cached for 10 minutes. */
async function userStats(db, user, now = Date.now()) {
	const hit = cache.get(user);
	if (hit && now - hit.at < STATS_TTL_MS) return hit.stats;
	const posts = await db.collection('verified_posts').find({ author: user }, {
		projection: {
			_id: 0, date: 1, 'json_metadata.step_count': 1, 'json_metadata.activity_type': 1,
			'json_metadata.activityDate': 1, 'json_metadata.video': 1, 'json_metadata.charity': 1,
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
			projection: { _id: 0, id: 1, visibility: 1 },
		}).toArray();
		for (const c of chs) challengesById.set(c.id, c);
		const counts = await db.collection('challenge_participants').aggregate([
			{ $match: { challenge_id: { $in: ids }, state: 'settled' } },
			{ $group: { _id: '$challenge_id', n: { $sum: 1 } } },
		]).toArray();
		for (const c of counts) finishersById.set(c._id, c.n);
	}
	const stats = Object.assign(reportStats(posts, now), arenaStats(participations, challengesById, finishersById));
	if (cache.size >= STATS_CACHE_MAX) cache.delete(cache.keys().next().value);
	cache.set(user, { at: now, stats });
	return stats;
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
		if (now < Date.parse(b.limited.from) || now > Date.parse(b.limited.until)) {
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
			const open = now >= Date.parse(l.from) && now <= Date.parse(l.until);
			return {
				id: l.id, value: stats[l.stat], target: l.target, open, claimed: claimed.has(l.id),
				claimable: open && !claimed.has(l.id) && stats[l.stat] >= l.target,
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
	indexReady = null;
}

module.exports = {
	FAMILIES, LIMITED, MAX_DAY_STEPS, MIN_ARENA_FIELD,
	catalog, reportDay, longestStreak, reportStats, arenaStats, userStats, parseBadge, canClaim, progress,
	claimedSet, ensureIndexes, resetForTests,
};
