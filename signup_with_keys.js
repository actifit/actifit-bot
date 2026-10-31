/**
 * Signup with device-generated keys: `POST /app/signupQuote` and `POST /app/signupWithKeys`.
 *
 * The app derives the account keys from the master password on the phone and sends only
 * the four PUBLIC keys. No password or private key ever reaches the server, and a request
 * that carries one is rejected.
 *
 * Flow:
 *   1. Quote: validate the request, check the name is free, and return the memo and the
 *      amount to pay. The memo is a hash of every field the signup depends on, so a payment
 *      is bound to exactly one name + key set + referrer + email + currency + promo code.
 *   2. The user pays (or uses a promo code).
 *   3. Submit: recompute the memo, claim it atomically (signup_claims, _id = memo), look the
 *      payment up in a shared transfer index, create the account with
 *      createHiveAccountWithKeys, and record the signup and rewards. A payment not yet
 *      visible returns `payment_pending` with `retry_after`; nothing waits server-side.
 *
 * Claim states: pending -> processing (leased to one request, every write checks the
 * lease token) -> created | failed. Pending claims with nothing paid expire after a week.
 *
 * Dark launch: everything is off until the `settings` document `signup_with_keys` has
 * `enabled: true` (cached for SETTINGS_CACHE_MS, so it works on both servers without a
 * deploy). Promo codes additionally need `promo_enabled: true`.
 *
 * Known limits (by design, handled by support / the signup watcher):
 * - top-ups are not added together: each transfer is judged on its own;
 * - a claim flagged `needs_refund` (underpaid, or the name was taken after payment) is
 *   refunded by hand;
 * - the transfer index reads head (not only irreversible) history.
 *
 * Load-time safe: requires only node built-ins. Every external effect comes in via `deps`,
 * so the routes can be tested on a bare Express app.
 */

'use strict';

const crypto = require('crypto');

const SETTINGS_ID = 'signup_with_keys';
const SETTINGS_CACHE_MS = 60 * 1000;
const DEFAULT_DAILY_CAP = 20;
const DEFAULT_PROMO_DAILY_CAP = 10;
const DAY_MS = 24 * 60 * 60 * 1000;
// longer than a slow account-history read + broadcast; renewed right before broadcasting
const CLAIM_LEASE_MS = 5 * 60 * 1000;
// The memo already binds a payment to one signup; the window only bounds how far back we look.
const PAYMENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const PENDING_CLAIM_TTL_MS = 7 * DAY_MS;
// how often one claim may trigger a payment check
const CLAIM_CHECK_INTERVAL_MS = 10 * 1000;
const RETRY_AFTER_S = 10;
// transfer index
const INDEX_REFRESH_MS = 10 * 1000;
// longer than the payment window + pending-claim TTL, so a late submit still finds its payment
const INDEX_RETENTION_MS = 14 * DAY_MS;
const INDEX_MAX_ENTRIES = 100000;
const MAX_TRANSFERS_PER_MEMO = 10;
// transfers below this are dust: never indexed, never a payment (a signup costs ~$2)
const MIN_INDEXED_AMOUNT = { HIVE: 1, HBD: 0.25 };
const HISTORY_PAGE = 1000;
const FIRST_SCAN_MAX_PAGES = 50;
const REFRESH_MAX_PAGES = 20;
// operation_filter_low bit for `transfer` (op id 2)
const TRANSFER_FILTER_LOW = 4;
// rate limits, counted in the DB so both servers share them
const RATE_WINDOW_MS = 60 * 60 * 1000;
const QUOTES_PER_IP = 30;
const NEW_CLAIMS_PER_IP = 20;
const FAILED_PROMOS_PER_IP = 10;
const FAILED_PROMOS_GLOBAL = 300;
const MEMO_PREFIX = 'signup:';
const MEMO_RE = /^signup:[0-9a-f]{24}$/;
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

/**
 * The memo a payment for these exact signup details must carry. The promo code is part of
 * it, so a paid signup and a promo signup (or two different codes) never share a claim.
 */
function signupMemo(f) {
	const parts = ['actifit-signup-v1', f.new_account, f.keys.owner, f.keys.active, f.keys.posting,
		f.keys.memo, f.referrer || '', f.email || '', f.sent_cur, f.promo_code || ''];
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

/**
 * Judge the transfers that carried `memo` (oldest first): the first one in the window that
 * pays enough in the right currency wins; otherwise report the first one seen as insufficient.
 */
function matchPayment(transfers, { currency, required, notBefore }) {
	let short = null;
	for (const t of transfers) {
		if (!(t.timestamp.getTime() >= notBefore)) continue;
		if (t.currency === currency && isFinite(t.amount) && t.amount >= required) return { status: 'paid', payment: t };
		short = short || t;
	}
	return short ? { status: 'insufficient', payment: short } : { status: 'none' };
}

/**
 * Transfers to the signup account that carry a well-formed signup memo and at least a
 * minimum amount, kept in memory and refreshed incrementally (newest entries first, then
 * any gap left behind), so a submit costs no chain call and dust cannot hide a payment.
 * Bounded: at most MAX_TRANSFERS_PER_MEMO per memo and `maxEntries` in total; when full, the
 * walk stops and keeps the rest as a gap to retry, so nothing is skipped for good.
 */
function createTransferIndex({ hiveCall, account, now, log, pageSize = HISTORY_PAGE, maxEntries = INDEX_MAX_ENTRIES }) {
	const byMemo = new Map();
	const seen = new Set();
	let high = null; // highest history index fetched
	let gaps = []; // [{start, stopAt}] ranges still to walk (indices > stopAt, <= start)
	let refreshedAt = 0;
	let inflight = null;
	let fullLogged = false;

	/** Index one history entry. Returns false only when the index is full. */
	function add(entry) {
		const [idx, h] = entry;
		if (seen.has(idx) || !h || !Array.isArray(h.op) || h.op[0] !== 'transfer') return true;
		const op = h.op[1] || {};
		if (op.to !== account || typeof op.memo !== 'string' || !MEMO_RE.test(op.memo)) return true;
		const [amountStr, currency] = String(op.amount || '').split(' ');
		const amount = parseFloat(amountStr);
		if (!(amount >= (MIN_INDEXED_AMOUNT[currency] || Infinity))) return true; // dust
		const timestamp = chainTime(h.timestamp);
		if (timestamp.getTime() < now() - INDEX_RETENTION_MS) return true;
		const list = byMemo.get(op.memo) || [];
		// keep the OLDEST transfers per memo: later ones (anyone can send to a public memo)
		// must not push out the payment that came first
		if (list.length >= MAX_TRANSFERS_PER_MEMO) {
			if (idx > list[list.length - 1].idx) return true;
			seen.delete(list.pop().idx);
		}
		if (seen.size >= maxEntries) {
			if (!fullLogged) log('signup transfer index is full (' + maxEntries + ' entries); possible flood');
			fullLogged = true;
			return false;
		}
		seen.add(idx);
		const t = { idx, trx_id: h.trx_id, from: op.from, amount, currency, timestamp };
		let i = list.length;
		while (i > 0 && list[i - 1].idx > idx) i--;
		list.splice(i, 0, t);
		byMemo.set(op.memo, list);
		return true;
	}

	/** Walk back from `start` until index `stopAt`, the retention cutoff, `maxPages`, or a full index. */
	async function walk(start, stopAt, maxPages) {
		const cutoff = now() - INDEX_RETENTION_MS;
		let maxIdx = -1;
		for (let page = 0; page < maxPages; page++) {
			// with a filter, hived needs start >= limit - 1
			const limit = start === -1 ? pageSize : Math.min(pageSize, start + 1);
			const res = await hiveCall('get_account_history', [account, start, limit, TRANSFER_FILTER_LOW, 0]);
			// only an empty array means "no more history"; anything else is a node error
			if (!Array.isArray(res)) throw new Error('bad get_account_history reply');
			if (!res.length) return { done: true, maxIdx };
			const entries = res.slice().sort((a, b) => b[0] - a[0]); // newest first
			maxIdx = Math.max(maxIdx, entries[0][0]);
			let oldest = Infinity;
			let oldestTs = Infinity;
			for (const e of entries) {
				if (e[0] <= stopAt) continue;
				if (!add(e)) return { done: false, next: e[0], maxIdx }; // full: retry from here later
				oldest = e[0];
				if (e[1] && e[1].timestamp) oldestTs = Math.min(oldestTs, chainTime(e[1].timestamp).getTime());
			}
			if (oldest === Infinity || oldest <= 0 || oldest - 1 <= stopAt || oldestTs < cutoff) return { done: true, maxIdx };
			start = oldest - 1;
		}
		return { done: false, next: start, maxIdx };
	}

	function prune() {
		const cutoff = now() - INDEX_RETENTION_MS;
		for (const [memo, list] of byMemo) {
			const kept = [];
			for (const t of list) {
				if (t.timestamp.getTime() >= cutoff) kept.push(t); else seen.delete(t.idx);
			}
			if (kept.length) byMemo.set(memo, kept); else byMemo.delete(memo);
		}
		if (seen.size < maxEntries) fullLogged = false;
	}

	async function doRefresh() {
		prune();
		const first = high === null;
		const prevHigh = first ? -1 : high;
		const r = await walk(-1, prevHigh, first ? FIRST_SCAN_MAX_PAGES : REFRESH_MAX_PAGES);
		const newGaps = r.done ? [] : [{ start: r.next, stopAt: prevHigh }];
		high = Math.max(prevHigh, r.maxIdx);
		const remaining = [];
		for (const g of gaps.concat(newGaps)) {
			const gr = await walk(g.start, g.stopAt, REFRESH_MAX_PAGES);
			if (!gr.done) remaining.push({ start: gr.next, stopAt: g.stopAt });
		}
		gaps = remaining;
		refreshedAt = now();
	}

	async function refresh() {
		if (high !== null && now() - refreshedAt < INDEX_REFRESH_MS) return;
		if (!inflight) inflight = doRefresh().finally(() => { inflight = null; });
		await inflight;
	}

	return {
		refresh,
		transfersFor: (memo) => (byMemo.get(memo) || []).slice(),
		_state: () => ({ high, gaps: gaps.slice(), size: seen.size }),
	};
}

function createSignupWithKeys(deps) {
	const now = deps.now || Date.now;
	const log = typeof deps.log === 'function' ? deps.log : () => {};
	let settingsCache = { at: 0, value: null };
	let index = null;
	const transfers = () => {
		if (!index) {
			index = createTransferIndex({ hiveCall: (m, p) => deps.hiveCall(m, p), account: deps.getConfig().signup_account, now, log,
				pageSize: deps.historyPageSize || HISTORY_PAGE, maxEntries: deps.indexMaxEntries || INDEX_MAX_ENTRIES }); // tests only
		}
		return index;
	};

	async function settings() {
		if (settingsCache.value && now() - settingsCache.at < SETTINGS_CACHE_MS) return settingsCache.value;
		let doc = null;
		try {
			doc = await deps.getDb().collection('settings').findOne({ _id: SETTINGS_ID });
		} catch (err) {
			log('signup settings read failed: ' + (err && err.message));
		}
		const intOr = (v, d) => (Number.isInteger(v) && v >= 0 ? v : d);
		const value = {
			enabled: !!(doc && doc.enabled === true),
			promo_enabled: !!(doc && doc.promo_enabled === true),
			daily_cap: intOr(doc && doc.daily_cap, DEFAULT_DAILY_CAP),
			promo_daily_cap: intOr(doc && doc.promo_daily_cap, DEFAULT_PROMO_DAILY_CAP),
		};
		settingsCache = { at: now(), value };
		return value;
	}

	/** Count one event in a shared hourly bucket; true when the bucket is over `max`. */
	async function overLimit(key, max) {
		const bucket = Math.floor(now() / RATE_WINDOW_MS);
		try {
			const res = await deps.getDb().collection('signup_rate_limits').findOneAndUpdate(
				{ _id: key + ':' + bucket },
				{ $inc: { n: 1 }, $setOnInsert: { expires_at: new Date((bucket + 2) * RATE_WINDOW_MS) } },
				{ upsert: true, returnDocument: 'after', includeResultMetadata: false });
			return !!(res && res.n > max);
		} catch (err) {
			// fail open: a DB hiccup must not lock out a user who already paid
			log('signup rate limit check failed: ' + (err && err.message));
			return false;
		}
	}

	/** Wrong promo codes lock that IP for the hour; a very high global count locks everyone (alarm). */
	async function promoLocked(ip) {
		const bucket = Math.floor(now() / RATE_WINDOW_MS);
		try {
			const col = deps.getDb().collection('signup_rate_limits');
			const mine = await col.findOne({ _id: 'promo_fail:' + String(ip || 'unknown') + ':' + bucket });
			if (mine && mine.n >= FAILED_PROMOS_PER_IP) return true;
			const all = await col.findOne({ _id: 'promo_fail_all:' + bucket });
			return !!(all && all.n >= FAILED_PROMOS_GLOBAL);
		} catch (_) { return false; }
	}

	async function countPromoMiss(ip) {
		await overLimit('promo_fail:' + String(ip || 'unknown'), Infinity);
		if (await overLimit('promo_fail_all', FAILED_PROMOS_GLOBAL - 1)) log('signup: global wrong-promo-code limit reached; promo signups locked for the hour');
	}

	async function accountExists(name) {
		const rows = await deps.hiveCall('get_accounts', [[name]]);
		if (!Array.isArray(rows)) throw new Error('bad get_accounts reply');
		return rows.length > 0;
	}

	async function createdToday(path) {
		return deps.getDb().collection('signup_claims').countDocuments({
			status: 'created', path, finalized_at: { $gte: new Date(now() - DAY_MS) } });
	}

	// ---- quote -------------------------------------------------------------------------------

	async function quote(body, ip) {
		const s = await settings();
		if (!s.enabled) return { status: 503, body: { enabled: false, reason: 'signup_disabled' } };
		if (await overLimit('quote:' + String(ip || 'unknown'), QUOTES_PER_IP)) return { status: 429, body: { reason: 'rate_limited', retry_after: 3600 } };
		const parsed = parseSignupRequest(body, deps);
		if (parsed.error) return { status: 400, body: { reason: parsed.error } };
		const f = parsed.fields;
		if (f.promo_code) {
			if (!s.promo_enabled || await promoLocked(ip)) return { status: 200, body: { enabled: true, reason: 'promo_invalid' } };
		} else if ((await createdToday('paid')) >= s.daily_cap) {
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
		const out = { enabled: true, reason: 'quoted', memo: signupMemo(f) };
		if (!f.promo_code) {
			const q = await deps.quoteAmount(f.sent_cur);
			if (!q || !q.live || !(q.amount > 0)) {
				return { status: 503, body: { enabled: true, reason: 'price_unavailable', retryable: true } };
			}
			out.amounts = { [f.sent_cur]: (Math.ceil(q.amount * 1000) / 1000).toFixed(3) };
			out.signup_account = deps.getConfig().signup_account;
			out.afit_reward = deps.paidAfitReward();
		}
		return { status: 200, body: out };
	}

	// ---- submit ------------------------------------------------------------------------------

	const reply = (reason, extra = {}) => ({
		status: 200,
		body: Object.assign({ accountCreated: false, paymentReceivedTx: '', reason, retryable: false }, extra),
	});
	const pending = (extra = {}) => reply('payment_pending', Object.assign({ retryable: true, retry_after: RETRY_AFTER_S }, extra));

	function claimsCol() { return deps.getDb().collection('signup_claims'); }

	/** Take the claim's processing lease. Returns the claim (with its lease token) or null. */
	async function acquire(memo) {
		const t = now();
		const claim = await claimsCol().findOneAndUpdate(
			{ _id: memo, $or: [{ status: 'pending' }, { status: 'processing', lease_until: { $lt: new Date(t) } }] },
			{ $set: { status: 'processing', lease_token: crypto.randomBytes(12).toString('hex'),
				lease_until: new Date(t + CLAIM_LEASE_MS), last_checked_at: new Date(t), updated_at: new Date(t) } },
			{ returnDocument: 'after', includeResultMetadata: false });
		if (claim && claim.expires_at) {
			await claimsCol().updateOne({ _id: memo, lease_token: claim.lease_token, expires_at: { $exists: true } },
				{ $set: { expires_at: new Date(t + PENDING_CLAIM_TTL_MS) } });
		}
		return claim;
	}

	/** Update a claim only while this request still holds its lease. Returns true if it did. */
	async function guarded(claim, update) {
		const res = await claimsCol().updateOne({ _id: claim._id, status: 'processing', lease_token: claim.lease_token }, update);
		return !!(res && res.matchedCount);
	}

	async function release(claim, set = {}) {
		await guarded(claim, { $set: Object.assign({ status: 'pending', updated_at: new Date(now()) }, set),
			$unset: { lease_until: '', lease_token: '' } });
	}

	async function fail(claim, reason, set = {}) {
		if (set.needs_refund) log('signup needs refund: claim ' + claim._id + ' (' + reason + ')');
		await guarded(claim, { $set: Object.assign({ status: 'failed', failure_reason: reason, updated_at: new Date(now()) }, set),
			$unset: { lease_until: '', lease_token: '', expires_at: '' } });
		return reply(reason);
	}

	/**
	 * Create the account for a claim we hold. An account that already exists with the
	 * submitted keys counts as ours only if, for this claim, we saw the name free and
	 * broadcast: Hive keys are public, so otherwise anyone could "claim" an existing account.
	 */
	async function create(claim, f) {
		const attemptedBefore = claim.broadcast_attempted === true;
		let exists;
		try { exists = await accountExists(f.new_account); } catch (_) { return 'node_down'; }
		if (exists) {
			if (!attemptedBefore) return 'username_taken';
			const out = await deps.createAccount(f.new_account, f.keys); // verifies the keys match
			return out.reason === 'exists_with_same_keys' ? 'created' : out.reason;
		}
		// the name is free. One claim per name may broadcast: two claims for the same name
		// (say, different referrers) must not both end up "created".
		const names = deps.getDb().collection('signup_names');
		const t = now();
		try {
			await names.insertOne({ _id: f.new_account, memo: claim._id, at: new Date(t) });
		} catch (err) {
			if (!(err && err.code === 11000)) throw err;
			const holder = await names.findOne({ _id: f.new_account });
			if (!holder || holder.memo !== claim._id) return 'username_taken';
		}
		// from here a broadcast may happen, so mark it (and renew the lease)
		if (!(await guarded(claim, { $set: { broadcast_attempted: true, lease_until: new Date(t + CLAIM_LEASE_MS) } }))) return 'lease_lost';
		const out = await deps.createAccount(f.new_account, f.keys);
		if (['node_down', 'no_account_token', 'invalid_username', 'invalid_keys'].includes(out.reason) && !attemptedBefore) {
			// refused before broadcasting: nothing went out for this claim, so free the name too
			await guarded(claim, { $set: { broadcast_attempted: false } });
			await names.deleteOne({ _id: f.new_account, memo: claim._id });
		}
		return out.reason === 'exists_with_same_keys' ? 'created' : out.reason;
	}

	/** The account exists on chain: record it, reward once, and mark the claim created. */
	async function finalize(claim, f, extra) {
		// a request that lost its lease leaves rewards and delegation to the one holding it
		if (!(await guarded(claim, { $set: { account_created_at: new Date(now()) } }))) return;
		const reward = extra.afit_reward;
		// always record the signup; an unavailable amount is recorded as 0 and flagged for payout
		const amountMissing = !(reward > 0) && extra.reward_expected;
		let recorded = false;
		try {
			recorded = (await deps.recordSignup(Object.assign({ new_account: f.new_account, memo: claim._id, email: f.email },
				extra, { afit_reward: reward > 0 ? reward : 0 }))) === true;
		} catch (err) {
			log('signup record failed for ' + f.new_account + ' (claim ' + claim._id + '): ' + (err && err.message));
		}
		const rewardRecorded = recorded && !amountMissing;
		if (!rewardRecorded) log('signup reward pending for ' + f.new_account + ' (claim ' + claim._id + ')');
		if (extra.delegate && claim.delegated !== true) {
			try {
				await deps.delegate(f.new_account);
				await guarded(claim, { $set: { delegated: true } });
			} catch (err) { log('signup delegation failed (account created): ' + (err && err.message)); }
		}
		await guarded(claim, {
			$set: { status: 'created', finalized_at: new Date(now()), updated_at: new Date(now()),
				reward_amount: reward > 0 ? reward : 0, reward_pending: !rewardRecorded },
			$unset: { lease_until: '', lease_token: '', expires_at: '' } });
	}

	async function submit(body, ip) {
		const s = await settings();
		if (!s.enabled) return { status: 503, body: { accountCreated: false, reason: 'signup_disabled', retryable: true } };
		const parsed = parseSignupRequest(body, deps);
		if (parsed.error) return { status: 400, body: { accountCreated: false, reason: parsed.error, retryable: false } };
		const f = parsed.fields;
		const memo = signupMemo(f);
		if (f.memo !== memo) return { status: 400, body: { accountCreated: false, reason: 'memo_mismatch', retryable: false } };
		const path = f.promo_code ? 'promo' : 'paid';
		if (path === 'promo' && !s.promo_enabled) return reply('promo_invalid');

		const claims = claimsCol();
		let existing = await claims.findOne({ _id: memo });
		if (!existing) {
			// a new claim: cheap checks first, so no row is written for a name that is taken
			if (await overLimit('claim:' + String(ip || 'unknown'), NEW_CLAIMS_PER_IP)) {
				return { status: 429, body: { accountCreated: false, reason: 'rate_limited', retryable: true, retry_after: 3600 } };
			}
			if (path === 'promo' && await promoLocked(ip)) return reply('promo_invalid');
			try {
				if (await accountExists(f.new_account)) return reply('username_taken');
				if (f.referrer && !(await accountExists(f.referrer))) return { status: 400, body: { accountCreated: false, reason: 'invalid_referrer', retryable: false } };
			} catch (err) {
				return { status: 503, body: { accountCreated: false, reason: 'server_error', retryable: true, retry_after: RETRY_AFTER_S } };
			}
			const t = new Date(now());
			try {
				await claims.insertOne({
					_id: memo, path, new_account: f.new_account, keys: f.keys, referrer: f.referrer,
					email: f.email, sent_cur: f.sent_cur, status: 'pending', created_at: t, updated_at: t,
					expires_at: new Date(t.getTime() + PENDING_CLAIM_TTL_MS),
				});
			} catch (err) {
				if (!(err && err.code === 11000)) throw err;
			}
			existing = await claims.findOne({ _id: memo });
		}
		if (!existing || existing.path !== path) return { status: 400, body: { accountCreated: false, reason: 'memo_mismatch', retryable: false } };
		if (existing.status === 'created') return reply('already_created', { accountCreated: true, paymentReceivedTx: existing.payment_trx_id || '' });
		if (existing.status === 'failed') return reply(existing.failure_reason || 'creation_failed');
		if (existing.status === 'pending' && existing.last_checked_at && now() - existing.last_checked_at.getTime() < CLAIM_CHECK_INTERVAL_MS) {
			return pending({ paymentReceivedTx: existing.payment_trx_id || '' });
		}

		const claim = await acquire(memo);
		if (!claim) return pending(); // another request holds the lease
		try {
			return path === 'paid' ? await submitPaid(claim, f) : await submitPromo(claim, f, s, ip);
		} catch (err) {
			log('signup submit error for ' + f.new_account + ': ' + (err && err.message));
			try { await release(claim); } catch (_) { /* the lease expires on its own */ }
			return { status: 500, body: { accountCreated: false, reason: 'server_error', retryable: true, retry_after: RETRY_AFTER_S } };
		}
	}

	async function submitPaid(claim, f) {
		let payment = claim.payment_trx_id ? {
			trx_id: claim.payment_trx_id, amount: claim.verified_amount, currency: claim.verified_currency,
		} : null;
		if (!payment) {
			const req = await deps.requiredAmount(f.sent_cur);
			if (!req || !req.live || !(req.amount > 0)) {
				// never judge a payment against a guessed price
				await release(claim);
				return reply('server_error', { retryable: true, retry_after: RETRY_AFTER_S });
			}
			await transfers().refresh();
			const created = claim.created_at instanceof Date ? claim.created_at.getTime() : now();
			const notBefore = Math.min(created, now()) - PAYMENT_WINDOW_MS;
			const m = matchPayment(transfers().transfersFor(claim._id), { currency: f.sent_cur, required: req.amount, notBefore });
			if (m.status === 'none') {
				await release(claim);
				return pending();
			}
			if (m.status === 'insufficient') {
				// stays open so a full transfer can still complete it; support refunds otherwise
				log('signup needs refund or top-up: claim ' + claim._id + ' got ' + m.payment.amount + ' ' + m.payment.currency);
				await release(claim, { insufficient_trx_id: m.payment.trx_id, needs_refund: true });
				await claimsCol().updateOne({ _id: claim._id }, { $unset: { expires_at: '' } });
				return reply('payment_insufficient');
			}
			payment = m.payment;
			const others = transfers().transfersFor(claim._id).filter((t) => t.trx_id !== payment.trx_id);
			if (others.length) log('signup claim ' + claim._id + ' also received ' + others.length + ' other transfer(s); refund them');
			try {
				const ok = await guarded(claim, { $set: {
					payment_trx_id: payment.trx_id, payment_ref: payment.trx_id + '/' + claim._id, payment_from: payment.from,
					verified_amount: payment.amount, verified_currency: payment.currency, needs_refund: others.length > 0,
					extra_transfers: others.map((t) => t.trx_id) },
				$unset: { expires_at: '' } });
				if (!ok) return pending();
			} catch (err) {
				if (err && err.code === 11000) return fail(claim, 'memo_mismatch');
				throw err;
			}
		}

		const outcome = await create(claim, f);
		if (outcome === 'created') {
			const reward = deps.paidAfitReward();
			await finalize(claim, f, {
				referrer: f.referrer, afit_reward: reward, reward_expected: true, confirming_tx: payment.trx_id,
				verified_amount: payment.amount, verified_currency: payment.currency,
				signup_reward: true, referrer_reward: true, promo: null, delegate: true,
			});
			return reply('created', { accountCreated: true, paymentReceivedTx: payment.trx_id });
		}
		if (outcome === 'lease_lost') return pending();
		if (outcome === 'username_taken') return fail(claim, 'username_taken', { needs_refund: true });
		if (outcome === 'invalid_username' || outcome === 'invalid_keys') return fail(claim, outcome, { needs_refund: true });
		// no_account_token, node_down, creation_failed: nothing final, the app retries
		log('signup paid creation not done for ' + f.new_account + ': ' + outcome);
		await release(claim);
		return reply(outcome === 'node_down' ? 'server_error' : 'creation_failed',
			{ retryable: true, retry_after: RETRY_AFTER_S, paymentReceivedTx: payment.trx_id });
	}

	async function submitPromo(claim, f, s, ip) {
		const promos = deps.getDb().collection('signup_promo_codes');
		let promo = null;
		if (claim.promo_id !== undefined && claim.promo_id !== null) {
			promo = await promos.findOne({ _id: claim.promo_id });
		} else {
			if ((await createdToday('promo')) >= s.promo_daily_cap) {
				await release(claim);
				return reply('signup_disabled', { retryable: true, retry_after: 3600 });
			}
			promo = await promos.findOneAndUpdate(
				{ code: f.promo_code, entries: { $gt: 0 } },
				{ $inc: { entries: -1 } },
				{ includeResultMetadata: false });
			if (!promo) {
				// a wrong code must not lock these details: drop the claim, count the miss
				await countPromoMiss(ip);
				await claimsCol().deleteOne({ _id: claim._id, status: 'processing', lease_token: claim.lease_token });
				return reply('promo_invalid');
			}
			if (!(await guarded(claim, { $set: { promo_id: promo._id }, $unset: { expires_at: '' } }))) {
				await promos.updateOne({ _id: promo._id }, { $inc: { entries: 1 } });
				return pending();
			}
			claim.promo_id = promo._id;
		}
		if (!promo) return fail(claim, 'promo_invalid');

		// give the entry back exactly once: only the request that clears promo_id restores it
		const restore = async () => {
			try {
				const res = await claimsCol().updateOne(
					{ _id: claim._id, status: 'processing', lease_token: claim.lease_token, promo_id: { $exists: true } },
					{ $unset: { promo_id: '' }, $set: { expires_at: new Date(now() + PENDING_CLAIM_TTL_MS) } });
				if (res && res.modifiedCount) await promos.updateOne({ _id: claim.promo_id }, { $inc: { entries: 1 } });
			} catch (err) { log('signup promo entry restore failed: ' + (err && err.message)); }
		};

		const outcome = await create(claim, f);
		if (outcome === 'created') {
			const assigned = typeof promo.assigned_user === 'string' && deps.isValidName(promo.assigned_user)
				&& promo.assigned_user !== f.new_account ? promo.assigned_user : '';
			await finalize(claim, f, {
				referrer: assigned, afit_reward: deps.promoAfitReward(promo), reward_expected: !!promo.signup_reward,
				confirming_tx: 'promo', verified_amount: 0, verified_currency: f.sent_cur,
				signup_reward: !!promo.signup_reward, referrer_reward: !!promo.referrer_reward,
				promo, delegate: !!promo.delegation,
			});
			return reply('created', { accountCreated: true });
		}
		if (outcome === 'lease_lost') return pending();
		if (outcome === 'creation_failed') {
			// unknown whether it landed: keep the entry held so a retry can finish it
			await release(claim);
			return reply('creation_failed', { retryable: true, retry_after: RETRY_AFTER_S });
		}
		// nothing was broadcast: give the entry back
		await restore();
		if (outcome === 'username_taken' || outcome === 'invalid_username' || outcome === 'invalid_keys') {
			return fail(claim, outcome);
		}
		await release(claim);
		return reply(outcome === 'node_down' ? 'server_error' : 'creation_failed', { retryable: true, retry_after: RETRY_AFTER_S });
	}

	return { quote, submit, settings, _transfers: transfers, _resetCache: () => { settingsCache = { at: 0, value: null }; } };
}

/** Indexes the claim table relies on. Idempotent; never throws. */
async function ensureSignupIndexes(db, log = () => {}) {
	try {
		const claims = db.collection('signup_claims');
		await claims.createIndex({ payment_ref: 1 },
			{ unique: true, partialFilterExpression: { payment_ref: { $type: 'string' } }, name: 'signup_payment_ref_unique' });
		await claims.createIndex({ status: 1, path: 1, finalized_at: 1 }, { name: 'signup_status_path_finalized' });
		// pending claims with nothing paid or held; the field is removed once there is
		await claims.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0, name: 'signup_pending_ttl' });
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
	createTransferIndex,
	ensureSignupIndexes,
	signupMemo,
	parseSignupRequest,
	matchPayment,
};
