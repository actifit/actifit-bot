/**
 * 3Speak video uploads through the embed service (https://embed.3speak.tv).
 *
 * 3Speak issues one API key per app. The key stays on this server: the Android app asks
 * for a short-lived, single-use upload token for the logged-in user, then uploads the
 * file straight to 3Speak with it (TUS). Each issued token is recorded so a user can see
 * their uploads on any device, and so one account cannot burn through the app's key.
 */

const EMBED_BASE = 'https://embed.3speak.tv';
const FRONTEND_APP = 'actifit';
const DAILY_LIMIT = 10;
const DAY_MS = 24 * 60 * 60 * 1000;
const TOKEN_TTL_S = 600;
const FETCH_TIMEOUT_MS = 15000;
const COLLECTION = 'threespeak_uploads';

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

/** {user, created} serves both the daily count and the list. Async, never throws. */
function ensureUploadIndexes(db) {
	try {
		const col = db.collection(COLLECTION);
		if (typeof col.createIndex !== 'function') return;
		Promise.resolve(col.createIndex({ user: 1, created: -1 })).catch((e) => console.log('threespeak_uploads index: ' + e.message));
	} catch (e) {
		console.log('threespeak_uploads index: ' + e.message);
	}
}

module.exports = { EMBED_BASE, FRONTEND_APP, DAILY_LIMIT, COLLECTION, fetchToken, issueUploadToken, listUploads, ensureUploadIndexes };
