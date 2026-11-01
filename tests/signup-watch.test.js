/**
 * signup_watch.js: the digest that tells a person about refunds owed, rewards not
 * recorded, unmatched payments, low claimed tokens and new signups.
 *
 * What these tests pin:
 * - each item is mailed once, and only marked after the mail went out;
 * - a payment counts as matched only when its claim names that transfer;
 * - the watcher never changes a claim's status or payment fields;
 * - one failing check doesn't hide the others.
 */

const { createSignupWatch, UNMATCHED_AFTER_MS } = require('../signup_watch');

// ---- tiny Mongo stand-in -------------------------------------------------------------------

function matches(doc, q) {
	for (const [k, v] of Object.entries(q || {})) {
		const val = doc[k];
		if (v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v)) {
			for (const [op, arg] of Object.entries(v)) {
				if (op === '$exists' && (val !== undefined) !== arg) return false;
				if (op === '$in' && !arg.includes(val)) return false;
				if (op === '$lt' && !(val < arg)) return false;
			}
		} else if (val !== v) return false;
	}
	return true;
}

function dupError() { const e = new Error('E11000 duplicate key'); e.code = 11000; return e; }

function makeCollection() {
	const docs = [];
	const find = (q) => {
		let rows = docs.filter((d) => matches(d, q));
		const cursor = {
			sort(spec) { const [k, dir] = Object.entries(spec)[0]; rows = rows.slice().sort((a, b) => (a[k] > b[k] ? dir : a[k] < b[k] ? -dir : 0)); return cursor; },
			limit(n) { rows = rows.slice(0, n); return cursor; },
			async toArray() { return rows.map((d) => ({ ...d })); },
		};
		return cursor;
	};
	return {
		docs,
		find,
		async findOne(q) { const d = docs.find((x) => matches(x, q)); return d ? { ...d } : null; },
		async insertMany(list) {
			let dup = false;
			for (const d of list) { if (docs.some((x) => x._id === d._id)) dup = true; else docs.push({ ...d }); }
			if (dup) throw dupError();
		},
		async updateMany(q, u) {
			let n = 0;
			for (let i = 0; i < docs.length; i++) if (matches(docs[i], q)) { docs[i] = { ...docs[i], ...u.$set }; n++; }
			return { matchedCount: n };
		},
		async updateOne(q, u, opts = {}) {
			const i = docs.findIndex((x) => matches(x, q));
			if (i === -1) { if (opts.upsert) docs.push({ ...q, ...u.$set }); return { matchedCount: 0 }; }
			docs[i] = { ...docs[i], ...u.$set };
			return { matchedCount: 1 };
		},
	};
}

function makeDb() {
	const cols = {};
	return { cols, collection: (n) => (cols[n] = cols[n] || makeCollection()) };
}

// ---- fake chain ----------------------------------------------------------------------------

const NOW = Date.parse('2026-11-01T12:00:00Z');
const chainTs = (ms) => new Date(ms).toISOString().slice(0, 19);
const MEMO_A = 'signup:' + 'a'.repeat(24);
const MEMO_B = 'signup:' + 'b'.repeat(24);

function makeChain() {
	const history = [];
	const chain = {
		history,
		tokens: 20,
		failTokens: false,
		pay({ from = 'payer', amount = '3.000 HIVE', memo, ageMs = 2 * UNMATCHED_AFTER_MS, trx_id }) {
			const idx = history.length;
			history.push([idx, { trx_id: trx_id || 'trx' + idx, timestamp: chainTs(NOW - ageMs),
				op: ['transfer', { from, to: 'actifit.signup', amount, memo }] }]);
			return 'trx' + idx;
		},
		async call(method, params) {
			if (method === 'get_accounts') {
				if (chain.failTokens) throw new Error('node down');
				return [{ name: params[0][0], pending_claimed_accounts: chain.tokens }];
			}
			if (method === 'get_account_history') {
				let [, start, limit] = params;
				if (start !== -1 && start < limit - 1) throw new Error('start must be >= limit - 1');
				if (start === -1) start = history.length - 1;
				return history.filter((e) => e[0] <= start).slice(-limit);
			}
			throw new Error('unexpected ' + method);
		},
	};
	return chain;
}

function setup(cfgOver = {}) {
	const db = makeDb();
	const chain = makeChain();
	const mails = [];
	const logs = [];
	const config = { account: 'actifit', signup_account: 'actifit.signup', report_emails: ['ops@example.com'], ...cfgOver };
	const deps = {
		getDb: () => db,
		getConfig: () => config,
		hiveCall: (m, p) => chain.call(m, p),
		log: (m) => logs.push(m),
		clock: NOW,
		now: () => deps.clock,
		mailFails: false,
		async sendMail(subject, body, to) {
			if (deps.mailFails) throw new Error('smtp down');
			mails.push({ subject, body, to });
		},
	};
	const watch = createSignupWatch(new Proxy(deps, {}));
	const claims = db.collection('signup_claims');
	const addClaim = (c) => { claims.docs.push({ status: 'pending', updated_at: new Date(NOW), ...c }); return c._id; };
	return { db, chain, mails, logs, config, deps, watch, claims, addClaim };
}

const paidClaim = (over = {}) => ({
	_id: MEMO_A, new_account: 'newguy', status: 'created', payment_trx_id: 'trx0', payment_from: 'payer',
	verified_amount: 3, verified_currency: 'HIVE', referrer: 'friend', reward_amount: 50, reward_pending: false, ...over,
});

// ---- tests ---------------------------------------------------------------------------------

describe('signup watch: claims', () => {
	test('mails a new signup once', async () => {
		const t = setup();
		t.chain.pay({ memo: MEMO_A });
		t.addClaim(paidClaim());
		const r = await t.watch.run();
		expect(r.mailed).toBe(true);
		expect(t.mails).toHaveLength(1);
		expect(t.mails[0].subject).toMatch(/new signups: 1/);
		expect(t.mails[0].body).toMatch(/@newguy paid 3\.000 HIVE from @payer in trx0, referrer @friend, reward 50 AFIT/);
		expect(t.mails[0].to).toEqual(['ops@example.com']);
		await t.watch.run();
		expect(t.mails).toHaveLength(1);
	});

	test('reports a refund owed with its reason, and does not touch the claim status', async () => {
		const t = setup();
		t.chain.pay({ memo: MEMO_A });
		t.addClaim(paidClaim({ status: 'failed', failure_reason: 'username_taken', needs_refund: true }));
		await t.watch.run();
		expect(t.mails[0].subject).toMatch(/refunds owed: 1/);
		expect(t.mails[0].body).toMatch(/@newguy \(failed, username_taken\), paid 3\.000 HIVE from @payer in trx0, memo signup:a+/);
		const c = t.claims.docs[0];
		expect(c.status).toBe('failed');
		expect(c.needs_refund).toBe(true);
		expect(c.watch_refund_at).toBeInstanceOf(Date);
		expect(Object.keys(c).filter((k) => !Object.keys(paidClaim()).includes(k)).sort())
			.toEqual(['failure_reason', 'needs_refund', 'updated_at', 'watch_refund_at']);
	});

	test('names underpaid and extra transfers as the refund reason', async () => {
		const t = setup();
		t.addClaim({ _id: MEMO_A, new_account: 'under', status: 'pending', needs_refund: true, insufficient_trx_id: 'trxU' });
		t.addClaim(paidClaim({ _id: MEMO_B, new_account: 'extra', needs_refund: true, extra_transfers: ['trxE'] }));
		await t.watch.run();
		expect(t.mails[0].body).toMatch(/@under \(pending, underpaid in trxU\)/);
		expect(t.mails[0].body).toMatch(/@extra \(created, extra transfers trxE\)/);
	});

	test('reports a reward that was not recorded', async () => {
		const t = setup();
		t.chain.pay({ memo: MEMO_A });
		t.addClaim(paidClaim({ reward_pending: true, reward_amount: 0 }));
		await t.watch.run();
		expect(t.mails[0].subject).toMatch(/rewards not recorded: 1/);
		expect(t.mails[0].body).toMatch(/Rewards not recorded \(1\)\n- @newguy \(referrer @friend\)/);
		expect(t.mails[0].body).toMatch(/reward 0 AFIT \(pending\)/);
	});

	test('a promo signup reads as promo', async () => {
		const t = setup();
		t.addClaim({ _id: MEMO_B, new_account: 'promoguy', status: 'created', reward_amount: 100 });
		await t.watch.run();
		expect(t.mails[0].body).toMatch(/@promoguy promo, reward 100 AFIT/);
	});

	test('caps each section per digest and sends the rest next time', async () => {
		const t = setup();
		for (let i = 0; i < 60; i++) {
			t.addClaim({ _id: 'signup:' + String(i).padStart(24, '0'), new_account: 'u' + i, status: 'created',
				reward_amount: 1, updated_at: new Date(NOW - (60 - i) * 1000) });
		}
		await t.watch.run();
		expect(t.mails[0].subject).toMatch(/new signups: 50/);
		expect(t.mails[0].body).toMatch(/@u0 /);
		await t.watch.run();
		expect(t.mails[1].subject).toMatch(/new signups: 10/);
		expect(t.mails[1].body).toMatch(/@u59 /);
		await t.watch.run();
		expect(t.mails).toHaveLength(2);
	});
});

describe('signup watch: unmatched payments', () => {
	test('reports a signup payment with no claim once it is an hour old, once', async () => {
		const t = setup();
		t.chain.pay({ memo: MEMO_A, amount: '3.100 HIVE', from: 'stranger' });
		await t.watch.run();
		expect(t.mails[0].subject).toMatch(/unmatched payments: 1/);
		expect(t.mails[0].body).toMatch(/3\.100 HIVE from @stranger in trx0 \(.*\), memo signup:a+, no claim/);
		await t.watch.run();
		expect(t.mails).toHaveLength(1);
	});

	test('waits an hour before calling a payment unmatched', async () => {
		const t = setup();
		t.chain.pay({ memo: MEMO_A, ageMs: UNMATCHED_AFTER_MS - 60 * 1000 });
		const r = await t.watch.run();
		expect(r.mailed).toBe(false);
		expect(t.mails).toHaveLength(0);
	});

	test('the claim\'s own payment and its flagged transfers are not unmatched', async () => {
		const t = setup();
		t.chain.pay({ memo: MEMO_A }); // trx0, the payment
		t.chain.pay({ memo: MEMO_A }); // trx1, flagged extra
		t.chain.pay({ memo: MEMO_B, trx_id: 'trxU' }); // underpaid, flagged
		t.addClaim(paidClaim({ extra_transfers: ['trx1'], watch_created_at: new Date(NOW), needs_refund: true, watch_refund_at: new Date(NOW) }));
		t.addClaim({ _id: MEMO_B, new_account: 'under', needs_refund: true, insufficient_trx_id: 'trxU', watch_refund_at: new Date(NOW) });
		const r = await t.watch.run();
		expect(r).toEqual({ sections: [], errors: [], mailed: false });
	});

	test('a paid claim never submitted, and a late second transfer, are unmatched', async () => {
		const t = setup();
		t.chain.pay({ memo: MEMO_B, from: 'paidnever' });
		t.chain.pay({ memo: MEMO_A }); // trx1 = the payment
		t.chain.pay({ memo: MEMO_A, from: 'again' }); // trx2, after the claim was created
		t.addClaim({ _id: MEMO_B, new_account: 'waiting', status: 'pending' });
		t.addClaim(paidClaim({ payment_trx_id: 'trx1', watch_created_at: new Date(NOW) }));
		await t.watch.run();
		expect(t.mails[0].subject).toMatch(/unmatched payments: 2/);
		expect(t.mails[0].body).toMatch(/from @paidnever in trx0 .*claim pending for @waiting/);
		expect(t.mails[0].body).toMatch(/from @again in trx2 .*claim created for @newguy/);
		expect(t.mails[0].body).not.toMatch(/in trx1/);
	});

	test('a new transfer on a memo already reported is reported too', async () => {
		const t = setup();
		t.chain.pay({ memo: MEMO_A });
		await t.watch.run();
		t.chain.pay({ memo: MEMO_A, from: 'second' });
		t.deps.clock += 10 * 60 * 1000; // the next scheduled run
		await t.watch.run();
		expect(t.mails).toHaveLength(2);
		expect(t.mails[1].body).toMatch(/from @second in trx1/);
		expect(t.mails[1].body).not.toMatch(/in trx0/);
	});

	test('ignores transfers without a signup memo', async () => {
		const t = setup();
		t.chain.pay({ memo: 'hello' });
		t.chain.pay({ memo: 'signup:nothex' });
		expect((await t.watch.run()).mailed).toBe(false);
	});

	test('skips the check when no signup_account is configured', async () => {
		const t = setup({ signup_account: undefined });
		t.chain.pay({ memo: MEMO_A });
		const r = await t.watch.run();
		expect(r).toEqual({ sections: [], errors: [], mailed: false });
	});
});

describe('signup watch: claimed account tokens', () => {
	test('alerts when tokens drop below the minimum, once, and sends an all-clear', async () => {
		const t = setup();
		t.chain.tokens = 3;
		await t.watch.run();
		expect(t.mails[0].subject).toMatch(/claimed tokens low \(3\)/);
		expect(t.mails[0].body).toMatch(/@actifit has 3 claimed account token\(s\), below 5/);
		t.chain.tokens = 2;
		await t.watch.run();
		expect(t.mails).toHaveLength(1);
		t.chain.tokens = 12;
		await t.watch.run();
		expect(t.mails[1].body).toMatch(/@actifit is back to 12 claimed account tokens/);
		await t.watch.run();
		expect(t.mails).toHaveLength(2);
	});

	test('the minimum comes from config', async () => {
		const t = setup({ signup_watch_min_tokens: 50 });
		t.chain.tokens = 20;
		await t.watch.run();
		expect(t.mails[0].body).toMatch(/below 50/);
	});

	test('a failing token check still lets the other sections through', async () => {
		const t = setup();
		t.chain.failTokens = true;
		t.addClaim(paidClaim({ payment_trx_id: undefined }));
		const r = await t.watch.run();
		expect(r.errors).toEqual(['tokens']);
		expect(r.mailed).toBe(true);
		expect(t.mails[0].subject).toMatch(/new signups: 1/);
		expect(t.logs.some((l) => /tokens check failed: node down/.test(l))).toBe(true);
	});
});

describe('signup watch: delivery', () => {
	test('a failed mail marks nothing, so the next run sends it again', async () => {
		const t = setup();
		t.chain.pay({ memo: MEMO_A });
		t.chain.tokens = 1;
		t.deps.mailFails = true;
		const r = await t.watch.run();
		expect(r.mailed).toBe(false);
		expect(t.claims.docs).toHaveLength(0);
		expect(t.db.collection('signup_watch_seen').docs).toHaveLength(0);
		expect(t.db.collection('signup_watch_state').docs).toHaveLength(0);
		t.deps.mailFails = false;
		await t.watch.run();
		expect(t.mails).toHaveLength(1);
		expect(t.mails[0].subject).toMatch(/unmatched payments: 1, claimed tokens low \(1\)/);
	});

	test('with no report_emails it logs and keeps the items for later', async () => {
		const t = setup({ report_emails: [] });
		t.addClaim(paidClaim());
		const r = await t.watch.run();
		expect(r.mailed).toBe(false);
		expect(t.logs.some((l) => /no report_emails configured/.test(l))).toBe(true);
		expect(t.claims.docs[0].watch_created_at).toBeUndefined();
		t.config.report_emails = ['ops@example.com'];
		await t.watch.run();
		expect(t.mails).toHaveLength(1);
	});

	test('overlapping runs share one pass', async () => {
		const t = setup();
		t.addClaim(paidClaim());
		const [a, b] = await Promise.all([t.watch.run(), t.watch.run()]);
		expect(a).toBe(b);
		expect(t.mails).toHaveLength(1);
	});

	test('a broken database never throws out of run()', async () => {
		const t = setup();
		t.chain.pay({ memo: MEMO_A });
		t.deps.getDb = () => { throw new Error('not connected'); };
		const r = await t.watch.run();
		expect(r.mailed).toBe(false);
		expect(r.errors.sort()).toEqual(['created', 'refunds', 'rewards', 'stuck', 'tokens', 'unmatched']);
	});

	test('mail text never carries the signup email address', async () => {
		const t = setup();
		t.addClaim(paidClaim({ email: 'private@example.org', needs_refund: true }));
		await t.watch.run();
		expect(t.mails[0].body).not.toMatch(/private@example\.org/);
	});
});

describe('signup watch: review round 1', () => {
	const flagAgain = (t, id, set) => {
		const c = t.claims.docs.find((d) => d._id === id);
		Object.assign(c, set, { refund_flagged_at: new Date(t.deps.clock + 1) });
		delete c.watch_refund_at; // what signup_with_keys does on every new refund flag
	};

	test('a claim flagged for a refund again is reported again', async () => {
		const t = setup();
		t.addClaim({ _id: MEMO_A, new_account: 'under', needs_refund: true, insufficient_trx_id: 'trxU', refund_flagged_at: new Date(NOW - 1000) });
		await t.watch.run();
		flagAgain(t, MEMO_A, { status: 'failed', failure_reason: 'username_taken', payment_trx_id: 'trxP', payment_from: 'p',
			verified_amount: 3, verified_currency: 'HIVE' });
		t.deps.clock += 10 * 60 * 1000;
		await t.watch.run();
		expect(t.mails).toHaveLength(2);
		expect(t.mails[1].body).toMatch(/@under \(failed, username_taken; underpaid in trxU\), paid 3\.000 HIVE from @p in trxP/);
	});

	test('a refund flagged again while the mail is going out is not lost', async () => {
		const t = setup();
		t.addClaim({ _id: MEMO_A, new_account: 'under', needs_refund: true, insufficient_trx_id: 'trxU', refund_flagged_at: new Date(NOW - 1000) });
		const send = t.deps.sendMail;
		t.deps.sendMail = async (...a) => { flagAgain(t, MEMO_A, { status: 'failed', failure_reason: 'username_taken' }); return send(...a); };
		await t.watch.run();
		expect(t.claims.docs[0].watch_refund_at).toBeUndefined();
		t.deps.sendMail = send;
		await t.watch.run();
		expect(t.mails).toHaveLength(2);
		expect(t.mails[1].body).toMatch(/failed, username_taken/);
		await t.watch.run();
		expect(t.mails).toHaveLength(2);
	});

	test('a refund on a claim from before refund_flagged_at existed is marked too', async () => {
		const t = setup();
		t.addClaim({ _id: MEMO_A, new_account: 'old', needs_refund: true, status: 'failed', failure_reason: 'username_taken' });
		await t.watch.run();
		await t.watch.run();
		expect(t.mails).toHaveLength(1);
	});

	test('lists every refund reason on a claim', async () => {
		const t = setup();
		t.addClaim(paidClaim({ status: 'failed', failure_reason: 'username_taken', needs_refund: true,
			insufficient_trx_id: 'trxU', extra_transfers: ['trxE1', 'trxE2'], watch_created_at: new Date(NOW) }));
		await t.watch.run();
		expect(t.mails[0].body).toMatch(/\(failed, username_taken; underpaid in trxU; extra transfers trxE1, trxE2\)/);
	});

	test('reports a paid claim whose account is still not created an hour later, once', async () => {
		const t = setup();
		t.chain.pay({ memo: MEMO_A });
		t.chain.pay({ memo: MEMO_B });
		t.addClaim(paidClaim({ status: 'pending', updated_at: new Date(NOW - 2 * 60 * 60 * 1000) }));
		t.addClaim(paidClaim({ _id: MEMO_B, new_account: 'recent', payment_trx_id: 'trx1', status: 'pending', updated_at: new Date(NOW - 30 * 60 * 1000) }));
		t.addClaim(paidClaim({ _id: 'signup:' + 'c'.repeat(24), new_account: 'done', payment_trx_id: 'trx9', updated_at: new Date(NOW - 5 * 60 * 60 * 1000), watch_created_at: new Date(NOW) }));
		t.addClaim(paidClaim({ _id: 'signup:' + 'd'.repeat(24), new_account: 'refused', payment_trx_id: 'trx8', status: 'failed', updated_at: new Date(NOW - 5 * 60 * 60 * 1000) }));
		await t.watch.run();
		expect(t.mails[0].subject).toBe('[Actifit signup watch] paid, account not created: 1');
		expect(t.mails[0].body).toMatch(/@newguy paid 3\.000 HIVE from @payer in trx0, memo signup:a+\. The app retries/);
		expect(t.mails[0].body).not.toMatch(/@recent|@done|@refused/);
		await t.watch.run();
		expect(t.mails).toHaveLength(1);
	});

	test('says a pending claim can still be submitted before calling its payment unmatched', async () => {
		const t = setup();
		t.chain.pay({ memo: MEMO_A });
		t.addClaim({ _id: MEMO_A, new_account: 'waiting', status: 'pending' });
		await t.watch.run();
		expect(t.mails[0].body).toMatch(/claim pending for @waiting: the app can still submit it, check before refunding/);
	});

	test('lists the oldest unmatched payments first when there are more than fit', async () => {
		const t = setup();
		for (let i = 0; i < 55; i++) t.chain.pay({ memo: 'signup:' + String(i).padStart(24, '0'), ageMs: (2 + (i % 2 ? 100 - i : i)) * 60 * 60 * 1000 });
		await t.watch.run();
		expect(t.mails[0].subject).toMatch(/unmatched payments: 50/);
		const times = [...t.mails[0].body.matchAll(/\((2026-[^)]+)\)/g)].map((m) => Date.parse(m[1]));
		expect(times).toHaveLength(50);
		expect(times).toEqual(times.slice().sort((a, b) => a - b));
		t.deps.clock += 10 * 60 * 1000;
		await t.watch.run();
		expect(t.mails[1].subject).toMatch(/unmatched payments: 5/);
		const later = [...t.mails[1].body.matchAll(/\((2026-[^)]+)\)/g)].map((m) => Date.parse(m[1]));
		expect(Math.min(...later)).toBeGreaterThanOrEqual(Math.max(...times));
	});

	test('caps refunds per digest too', async () => {
		const t = setup();
		for (let i = 0; i < 52; i++) t.addClaim({ _id: 'signup:' + String(i).padStart(24, '0'), new_account: 'r' + i, needs_refund: true, status: 'failed' });
		await t.watch.run();
		await t.watch.run();
		expect(t.mails.map((m) => m.subject)).toEqual(['[Actifit signup watch] refunds owed: 50', '[Actifit signup watch] refunds owed: 2']);
	});

	test('labels the token alert and the all-clear by what happened', async () => {
		const t = setup();
		t.chain.tokens = 3;
		await t.watch.run();
		t.chain.tokens = 9;
		await t.watch.run();
		expect(t.mails.map((m) => m.subject)).toEqual(['[Actifit signup watch] claimed tokens low (3)', '[Actifit signup watch] claimed tokens recovered (9)']);
	});

	test('mails once when checks keep failing for an hour, and again only after they recovered', async () => {
		const t = setup();
		t.chain.failTokens = true;
		for (let i = 0; i < 5; i++) await t.watch.run();
		expect(t.mails).toHaveLength(0);
		await t.watch.run();
		expect(t.mails[0].subject).toBe('[Actifit signup watch] watcher checks failing');
		expect(t.mails[0].body).toMatch(/failed 6 runs in a row: tokens/);
		for (let i = 0; i < 10; i++) await t.watch.run();
		expect(t.mails).toHaveLength(1);
		t.chain.failTokens = false;
		await t.watch.run();
		t.chain.failTokens = true;
		for (let i = 0; i < 5; i++) await t.watch.run();
		expect(t.mails).toHaveLength(1);
		await t.watch.run();
		expect(t.mails).toHaveLength(2);
	});

	test('names failed checks in a digest that goes out anyway', async () => {
		const t = setup();
		t.chain.failTokens = true;
		t.addClaim(paidClaim());
		await t.watch.run();
		expect(t.mails[0].body).toMatch(/Checks that failed this run: tokens\./);
	});

	test('logs a missing report_emails once, not every run', async () => {
		const t = setup({ report_emails: [] });
		t.addClaim(paidClaim());
		await t.watch.run();
		await t.watch.run();
		expect(t.logs.filter((l) => /no report_emails/.test(l))).toHaveLength(1);
	});

	test('a duplicate when marking a payment is fine; any other write error is logged', async () => {
		const t = setup();
		t.chain.pay({ memo: MEMO_A });
		const seen = t.db.collection('signup_watch_seen');
		const bulk = (codes) => { const e = new Error('bulk'); e.code = codes[0]; e.writeErrors = codes.map((code) => ({ code })); return e; };
		seen.insertMany = async () => { throw bulk([11000]); };
		await t.watch.run();
		expect(t.logs.some((l) => /may repeat/.test(l))).toBe(false);
		t.chain.pay({ memo: MEMO_B });
		t.deps.clock += 10 * 60 * 1000;
		seen.insertMany = async () => { throw bulk([11000, 121]); };
		await t.watch.run();
		expect(t.logs.some((l) => /marking Unmatched payments failed \(may repeat\)/.test(l))).toBe(true);
	});
});
