/**
 * Challenge Engine end-to-end DEMO (dev tool, not shipped in the API).
 *
 * Drives the whole F1–F6 pipeline against the in-memory mock DB — no Mongo, no
 * config, no network. Run:  node scripts/arena_demo.js
 *
 * It shows a challenge going from creation → joins → verification (with a
 * cheater flagged) → standings → pool → resolution/payout → the read API, plus
 * a couple of compliance rejections.
 */

'use strict';

// Shim jest.fn so the in-memory mock DB can run outside the test runner.
global.jest = global.jest || { fn: (impl) => (impl || (() => {})) };

const { createMockDb } = require('../tests/helpers/mock-db');
const arena = require('../arena');
const verify = require('../arena_verify');
const standings = require('../arena_standings');
const merits = require('../arena_merits');
const pools = require('../arena_pools');
const api = require('../arena_api');

const OFFICIAL = 'actifit';
const line = (s) => console.log(s);
const hr = (t) => line(`\n========== ${t} ==========`);

// build an on-chain custom_json op envelope
const op = (body, signer, trx) => ({
	id: arena.ARENA_JSON_ID,
	json: JSON.stringify(body),
	required_posting_auths: [signer],
	required_auths: [],
	trx_id: trx,
	block_num: 1,
	timestamp: '2026-08-10T00:00:00',
});
const post = (author, dateISO, steps) => ({ author, permlink: `p-${author}-${dateISO}`, date: new Date(dateISO), json_metadata: { step_count: steps } });

(async () => {
	const db = createMockDb();

	hr('1. Seed the §7.5 default contest set');
	const seeded = await api.seedDefaultContests(db, { officialAccount: OFFICIAL, nowMs: Date.parse('2026-08-01T00:00:00Z'), at: '2026-08-01T00:00:00' });
	line(`seeded ${seeded.seeded} official contests:`);
	for (const c of await api.listChallenges(db)) line(`   • ${c.title}  [${c.type}]  state=${c.state}`);

	hr('2. Create a weekly step-league challenge + players join (on-chain ops)');
	const window = { start: '2026-08-09T00:00:00Z', end: '2026-08-16T00:00:00Z' };
	await arena.indexArenaOp(db, op({ op: 'challenge_create', v: 1, id: 'ch_demo', type: 'league_fixture', origin_tier: 'official', title: 'Demo Step League', window, entry: { mode: 'free' }, scoring: { metric: 'activity_count', rule: 'max' } }, OFFICIAL, 'trx_create'), { officialAccount: OFFICIAL });
	for (const u of ['alice', 'bob', 'eve']) {
		const r = await arena.indexArenaOp(db, op({ op: 'join', challenge_id: 'ch_demo' }, u, `trx_join_${u}`));
		line(`   ${u} joined → ${r.action}  (signed by ${u} — participation is cryptographic)`);
	}

	hr('3. Real activity lands as verified_posts (the trusted input)');
	db.collection('verified_posts').__seed([
		post('alice', '2026-08-10T10:00:00Z', 9000), post('alice', '2026-08-11T10:00:00Z', 11000), post('alice', '2026-08-12T10:00:00Z', 12000),
		post('bob', '2026-08-10T10:00:00Z', 7000), post('bob', '2026-08-11T10:00:00Z', 8000), post('bob', '2026-08-12T10:00:00Z', 6000),
		post('eve', '2026-08-10T10:00:00Z', 5000), post('eve', '2026-08-11T10:00:00Z', 6000), post('eve', '2026-08-12T10:00:00Z', 350000), // implausible
	]);
	line('   alice: 9k+11k+12k   bob: 7k+8k+6k   eve: 5k+6k+350k (⚠ implausible)');

	hr('4. Verify — trusted scores + anti-cheat flags');
	const v = await verify.verifyChallenge(db, 'ch_demo', { asOf: '2026-08-16T00:00:00Z' });
	line(`   verified ${v.participants} participants, ${v.flagged} flagged for review`);
	for (const p of await db.collection('challenge_participants').find({ challenge_id: 'ch_demo' }).toArray()) {
		line(`   ${p.entity}: verified=${p.score.verified}  flags=[${p.flags.join(',') || '—'}]`);
	}

	hr('5. Standings — ranked, held players excluded from prize slots');
	const s = await standings.buildStandings(db, { challengeIds: ['ch_demo'], scope: 'league', window: { kind: 'weekly', index: 1 }, cohort: null, promotion: { up: 1, down: 1 } });
	line(`   ranked ${s.ranked} (held-out: ${s.held})`);
	const stDoc = await db.collection('standings').findOne({ id: s.id });
	for (const row of stDoc.rows) line(`   #${row.rank} ${row.entity}  score=${row.score}  ${row.movement}`);

	hr('6. Fund a treasury pool + resolve → payouts');
	await pools.createPool(db, { id: 'pool_demo', funding: 'treasury', budget: 1000, currency: 'AFIT' });
	const res = await pools.resolveChallenge(db, {
		challengeId: 'ch_demo', poolId: 'pool_demo',
		standings: stDoc.rows.map((r) => ({ entity: r.entity, rank: r.rank, score_verified: r.score })),
		prizes: [{ rank: 1, afit: 100, merits: 50, badges: ['champion'] }, { rank: 2, merits: 20 }],
		asOf: '2026-08-16T00:00:00Z',
	});
	line(`   resolved: paid ${res.paidAfit} AFIT to ${res.rewarded} winners`);
	line(`   Merit balances → alice=${await merits.balanceOf(db, 'alice')}  bob=${await merits.balanceOf(db, 'bob')}  eve=${await merits.balanceOf(db, 'eve')} (eve got nothing — held)`);
	line('   on-chain settle payload the broadcaster would post:');
	line('   ' + JSON.stringify(res.settlePayload));

	hr('7. Rewards shop — earn-only Merits spent on fixed-content items');
	await merits.addShopItem(db, { id: 'shirt', kind: 'cosmetic', title: 'Champion Shirt', cost_merits: 30, stock: 5 });
	const buy = await merits.purchase(db, { user: 'alice', itemId: 'shirt', at: '2026-08-16T01:00:00Z' });
	line(`   alice buys "Champion Shirt" (30 merits) → ${buy.ok ? 'ok' : buy.reason};  alice balance now ${await merits.balanceOf(db, 'alice')}`);

	hr('8. Read API (what web/app consume)');
	const ch = await api.getChallenge(db, 'ch_demo');
	line(`   getChallenge(ch_demo): "${ch.challenge.title}", ${ch.participants.length} participants (flags projected out: ${ch.participants[0].flags === undefined})`);
	line(`   getMerits(alice): balance=${(await api.getMerits(db, 'alice')).balance}, ledger rows=${(await api.getMerits(db, 'alice')).ledger.length}`);
	line(`   getPool(pool_demo): budget=${(await api.getPool(db, 'pool_demo')).budget} paid=${(await api.getPool(db, 'pool_demo')).paid}`);

	hr('9. Compliance guardrails (house rule) — these are REJECTED');
	const fee = await arena.indexArenaOp(db, op({ op: 'challenge_create', v: 1, id: 'ch_bad', type: 'duel', window, entry: { mode: 'fee', fee: 100 }, scoring: { metric: 'steps', rule: 'max' } }, OFFICIAL, 'trx_bad'), { officialAccount: OFFICIAL });
	line(`   fee-entry challenge (I1):        ${fee.ok ? 'ALLOWED ✗' : 'rejected ✓ — ' + fee.reason}`);
	const mint = await merits.award(db, { user: 'eve', amount: 999999, reason: 'admin_adjust', at: '2026-08-16T00:00:00Z' });
	line(`   unauthorized Merit mint (I3/I4): ${mint.ok ? 'ALLOWED ✗' : 'rejected ✓ — ' + mint.reason}`);
	const stake = await pools.createPool(db, { id: 'p_bad', funding: 'stake', budget: 100 });
	line(`   participant-stake pool (I2):     ${stake.ok ? 'ALLOWED ✗' : 'rejected ✓ — ' + stake.reason}`);

	hr('DONE — a challenge ran end-to-end: create → join → verify → rank → pay → spend → read');
})().catch((e) => { console.error('DEMO ERROR', e); process.exit(1); });
