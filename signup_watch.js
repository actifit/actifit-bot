/**
 * Signup watcher: emails one digest to `report_emails` when something about the
 * device-key signup (signup_with_keys.js) needs a person.
 *
 * Each run collects:
 *   - refunds owed: claims flagged `needs_refund` (underpaid, extra transfers, or the name
 *     was taken after payment);
 *   - rewards not recorded: created claims with `reward_pending`;
 *   - unmatched payments: signup-memo transfers older than an hour that no claim accounts
 *     for (paid but never submitted, a transfer to a promo memo, a late duplicate);
 *   - claimed account tokens running low on the creator account (on the change, plus an
 *     all-clear when they recover);
 *   - every new signup.
 *
 * Every item is reported once. It is marked as reported only after the mail went out, so
 * a mail failure (or no `report_emails`) means it is retried on the next run.
 *
 * Read-only towards users and the chain: it never refunds, pays or changes a claim's
 * status, and adds only its own `watch_*` fields to claims.
 *
 * Load-time safe: every external effect comes in via `deps`.
 */

'use strict';

const { createTransferIndex } = require('./signup_with_keys');

const HOUR_MS = 60 * 60 * 1000;
const UNMATCHED_AFTER_MS = HOUR_MS; // give the app time to submit after paying
const SEEN_TTL_MS = 30 * 24 * HOUR_MS;
const MAX_PER_KIND = 50; // per digest; the rest go in the next one
const DEFAULT_MIN_TOKENS = 5;

const STATE_COL = 'signup_watch_state';
const SEEN_COL = 'signup_watch_seen';

function fmtAmount(amount, currency) {
	return Number.isFinite(amount) ? amount.toFixed(3) + ' ' + currency : '?';
}

function refundReason(c) {
	if (c.failure_reason) return c.failure_reason;
	if (c.extra_transfers && c.extra_transfers.length) return 'extra transfers ' + c.extra_transfers.join(', ');
	if (c.insufficient_trx_id) return 'underpaid (' + c.insufficient_trx_id + ')';
	return 'flagged';
}

function createSignupWatch(deps) {
	const now = deps.now || Date.now;
	const log = typeof deps.log === 'function' ? deps.log : () => {};
	let index = null;
	let running = null;

	const transfers = () => {
		if (!index) index = createTransferIndex({ hiveCall: (m, p) => deps.hiveCall(m, p), account: deps.getConfig().signup_account, now, log });
		return index;
	};
	const claimsCol = () => deps.getDb().collection('signup_claims');
	const findClaims = (q) => claimsCol().find(q).sort({ updated_at: 1 }).limit(MAX_PER_KIND).toArray();
	const markClaims = (ids, field) => ids.length
		? claimsCol().updateMany({ _id: { $in: ids } }, { $set: { [field]: new Date(now()) } })
		: null;

	/** One section of the digest: its lines and how to mark them reported. */
	async function claimSection(title, q, field, line) {
		const rows = await findClaims(Object.assign({}, q, { [field]: { $exists: false } }));
		return { title, lines: rows.map(line), mark: () => markClaims(rows.map((c) => c._id), field) };
	}

	async function createdSection() {
		return claimSection('New signups', { status: 'created' }, 'watch_created_at', (c) => '@' + c.new_account
			+ (c.payment_trx_id ? ' paid ' + fmtAmount(c.verified_amount, c.verified_currency) + ' from @' + c.payment_from : ' promo')
			+ (c.referrer ? ', referrer @' + c.referrer : '')
			+ ', reward ' + (c.reward_amount || 0) + ' AFIT' + (c.reward_pending ? ' (pending)' : ''));
	}

	async function refundSection() {
		return claimSection('Refunds owed', { needs_refund: true }, 'watch_refund_at', (c) => '@' + c.new_account
			+ ' (' + c.status + ', ' + refundReason(c) + ')'
			+ (c.payment_trx_id ? ', paid ' + fmtAmount(c.verified_amount, c.verified_currency) + ' from @' + c.payment_from + ' in ' + c.payment_trx_id : '')
			+ ', memo ' + c._id);
	}

	async function rewardSection() {
		return claimSection('Rewards not recorded', { status: 'created', reward_pending: true }, 'watch_reward_at', (c) => '@' + c.new_account
			+ (c.referrer ? ' (referrer @' + c.referrer + ')' : '') + ', memo ' + c._id);
	}

	async function unmatchedSection() {
		if (!deps.getConfig().signup_account) return null;
		await transfers().refresh();
		const old = transfers().all().filter((t) => now() - t.timestamp.getTime() >= UNMATCHED_AFTER_MS);
		if (!old.length) return null;
		const memos = [...new Set(old.map((t) => t.memo))];
		const claims = new Map((await claimsCol().find({ _id: { $in: memos } }).toArray()).map((c) => [c._id, c]));
		const accounted = (t) => {
			const c = claims.get(t.memo);
			// extra and underpaid transfers are already in the refunds section
			return !!c && (c.payment_trx_id === t.trx_id || c.insufficient_trx_id === t.trx_id
				|| (Array.isArray(c.extra_transfers) && c.extra_transfers.includes(t.trx_id)));
		};
		const open = old.filter((t) => !accounted(t)).map((t) => Object.assign({ ref: t.trx_id + '/' + t.memo }, t));
		if (!open.length) return null;
		const seen = new Set((await deps.getDb().collection(SEEN_COL).find({ _id: { $in: open.map((t) => t.ref) } }).toArray()).map((d) => d._id));
		const rows = open.filter((t) => !seen.has(t.ref)).slice(0, MAX_PER_KIND);
		return {
			title: 'Unmatched payments',
			lines: rows.map((t) => fmtAmount(t.amount, t.currency) + ' from @' + t.from + ' in ' + t.trx_id
				+ ' (' + t.timestamp.toISOString() + '), memo ' + t.memo
				+ (claims.has(t.memo) ? ', claim ' + claims.get(t.memo).status + ' for @' + claims.get(t.memo).new_account : ', no claim')),
			mark: async () => {
				const at = new Date(now());
				const expires = new Date(now() + SEEN_TTL_MS);
				try {
					await deps.getDb().collection(SEEN_COL).insertMany(rows.map((t) => ({ _id: t.ref, at, expires_at: expires })), { ordered: false });
				} catch (err) {
					if (!(err && err.code === 11000)) throw err; // another run already marked some
				}
			},
		};
	}

	async function tokenSection() {
		const cfg = deps.getConfig();
		if (!cfg.account) return null;
		const min = Number.isInteger(cfg.signup_watch_min_tokens) && cfg.signup_watch_min_tokens >= 0
			? cfg.signup_watch_min_tokens : DEFAULT_MIN_TOKENS;
		const acc = (await deps.hiveCall('get_accounts', [[cfg.account]]) || [])[0];
		const n = acc ? Number(acc.pending_claimed_accounts) : NaN;
		if (!Number.isFinite(n)) throw new Error('no claimed-token count for @' + cfg.account);
		const low = n < min;
		const state = await deps.getDb().collection(STATE_COL).findOne({ _id: 'tokens' });
		if (low === !!(state && state.low)) return null;
		return {
			title: 'Claimed account tokens',
			lines: [low
				? '@' + cfg.account + ' has ' + n + ' claimed account token(s), below ' + min + '. Paid signups stop at 0 (no fee fallback).'
				: '@' + cfg.account + ' is back to ' + n + ' claimed account tokens.'],
			mark: () => deps.getDb().collection(STATE_COL).updateOne({ _id: 'tokens' },
				{ $set: { low, count: n, at: new Date(now()) } }, { upsert: true }),
		};
	}

	async function doRun() {
		const sections = [];
		const errors = [];
		for (const [name, fn] of [['refunds', refundSection], ['unmatched', unmatchedSection],
			['rewards', rewardSection], ['tokens', tokenSection], ['created', createdSection]]) {
			try {
				const s = await fn();
				if (s && s.lines.length) sections.push(s);
			} catch (err) {
				errors.push(name);
				log('signup watch: ' + name + ' check failed: ' + (err && err.message));
			}
		}
		const summary = { sections: sections.map((s) => s.title + ': ' + s.lines.length), errors, mailed: false };
		if (!sections.length) return summary;

		const subject = '[Actifit signup watch] ' + sections.map((s) => s.lines.length + ' ' + s.title.toLowerCase()).join(', ');
		const body = sections.map((s) => s.title + ' (' + s.lines.length + ')\n' + s.lines.map((l) => '- ' + l).join('\n')).join('\n\n')
			+ '\n\nEach item is reported once. Refunds are sent by hand.\n';
		const to = deps.getConfig().report_emails;
		if (!to || !to.length) {
			log('signup watch: no report_emails configured, not delivered: ' + subject);
			return summary;
		}
		try {
			await deps.sendMail(subject, body, to);
		} catch (err) {
			log('signup watch: mail failed, will retry: ' + (err && err.message));
			return summary;
		}
		summary.mailed = true;
		for (const s of sections) {
			try { await s.mark(); } catch (err) { log('signup watch: marking ' + s.title + ' failed (may repeat): ' + (err && err.message)); }
		}
		return summary;
	}

	/** One watch pass. Overlapping calls share the run in progress. Never throws. */
	function run() {
		if (!running) {
			running = doRun()
				.catch((err) => { log('signup watch failed: ' + (err && err.message)); return { sections: [], errors: ['run'], mailed: false }; })
				.finally(() => { running = null; });
		}
		return running;
	}

	return { run };
}

module.exports = { createSignupWatch, UNMATCHED_AFTER_MS, DEFAULT_MIN_TOKENS };
