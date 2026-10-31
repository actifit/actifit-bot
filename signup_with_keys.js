/**
 * Signup with device-generated keys: `POST /app/signupQuote` and `POST /app/signupWithKeys`.
 *
 * The app derives the account keys from the master password on the phone and sends only
 * the four PUBLIC keys. No password or private key ever reaches the server, and a request
 * that carries one is rejected.
 *
 * Flow:
 *   1. Quote: validate the request, check the name is free, and return the memo and the
 *      amounts to pay. The memo is a hash of every field the signup depends on, so a payment
 *      is bound to exactly one name + key set + referrer + email + currency.
 *   2. The user pays (or uses a promo code).
 *   3. Submit: recompute the memo, claim it atomically (signup_claims, _id = memo), look the
 *      payment up once on chain, create the account with createHiveAccountWithKeys, and
 *      record the signup and rewards. A payment not yet visible returns `payment_pending`
 *      and the app retries; nothing waits server-side.
 *
 * Dark launch: everything is off until the `settings` document `signup_with_keys` has
 * `enabled: true` (cached for SETTINGS_CACHE_MS, so it works on both servers without a
 * deploy). Promo codes additionally need `promo_enabled: true`.
 *
 * Load-time safe: requires only node built-ins. Every external effect comes in via `deps`,
 * so the routes can be tested on a bare Express app.
 */

'use strict';

const crypto = require('crypto');

const SETTINGS_ID = 'signup_with_keys';
const SETTINGS_CACHE_MS = 60 * 1000;
const DEFAULT_DAILY_CAP = 20;
const CLAIM_LEASE_MS = 2 * 60 * 1000;
const PAYMENT_WINDOW_MS = 72 * 60 * 60 * 1000;
const HISTORY_PAGE = 1000;
const HISTORY_MAX_PAGES = 5;
// operation_filter_low bit for `transfer` (op id 2)
const TRANSFER_FILTER_LOW = 4;
const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_MAX_PER_WINDOW = 30;
const MEMO_PREFIX = 'signup:';
const CURRENCIES = ['HIVE', 'HBD'];
// Fields that must never be sent: the keys are made on the device, and only public keys travel.
const FORBIDDEN_FIELDS = ['new_pass', 'password', 'master_password', 'owner_key', 'active_key',
	'posting_key', 'memo_key', 'private_key', 'wif'];
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/;
const PROMO_RE = /^[A-Za-z0-9_-]{1,64}$/;

// Chain timestamps are UTC without a zone suffix.
function chainTime(ts) {
	return new Date(String(ts).endsWith('Z') ? ts : ts + 'Z');
}

/** The memo a payment for these exact signup details must carry. */
function signupMemo(f) {
	const parts = ['actifit-signup-v1', f.new_account, f.keys.owner, f.keys.active, f.keys.posting,
		f.keys.memo, f.referrer || '', f.email || '', f.sent_cur];
	return MEMO_PREFIX + crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 24);
}

/**
 * Strict request schema. Returns {fields} or {error}. Only plain strings are accepted, so no
 * object can reach a Mongo query.
 */
function parseSignupRequest(body, deps) {
	if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'invalid_request' };
	for (const f of FORBIDDEN_FIELDS) {
		if (Object.prototype.hasOwnProperty.call(body, f)) return { error: 'invalid_request' };
	}
	const str = (v) => (typeof v === 'string' ? v.trim() : v);
	const new_account = str(body.new_account);
	if (!deps.isValidName(new_account)) return { error: 'invalid_username' };
	const keys = deps.parseKeys(body.keys);
	if (!keys) return { error: 'invalid_keys' };

	let referrer = str(body.referrer);
	if (referrer === undefined || referrer === null || referrer === '') referrer = '';
	else if (!deps.isValidName(referrer) || referrer === new_account) return { error: 'invalid_referrer' };

	let email = str(body.email);
	if (email === undefined || email === null || email === '') email = '';
	else if (typeof email !== 'string' || email.length > 254 || !EMAIL_RE.test(email)) return { error: 'invalid_email' };
	email = email.toLowerCase();

	const sent_cur = str(body.sent_cur);
	if (!CURRENCIES.includes(sent_cur)) return { error: 'invalid_currency' };

	let promo_code = str(body.promo_code);
	if (promo_code === undefined || promo_code === null || promo_code === '') promo_code = '';
	else if (typeof promo_code !== 'string' || !PROMO_RE.test(promo_code)) return { error: 'promo_invalid' };

	let memo = body.memo;
	if (memo !== undefined && typeof memo !== 'string') return { error: 'memo_mismatch' };

	return { fields: { new_account, keys, referrer, email, sent_cur, promo_code, memo } };
}

/** First transfer to `to` carrying `memo` within the window, judged against `required`. */
function matchPayment(history, { to, memo, currency, required, notBefore }) {
	let sawMemo = null;
	for (const entry of history) {
		const h = entry && entry[1];
		if (!h || !Array.isArray(h.op) || h.op[0] !== 'transfer') continue;
		const op = h.op[1] || {};
		if (op.to !== to || op.memo !== memo) continue;
		const ts = chainTime(h.timestamp);
		if (!(ts.getTime() >= notBefore)) continue;
		const [amountStr, cur] = String(op.amount || '').split(' ');
		const amount = parseFloat(amountStr);
		const found = { trx_id: h.trx_id, from: op.from, amount, currency: cur, timestamp: ts };
		if (cur === currency && isFinite(amount) && amount >= required) return { status: 'paid', payment: found };
		sawMemo = sawMemo || found;
	}
	return sawMemo ? { status: 'insufficient', payment: sawMemo } : { status: 'none' };
}

function createSignupWithKeys(deps) {
	const now = deps.now || Date.now;
	const log = typeof deps.log === 'function' ? deps.log : () => {};
	let settingsCache = { at: 0, value: null };

	async function settings() {
		if (settingsCache.value && now() - settingsCache.at < SETTINGS_CACHE_MS) return settingsCache.value;
		let doc = null;
		try {
			doc = await deps.getDb().collection('settings').findOne({ _id: SETTINGS_ID });
		} catch (err) {
			log('signup settings read failed: ' + (err && err.message));
		}
		const cap = doc && Number.isInteger(doc.daily_cap) && doc.daily_cap >= 0 ? doc.daily_cap : DEFAULT_DAILY_CAP;
		const value = {
			enabled: !!(doc && doc.enabled === true),
			promo_enabled: !!(doc && doc.promo_enabled === true),
			daily_cap: cap,
		};
		settingsCache = { at: now(), value };
		return value;
	}

	/** Shared (DB-backed) per-IP limit, so both servers count against one budget. */
	async function overRateLimit(ip, route) {
		const bucket = Math.floor(now() / RATE_WINDOW_MS);
		const id = route + ':' + String(ip || 'unknown') + ':' + bucket;
		try {
			const res = await deps.getDb().collection('signup_rate_limits').findOneAndUpdate(
				{ _id: id },
				{ $inc: { n: 1 }, $setOnInsert: { expires_at: new Date((bucket + 2) * RATE_WINDOW_MS) } },
				{ upsert: true, returnDocument: 'after', includeResultMetadata: false });
			return !!(res && res.n > RATE_MAX_PER_WINDOW);
		} catch (err) {
			log('signup rate limit check failed: ' + (err && err.message));
			return false;
		}
	}

	async function accountExists(name) {
		const rows = await deps.hiveCall('get_accounts', [[name]]);
		if (!Array.isArray(rows)) throw new Error('bad get_accounts reply');
		return rows.length > 0;
	}

	async function createdToday() {
		return deps.getDb().collection('signup_claims').countDocuments({
			status: 'created', finalized_at: { $gte: new Date(now() - 24 * 60 * 60 * 1000) } });
	}

	/** Transfers to the signup account in the last PAYMENT_WINDOW_MS, newest first. */
	async function recentTransfers() {
		const to = deps.getConfig().signup_account;
		const notBefore = now() - PAYMENT_WINDOW_MS;
		const history = [];
		let start = -1;
		for (let page = 0; page < HISTORY_MAX_PAGES; page++) {
			// with a filter, hived needs start >= limit - 1
			const limit = start === -1 ? HISTORY_PAGE : Math.min(HISTORY_PAGE, start + 1);
			const res = await deps.hiveCall('get_account_history', [to, start, limit, TRANSFER_FILTER_LOW, 0]);
			if (!Array.isArray(res) || !res.length) break;
			history.push(...res);
			const oldest = res.reduce((min, e) => Math.min(min, e[0]), Infinity);
			const oldestTs = res.reduce((min, e) => Math.min(min, e[1] && e[1].timestamp ? chainTime(e[1].timestamp).getTime() : Infinity), Infinity);
			if (res.length < limit || oldest <= 0 || oldestTs < notBefore) break;
			start = oldest - 1;
		}
		return { history, notBefore, to };
	}

	// ---- quote -------------------------------------------------------------------------------

	async function quote(body, ip) {
		const s = await settings();
		if (!s.enabled) return { status: 503, body: { enabled: false, reason: 'signup_disabled' } };
		if (await overRateLimit(ip, 'quote')) return { status: 429, body: { reason: 'rate_limited' } };
		const parsed = parseSignupRequest(body, deps);
		if (parsed.error) return { status: 400, body: { reason: parsed.error } };
		const f = parsed.fields;
		if (f.promo_code) {
			if (!s.promo_enabled) return { status: 200, body: { enabled: true, reason: 'promo_invalid' } };
		} else if ((await createdToday()) >= s.daily_cap) {
			// stop new payments once the day's budget is used; paid submits are always honoured
			return { status: 503, body: { enabled: false, reason: 'signup_disabled' } };
		}
		try {
			if (await accountExists(f.new_account)) return { status: 200, body: { enabled: true, reason: 'username_taken' } };
			if (f.referrer && !(await accountExists(f.referrer))) return { status: 400, body: { reason: 'invalid_referrer' } };
		} catch (err) {
			log('signup quote: chain lookup failed: ' + (err && err.message));
			return { status: 503, body: { enabled: true, reason: 'server_error', retryable: true } };
		}
		const amounts = {};
		for (const cur of CURRENCIES) {
			const q = await deps.quoteAmount(cur);
			if (!q || !q.live || !(q.amount > 0)) {
				return { status: 503, body: { enabled: true, reason: 'server_error', retryable: true } };
			}
			amounts[cur] = (Math.ceil(q.amount * 1000) / 1000).toFixed(3);
		}
		return {
			status: 200,
			body: {
				enabled: true,
				reason: 'quoted',
				memo: signupMemo(f),
				amounts,
				signup_account: deps.getConfig().signup_account,
				afit_reward: f.promo_code ? undefined : deps.paidAfitReward(),
			},
		};
	}

	// ---- submit ------------------------------------------------------------------------------

	const reply = (reason, extra = {}) => ({
		status: 200,
		body: Object.assign({ accountCreated: false, paymentReceivedTx: '', reason, retryable: false }, extra),
	});

	/** Take the claim's processing lease, or report why not. */
	async function acquire(claims, memo) {
		const t = now();
		return claims.findOneAndUpdate(
			{ _id: memo, $or: [{ status: 'pending' }, { status: 'processing', lease_until: { $lt: new Date(t) } }] },
			{ $set: { status: 'processing', lease_until: new Date(t + CLAIM_LEASE_MS), updated_at: new Date(t) } },
			{ returnDocument: 'after', includeResultMetadata: false });
	}

	async function release(claims, memo, set = {}) {
		await claims.updateOne({ _id: memo, status: 'processing' },
			{ $set: Object.assign({ status: 'pending', updated_at: new Date(now()) }, set), $unset: { lease_until: '' } });
	}

	async function finalize(claims, claim, f, extra) {
		// stays 'processing': if we crash before 'created', the lease expires and a retry lands
		// here again through exists_with_same_keys (recordSignup is idempotent)
		await claims.updateOne({ _id: claim._id }, { $set: { account_created_at: new Date(now()), updated_at: new Date(now()) } });
		const recorded = await deps.recordSignup(Object.assign({
			new_account: f.new_account, memo: claim._id, email: f.email,
		}, extra));
		if (!recorded) log('signup recorded with errors for ' + f.new_account + ' (claim ' + claim._id + ')');
		if (extra.delegate) {
			try { await deps.delegate(f.new_account); } catch (err) { log('signup delegation failed (account created): ' + (err && err.message)); }
		}
		await claims.updateOne({ _id: claim._id }, {
			$set: { status: 'created', finalized_at: new Date(now()), updated_at: new Date(now()) },
			$unset: { lease_until: '' } });
	}

	/**
	 * Create the account for a claim we hold. `exists_with_same_keys` counts as ours only if we
	 * already attempted a broadcast for this claim: Hive keys are public, so without that an
	 * existing account could be "claimed" by anyone who knows its keys.
	 */
	async function create(claims, claim, f) {
		const attemptedBefore = claim.broadcast_attempted === true;
		await claims.updateOne({ _id: claim._id }, { $set: { broadcast_attempted: true } });
		const out = await deps.createAccount(f.new_account, f.keys);
		if (out.reason === 'created') return 'created';
		if (out.reason === 'exists_with_same_keys') return attemptedBefore ? 'created' : 'username_taken';
		return out.reason; // no_account_token, node_down, creation_failed, invalid_*
	}

	async function submit(body, ip) {
		const s = await settings();
		if (!s.enabled) return { status: 503, body: { accountCreated: false, reason: 'signup_disabled', retryable: true } };
		if (await overRateLimit(ip, 'submit')) return { status: 429, body: { accountCreated: false, reason: 'rate_limited', retryable: true } };
		const parsed = parseSignupRequest(body, deps);
		if (parsed.error) return { status: 400, body: { accountCreated: false, reason: parsed.error, retryable: false } };
		const f = parsed.fields;
		const memo = signupMemo(f);
		if (f.memo !== memo) return { status: 400, body: { accountCreated: false, reason: 'memo_mismatch', retryable: false } };
		const path = f.promo_code ? 'promo' : 'paid';
		if (path === 'promo' && !s.promo_enabled) return reply('promo_invalid');

		const claims = deps.getDb().collection('signup_claims');
		const t = new Date(now());
		try {
			await claims.insertOne({
				_id: memo, path, new_account: f.new_account, keys: f.keys, referrer: f.referrer,
				email: f.email, sent_cur: f.sent_cur, status: 'pending', created_at: t, updated_at: t,
			});
		} catch (err) {
			if (!(err && err.code === 11000)) throw err;
		}

		const existing = await claims.findOne({ _id: memo });
		if (!existing || existing.path !== path) return { status: 400, body: { accountCreated: false, reason: 'memo_mismatch', retryable: false } };
		if (existing.status === 'created') return reply('already_created', { accountCreated: true, paymentReceivedTx: existing.payment_trx_id || '' });
		if (existing.status === 'failed') return reply(existing.failure_reason || 'creation_failed');

		const claim = await acquire(claims, memo);
		if (!claim) {
			// another request holds the lease, or the claim is mid-finalize: ask the app to retry
			return reply('payment_pending', { retryable: true });
		}
		try {
			return path === 'paid' ? await submitPaid(claims, claim, f) : await submitPromo(claims, claim, f, s);
		} catch (err) {
			log('signup submit error for ' + f.new_account + ': ' + (err && err.message));
			try { await release(claims, memo); } catch (_) { /* the lease expires on its own */ }
			return { status: 500, body: { accountCreated: false, reason: 'server_error', retryable: true } };
		}
	}

	async function fail(claims, claim, reason) {
		await claims.updateOne({ _id: claim._id }, {
			$set: { status: 'failed', failure_reason: reason, updated_at: new Date(now()) }, $unset: { lease_until: '' } });
		return reply(reason);
	}

	async function submitPaid(claims, claim, f) {
		let payment = claim.payment_trx_id ? {
			trx_id: claim.payment_trx_id, amount: claim.verified_amount, currency: claim.verified_currency,
		} : null;
		if (!payment) {
			const required = await deps.requiredAmount(f.sent_cur);
			const { history, notBefore, to } = await recentTransfers();
			const m = matchPayment(history, { to, memo: claim._id, currency: f.sent_cur, required, notBefore });
			if (m.status === 'none') {
				await release(claims, claim._id);
				return reply('payment_pending', { retryable: true });
			}
			if (m.status === 'insufficient') {
				// keep the claim open: support refunds or tops up by hand (the watcher flags it)
				await release(claims, claim._id, { insufficient_trx_id: m.payment.trx_id });
				return reply('payment_insufficient');
			}
			payment = m.payment;
			try {
				await claims.updateOne({ _id: claim._id }, { $set: {
					payment_trx_id: payment.trx_id, payment_from: payment.from,
					verified_amount: payment.amount, verified_currency: payment.currency } });
			} catch (err) {
				if (err && err.code === 11000) return fail(claims, claim, 'memo_mismatch');
				throw err;
			}
		}

		const outcome = await create(claims, claim, f);
		if (outcome === 'created') {
			let referrer = f.referrer;
			if (referrer) {
				try { if (!(await accountExists(referrer))) referrer = ''; } catch (_) { referrer = ''; }
			}
			await finalize(claims, claim, f, {
				referrer, afit_reward: deps.paidAfitReward(), confirming_tx: payment.trx_id,
				verified_amount: payment.amount, verified_currency: payment.currency,
				signup_reward: true, referrer_reward: true, promo: null, delegate: true,
			});
			return reply('created', { accountCreated: true, paymentReceivedTx: payment.trx_id });
		}
		if (outcome === 'username_taken') return fail(claims, claim, 'username_taken');
		if (outcome === 'invalid_username' || outcome === 'invalid_keys') return fail(claims, claim, outcome);
		// no_account_token, node_down, creation_failed: nothing final, the app retries
		log('signup paid creation not done for ' + f.new_account + ': ' + outcome);
		await release(claims, claim._id);
		return reply(outcome === 'node_down' ? 'server_error' : 'creation_failed', { retryable: true, paymentReceivedTx: payment.trx_id });
	}

	async function submitPromo(claims, claim, f, s) {
		const promos = deps.getDb().collection('signup_promo_codes');
		let promoId = claim.promo_id;
		let promo = null;
		if (promoId) {
			promo = await promos.findOne({ _id: promoId });
		} else {
			if ((await createdToday()) >= s.daily_cap) {
				await release(claims, claim._id);
				return reply('signup_disabled', { retryable: true });
			}
			promo = await promos.findOneAndUpdate(
				{ code: f.promo_code, entries: { $gt: 0 } },
				{ $inc: { entries: -1 } },
				{ includeResultMetadata: false });
			if (!promo) return fail(claims, claim, 'promo_invalid');
			promoId = promo._id;
			await claims.updateOne({ _id: claim._id }, { $set: { promo_id: promoId } });
		}
		if (!promo) return fail(claims, claim, 'promo_invalid');

		const restore = async () => {
			try {
				await promos.updateOne({ _id: promoId }, { $inc: { entries: 1 } });
				await claims.updateOne({ _id: claim._id }, { $unset: { promo_id: '' } });
			} catch (err) { log('signup promo entry restore failed: ' + (err && err.message)); }
		};

		const outcome = await create(claims, claim, f);
		if (outcome === 'created') {
			const assigned = typeof promo.assigned_user === 'string' && deps.isValidName(promo.assigned_user)
				&& promo.assigned_user !== f.new_account ? promo.assigned_user : '';
			await finalize(claims, claim, f, {
				referrer: assigned, afit_reward: deps.promoAfitReward(promo), confirming_tx: 'promo:' + String(promoId),
				verified_amount: 0, verified_currency: f.sent_cur,
				signup_reward: !!promo.signup_reward, referrer_reward: !!promo.referrer_reward,
				promo, delegate: !!promo.delegation,
			});
			return reply('created', { accountCreated: true });
		}
		if (outcome === 'creation_failed') {
			// unknown whether it landed: keep the entry held so a retry can finish it
			await release(claims, claim._id);
			return reply('creation_failed', { retryable: true });
		}
		// nothing was broadcast: give the entry back
		await restore();
		if (outcome === 'username_taken' || outcome === 'invalid_username' || outcome === 'invalid_keys') {
			return fail(claims, claim, outcome);
		}
		await release(claims, claim._id);
		return reply(outcome === 'node_down' ? 'server_error' : 'creation_failed', { retryable: true });
	}

	return { quote, submit, settings, _resetCache: () => { settingsCache = { at: 0, value: null }; } };
}

/** Indexes the claim table relies on. Idempotent; never throws. */
async function ensureSignupIndexes(db, log = () => {}) {
	try {
		await db.collection('signup_claims').createIndex({ payment_trx_id: 1 },
			{ unique: true, partialFilterExpression: { payment_trx_id: { $type: 'string' } }, name: 'signup_payment_trx_unique' });
		await db.collection('signup_claims').createIndex({ status: 1, finalized_at: 1 }, { name: 'signup_status_finalized' });
		await db.collection('signup_rate_limits').createIndex({ expires_at: 1 }, { expireAfterSeconds: 0, name: 'signup_rate_ttl' });
	} catch (err) {
		log('signup index setup failed: ' + (err && err.message));
	}
}

function registerSignupWithKeysRoutes(app, deps, opts = {}) {
	const svc = createSignupWithKeys(deps);
	const mw = typeof opts.limiter === 'function' ? [opts.limiter] : [];
	const ipOf = typeof opts.ipOf === 'function' ? opts.ipOf : (req) => req.ip;
	const log = typeof deps.log === 'function' ? deps.log : () => {};
	const handle = (fn) => async (req, res) => {
		try {
			const out = await fn(req.body, ipOf(req));
			res.status(out.status).send(out.body);
		} catch (err) {
			log('signup route error: ' + (err && err.message));
			res.status(500).send({ accountCreated: false, reason: 'server_error', retryable: true });
		}
	};
	app.post('/app/signupQuote', ...mw, handle(svc.quote));
	app.post('/app/signupWithKeys', ...mw, handle(svc.submit));
	return svc;
}

module.exports = {
	registerSignupWithKeysRoutes,
	createSignupWithKeys,
	ensureSignupIndexes,
	signupMemo,
	parseSignupRequest,
	matchPayment,
};
