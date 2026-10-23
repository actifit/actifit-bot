/**
 * A verified Hive transaction (a row in `verified_tx`) authorises ONE action, shortly after
 * it was signed.
 *
 * - Only rows recorded from the Hive chain count.
 * - Age is judged by the transaction's own expiration (set at signing, at most 1h ahead),
 *   so an old transaction cannot be made fresh by recording it again later.
 * - The claim is an insert into `consumed_tx` keyed by the transaction id. `_id` is unique,
 *   so exactly one claim wins even if the transaction was recorded more than once.
 */

const SIGNED_TX_MAX_AGE_MS = 6 * 60 * 60 * 1000;

// Chain timestamps are UTC ISO strings without a zone ("2026-10-23T10:00:00"), which
// compare correctly as strings.
function chainTimestamp(ms) {
	return new Date(ms).toISOString().slice(0, 19);
}

/**
 * @returns {Promise<boolean>} true only for the first claim of a recent Hive transaction
 */
async function claimVerifiedTx(db, tx_id, purpose, now = Date.now) {
	const id = String(tx_id);
	try {
		const row = await db.collection('verified_tx').findOne({
			tx_id: id,
			chain: 'HIVE',
			date: { $gte: new Date(now() - SIGNED_TX_MAX_AGE_MS) },
			'tx.expiration': { $gte: chainTimestamp(now() - SIGNED_TX_MAX_AGE_MS) },
		});
		if (!row) return false;
		await db.collection('consumed_tx').insertOne({ _id: id, purpose, at: new Date(now()) });
		return true;
	} catch (err) {
		if (err && err.code === 11000) return false; // already claimed
		console.log('claimVerifiedTx failed for ' + id + ' - ' + (err && err.message ? err.message : err));
		return false;
	}
}

function normalizeAccountName(name) {
	return String(name == null ? '' : name).replace(/^@/, '').trim().toLowerCase();
}

module.exports = { claimVerifiedTx, normalizeAccountName, SIGNED_TX_MAX_AGE_MS };
