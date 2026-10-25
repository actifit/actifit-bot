/**
 * GET /fetchUserData - restore a logged-in session on page load.
 *
 * Runs after checkHdrs, which has already authenticated the session: a valid JWT whose
 * hash is in user_login_token, for this user. That IS the proof of login.
 *
 * This route used to "re-validate" by decrypting the posting key stored with the
 * session and checking it against the chain. Since the signed-challenge login, no key
 * is stored at all, so that check failed for every session - and the website treats a
 * failed /fetchUserData as a dead session and logs the user out. Typed-key users were
 * logged out on every page load.
 *
 * The account comes from the chain, as public data. No key is needed or used.
 */

function createFetchUserDataHandler({ getAccountData }) {
	return async function fetchUserData(req, res) {
		// checkHdrs overwrites req.query.user with the token's verified username
		const username = req.query && req.query.user;
		const bchain = (req.query && req.query.bchain) || 'HIVE';
		try {
			const account = await getAccountData(username, bchain);
			const acct = account && account[bchain];
			if (!acct || acct.name !== username) {
				// a node problem, not a bad session
				return res.status(503).json({ success: false, message: 'Account data temporarily unavailable' });
			}
			return res.json({ success: true, userdata: acct });
		} catch (err) {
			console.log('fetchUserData: ' + (err && err.message ? err.message : err));
			return res.status(503).json({ success: false, message: 'Account data temporarily unavailable' });
		}
	};
}

module.exports = { createFetchUserDataHandler };
