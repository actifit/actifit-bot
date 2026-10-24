/**
 * Session tokens are stored only as a SHA-256 hash (`token_hash` in user_login_token).
 * The raw token is returned to the client once and never saved, so reading the
 * database does not yield usable sessions.
 *
 * Rows written before this change hold the raw token in `token`. They are still matched,
 * but a token is only accepted while its JWT is valid (24 hours). Rows kept by "keep me
 * logged in" are not cleaned up on their own, so the existing rows are migrated to
 * `token_hash` once after deploy.
 */

const crypto = require('crypto');

function hashToken(token) {
	return crypto.createHash('sha256').update(String(token)).digest('hex');
}

// Mongo filter for the session row of `user` holding `token`.
function sessionFilter(user, token) {
	const t = String(token);
	return { user: String(user), $or: [{ token_hash: hashToken(t) }, { token: t }] };
}

module.exports = { hashToken, sessionFilter };
