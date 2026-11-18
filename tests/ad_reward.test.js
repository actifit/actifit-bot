/**
 * ad_reward.js: v1 rewarded-ad intents ("r1_<id>" SSV custom data).
 * In-memory stand-in for the two collections; real MongoDB runs when MONGO_TEST_URI is set.
 */

const ar = require('../ad_reward');

function fakeDb() {
	const intents = new Map();
	const tx = [];
	const matchesTx = (d, q) => d.user === q.user && d.reward_activity === q.reward_activity
		&& d.tier === q.tier && d.date >= q.date.$gte;
	return {
		intents, tx,
		collection(name) {
			if (name === 'ad_reward_intents') return {
				createIndex: async () => 'ok',
				insertOne: async (doc) => { intents.set(doc._id, doc); return { insertedId: doc._id }; },
				findOneAndDelete: async (q) => {
					const d = intents.get(q._id);
					if (!d || !(d.expires_at > q.expires_at.$gt)) return { value: null };
					intents.delete(q._id);
					return { value: d };
				},
			};
			if (name === 'token_transactions') return {
				countDocuments: async (q) => tx.filter((d) => matchesTx(d, q)).length,
			};
			throw new Error('unexpected collection ' + name);
		},
	};
}

const T0 = Date.UTC(2026, 10, 18, 12, 0, 0);
const at = (ms) => () => ms;

describe('rewardAmount', () => {
	test('stays inside the tier range, floored to 3 decimals', () => {
		expect(ar.rewardAmount(4, () => 0)).toBe(0.01);
		expect(ar.rewardAmount(4, () => 0.999999)).toBeLessThanOrEqual(10);
		expect(ar.rewardAmount(1, () => 0.5)).toBe(1.505);
		for (let i = 0; i < 200; i++) {
			const v = ar.rewardAmount(3);
			expect(v).toBeGreaterThanOrEqual(0.01);
			expect(v).toBeLessThanOrEqual(7);
			expect(Number(v.toFixed(3))).toBe(v);
		}
	});
	test('unknown tier pays nothing', () => {
		expect(ar.rewardAmount(9)).toBe(0);
	});
});

describe('parseV1', () => {
	test('accepts only r1_ + 32 hex chars', () => {
		expect(ar.parseV1('r1_' + 'a'.repeat(32))).toBe('a'.repeat(32));
		expect(ar.parseV1('r1_' + 'a'.repeat(31))).toBeNull();
		expect(ar.parseV1('r1_' + 'A'.repeat(32))).toBeNull();
		expect(ar.parseV1('r1_' + 'a'.repeat(32) + '_x')).toBeNull();
		expect(ar.parseV1(undefined)).toBeNull();
	});
	test('legacy custom data is left to the legacy path', () => {
		expect(ar.parseV1('alice_2.5_2_5K%20Reward')).toBeNull();
	});
});

describe('intents', () => {
	test('an intent pays once: the second consume finds nothing', async () => {
		const db = fakeDb();
		const { id } = await ar.createIntent(db, 'alice', '3', at(T0));
		expect(id).toMatch(/^[0-9a-f]{32}$/);
		const doc = await ar.consumeIntent(db, id, at(T0 + 1000));
		expect(doc).toMatchObject({ user: 'alice', tier: 3 });
		expect(doc.amount).toBeGreaterThanOrEqual(0.01);
		expect(doc.amount).toBeLessThanOrEqual(7);
		expect(await ar.consumeIntent(db, id, at(T0 + 2000))).toBeNull();
	});

	test('an expired intent is refused', async () => {
		const db = fakeDb();
		const { id } = await ar.createIntent(db, 'alice', 1, at(T0));
		expect(await ar.consumeIntent(db, id, at(T0 + ar.INTENT_TTL_MS + 1))).toBeNull();
	});

	test('a bad tier or malformed id is refused', async () => {
		const db = fakeDb();
		expect(await ar.createIntent(db, 'alice', 0, at(T0))).toEqual({ error: 'bad_tier' });
		expect(await ar.createIntent(db, 'alice', 'x', at(T0))).toEqual({ error: 'bad_tier' });
		expect(await ar.consumeIntent(db, { $ne: null }, at(T0))).toBeNull();
		expect(await ar.consumeIntent(db, 'zz', at(T0))).toBeNull();
	});

	test('no new intent once the tier was paid today (UTC); tomorrow is fine', async () => {
		const db = fakeDb();
		db.tx.push({ user: 'alice', reward_activity: 'Ad Reward', tier: '2', date: new Date(T0 - 3600 * 1000) });
		expect(await ar.createIntent(db, 'alice', 2, at(T0))).toEqual({ error: 'already_claimed' });
		expect((await ar.createIntent(db, 'alice', 3, at(T0))).id).toBeDefined();
		expect((await ar.createIntent(db, 'bob', 2, at(T0))).id).toBeDefined();
		expect((await ar.createIntent(db, 'alice', 2, at(T0 + 24 * 3600 * 1000))).id).toBeDefined();
	});
});

const MONGO_URI = process.env.MONGO_TEST_URI;
(MONGO_URI ? describe : describe.skip)('intents (real MongoDB)', () => {
	const { MongoClient } = require('mongodb');
	let client, db;
	beforeAll(async () => {
		client = await MongoClient.connect(MONGO_URI);
		db = client.db('ad_reward_test_' + Date.now());
	});
	afterAll(async () => { await db.dropDatabase(); await client.close(); });

	test('concurrent consumes of one id: exactly one wins', async () => {
		const { id } = await ar.createIntent(db, 'alice', 4);
		const results = await Promise.all([1, 2, 3, 4, 5].map(() => ar.consumeIntent(db, id)));
		expect(results.filter(Boolean)).toHaveLength(1);
	});
});
