/**
 * AFIT amounts must be real numbers.
 *
 * 13 signups (May-July 2026) stored a Signup Reward with token_count: NaN. Balances are a
 * SUM of token_count, so each of those users' whole AFIT balance became NaN - and a NaN
 * balance slipped past "not enough AFIT" checks (NaN < x is false): one account used it
 * to exchange 22,400 AFIT for upvotes while holding ~11,400.
 *
 * The balance-rebuild tests use a real MongoDB (set MONGO_TEST_URI): how NaN, null and
 * strings behave in a $match / $sum is exactly what is under test, and a mock would only
 * repeat my own assumptions about it.
 */
const { MongoClient } = require('mongodb');
const utils = require('../utils');
const d = require('../delegations');
const arenaAfit = require('../arena_afit');

describe('utils.UPVOTE_EXCHANGE_TIERS', () => {
	test('is exactly the four tiers the wallet offers and the voter prices at 10-25%', () => {
		expect(utils.UPVOTE_EXCHANGE_TIERS).toEqual([50, 100, 150, 200]);
	});
});

describe('utils.finiteAmount - the one rule for "is this an AFIT amount"', () => {
	test.each([
		[100, 100], ['100', 100], ['0.013', 0.013], [-30, -30], ['-1000', -1000], [0, 0]
	])('%p -> %p', (input, expected) => {
		expect(utils.finiteAmount(input)).toBe(expected);
	});

	test.each([
		[undefined], [null], [''], ['  '], ['NaN'], [NaN], ['abc'], ['100abc'], [Infinity], ['Infinity'], [{}],
		// numbers and strings only: qs can turn a query param into an array
		[true], [[5]]
	])('%p is not an amount', (input) => {
		expect(utils.finiteAmount(input)).toBeNull();
	});

	test('a NaN balance can no longer pass a "not enough AFIT" check', () => {
		// the exchange route compared parseFloat("NaN") < min -> false -> allowed
		const balance = utils.finiteAmount('NaN');
		const allowed = balance !== null && !(balance < 200);
		expect(allowed).toBe(false);
	});
});

const MONGO_URI = process.env.MONGO_TEST_URI;
const describeDb = MONGO_URI ? describe : describe.skip;

describeDb('daily balance rebuild (delegations.updateUserTokens) on a real MongoDB', () => {
	let client, db;

	beforeAll(async () => {
		client = await new MongoClient(MONGO_URI).connect();
		db = client.db('afit_amounts_test_' + Date.now());
		d.__setTestDb(db);
	});
	afterAll(async () => {
		if (db) await db.dropDatabase();
		if (client) await client.close();
	});
	beforeEach(async () => {
		await db.dropDatabase();
		await db.collection('token_transactions').insertMany([
			{ user: 'good', token_count: 100 },
			{ user: 'good', token_count: -30 },
			{ user: 'good', token_count: 0.5 },
			// the production case: a Signup Reward stored as NaN, plus normal rows
			{ user: 'poisoned', reward_activity: 'Signup Reward', token_count: NaN },
			{ user: 'poisoned', token_count: 100 },
			{ user: 'poisoned', token_count: 24.21 },
			// other ways a row can be broken
			{ user: 'messy', token_count: 10 },
			{ user: 'messy', token_count: null },
			{ user: 'messy' },
			{ user: 'messy', token_count: '12' },
			{ user: 'messy', token_count: Infinity },
			{ user: 'onlybad', token_count: NaN }
		]);
	});

	const balances = async () => {
		const rows = await db.collection('user_tokens').find({}).toArray();
		return Object.fromEntries(rows.map((r) => [r._id, r.tokens]));
	};

	test('one NaN row no longer turns a user\'s whole balance into NaN', async () => {
		await d.updateUserTokens();
		const b = await balances();
		expect(b.poisoned).toBeCloseTo(124.21, 6);
		expect(Number.isNaN(b.poisoned)).toBe(false);
	});

	test('normal balances are unchanged', async () => {
		await d.updateUserTokens();
		expect((await balances()).good).toBeCloseTo(70.5, 6);
	});

	test('null, missing, string and Infinity amounts are skipped, real ones counted', async () => {
		await d.updateUserTokens();
		expect((await balances()).messy).toBe(10);
	});

	test('a user with only broken rows gets no NaN balance', async () => {
		await d.updateUserTokens();
		const b = await balances();
		// no document at all: the API then reports 0 for them (grabUserTokensFunc)
		expect(b.onlybad).toBeUndefined();
		expect(Object.values(b).some((v) => Number.isNaN(v))).toBe(false);
	});

	test('arena reconcileBalance sums the real rows instead of zeroing on a NaN row', async () => {
		// before: $sum -> NaN, then Number(NaN) || 0 -> the balance was set to 0
		await arenaAfit.reconcileBalance(db, 'poisoned');
		const doc = await db.collection('user_tokens').findOne({ _id: 'poisoned' });
		expect(doc.tokens).toBeCloseTo(124.21, 6);
	});

	test('utils.FINITE_AMOUNT matches exactly the numeric rows', async () => {
		const n = await db.collection('token_transactions').countDocuments({ token_count: utils.FINITE_AMOUNT });
		// good x3, poisoned 100 + 24.21, messy 10
		expect(n).toBe(6);
	});
});
