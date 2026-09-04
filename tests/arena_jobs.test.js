/**
 * Challenge Engine — scheduled aggregation job (Trello #176/#177) — unit tests.
 *
 * Exercises aggregateActiveChallenges end to end against the in-memory mock:
 * verified_posts → participant scores → per-challenge standings, keyed by the
 * challenge id (what the web detail page queries).
 */

const { createMockDb } = require('./helpers/mock-db');
const jobs = require('../arena_jobs');

const post = (author, dateISO, step_count) => ({
	author,
	permlink: `p-${author}-${dateISO}`,
	date: new Date(dateISO),
	json_metadata: { step_count },
});

const WINDOW = { start: '2026-08-01T00:00:00Z', end: '2026-08-31T23:59:59Z' };

function seed() {
	const db = createMockDb();
	db.collection('challenges').__seed([
		{ id: 'ch_open', state: 'open', type: 'league_fixture', window: WINDOW, scoring: { metric: 'activity_count', rule: 'max' } },
		{ id: 'ch_settled', state: 'settled', type: 'league_fixture', window: WINDOW, scoring: { metric: 'activity_count', rule: 'max' } },
		{ id: 'ch_nowindow', state: 'open', type: 'duel', window: null, scoring: { metric: 'activity_count', rule: 'max' } },
	]);
	db.collection('challenge_participants').__seed([
		{ challenge_id: 'ch_open', entity: 'alice', flags: [] },
		{ challenge_id: 'ch_open', entity: 'bob', flags: [] },
		{ challenge_id: 'ch_settled', entity: 'carol', flags: [] },
	]);
	db.collection('verified_posts').__seed([
		post('alice', '2026-08-10T10:00:00Z', 5000),
		post('alice', '2026-08-11T10:00:00Z', 6000),
		post('bob', '2026-08-10T10:00:00Z', 9000),
	]);
	return db;
}

describe('arena_jobs.aggregateActiveChallenges', () => {
	test('scores participants and builds a per-challenge standings board keyed by challenge id', async () => {
		const db = seed();
		const res = await jobs.aggregateActiveChallenges(db, { asOf: '2026-09-01T00:00:00Z' });

		// ch_open + ch_nowindow are the two aggregatable; ch_nowindow is skipped.
		expect(res.ok).toBe(true);
		expect(res.verified).toBe(1);   // only ch_open verified
		expect(res.standings).toBe(1);
		expect(res.skipped).toBe(1);    // ch_nowindow (no window)
		expect(res.failed).toBe(0);

		// participants got scores
		const alice = await db.collection('challenge_participants').findOne({ challenge_id: 'ch_open', entity: 'alice' });
		expect(alice.score.verified).toBe(11000);
		const bob = await db.collection('challenge_participants').findOne({ challenge_id: 'ch_open', entity: 'bob' });
		expect(bob.score.verified).toBe(9000);

		// standings doc is keyed by the CHALLENGE id (web reads /arena/standings?id=ch_open)
		const board = await db.collection('standings').findOne({ id: 'ch_open' });
		expect(board).toBeTruthy();
		expect(board.rows[0]).toMatchObject({ entity: 'alice', rank: 1 });
		expect(board.rows[1]).toMatchObject({ entity: 'bob', rank: 2 });
	});

	test('does NOT process terminal (settled) challenges', async () => {
		const db = seed();
		await jobs.aggregateActiveChallenges(db);
		const carol = await db.collection('challenge_participants').findOne({ challenge_id: 'ch_settled', entity: 'carol' });
		expect(carol.score).toBeUndefined(); // never scored
		expect(await db.collection('standings').findOne({ id: 'ch_settled' })).toBeNull();
	});

	test('one bad challenge does not abort the sweep', async () => {
		const db = seed();
		// Make buildStandings throw for ch_open by breaking the participants cursor
		// only when queried with the ch_open filter would be complex; instead verify
		// the failure path is counted by monkeypatching a collection method.
		const realFind = db.collection('challenge_participants').find;
		let calls = 0;
		db.collection('challenge_participants').find = (...args) => {
			calls++;
			if (calls === 2) throw new Error('transient read error'); // fail buildStandings' read
			return realFind(...args);
		};
		const res = await jobs.aggregateActiveChallenges(db);
		expect(res.failed).toBe(1);
		expect(res.ok).toBe(true); // sweep still completes
	});

	test('empty DB → clean zeroed summary', async () => {
		const db = createMockDb();
		const res = await jobs.aggregateActiveChallenges(db);
		expect(res).toMatchObject({ ok: true, processed: 0, verified: 0, standings: 0, failed: 0, skipped: 0 });
	});

	test('a participant who LEFT is not scored and not ranked', async () => {
		const db = seed();
		// bob leaves ch_open after posting.
		await db.collection('challenge_participants').updateOne(
			{ challenge_id: 'ch_open', entity: 'bob' }, { $set: { state: 'left' } });
		await jobs.aggregateActiveChallenges(db, { asOf: '2026-09-01T00:00:00Z' });
		const bob = await db.collection('challenge_participants').findOne({ challenge_id: 'ch_open', entity: 'bob' });
		expect(bob.score).toBeUndefined(); // never scored
		const board = await db.collection('standings').findOne({ id: 'ch_open' });
		expect(board.rows.map(r => r.entity)).toEqual(['alice']); // bob absent
	});

	test('a challenge whose window has NOT started is skipped (no premature board)', async () => {
		const db = createMockDb();
		db.collection('challenges').__seed([
			{ id: 'ch_future', state: 'open', type: 'duel',
			  window: { start: '2027-01-01T00:00:00Z', end: '2027-01-08T00:00:00Z' },
			  scoring: { metric: 'activity_count', rule: 'max' } },
		]);
		db.collection('challenge_participants').__seed([{ challenge_id: 'ch_future', entity: 'zoe', flags: [] }]);
		const res = await jobs.aggregateActiveChallenges(db, { asOf: '2026-09-01T00:00:00Z' });
		expect(res.skipped).toBe(1);
		expect(res.standings).toBe(0);
		expect(await db.collection('standings').findOne({ id: 'ch_future' })).toBeNull();
	});

	test('ensureArenaJobIndexes declares the verified_posts {author,date} index', async () => {
		// The shared mock has no createIndex, so drive a bespoke db (mirrors the
		// ensureArenaIndexes test pattern).
		const calls = [];
		const idxDb = { collection: () => ({ createIndex: (spec) => { calls.push(spec); return Promise.resolve(); } }) };
		await jobs.ensureArenaJobIndexes(idxDb);
		expect(calls).toContainEqual({ author: 1, date: 1 });
	});
});
