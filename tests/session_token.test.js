/**
 * Session tokens stored as hashes (session_token.js).
 */

const crypto = require('crypto');
const { hashToken, sessionFilter } = require('../session_token');

describe('session_token', () => {
	test('hashToken is the SHA-256 hex of the token', () => {
		expect(hashToken('abc')).toBe(crypto.createHash('sha256').update('abc').digest('hex'));
		expect(hashToken('abc')).not.toContain('abc');
	});

	test('sessionFilter matches the hash, or a plaintext token from before hashing', () => {
		expect(sessionFilter('alice', 'tok')).toEqual({ user: 'alice', $or: [{ token_hash: hashToken('tok') }, { token: 'tok' }] });
	});

	test('operator-shaped input is turned into plain strings', () => {
		const f = sessionFilter({ $ne: null }, { $ne: null });
		expect(typeof f.user).toBe('string');
		expect(typeof f.$or[1].token).toBe('string');
		expect(typeof f.$or[0].token_hash).toBe('string');
	});
});

const MONGO_URI = process.env.MONGO_TEST_URI;
(MONGO_URI ? describe : describe.skip)('sessionFilter against a real MongoDB', () => {
	const { MongoClient } = require('mongodb');
	let client, col;
	beforeAll(async () => {
		client = await MongoClient.connect(MONGO_URI);
		col = client.db('session_token_test_' + Date.now()).collection('user_login_token');
		await col.insertMany([
			{ user: 'alice', token_hash: hashToken('new-token') },
			{ user: 'bob', token: 'legacy-token' },
		]);
	});
	afterAll(async () => { await col.s.db.dropDatabase(); await client.close(); });

	test('finds hashed and legacy rows, nothing else', async () => {
		expect(await col.countDocuments(sessionFilter('alice', 'new-token'))).toBe(1);
		expect(await col.countDocuments(sessionFilter('bob', 'legacy-token'))).toBe(1);
		expect(await col.countDocuments(sessionFilter('alice', hashToken('new-token')))).toBe(0); // the hash is not a token
		expect(await col.countDocuments(sessionFilter('alice', 'legacy-token'))).toBe(0); // wrong user
		expect(await col.countDocuments(sessionFilter('bob', { $ne: null }))).toBe(0);
	});
});
