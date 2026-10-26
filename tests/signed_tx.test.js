/**
 * Single-use claiming of verified posting-signed transactions (signed_tx.js).
 *
 * Uses a real MongoDB when MONGO_TEST_URI is set (claim atomicity and filter semantics
 * matter); otherwise only the pure helpers run.
 */

const { claimVerifiedTx, normalizeAccountName, txSigners, SIGNED_TX_MAX_AGE_MS } = require('../signed_tx');

describe('normalizeAccountName', () => {
	test('strips @, trims and lowercases; empty for null', () => {
		expect(normalizeAccountName('@Friend ')).toBe('friend');
		expect(normalizeAccountName(undefined)).toBe('');
		expect(normalizeAccountName(null)).toBe('');
	});
});

describe('txSigners', () => {
	test('counts posting authority only: custom_json posting auths and posting ops, not transfers or active auths', () => {
		const tx = { operations: [
			['custom_json', { required_posting_auths: ['alice'], required_auths: ['act'], id: 'x', json: '{}' }],
			['vote', { voter: 'bob', author: 'z', permlink: 'p', weight: 1 }],
			['transfer', { from: 'carol', to: 'shop', amount: '1.000 HIVE', memo: '' }],
		] };
		expect(txSigners(tx).sort()).toEqual(['alice', 'bob']);
		expect(txSigners(null)).toEqual([]);
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
	beforeEach(async () => {
		await db.collection('verified_tx').deleteMany({});
		await db.collection('consumed_tx').deleteMany({});
		await db.collection('key_rotation_required').deleteMany({});
	});

	describe('signers flagged for a key change', () => {
		const SINCE = new Date('2026-10-21T19:00:00Z');
		const CLEARED = new Date(Date.now() - 60 * 60 * 1000);
		const cj = (user, block_num) => row('cj-' + user + '-' + block_num, 0, { tx: {
			expiration: new Date(Date.now() + 30 * 60 * 1000).toISOString().slice(0, 19),
			block_num,
			operations: [['custom_json', { required_posting_auths: [user], required_auths: [], id: 'actifit', json: '{}' }]],
		} });
		const flag = (user, extra = {}) => db.collection('key_rotation_required').insertOne(Object.assign({ user, since: SINCE, group: 'A' }, extra));
		const claim = async (r) => { await db.collection('verified_tx').insertOne(r); return claimVerifiedTx(db, r.tx_id, 'buy-gadget'); };

		test('an unflagged signer is unaffected', async () => {
			expect(await claim(cj('clean', 100))).toBe(true);
		});

		test('a still-active flag refuses the transaction', async () => {
			await flag('u1');
			expect(await claim(cj('u1', 9999))).toBe(false);
		});

		test('cleared with a key-change block: only transactions from later blocks pass', async () => {
			await flag('u2', { cleared_at: CLEARED, rotated_block: 5000 });
			expect(await claim(cj('u2', 4999))).toBe(false);
			expect(await claim(cj('u2', 5000))).toBe(false);
			expect(await claim(cj('u2', 5001))).toBe(true);
		});

		test('cleared with a key-change block but the transaction has no block number: refused', async () => {
			await flag('u3', { cleared_at: CLEARED, rotated_block: 5000 });
			expect(await claim(cj('u3', undefined))).toBe(false);
		});

		test('cleared without a key-change block: left to the gate hold', async () => {
			await flag('u4', { cleared_at: CLEARED });
			expect(await claim(cj('u4', 1))).toBe(true);
		});

		test('re-flagged after a clear: refused', async () => {
			await flag('u5', { cleared_at: new Date('2026-10-20T00:00:00Z'), rotated_block: 5000 });
			expect(await claim(cj('u5', 9999))).toBe(false);
		});

		test('a HIVE transfer from a flagged account (active key) still passes', async () => {
			await flag('u6');
			const r = row('tr-u6', 0, { tx: {
				expiration: new Date(Date.now() + 30 * 60 * 1000).toISOString().slice(0, 19),
				block_num: 10, operations: [['transfer', { from: 'u6', to: 'actifit.market', amount: '1.000 HIVE', memo: 'buy-gadget:x' }]],
			} });
			expect(await claim(r)).toBe(true);
		});
	});
	// a row as findVerifyTrx stores it: recorded now, signed `signedAgoMs` ago
	const row = (tx_id, signedAgoMs = 0, extra = {}) => Object.assign({
		tx_id, chain: 'HIVE', date: new Date(),
		tx: { expiration: new Date(Date.now() - signedAgoMs + 30 * 60 * 1000).toISOString().slice(0, 19) },
	}, extra);

	test('first claim succeeds, second is refused', async () => {
		await db.collection('verified_tx').insertOne(row('a'));
		expect(await claimVerifiedTx(db, 'a', 'buy-gadget')).toBe(true);
		expect(await claimVerifiedTx(db, 'a', 'buy-gadget')).toBe(false);
		const claim = await db.collection('consumed_tx').findOne({ _id: 'a' });
		expect(claim.purpose).toBe('buy-gadget');
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
		expect(concurrent.filter(Boolean)).toHaveLength(1);
	});

	test('duplicate rows under concurrency: exactly one winner, every time', async () => {
		for (let i = 0; i < 50; i++) {
			const id = 'race' + i;
			await db.collection('verified_tx').insertMany([row(id), row(id), row(id)]);
			const results = await Promise.all([1, 2, 3, 4].map(() => claimVerifiedTx(db, id, 'x')));
			expect(results.filter(Boolean)).toHaveLength(1);
		}
	});

	test('rows recorded from another chain are refused', async () => {
		await db.collection('verified_tx').insertOne(row('blurt', 0, { chain: 'BLURT' }));
		await db.collection('verified_tx').insertOne(row('nochain', 0, { chain: undefined }));
		expect(await claimVerifiedTx(db, 'blurt', 'buy-gadget')).toBe(false);
		expect(await claimVerifiedTx(db, 'nochain', 'buy-gadget')).toBe(false);
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
		const broken = { collection: () => ({
			findOne: async () => { throw new Error('down'); },
			insertOne: async () => { throw new Error('down'); },
		}) };
		const log = jest.spyOn(console, 'log').mockImplementation(() => {});
		expect(await claimVerifiedTx(broken, 'a', 'x')).toBe(false);
		log.mockRestore();
	});
});
