/**
 * A verified posting-signed transaction (a row in `verified_tx`) authorises ONE action,
 * shortly after it was recorded. Claiming is atomic, so the same transaction cannot be
 * used twice, and transactions recorded long ago are refused.
 */

const SIGNED_TX_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * @returns {Promise<boolean>} true only for the first claim of a recent, unclaimed row
 */
async function claimVerifiedTx(db, tx_id, purpose, now = Date.now) {
	try {
		const res = await db.collection('verified_tx').findOneAndUpdate(
			{ tx_id: String(tx_id), consumed_for: { $exists: false }, date: { $gte: new Date(now() - SIGNED_TX_MAX_AGE_MS) } },
			{ $set: { consumed_for: purpose, consumed_at: new Date(now()) } }
		);
		// driver 5 returns { value }; driver 6 returns the document itself
		const doc = res && Object.prototype.hasOwnProperty.call(res, 'value') ? res.value : res;
		return !!doc;
	} catch (err) {
		console.log('claimVerifiedTx failed for ' + tx_id + ' - ' + (err && err.message ? err.message : err));
		return false;
	}
}

function normalizeAccountName(name) {
	return String(name == null ? '' : name).replace(/^@/, '').trim().toLowerCase();
}

module.exports = { claimVerifiedTx, normalizeAccountName, SIGNED_TX_MAX_AGE_MS };
