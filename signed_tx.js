/**
 * A verified Hive transaction (a row in `verified_tx`) authorises ONE action, shortly after
 * it was signed.
 *
 * - Only rows recorded from the Hive chain count.
 * - Age is judged by the transaction's own expiration (set at signing, at most 1h ahead),
 *   so an old transaction cannot be made fresh by recording it again later.
 * - The claim is an insert into `consumed_tx` keyed by the transaction id. `_id` is unique,
 *   so exactly one claim wins even if the transaction was recorded more than once.
 * - If a signer is flagged in `key_rotation_required`, the transaction must come from a
 *   block after that account's key change (`rotated_block`): one from before may have been
 *   signed with the old, possibly exposed key. A still-active flag refuses it outright.
 *   Gadget transactions are exempt (KEY_ROTATION_EXEMPT).
 */

const SIGNED_TX_MAX_AGE_MS = 6 * 60 * 60 * 1000;

// Gadget buys, activations and deactivations act only on the signer's own AFIT and gadgets,
// so they are accepted from a flagged signer too (an owner decision, activations that name
// a reward beneficiary included).
const KEY_ROTATION_EXEMPT = new Set(['buy-gadget', 'activate-gadget', 'deactivate-gadget']);
const { SIGNED_TX_HOLD_MS } = require('./key_rotation');

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
		if (!KEY_ROTATION_EXEMPT.has(purpose) && !(await signedAfterKeyChange(db, row.tx, now))) {
			console.log('claimVerifiedTx: ' + id + ' is from before a signer key change; refused');
			return false;
		}
		await db.collection('consumed_tx').insertOne({ _id: id, purpose, at: new Date(now()) });
		return true;
	} catch (err) {
		if (err && err.code === 11000) return false; // already claimed
		console.log('claimVerifiedTx failed for ' + id + ' - ' + (err && err.message ? err.message : err));
		return false;
	}
}

// Accounts whose POSTING authority a transaction relies on. Only posting keys were
// exposed, so active-key operations (transfers, required_auths) are not counted: a
// flagged user can still pay with HIVE.
const POSTING_OP_SIGNER = { vote: 'voter', comment: 'author', comment_options: 'author', delete_comment: 'author' };
function txSigners(tx) {
	const out = new Set();
	for (const entry of (tx && Array.isArray(tx.operations)) ? tx.operations : []) {
		if (!Array.isArray(entry)) continue;
		const [type, op] = entry;
		if (!op || typeof op !== 'object') continue;
		for (const a of [].concat(op.required_posting_auths || [])) out.add(String(a));
		const k = POSTING_OP_SIGNER[type];
		if (k && typeof op[k] === 'string') out.add(op[k]);
	}
	return [...out];
}

// false when a flagged signer's key change is newer than the transaction's block.
// Once SIGNED_TX_HOLD_MS has passed since the clear, any transaction signed with the old
// key has expired out of the claim window (expiration <= key change + 1h, and claims need
// expiration within SIGNED_TX_MAX_AGE_MS), so the block rule no longer applies.
async function signedAfterKeyChange(db, tx, now = Date.now) {
	const signers = txSigners(tx);
	if (!signers.length) return true;
	const flags = await db.collection('key_rotation_required').find({ user: { $in: signers } }).toArray();
	if (!flags.length) return true;
	const block = Number(tx && tx.block_num);
	for (const f of flags) {
		const active = !(f.cleared_at instanceof Date)
			|| (f.since instanceof Date && f.since.getTime() > f.cleared_at.getTime());
		if (active) return false;
		if (now() - f.cleared_at.getTime() >= SIGNED_TX_HOLD_MS) continue;
		if (!Number.isInteger(f.rotated_block)) return false; // key-change block unknown: refuse until the hold has passed
		if (!(Number.isInteger(block) && block > f.rotated_block)) return false;
	}
	return true;
}

function normalizeAccountName(name) {
	return String(name == null ? '' : name).replace(/^@/, '').trim().toLowerCase();
}

module.exports = { claimVerifiedTx, normalizeAccountName, txSigners, signedAfterKeyChange, SIGNED_TX_MAX_AGE_MS };
