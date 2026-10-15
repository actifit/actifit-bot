/**
 * Challenge Engine — user-facing notifications (Trello #56, mobile phase 3).
 *
 * The engine already records lifecycle events in `arena_events` (§9). This module turns
 * the two worth interrupting someone for into real notifications — the inbox entry the
 * apps list plus a phone push — through an injected `notify` hook (app.js passes
 * utils.sendNotification), so this file stays config/Firebase-free and unit-testable:
 *
 *   - arena_results: a rewarded finisher's outcome, sent from the resolution sweep.
 *   - arena_closing: a joined multi-day challenge ends within a few hours and the user
 *     has not posted a report today. Sent at most once per (user, challenge); the
 *     `window_closing` arena event doubles as the dedupe record.
 *
 * Both skip challenges shorter than two days (Daily Focus closes and pays every day, so
 * either message would become a daily nag) and squad challenges (a squad id is not a
 * user who can receive a notification).
 *
 * Only OFFICIAL, PUBLIC challenges are named in the text. Any user can create a challenge,
 * and its title would otherwise arrive as an official-looking Actifit push (a phishing
 * vector); and the inbox is readable by username without login, so a non-public
 * challenge's title must not land there. Those get generic wording — the link still opens
 * the challenge.
 *
 * Every notification links to https://actifit.io/arena/<id>; the apps open their native
 * challenge screen for that URL and the web opens the page.
 */

'use strict';

const arenaApi = require('./arena_api');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const TYPE_RESULTS = 'arena_results';
const TYPE_CLOSING = 'arena_closing';
// The notifications settings category, so users can switch these off like any other.
const CATEGORY = 'arena';

function challengeUrl(id) {
	return 'https://actifit.io/arena/' + encodeURIComponent(id);
}

const MIN_WINDOW_MS = 2 * DAY;

/** Whether a challenge is one we notify about at all (see the header). */
function notifiable(ch, minWindowMs = MIN_WINDOW_MS) {
	if (!ch || (ch.participants_kind || 'user') !== 'user') return false;
	const start = Date.parse(ch.window && ch.window.start);
	const end = Date.parse(ch.window && ch.window.end);
	return Number.isFinite(start) && Number.isFinite(end) && end - start >= minWindowMs;
}

const MAX_TITLE_CHARS = 80;

/** The title to quote, or null when the challenge must not be named (see the header). */
function quotableTitle(ch) {
	if (!ch || ch.origin_tier !== 'official' || ch.visibility !== 'public') return null;
	const raw = typeof ch.title === 'string' && ch.title.trim() ? ch.title : ch.id;
	if (typeof raw !== 'string') return null;
	// eslint-disable-next-line no-control-regex
	const clean = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
	if (!clean) return null;
	return clean.length > MAX_TITLE_CHARS ? clean.slice(0, MAX_TITLE_CHARS - 1).trimEnd() + '…' : clean;
}

function formatAfit(n) {
	const v = Number(n) || 0;
	return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/\.?0+$/, '');
}

/** "You finished #2 in "Weekly Step League" and earned 60 AFIT and the "X" badge." */
function resultsMessage(ch, { rank, afit, badges } = {}) {
	const prizes = [];
	if (Number(afit) > 0) prizes.push(formatAfit(afit) + ' AFIT');
	const named = (Array.isArray(badges) ? badges : []).filter((b) => typeof b === 'string' && b.trim());
	if (named.length === 1) prizes.push('the "' + named[0] + '" badge');
	else if (named.length > 1) prizes.push(named.length + ' badges');
	const earned = prizes.length ? ' and earned ' + prizes.join(' and ') : '';
	const title = quotableTitle(ch);
	const where = title ? '"' + title + '"' : 'an Arena challenge';
	return Number.isInteger(rank) && rank > 0
		? 'You finished #' + rank + ' in ' + where + earned + '.'
		: 'Results are in for ' + where + ': you earned ' + (prizes.join(' and ') || 'a reward') + '.';
}

function closingMessage(ch, hoursLeft) {
	const h = Math.max(1, Math.round(hoursLeft));
	const title = quotableTitle(ch);
	return (title ? '"' + title + '"' : 'An Arena challenge you joined') + ' ends in about ' + h
		+ (h === 1 ? ' hour' : ' hours') + '. Post today\'s report so your activity counts.';
}

/** Sends one arena_results notification per rewarded finisher. Never throws. */
async function notifyResults(ch, rewards, rankByEntity, opts = {}) {
	const notify = typeof opts.notify === 'function' ? opts.notify : null;
	const log = typeof opts.log === 'function' ? opts.log : () => {};
	if (!notify || !notifiable(ch)) return 0;
	let sent = 0;
	for (const rw of rewards || []) {
		if (!rw || !rw.entity) continue;
		const badges = Array.isArray(rw.badges) ? rw.badges : [];
		if (!(Number(rw.afit) > 0 || badges.length > 0)) continue;
		try {
			await notify({
				user: rw.entity,
				type: TYPE_RESULTS,
				category: CATEGORY,
				details: resultsMessage(ch, { rank: rankByEntity && rankByEntity.get(rw.entity), afit: rw.afit, badges }),
				url: challengeUrl(ch.id),
			});
			sent++;
		} catch (e) {
			log(`arena notify: results for ${rw.entity} on ${ch.id} failed: ${e && e.message}`);
		}
	}
	return sent;
}

/**
 * Reminds participants of joined multi-day challenges that close within `hoursBefore`
 * and who have not posted a verified report today (UTC). Idempotent per (user,
 * challenge) via the `window_closing` arena event.
 */
async function notifyClosingSoon(db, opts = {}) {
	const notify = typeof opts.notify === 'function' ? opts.notify : null;
	const log = typeof opts.log === 'function' ? opts.log : () => {};
	if (!notify) return { ok: false, reason: 'no notify hook' };
	const nowMs = Number.isFinite(opts.now) ? opts.now : Date.now();
	const hoursBefore = Number.isFinite(opts.hoursBefore) && opts.hoursBefore > 0 ? opts.hoursBefore : 12;
	const minWindowMs = Number.isFinite(opts.minWindowDays) && opts.minWindowDays > 0 ? opts.minWindowDays * DAY : MIN_WINDOW_MS;
	const maxPerRun = Number.isInteger(opts.maxPerRun) && opts.maxPerRun > 0 ? opts.maxPerRun : 500;
	const dayStart = new Date(nowMs);
	dayStart.setUTCHours(0, 0, 0, 0);

	const challenges = await db.collection('challenges').find({ state: { $in: ['open', 'active'] } }).toArray();
	let notified = 0, alreadySent = 0, postedToday = 0, optedOut = 0;
	for (const ch of challenges) {
		if (!notifiable(ch, minWindowMs)) continue;
		const end = Date.parse(ch.window.end);
		if (end <= nowMs || end - nowMs > hoursBefore * HOUR) continue;

		const parts = (await db.collection(arenaApi.COLLECTIONS.PARTICIPANTS).find({ challenge_id: ch.id }).toArray())
			.filter((p) => p && p.entity && p.state !== 'left');
		if (!parts.length) continue;
		// Two queries per challenge, not two per participant: who was already reminded,
		// and who already posted today (their activity is in — nothing to act on).
		const reminded = new Set((await db.collection(arenaApi.COLLECTIONS.EVENTS)
			.find({ type: 'window_closing', challenge_id: ch.id }).toArray()).map((e) => e.user));
		const posted = new Set((await db.collection('verified_posts')
			.find({ author: { $in: parts.map((p) => p.entity) }, date: { $gte: dayStart } }, { projection: { author: 1 } })
			.toArray()).map((v) => v.author));

		for (const p of parts) {
			if (notified >= maxPerRun) return { ok: true, notified, alreadySent, postedToday, optedOut, capped: true };
			if (reminded.has(p.entity)) { alreadySent++; continue; }
			if (posted.has(p.entity)) { postedToday++; continue; }

			const hoursLeft = (end - nowMs) / HOUR;
			try {
				// Record first: a failed push must not turn into a reminder on every tick.
				// Without the record there is no dedupe, so don't send at all.
				const rec = await arenaApi.emitEvent(db, {
					type: 'window_closing', user: p.entity, challenge_id: ch.id,
					data: { hours_left: Math.round(hoursLeft) }, at: new Date(nowMs).toISOString(),
				});
				if (!rec || !rec.ok) {
					log(`arena notify: could not record closing reminder for ${p.entity} on ${ch.id}: ${rec && rec.reason}`);
					continue;
				}
				const delivered = await notify({
					user: p.entity,
					type: TYPE_CLOSING,
					category: CATEGORY,
					details: closingMessage(ch, hoursLeft),
					url: challengeUrl(ch.id),
				});
				if (delivered === false) optedOut++;
				else notified++;
			} catch (e) {
				log(`arena notify: closing reminder for ${p.entity} on ${ch.id} failed: ${e && e.message}`);
			}
		}
	}
	return { ok: true, notified, alreadySent, postedToday, optedOut };
}

module.exports = {
	TYPE_RESULTS,
	TYPE_CLOSING,
	CATEGORY,
	challengeUrl,
	quotableTitle,
	resultsMessage,
	closingMessage,
	notifyResults,
	notifyClosingSoon,
};
