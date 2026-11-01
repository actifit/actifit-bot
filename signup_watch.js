/**
 * Signup watcher: emails one digest to `report_emails` when something about the
 * device-key signup (signup_with_keys.js) needs a person.
 *
 * Each run collects:
 *   - refunds owed: claims flagged `needs_refund` (underpaid, extra transfers, or the name
 *     was taken after payment). Reported again whenever the claim is flagged again
 *     (`refund_flagged_at` changes), since what is owed may have grown;
 *   - paid but not created: a matched payment whose account still isn't created an hour
 *     later (no claimed token, node down) and the app hasn't finished it;
 *   - rewards not recorded: created claims with `reward_pending`;
 *   - unmatched payments: signup-memo transfers older than an hour that no claim accounts
 *     for (paid but never submitted, a transfer to a promo memo, a late duplicate);
 *   - claimed account tokens running low on the creator account (on the change, plus an
 *     all-clear when they recover);
 *   - every new signup;
 *   - the watcher's own checks failing for an hour.
 *
 * Every item is reported once. It is marked as reported only after the mail went out, so
 * a mail failure (or no `report_emails`) means it is retried on the next run.
 *
 * Read-only towards users and the chain: it never refunds, pays or changes a claim's
 * status, and adds only its own `watch_*` fields to claims.
 *
 * Limits it inherits from the transfer index: transfers below the dust floor, and an 11th
 * or later transfer on one memo, are not indexed and so are not reported.
 *
 * Load-time safe: every external effect comes in via `deps`.
 */

'use strict';

const { createTransferIndex } = require('./signup_with_keys');

const HOUR_MS = 60 * 60 * 1000;
const UNMATCHED_AFTER_MS = HOUR_MS; // give the app time to submit after paying
const STUCK_AFTER_MS = HOUR_MS;
const SEEN_TTL_MS = 30 * 24 * HOUR_MS;
const MAX_PER_KIND = 50; // per digest; the rest go in the next one
const DEFAULT_MIN_TOKENS = 5;
const FAILING_RUNS_ALERT = 6; // an hour of failing checks at the default 10-minute cron

const STATE_COL = 'signup_watch_state';
const SEEN_COL = 'signup_watch_seen';

function fmtAmount(amount, currency) {
	return Number.isFinite(amount) ? amount.toFixed(3) + ' ' + currency : '?';
}

function refundReason(c) {
	const parts = [];
	if (c.failure_reason) parts.push(c.failure_reason);
	if (c.insufficient_trx_id) parts.push('underpaid in ' + c.insufficient_trx_id);
	if (Array.isArray(c.extra_transfers) && c.extra_transfers.length) parts.push('extra transfers ' + c.extra_transfers.join(', '));
	return parts.join('; ') || 'flagged';
}

const paidText = (c) => (c.payment_trx_id
	? 'paid ' + fmtAmount(c.verified_amount, c.verified_currency) + ' from @' + c.payment_from + ' in ' + c.payment_trx_id : '');

function createSignupWatch(deps) {
	const now = deps.now || Date.now;
	const log = typeof deps.log === 'function' ? deps.log : () => {};
	let index = null;
	let running = null;
	let failingRuns = 0;
	let failingAlerted = false;
	let noRecipientsLogged = false;

	const transfers = () => {
		if (!index) index = createTransferIndex({ hiveCall: (m, p) => deps.hiveCall(m, p), account: deps.getConfig().signup_account, now, log });
		return index;
	};
	const claimsCol = () => deps.getDb().collection('signup_claims');
	const findClaims = (q) => claimsCol().find(q).sort({ updated_at: 1 }).limit(MAX_PER_KIND).toArray();

	/** A digest section over claims, marked by `field`. `markFilter` narrows the mark to what was reported. */
	async function claimSection(title, q, field, line, markFilter = () => ({})) {
		const rows = await findClaims(Object.assign({}, q, { [field]: { $exists: false } }));
		return {
			title, lines: rows.map(line),
			mark: async () => {
				const at = new Date(now());
				for (const c of rows) await claimsCol().updateOne(Object.assign({ _id: c._id }, markFilter(c)), { $set: { [field]: at } });
			},
		};
	}

	const createdSection = () => claimSection('New signups', { status: 'created' }, 'watch_created_at', (c) => '@' + c.new_account
		+ (c.payment_trx_id ? ' ' + paidText(c) : ' promo')
		+ (c.referrer ? ', referrer @' + c.referrer : '')
		+ ', reward ' + (c.reward_amount || 0) + ' AFIT' + (c.reward_pending ? ' (pending)' : ''));

	// marked only if not flagged again since the read, so a new flag is never lost
	const refundSection = () => claimSection('Refunds owed', { needs_refund: true }, 'watch_refund_at', (c) => '@' + c.new_account
		+ ' (' + c.status + ', ' + refundReason(c) + ')'
		+ (c.payment_trx_id ? ', ' + paidText(c) : '') + ', memo ' + c._id,
	(c) => ({ refund_flagged_at: c.refund_flagged_at instanceof Date ? c.refund_flagged_at : { $exists: false } }));

	const stuckSection = () => claimSection('Paid, account not created',
		{ payment_trx_id: { $exists: true }, status: { $in: ['pending', 'processing'] }, updated_at: { $lt: new Date(now() - STUCK_AFTER_MS) } },
		'watch_stuck_at', (c) => '@' + c.new_account + ' ' + paidText(c)
			+ ', memo ' + c._id + '. The app retries on its own; refund if it never finishes.');

	const rewardSection = () => claimSection('Rewards not recorded', { status: 'created', reward_pending: true }, 'watch_reward_at',
		(c) => '@' + c.new_account + (c.referrer ? ' (referrer @' + c.referrer + ')' : '') + ', memo ' + c._id);

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
		const rows = open.filter((t) => !seen.has(t.ref)).sort((a, b) => a.timestamp - b.timestamp).slice(0, MAX_PER_KIND);
		const claimText = (c) => (!c ? ', no claim'
			: c.status === 'pending' || c.status === 'processing'
				? ', claim ' + c.status + ' for @' + c.new_account + ': the app can still submit it, check before refunding'
				: ', claim ' + c.status + ' for @' + c.new_account);
		return {
			title: 'Unmatched payments',
			lines: rows.map((t) => fmtAmount(t.amount, t.currency) + ' from @' + t.from + ' in ' + t.trx_id
				+ ' (' + t.timestamp.toISOString() + '), memo ' + t.memo + claimText(claims.get(t.memo))),
			mark: async () => {
				const at = new Date(now());
				const expires = new Date(now() + SEEN_TTL_MS);
				try {
					await deps.getDb().collection(SEEN_COL).insertMany(rows.map((t) => ({ _id: t.ref, at, expires_at: expires })), { ordered: false });
				} catch (err) {
					// duplicates only mean another run already marked some
					const errs = err && Array.isArray(err.writeErrors) ? err.writeErrors : [err];
					if (!errs.every((e) => e && e.code === 11000)) throw err;
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
			title: low ? 'Claimed tokens low' : 'Claimed tokens recovered',
			tag: (low ? 'claimed tokens low (' : 'claimed tokens recovered (') + n + ')',
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
		for (const [name, fn] of [['refunds', refundSection], ['stuck', stuckSection], ['unmatched', unmatchedSection],
			['rewards', rewardSection], ['tokens', tokenSection], ['created', createdSection]]) {
			try {
				const s = await fn();
				if (s && s.lines.length) sections.push(s);
			} catch (err) {
				errors.push(name);
				log('signup watch: ' + name + ' check failed: ' + (err && err.message));
			}
		}
		// checks that keep failing would otherwise go quiet: say so once, after an hour
		failingRuns = errors.length ? failingRuns + 1 : 0;
		if (!errors.length) failingAlerted = false;
		if (failingRuns >= FAILING_RUNS_ALERT && !failingAlerted) {
			sections.push({ title: 'Watcher checks failing', tag: 'watcher checks failing',
				lines: ['These checks have failed ' + failingRuns + ' runs in a row: ' + errors.join(', ') + '. See the api log.'],
				mark: async () => { failingAlerted = true; } });
		}
		const summary = { sections: sections.map((s) => s.title + ': ' + s.lines.length), errors, mailed: false };
		if (!sections.length) return summary;

		const subject = '[Actifit signup watch] ' + sections.map((s) => s.tag || s.title.toLowerCase() + ': ' + s.lines.length).join(', ');
		const body = sections.map((s) => s.title + ' (' + s.lines.length + ')\n' + s.lines.map((l) => '- ' + l).join('\n')).join('\n\n')
			+ (errors.length ? '\n\nChecks that failed this run: ' + errors.join(', ') + '.' : '')
			+ '\n\nEach item is reported once. Refunds are sent by hand.\n';
		const to = deps.getConfig().report_emails;
		if (!to || !to.length) {
			if (!noRecipientsLogged) log('signup watch: no report_emails configured, nothing is delivered (first: ' + subject + ')');
			noRecipientsLogged = true;
			return summary;
		}
		noRecipientsLogged = false;
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

module.exports = { createSignupWatch, UNMATCHED_AFTER_MS, STUCK_AFTER_MS, DEFAULT_MIN_TOKENS, FAILING_RUNS_ALERT };
