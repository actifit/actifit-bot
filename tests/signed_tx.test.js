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

	test('first claim succeeds, second is refused', async () => {
		await db.collection('verified_tx').insertOne({ tx_id: 'a', date: new Date() });
		expect(await claimVerifiedTx(db, 'a', 'buy-gadget')).toBe(true);
		expect(await claimVerifiedTx(db, 'a', 'buy-gadget')).toBe(false);
		const row = await db.collection('verified_tx').findOne({ tx_id: 'a' });
		expect(row.consumed_for).toBe('buy-gadget');
	});

	test('concurrent claims: exactly one wins', async () => {
		await db.collection('verified_tx').insertOne({ tx_id: 'b', date: new Date() });
		const results = await Promise.all(Array.from({ length: 20 }, () => claimVerifiedTx(db, 'b', 'activate-gadget')));
		expect(results.filter(Boolean)).toHaveLength(1);
	});

	test('rows recorded before the age limit are refused', async () => {
		await db.collection('verified_tx').insertOne({ tx_id: 'c', date: new Date(Date.now() - SIGNED_TX_MAX_AGE_MS - 60000) });
		expect(await claimVerifiedTx(db, 'c', 'buy-gadget')).toBe(false);
	});

	test('rows without a date (legacy) are refused', async () => {
		await db.collection('verified_tx').insertOne({ tx_id: 'd' });
		expect(await claimVerifiedTx(db, 'd', 'buy-gadget')).toBe(false);
	});

	test('unknown transaction is refused', async () => {
		expect(await claimVerifiedTx(db, 'nope', 'buy-gadget')).toBe(false);
	});

	test('non-string ids cannot match operators', async () => {
		await db.collection('verified_tx').insertOne({ tx_id: 'e', date: new Date() });
		expect(await claimVerifiedTx(db, { $ne: null }, 'buy-gadget')).toBe(false);
	});

	test('database errors fail closed', async () => {
		const broken = { collection: () => ({ findOneAndUpdate: async () => { throw new Error('down'); } }) };
		const log = jest.spyOn(console, 'log').mockImplementation(() => {});
		expect(await claimVerifiedTx(broken, 'a', 'x')).toBe(false);
		log.mockRestore();
	});
});
