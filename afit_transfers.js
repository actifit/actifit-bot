/**
 * AFIT transfers that leave a user's Actifit balance:
 *   - tipAccount       : send AFIT to another Actifit user (off-chain ledger)
 *   - initiateAfitMove : record a standing daily order to move AFIT to Hive-Engine
 *   - signTransfer / sendAndResolve : the Hive-Engine transfer used by the daily move job,
 *     with a known transaction id so the outcome can be checked before any refund.
 *
 * Every dependency (db, config, chain clients, locks, notifications) is passed in, so the
 * module is load-time safe and testable without a database or a chain.
 */

'use strict';

const dhive = require('@hiveio/dhive');
const afitBalance = require('./afit_balance');

// Off-chain AFIT balances are kept to 3 decimals.
const AFIT_DECIMALS = 3;
const AFIT_STRING = /^\d+(\.\d{1,3})?$/;
const MAX_NOTE_LENGTH = 500;
const HE_CONTRACT_ID = 'ssc-mainnet-hive';

/**
 * An AFIT amount from a request: a finite number > 0 with at most 3 decimals, or null.
 * Accepts a number or a plain decimal string (no sign, exponent or spaces).
 */
function afitAmount(value) {
	if (typeof value === 'string') {
		if (!AFIT_STRING.test(value)) return null;
	} else if (typeof value !== 'number') {
		return null;
	}
	const n = afitBalance.positiveAmount(value);
	if (n === null) return null;
	const scaled = n * 1000;
	if (Math.abs(scaled - Math.round(scaled)) > 1e-6) return null;
	const rounded = Number(n.toFixed(AFIT_DECIMALS));
	return rounded > 0 ? rounded : null;
}

/** A config value as a finite number >= 0, or null when missing / not numeric. */
function configAmount(config, key) {
	const n = afitBalance.finiteAmount(config ? config[key] : undefined);
	return n !== null && n >= 0 ? n : null;
}

/**
 * The limits the AFIT move depends on, or null when any is missing or invalid (callers
 * then refuse to proceed: a missing limit must never mean "no limit").
 */
function moveLimits(config) {
	const maxPerDay = configAmount(config, 'max_afit_to_se_day');
	const freePerDay = configAmount(config, 'free_movable_afit_day');
	const ratio = configAmount(config, 'afitx_afit_move_ratio');
	if (maxPerDay === null || maxPerDay <= 0 || freePerDay === null || ratio === null || ratio <= 0) return null;
	return { maxPerDay, freePerDay, ratio };
}

/** AFITX needed to move `amount` AFIT a day (0 up to the free allowance). */
function afitxRequired(amount, limits) {
	return Math.max(0, (amount - limits.freePerDay) / limits.ratio);
}

/** Why the AFITX balance does not allow moving `amount`, or null when it does. */
function afitxShortfall(amount, afitxBalance, limits) {
	if (amount <= limits.freePerDay) return null;
	if (!(afitxBalance >= 0.1)) return 'min_afitx';
	if (afitxRequired(amount, limits) > afitxBalance) return 'afitx_ratio';
	return null;
}

function withTimeout(promise, ms, label) {
	let t;
	const timer = new Promise((_, reject) => {
		t = setTimeout(() => reject(new Error('timed out after ' + ms + 'ms: ' + label)), ms);
	});
	return Promise.race([Promise.resolve(promise), timer]).finally(() => clearTimeout(t));
}

/**
 * A user's AFITX balance on Hive-Engine plus the legacy Steem-Engine one.
 * Steem-Engine is optional: any failure there counts as 0. `heOk` is false when the
 * Hive-Engine balance could not be read (the caller decides whether that matters).
 */
async function fetchAfitxBalance(user, { hsc, ssc, timeoutMs = 10000 } = {}) {
	let se = 0;
	let he = 0;
	let heOk = true;
	if (ssc) {
		try {
			const bal = await withTimeout(ssc.findOne('tokens', 'balances', { account: user, symbol: 'AFITX' }), timeoutMs, 'S-E AFITX');
			const n = bal ? afitBalance.finiteAmount(bal.balance) : null;
			if (n !== null && n > 0) se = n;
		} catch (err) {
			// Steem-Engine is legacy; its balance is optional
		}
	}
	try {
		const bal = await withTimeout(hsc.findOne('tokens', 'balances', { account: user, symbol: 'AFITX' }), timeoutMs, 'H-E AFITX');
		if (bal) {
			const n = afitBalance.finiteAmount(bal.balance);
			if (n === null) heOk = false;
			else if (n > 0) he = n;
		}
	} catch (err) {
		heOk = false;
	}
	return { total: se + he, se, he, heOk };
}

/** A Hive account name with the optional leading '@' removed, or null when invalid. */
function cleanAccountName(value, isValidName) {
	if (typeof value !== 'string') return null;
	const name = value.trim().replace(/^@/, '');
	return isValidName(name) ? name : null;
}

/**
 * POST /tipAccount: send `amount` AFIT from the logged-in `user` to `body.targetUser`.
 *
 * deps: { db, config, withAfitLock(user, fn) -> {busy}|{value}, busyError,
 *         tippedToday(user) -> number, accountExists(name) -> true|false|null,
 *         isValidName(name) -> bool, notify(db, to, from, type, category, text, url) }
 * Returns the JSON body to answer with.
 */
async function tipAccount(deps, user, body) {
	const { db, config } = deps;
	body = body || {};
	if (!body.targetUser || body.amount === undefined || body.amount === null || body.amount === '') {
		return { error: 'generic error' };
	}
	const targetUser = cleanAccountName(body.targetUser, deps.isValidName);
	if (!targetUser) return { error: 'Invalid recipient account' };
	if (targetUser === user) return { error: 'You cannot tip your own account' };

	const amount = afitAmount(body.amount);
	if (amount === null) return { error: 'Invalid AFIT amount. Use a positive number with at most 3 decimals.' };

	const maxPerDay = configAmount(config, 'max_allowed_tips_per_day');
	if (maxPerDay === null || maxPerDay <= 0) return { error: 'Tipping is temporarily unavailable. Please try again later.' };

	let note = typeof body.note === 'string' ? body.note.trim() : '';
	if (note.length > MAX_NOTE_LENGTH) note = note.slice(0, MAX_NOTE_LENGTH);

	// sender banned?
	if (await db.collection('banned_accounts').findOne({ user, ban_status: 'active' })) {
		return { error: 'You cannot tip AFIT as your account is banned' };
	}
	// recipient banned?
	if (await db.collection('banned_accounts').findOne({ user: targetUser, ban_status: 'active' })) {
		return { error: 'You cannot tip AFIT to a banned account' };
	}
	// the recipient must be a real Hive account; when it cannot be checked, refuse
	// (a lookup that fails or finds nothing both refuse the tip)
	const exists = await Promise.resolve().then(() => deps.accountExists(targetUser)).catch(() => null);
	if (exists !== true) return { error: 'Recipient account not found or could not be verified. Check the name and try again.' };

	const noteVal = note !== '' ? note : user + ' tipped ' + targetUser + ' ' + amount + ' AFIT';
	const tipTrans = { reward_activity: 'Send Tip', recipient: targetUser, tip_amount: amount, note: noteVal, date: new Date() };
	const tipReceiptTrans = { reward_activity: 'Receive Tip', sender: user, tip_amount: amount, note: noteVal, date: new Date() };

	// Under the sender's lock: daily cap (so concurrent tips cannot all pass it against the
	// same total), atomic debit with its ledger row (which carries `user`, so tippedToday
	// counts it), then the credit under the recipient's lock. A failed credit undoes the debit.
	const tip = await deps.withAfitLock(user, async () => {
		const totalTipAmount = afitBalance.finiteAmount(await deps.tippedToday(user));
		if (totalTipAmount === null) return { capError: 'Unable to check your tips for today. Please try again later.' };
		if (!(totalTipAmount < maxPerDay)) {
			return { capError: 'User cannot tip more today. Max tips per day is set at ' + maxPerDay + ' AFIT' };
		}
		if (totalTipAmount + amount > maxPerDay) {
			return { capError: 'Tip amount exceeds daily limit (' + maxPerDay + ') by ' + Number(((totalTipAmount + amount) - maxPerDay).toFixed(AFIT_DECIMALS)) + ' AFIT. Try a smaller amount.' };
		}
		const debit = await afitBalance.debitAfit(db, user, amount, { ledgerRow: tipTrans, context: 'tip-sender' });
		if (!debit.ok) return { debit };
		const credit = await deps.withAfitLock(targetUser, () => afitBalance.creditAfit(db, targetUser, amount, tipReceiptTrans, { context: 'tip-recipient' }));
		if (credit.busy || !credit.value || !credit.value.ok) {
			await afitBalance.undoDebit(db, user, debit, 'tip-sender');
			return { debit, failed: true };
		}
		return { debit, credit: credit.value };
	});
	if (tip.busy) return { error: deps.busyError };
	if (tip.value.capError) return { error: tip.value.capError };
	if (!tip.value.debit.ok) {
		return { error: tip.value.debit.reason === 'insufficient_funds' ? 'Account does not have enough AFIT funds' : 'Error performing tip action. DB storing issue' };
	}
	if (tip.value.failed) return { error: 'Error performing tip action. DB storing issue' };

	let senderBalance = tip.value.debit.balance;
	if (typeof senderBalance !== 'number') senderBalance = await afitBalance.readBalance(db, user).catch(() => 0);
	let recipientBalance = tip.value.credit.balance;
	if (typeof recipientBalance !== 'number') recipientBalance = await afitBalance.readBalance(db, targetUser).catch(() => 0);

	const notify = (...args) => Promise.resolve().then(() => deps.notify(...args)).catch((e) => console.log('tip notification failed: ' + (e && e.message)));
	notify(db, targetUser, user, 'receive_afit', 'payment', 'You received "' + amount + ' AFIT" from ' + user + (note !== '' ? ' with note ' + note : ''), 'https://actifit.io/' + targetUser + '/wallet');
	notify(db, targetUser, user, 'tip_notification', 'payment', 'User ' + user + ' has sent you ' + amount + ' AFIT', 'https://actifit.io/' + user);

	return { status: 'Success', tipAmount: amount, senderTokenCount: senderBalance, recipientTokenCount: recipientBalance };
}

/**
 * POST /initiateAFITMoveSE: record (or replace) the logged-in user's standing daily order
 * to move AFIT to Hive-Engine. Nothing is moved here; the daily job does that.
 *
 * deps: { db, config, hsc, ssc, grabUserTokens(user) -> {tokens} }
 */
async function initiateAfitMove(deps, user, body) {
	const { db, config } = deps;
	body = body || {};
	if (body.amount === undefined || body.amount === null || body.amount === '') return { error: 'generic error' };

	const amount = afitAmount(body.amount);
	if (amount === null) return { error: 'Invalid AFIT amount. Use a positive number with at most 3 decimals.' };

	const limits = moveLimits(config);
	if (!limits) return { error: 'Moving AFIT is temporarily unavailable. Please try again later.' };

	if (await db.collection('banned_accounts').findOne({ user, ban_status: 'active' })) {
		return { error: 'You cannot move AFIT as your account is banned' };
	}
	if (amount > limits.maxPerDay) {
		return { error: 'You cannot transfer more than ' + limits.maxPerDay + ' AFIT / day' };
	}

	const userInfo = await deps.grabUserTokens(user);
	const balance = afitBalance.finiteAmount(userInfo && userInfo.tokens);
	if (balance === null || balance < amount) return { error: 'Account does not have enough AFIT funds' };

	if (amount > limits.freePerDay) {
		const afitx = await fetchAfitxBalance(user, { hsc: deps.hsc, ssc: deps.ssc });
		if (!afitx.heOk) return { error: 'Unable to fetch AFITX Funds. Try again later.' };
		const short = afitxShortfall(amount, afitx.total, limits);
		if (short === 'min_afitx') return { error: 'You do not have enough AFITX to move AFIT tokens over.' };
		if (short) return { error: 'You do not have enough AFITX to move ' + amount + ' AFIT' };
	}

	const order = {
		user,
		daily_afit_transfer: amount,
		min_afitx: afitxRequired(amount, limits),
		date: new Date(),
	};
	try {
		await db.collection('powering_down_he').updateOne({ user }, { $set: order }, { upsert: true });
	} catch (err) {
		console.error(err);
		return { error: 'Error performing power down. DB storing issue' };
	}
	return { status: 'Success', trx: order };
}

/**
 * Build and sign (without sending) the custom_json that makes Hive-Engine transfer
 * `quantity` AFIT from `account` to `to`. The transaction id is known before anything is
 * broadcast, so the outcome can be looked up whatever happens to the broadcast call.
 */
async function signTransfer(client, { account, key, to, quantity }) {
	const props = await client.database.getDynamicGlobalProperties();
	const json = JSON.stringify({
		contractName: 'tokens',
		contractAction: 'transfer',
		contractPayload: { symbol: 'AFIT', to, quantity: String(quantity), memo: '' },
	});
	const expiration = new Date(new Date(props.time + 'Z').getTime() + 60 * 1000).toISOString().slice(0, -5);
	const tx = {
		ref_block_num: props.head_block_number & 0xffff,
		ref_block_prefix: Buffer.from(props.head_block_id, 'hex').readUInt32LE(4),
		expiration,
		operations: [['custom_json', { required_auths: [account], required_posting_auths: [], id: HE_CONTRACT_ID, json }]],
		extensions: [],
	};
	const signed = client.broadcast.sign(tx, key);
	return { signed, trxId: dhive.cryptoUtils.generateTrxId(signed), expiration };
}

function parseLogs(logs) {
	if (!logs) return {};
	if (typeof logs === 'object') return logs;
	try { return JSON.parse(logs); } catch (_) { return null; }
}

/**
 * Find out what happened to a broadcast transfer.
 *
 *   'landed'           Hive-Engine executed the transfer to `to`
 *   'failed_on_engine' the transaction is on Hive but Hive-Engine rejected it (no tokens moved)
 *   'not_landed'       Hive reports the transaction expired without being included (irreversible)
 *   'unknown'          could not be determined within the polling window
 *
 * Polls until shortly after the transaction's expiration (it cannot be included after it),
 * then every `pollMs`, `attempts` times in total.
 */
async function resolveTransfer({ trxId, expiration, to, hsc, hiveClient, sleep, now = Date.now, pollMs = 30000, attempts = 8, graceMs = 20000 }) {
	const firstWait = Math.max(0, new Date(expiration + 'Z').getTime() + graceMs - now());
	if (firstWait > 0) await sleep(firstWait);
	let hiveStatus = null;
	for (let i = 0; i < attempts; i++) {
		if (i > 0) await sleep(pollMs);
		let info = null;
		try { info = await withTimeout(hsc.getTransactionInfo(trxId), 15000, 'H-E getTransactionInfo'); } catch (_) { info = null; }
		if (info) {
			const logs = parseLogs(info.logs);
			if (logs && Array.isArray(logs.errors) && logs.errors.length) return { outcome: 'failed_on_engine', hiveStatus, detail: logs.errors };
			const sent = logs && Array.isArray(logs.events) && logs.events.some((e) => e && e.contract === 'tokens' && e.event === 'transfer' && e.data && e.data.to === to && e.data.symbol === 'AFIT');
			if (sent) return { outcome: 'landed', hiveStatus };
			return { outcome: 'unknown', hiveStatus, detail: 'engine transaction found without a transfer event' };
		}
		try {
			const st = await withTimeout(hiveClient.call('transaction_status_api', 'find_transaction', { transaction_id: trxId, expiration }), 15000, 'find_transaction');
			hiveStatus = st && st.status ? st.status : hiveStatus;
		} catch (_) { /* keep the last known status */ }
		if (hiveStatus === 'expired_irreversible') return { outcome: 'not_landed', hiveStatus };
	}
	return { outcome: 'unknown', hiveStatus };
}

module.exports = {
	AFIT_DECIMALS,
	HE_CONTRACT_ID,
	afitAmount,
	configAmount,
	moveLimits,
	afitxRequired,
	afitxShortfall,
	fetchAfitxBalance,
	cleanAccountName,
	tipAccount,
	initiateAfitMove,
	signTransfer,
	resolveTransfer,
	withTimeout,
};
