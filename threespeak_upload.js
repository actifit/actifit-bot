/**
 * 3Speak video uploads through the embed service (https://embed2.3speak.tv, 3Speak's primary
 * upload host; embed.3speak.tv is their slower fallback and cannot resume uploads).
 *
 * 3Speak issues one API key per app. The key stays on this server: the Android app asks
 * for a short-lived, single-use upload token for the logged-in user, then uploads the
 * file straight to 3Speak with it (TUS). Each issued token is recorded so a user can see
 * their uploads on any device, and so one account cannot burn through the app's key.
 *
 * 3Speak requires every video to be linked to its Hive post (POST /video/:permlink/hive)
 * or it never shows in their feeds. That call needs the key, so this server does it:
 * linkPendingUploads() finds recent uploads whose report post is now on chain and links
 * them, retrying on its next run until 3Speak accepts. The app's report post uses the
 * video's permlink, so the post is always at @user/<video permlink>.
 */

const EMBED_BASE = 'https://embed2.3speak.tv';
const FRONTEND_APP = 'actifit';
const DAILY_LIMIT = 10;
const DAY_MS = 24 * 60 * 60 * 1000;
const TOKEN_TTL_S = 600;
const FETCH_TIMEOUT_MS = 15000;
const COLLECTION = 'threespeak_uploads';
const LINK_WINDOW_MS = 3 * DAY_MS; // stop looking for a report post after this
const LINK_BATCH = 50;

/** Asks 3Speak for an upload token. Returns the parsed body, or throws with .status set. */
async function fetchToken(apiKey, owner, short, fetchImpl = fetch) {
	const res = await fetchImpl(EMBED_BASE + '/uploads/token', {
		method: 'POST',
		headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
		body: JSON.stringify({ owner, frontend_app: FRONTEND_APP, short: !!short, ttl: TOKEN_TTL_S }),
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	let body = null;
	try { body = await res.json(); } catch (e) { /* non-JSON error page */ }
	if (!res.ok || !body || !body.token || !body.permlink) {
		const err = new Error('3Speak token request failed: HTTP ' + res.status
			+ (body && body.error ? ' ' + String(body.error).slice(0, 200) : ''));
		err.status = res.status;
		throw err;
	}
	return body;
}

/**
 * Issues an upload token for `user`. Returns { status, body } for the route to send.
 * Fails closed when no key is configured, and limits each account to DAILY_LIMIT a day.
 * The slot is reserved before 3Speak is called, so parallel requests cannot all pass the
 * check; a failed request gives its slot back.
 */
async function issueUploadToken(db, user, { apiKey, short = false, fetchImpl, now = Date.now } = {}) {
	if (!apiKey) return { status: 503, body: { error: 'Video uploads are not available right now' } };
	const col = db.collection(COLLECTION);
	const { insertedId } = await col.insertOne({ user, short: !!short, created: new Date(now()) });
	const release = () => col.deleteOne({ _id: insertedId }).catch(() => {});
	const used = await col.countDocuments({ user, created: { $gte: new Date(now() - DAY_MS) } });
	if (used > DAILY_LIMIT) {
		await release();
		return { status: 429, body: { error: 'Daily video upload limit reached, please try again tomorrow' } };
	}
	let tk;
	try {
		tk = await fetchToken(apiKey, user, short, fetchImpl);
	} catch (err) {
		await release();
		console.log('3speak upload token: ' + err.message);
		return { status: 502, body: { error: '3Speak video service is unavailable right now, please try again later' } };
	}
	const embedUrl = tk.embed_url || ('https://play.3speak.tv/embed?v=' + user + '/' + tk.permlink);
	await col.updateOne({ _id: insertedId }, { $set: { permlink: tk.permlink, embed_url: embedUrl } });
	return {
		status: 200,
		body: {
			token: tk.token,
			upload_url: tk.upload_url || EMBED_BASE + '/uploads',
			permlink: tk.permlink,
			embed_url: embedUrl,
			expires_at: tk.expires_at,
		},
	};
}

/** The user's most recent upload tokens (newest first), for the app's "my videos" list. */
async function listUploads(db, user, limit = 20) {
	const rows = await db.collection(COLLECTION)
		.find({ user, permlink: { $exists: true } }, { projection: { _id: 0, permlink: 1, embed_url: 1, short: 1, created: 1 } })
		.sort({ created: -1 }).limit(limit).toArray();
	return rows;
}

/** Tells 3Speak which Hive post a video belongs to. Throws with .status on failure. */
async function linkToPost(apiKey, permlink, post, fetchImpl = fetch) {
	let tags = [];
	try {
		const meta = JSON.parse(post.json_metadata || '{}');
		if (Array.isArray(meta.tags)) tags = meta.tags.filter((t) => typeof t === 'string').slice(0, 10);
	} catch (e) { /* no tags */ }
	const res = await fetchImpl(EMBED_BASE + '/video/' + encodeURIComponent(permlink) + '/hive', {
		method: 'POST',
		headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
		body: JSON.stringify({
			hive_author: post.author,
			hive_permlink: post.permlink,
			hive_title: post.title || '',
			hive_body: post.body || '',
			hive_tags: tags,
		}),
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (!res.ok) {
		let detail = '';
		try { detail = String((await res.json()).error || '').slice(0, 200); } catch (e) { /* not JSON */ }
		const err = new Error('3Speak link failed: HTTP ' + res.status + (detail ? ' ' + detail : ''));
		err.status = res.status;
		throw err;
	}
}

/**
 * Links each recent, not yet linked upload whose report post exists. `getContent(author,
 * permlink)` reads Hive (condenser get_content; a missing post comes back with an empty
 * author). Uploads never used in a report are simply skipped until they age out.
 * Returns { checked, linked, failed }.
 */
async function linkPendingUploads(db, { apiKey, getContent, fetchImpl, now = Date.now } = {}) {
	const out = { checked: 0, linked: 0, failed: 0 };
	if (!apiKey) return out;
	const col = db.collection(COLLECTION);
	const rows = await col.find(
		{ permlink: { $exists: true }, linked: { $exists: false }, created: { $gte: new Date(now() - LINK_WINDOW_MS) } },
		{ projection: { user: 1, permlink: 1 } },
	).sort({ created: -1 }).limit(LINK_BATCH).toArray();
	for (const row of rows) {
		out.checked++;
		try {
			const post = await getContent(row.user, row.permlink);
			// the post must be the uploader's own, at the video's permlink
			if (!post || post.author !== row.user || post.permlink !== row.permlink) continue;
			await linkToPost(apiKey, row.permlink, post, fetchImpl);
			await col.updateOne({ _id: row._id }, { $set: { linked: new Date(now()) } });
			out.linked++;
		} catch (err) {
			out.failed++;
			console.log('3speak link ' + row.user + '/' + row.permlink + ': ' + err.message);
		}
	}
	return out;
}

/** Indexes for the daily count, the list and the linker. Async, never throws. */
function ensureUploadIndexes(db) {
	try {
		const col = db.collection(COLLECTION);
		if (typeof col.createIndex !== 'function') return;
		Promise.resolve(col.createIndex({ user: 1, created: -1 })).catch((e) => console.log('threespeak_uploads index: ' + e.message));
		// the linker's scan of recent uploads
		Promise.resolve(col.createIndex({ created: -1 })).catch((e) => console.log('threespeak_uploads index: ' + e.message));
	} catch (e) {
		console.log('threespeak_uploads index: ' + e.message);
	}
}

module.exports = {
	EMBED_BASE, FRONTEND_APP, DAILY_LIMIT, COLLECTION,
	fetchToken, issueUploadToken, listUploads, linkToPost, linkPendingUploads, ensureUploadIndexes,
};
