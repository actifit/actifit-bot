/**
 * Challenge Engine — recurrence AUTO-ENROLMENT (carry-forward) — unit tests.
 *
 * A `join` is a user-signed op scoped to ONE challenge id, so a recurring
 * default rolled into a brand-new id with an EMPTY roster and nobody realised
 * they had to re-join: in production `def_daily_focus@2026-09-25` ran, resolved
 * and settled on-chain for nobody. autoEnrollRecurrences carries the series
 * roster forward by broadcasting the official-signed `enroll` op.
 *
 * The cases that matter:
 *   - carries the roster, and sources it from the WHOLE SERIES (so an already
 *     empty occurrence does not make every later one empty forever)
 *   - respects `state: 'left'` as a real opt-out
 *   - prunes the dormant, keeps the merely-intermittent (the production roster
 *     posts 2-8 reports/week, so the lookback must be generous)
 *   - never double-enrols, never re-broadcasts, never enrols the funder (I7)
 *   - waits for the tailer instead of losing the roster
 */

const { createMockDb } = require('./helpers/mock-db');
const jobs = require('../arena_jobs');

const NOW = '2026-09-27T13:35:00Z';
const nowMs = Date.parse(NOW);
const DAY = 24 * 60 * 60 * 1000;

// A verified activity report `agoDays` before NOW.
const post = (author, agoDays) => ({
	author,
	permlink: `p-${author}-${agoDays}`,
	date: new Date(nowMs - agoDays * DAY),
	json_metadata: { step_count: ['11000'] },
});

/**
 * A daily series with the production-shaped hole: the base ran with a roster,
 * `@09-25` closed EMPTY, and `@09-26` (just rolled from the empty one) is open.
 */
function seed(overrides = {}) {
	const db = createMockDb();
	const win = (startISO, days) => ({
		start: startISO,
		end: new Date(Date.parse(startISO) + days * DAY).toISOString(),
		tz: 'UTC',
	});

	db.collection('challenges').__seed([
		{
			id: 'def_daily_focus', state: 'settled', type: 'daily_focus', recurrence: 'Daily',
			window: win('2026-09-23T13:06:00Z', 1), participants_kind: 'user',
		},
		{
			id: 'def_daily_focus@2026-09-25', state: 'settled', type: 'daily_focus', recurrence: 'Daily',
			parent_id: 'def_daily_focus', window: win('2026-09-25T13:06:00Z', 1), participants_kind: 'user',
		},
		{
			id: 'def_daily_focus@2026-09-26', state: 'open', type: 'daily_focus', recurrence: 'Daily',
			parent_id: 'def_daily_focus', window: win('2026-09-27T13:06:00Z', 1), participants_kind: 'user',
			...(overrides.target || {}),
		},
	]);

	db.collection('challenge_participants').__seed([
		// on the BASE occurrence, two challenges back — the series roster
		{ challenge_id: 'def_daily_focus', entity: 'rajpootg', state: 'settled', flags: [] },
		{ challenge_id: 'def_daily_focus', entity: 'thepavsalford', state: 'settled', flags: [] },
		{ challenge_id: 'def_daily_focus', entity: 'quitter', state: 'left', flags: [] },
		{ challenge_id: 'def_daily_focus', entity: 'dormant', state: 'settled', flags: [] },
		// `@2026-09-25` is EMPTY — the production hole
		...(overrides.participants || []),
	]);

	db.collection('verified_posts').__seed([
		post('rajpootg', 1),        // active
		post('thepavsalford', 4),   // intermittent, but inside a 7-day lookback
		post('quitter', 1),         // active, but opted out
		post('dormant', 40),        // long gone
	]);

	db.collection('challenge_resolutions').__seed([
		{
			challenge_id: 'def_daily_focus@2026-09-25',
			recurred_to: 'def_daily_focus@2026-09-26',
			settle_trx: 'abc123',
			...(overrides.resolution || {}),
		},
	]);
	return db;
}

const collect = () => {
	const sent = [];
	const fn = async (body) => { sent.push(body); return { id: 'trx-' + sent.length }; };
	return { sent, fn };
};

describe('arena_jobs.autoEnrollRecurrences', () => {
	test('carries the series roster into the rolled occurrence via an official enroll op', async () => {
		const db = seed();
		const { sent, fn } = collect();

		const res = await jobs.autoEnrollRecurrences(db, { asOf: NOW, broadcastOp: fn });

		expect(res.ok).toBe(true);
		expect(res.processed).toBe(1);
		expect(res.failed).toBe(0);
		expect(res.ops).toBe(1);

		expect(sent).toHaveLength(1);
		expect(sent[0].op).toBe('enroll');
		expect(sent[0].v).toBe(1);
		expect(sent[0].challenge_id).toBe('def_daily_focus@2026-09-26');
		// Sourced from the BASE (two occurrences back) even though the immediately
		// previous occurrence was empty — the hole must not propagate.
		expect(sent[0].entities).toEqual(['rajpootg', 'thepavsalford']);
		// Provenance, so an auto-enrolment is legible on-chain.
		expect(sent[0].reason).toBe('recurrence_carry_forward');
		expect(sent[0].from).toBe('def_daily_focus@2026-09-25');
		expect(res.enrolled).toBe(2);
	});

	test('a left participant is NOT carried, and a dormant one is pruned', async () => {
		const db = seed();
		const { sent, fn } = collect();
		await jobs.autoEnrollRecurrences(db, { asOf: NOW, broadcastOp: fn });

		expect(sent[0].entities).not.toContain('quitter');   // explicit on-chain opt-out
		expect(sent[0].entities).not.toContain('dormant');   // no activity in the lookback
	});

	test('the lookback is generous enough for an intermittent weekly participant', async () => {
		// thepavsalford last posted 4 days ago. A 2-day lookback would drop a real
		// participant — this is exactly what the production roster looked like.
		const db = seed();
		const { sent, fn } = collect();
		await jobs.autoEnrollRecurrences(db, { asOf: NOW, broadcastOp: fn, lookbackDays: 2 });
		expect(sent[0].entities).toEqual(['rajpootg']);

		const db2 = seed();
		const c2 = collect();
		await jobs.autoEnrollRecurrences(db2, { asOf: NOW, broadcastOp: c2.fn });   // default 7
		expect(c2.sent[0].entities).toContain('thepavsalford');
	});

	test('marks the resolution so a second run broadcasts nothing', async () => {
		const db = seed();
		const first = collect();
		await jobs.autoEnrollRecurrences(db, { asOf: NOW, broadcastOp: first.fn });

		const marker = await db.collection('challenge_resolutions')
			.findOne({ challenge_id: 'def_daily_focus@2026-09-25' });
		expect(marker.auto_enrolled_at).toBe(NOW);
		expect(marker.auto_enrolled_count).toBe(2);
		expect(marker.auto_enroll_reason).toBe('carried forward');

		const second = collect();
		const res2 = await jobs.autoEnrollRecurrences(db, { asOf: NOW, broadcastOp: second.fn });
		expect(second.sent).toHaveLength(0);
		expect(res2.processed).toBe(0);
	});

	test('someone already on the target roster is not enrolled twice', async () => {
		const db = seed({
			participants: [
				{ challenge_id: 'def_daily_focus@2026-09-26', entity: 'rajpootg', state: 'enrolled', flags: [] },
			],
		});
		const { sent, fn } = collect();
		await jobs.autoEnrollRecurrences(db, { asOf: NOW, broadcastOp: fn });
		expect(sent[0].entities).toEqual(['thepavsalford']);
	});

	test('the funder of a prize is never carried in (I7)', async () => {
		const db = seed({ target: { rewards: { funder: 'rajpootg', kind: 'afit', amount: 500 } } });
		const { sent, fn } = collect();
		await jobs.autoEnrollRecurrences(db, { asOf: NOW, broadcastOp: fn });
		expect(sent[0].entities).toEqual(['thepavsalford']);
	});

	test('waits for the tailer rather than losing the roster when the target is unindexed', async () => {
		const db = seed({ resolution: { recurred_to: 'def_daily_focus@2026-09-28' } });
		const { sent, fn } = collect();
		const res = await jobs.autoEnrollRecurrences(db, { asOf: NOW, broadcastOp: fn });

		expect(sent).toHaveLength(0);
		expect(res.skipped).toBe(1);
		// Crucially the marker stays UNSET, so the next tick retries once the
		// tailer has indexed the new challenge.
		const marker = await db.collection('challenge_resolutions')
			.findOne({ challenge_id: 'def_daily_focus@2026-09-25' });
		expect(marker.auto_enrolled_at).toBeUndefined();
	});

	test('a target whose window already closed is marked done, not enrolled', async () => {
		const db = seed({ target: { window: { start: '2026-09-25T13:06:00Z', end: '2026-09-27T13:06:00Z', tz: 'UTC' } } });
		const { sent, fn } = collect();
		const res = await jobs.autoEnrollRecurrences(db, { asOf: NOW, broadcastOp: fn });

		expect(sent).toHaveLength(0);
		expect(res.skipped).toBe(1);
		const marker = await db.collection('challenge_resolutions')
			.findOne({ challenge_id: 'def_daily_focus@2026-09-25' });
		expect(marker.auto_enroll_reason).toBe('target window already closed');
	});

	test('a settled target is marked done, not enrolled', async () => {
		const db = seed({ target: { state: 'settled' } });
		const { sent, fn } = collect();
		const res = await jobs.autoEnrollRecurrences(db, { asOf: NOW, broadcastOp: fn });
		expect(sent).toHaveLength(0);
		expect(res.skipped).toBe(1);
		const marker = await db.collection('challenge_resolutions')
			.findOne({ challenge_id: 'def_daily_focus@2026-09-25' });
		expect(marker.auto_enroll_reason).toBe('target state settled');
	});

	test('no broadcaster leaves every marker unset so nothing is silently lost', async () => {
		const db = seed();
		const res = await jobs.autoEnrollRecurrences(db, { asOf: NOW });
		expect(res.ok).toBe(true);
		expect(res.enrolled).toBe(0);
		const marker = await db.collection('challenge_resolutions')
			.findOne({ challenge_id: 'def_daily_focus@2026-09-25' });
		expect(marker.auto_enrolled_at).toBeUndefined();
	});

	test('an empty carry-forward set is marked done and broadcasts nothing', async () => {
		const db = createMockDb();
		db.collection('challenges').__seed([
			{ id: 'def_x@2026-09-26', state: 'open', type: 'daily_focus', recurrence: 'Daily', parent_id: 'def_x', window: { start: '2026-09-27T13:06:00Z', end: '2026-09-28T13:06:00Z' }, participants_kind: 'user' },
		]);
		db.collection('challenge_participants').__seed([]);
		db.collection('verified_posts').__seed([]);
		db.collection('challenge_resolutions').__seed([
			{ challenge_id: 'def_x@2026-09-25', recurred_to: 'def_x@2026-09-26' },
		]);

		const { sent, fn } = collect();
		const res = await jobs.autoEnrollRecurrences(db, { asOf: NOW, broadcastOp: fn });
		expect(sent).toHaveLength(0);
		expect(res.skipped).toBe(1);
		const marker = await db.collection('challenge_resolutions').findOne({ challenge_id: 'def_x@2026-09-25' });
		expect(marker.auto_enroll_reason).toBe('no active carry-forward candidates');
	});

	test('a roster larger than one op is split into chunks', async () => {
		const db = createMockDb();
		db.collection('challenges').__seed([
			{ id: 'def_big', state: 'settled', type: 'daily_focus', recurrence: 'Daily', window: { start: '2026-09-25T13:06:00Z', end: '2026-09-26T13:06:00Z' }, participants_kind: 'user' },
			{ id: 'def_big@2026-09-26', state: 'open', type: 'daily_focus', recurrence: 'Daily', parent_id: 'def_big', window: { start: '2026-09-27T13:06:00Z', end: '2026-09-28T13:06:00Z' }, participants_kind: 'user' },
		]);
		const n = jobs.AUTO_ENROLL_CHUNK + 5;
		const users = Array.from({ length: n }, (_, i) => `u${String(i).padStart(4, '0')}`);
		db.collection('challenge_participants').__seed(
			users.map((u) => ({ challenge_id: 'def_big', entity: u, state: 'settled', flags: [] }))
		);
		db.collection('verified_posts').__seed(users.map((u) => post(u, 1)));
		db.collection('challenge_resolutions').__seed([
			{ challenge_id: 'def_big', recurred_to: 'def_big@2026-09-26' },
		]);

		const { sent, fn } = collect();
		const res = await jobs.autoEnrollRecurrences(db, { asOf: NOW, broadcastOp: fn });

		expect(res.ops).toBe(2);
		expect(sent).toHaveLength(2);
		expect(sent[0].entities).toHaveLength(jobs.AUTO_ENROLL_CHUNK);
		expect(sent[1].entities).toHaveLength(5);
		// Every carried entity appears exactly once across the chunks.
		const all = [...sent[0].entities, ...sent[1].entities];
		expect(new Set(all).size).toBe(n);
		expect(res.enrolled).toBe(n);
	});

	test('a broadcast failure leaves the marker unset so the roster is retried', async () => {
		const db = seed();
		const boom = async () => { throw new Error('rpc down'); };
		const res = await jobs.autoEnrollRecurrences(db, { asOf: NOW, broadcastOp: boom });

		expect(res.failed).toBe(1);
		expect(res.enrolled).toBe(0);
		const marker = await db.collection('challenge_resolutions')
			.findOne({ challenge_id: 'def_daily_focus@2026-09-25' });
		expect(marker.auto_enrolled_at).toBeUndefined();

		// and a later successful tick carries the full roster
		const { sent, fn } = collect();
		await jobs.autoEnrollRecurrences(db, { asOf: NOW, broadcastOp: fn });
		expect(sent[0].entities).toEqual(['rajpootg', 'thepavsalford']);
	});
});

describe('the enroll op autoEnrollRecurrences emits is accepted by the indexer', () => {
	const arena = require('../arena');

	test('it validates, and only the official account may sign it', async () => {
		const body = {
			op: 'enroll', v: 1,
			challenge_id: 'def_daily_focus@2026-09-26',
			entities: ['rajpootg', 'thepavsalford'],
			reason: 'recurrence_carry_forward',
			from: 'def_daily_focus@2026-09-25',
		};
		expect(arena.validateArenaOp(body)).toEqual({ valid: true, errors: [] });

		const db = createMockDb();
		db.collection('challenges').__seed([
			{ id: 'def_daily_focus@2026-09-26', state: 'open', type: 'daily_focus', participants_kind: 'user' },
		]);
		db.collection('challenge_participants').__seed([]);

		// trx_id/block_num ride on the CHAIN OP (the idempotency key the indexer
		// reads), not on opts — an op without one is refused outright.
		const chainOp = (signer, trx_id) => ({
			id: arena.ARENA_JSON_ID,
			json: JSON.stringify(body),
			required_posting_auths: [signer],
			required_auths: [],
			trx_id,
			block_num: 1,
			timestamp: NOW,
		});

		// a user cannot enrol other people
		const bad = await arena.indexArenaOp(db, chainOp('rajpootg', 't1'), { officialAccount: 'actifit' });
		expect(bad.ok).toBe(false);
		expect(bad.reason).toMatch(/official account/);

		const good = await arena.indexArenaOp(db, chainOp('actifit', 't2'), { officialAccount: 'actifit' });
		expect(good.ok).toBe(true);
		expect(good.count).toBe(2);

		// enrolled in the same shape a real join produces, so scoring picks them up
		const p = await db.collection('challenge_participants')
			.findOne({ challenge_id: 'def_daily_focus@2026-09-26', entity: 'rajpootg' });
		expect(p.state).toBe('enrolled');
		expect(p.score).toBeNull();

		// re-tailing the same op enrols nobody twice
		const again = await arena.indexArenaOp(db, chainOp('actifit', 't2'), { officialAccount: 'actifit' });
		expect(again.ok).toBe(true);
		expect(again.count).toBe(0);
	});
});
