/**
 * A verified transaction (a row in `verified_tx`) authorises ONE action, shortly after it
 * was signed. Claiming is atomic, so the same transaction cannot be used twice. Age is
 * judged by the transaction's own expiration (set at signing, at most 1h ahead), so an
 * old transaction cannot be made fresh by recording it again later.
 */

const SIGNED_TX_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * @returns {Promise<boolean>} true only for the first claim of a recent, unclaimed row
 */
// Chain timestamps are UTC ISO strings without a zone ("2026-10-23T10:00:00"), which
// compare correctly as strings.
function chainTimestamp(ms) {
	return new Date(ms).toISOString().slice(0, 19);
}

async function claimVerifiedTx(db, tx_id, purpose, now = Date.now) {
	try {
		const res = await db.collection('verified_tx').findOneAndUpdate(
			{
				tx_id: String(tx_id),
				consumed_for: { $exists: false },
				date: { $gte: new Date(now() - SIGNED_TX_MAX_AGE_MS) },
				'tx.expiration': { $gte: chainTimestamp(now() - SIGNED_TX_MAX_AGE_MS) },
			},
			{ $set: { consumed_for: purpose, consumed_at: new Date(now()) } }
		);
		// driver 5 returns { value }; driver 6 returns the document itself
		const doc = res && Object.prototype.hasOwnProperty.call(res, 'value') ? res.value : res;
		if (!doc) return false;
		// verified_tx can hold the same transaction more than once (concurrent recording);
		// only the first claim across all of its rows may act.
		const claimed = await db.collection('verified_tx').countDocuments({ tx_id: String(tx_id), consumed_for: { $exists: true } });
		return claimed === 1;
	} catch (err) {
		console.log('claimVerifiedTx failed for ' + tx_id + ' - ' + (err && err.message ? err.message : err));
		return false;
	}
}

function normalizeAccountName(name) {
	return String(name == null ? '' : name).replace(/^@/, '').trim().toLowerCase();
}

module.exports = { claimVerifiedTx, normalizeAccountName, SIGNED_TX_MAX_AGE_MS };
