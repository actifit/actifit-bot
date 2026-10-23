/**
 * Single-use claiming of verified posting-signed transactions (signed_tx.js).
 *
 * Uses a real MongoDB when MONGO_TEST_URI is set (claim atomicity and filter semantics
 * matter); otherwise only the pure helpers run.
 */

const { claimVerifiedTx, normalizeAccountName, SIGNED_TX_MAX_AGE_MS } = require('../signed_tx');

describe('normalizeAccountName', () => {
	test('strips @, trims and lowercases; empty for null', () => {
		expect(normalizeAccountName('@Friend ')).toBe('friend');
		expect(normalizeAccountName(undefined)).toBe('');
		expect(normalizeAccountName(null)).toBe('');
	});
});

const uri = process.env.MONGO_TEST_URI;
(uri ? describe : describe.skip)('claimVerifiedTx (real MongoDB)', () => {
	const { MongoClient } = require('mongodb');
	let client, db;
	beforeAll(async () => {
		client = await MongoClient.connect(uri);
		db = client.db('signed_tx_test_' + Date.now());
	});
	afterAll(async () => {
		await db.dropDatabase();
		await client.close();
	});
	beforeEach(async () => { await db.collection('verified_tx').deleteMany({}); });
	// a row as findVerifyTrx stores it: recorded now, signed `signedAgoMs` ago
	const row = (tx_id, signedAgoMs = 0, extra = {}) => Object.assign({
		tx_id, date: new Date(),
		tx: { expiration: new Date(Date.now() - signedAgoMs + 30 * 60 * 1000).toISOString().slice(0, 19) },
	}, extra);

	test('first claim succeeds, second is refused', async () => {
		await db.collection('verified_tx').insertOne(row('a'));
		expect(await claimVerifiedTx(db, 'a', 'buy-gadget')).toBe(true);
		expect(await claimVerifiedTx(db, 'a', 'buy-gadget')).toBe(false);
		const stored = await db.collection('verified_tx').findOne({ tx_id: 'a' });
		expect(stored.consumed_for).toBe('buy-gadget');
	});

	test('concurrent claims: exactly one wins', async () => {
		await db.collection('verified_tx').insertOne(row('b'));
		const results = await Promise.all(Array.from({ length: 20 }, () => claimVerifiedTx(db, 'b', 'activate-gadget')));
		expect(results.filter(Boolean)).toHaveLength(1);
	});

	test('rows recorded before the age limit are refused', async () => {
		await db.collection('verified_tx').insertOne(row('c', 0, { date: new Date(Date.now() - SIGNED_TX_MAX_AGE_MS - 60000) }));
		expect(await claimVerifiedTx(db, 'c', 'buy-gadget')).toBe(false);
	});

	test('an old transaction recorded just now is refused (age is by signing time)', async () => {
		await db.collection('verified_tx').insertOne(row('old', 30 * 24 * 60 * 60 * 1000));
		expect(await claimVerifiedTx(db, 'old', 'buy-gadget')).toBe(false);
	});

	test('the same transaction stored twice still authorises only one action', async () => {
		await db.collection('verified_tx').insertMany([row('dup'), row('dup')]);
		const sequential = [await claimVerifiedTx(db, 'dup', 'x'), await claimVerifiedTx(db, 'dup', 'x')];
		expect(sequential).toEqual([true, false]);
		await db.collection('verified_tx').insertMany([row('dup2'), row('dup2'), row('dup2')]);
		const concurrent = await Promise.all([1, 2, 3].map(() => claimVerifiedTx(db, 'dup2', 'x')));
		expect(concurrent.filter(Boolean).length).toBeLessThanOrEqual(1);
	});

	test('rows without a date (legacy) are refused', async () => {
		await db.collection('verified_tx').insertOne({ tx_id: 'd' });
		expect(await claimVerifiedTx(db, 'd', 'buy-gadget')).toBe(false);
	});

	test('unknown transaction is refused', async () => {
		expect(await claimVerifiedTx(db, 'nope', 'buy-gadget')).toBe(false);
	});

	test('non-string ids cannot match operators', async () => {
		await db.collection('verified_tx').insertOne(row('e'));
		expect(await claimVerifiedTx(db, { $ne: null }, 'buy-gadget')).toBe(false);
	});

	test('database errors fail closed', async () => {
		const broken = { collection: () => ({ findOneAndUpdate: async () => { throw new Error('down'); } }) };
		const log = jest.spyOn(console, 'log').mockImplementation(() => {});
		expect(await claimVerifiedTx(broken, 'a', 'x')).toBe(false);
		log.mockRestore();
	});
});
