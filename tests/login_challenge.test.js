/**
 * Signed-challenge login (login_challenge.js).
 *
 * Signature checks run everywhere; challenge storage runs against a real MongoDB when
 * MONGO_TEST_URI is set (single-use and expiry depend on real query semantics).
 */

const dhive = require('@hiveio/dhive');
// the same module the website imports for HiveAuth verification
const hivejsEcc = require('@hiveio/hive-js/lib/auth/ecc');
const lc = require('../login_challenge');

const keyA = dhive.PrivateKey.fromSeed('login-test-key-a');
const keyB = dhive.PrivateKey.fromSeed('login-test-key-b');
const keyC = dhive.PrivateKey.fromSeed('login-test-key-c');
const pub = (k) => k.createPublic().toString();
const account = (auths, threshold = 1) => ({ name: 'alice', posting: { weight_threshold: threshold, account_auths: [], key_auths: auths } });

// what Hive Keychain's requestSignBuffer does
const signDhive = (key, message) => key.sign(dhive.cryptoUtils.sha256(Buffer.from(message, 'utf8'))).toString();
// what a browser using hive-js does
const signHivejs = (key, message) => hivejsEcc.Signature.signBufferSha256(
	hivejsEcc.hash.sha256(message), key.toString()).toHex();

const MSG = lc.loginMessage('alice', 'ab'.repeat(32));

describe('verifyPostingSignature', () => {
	test('a signature by a current posting key is accepted (Keychain-style signing)', () => {
		expect(lc.verifyPostingSignature(account([[pub(keyA), 1]]), MSG, signDhive(keyA, MSG))).toBe(pub(keyA));
	});

	test('hive-js signatures verify the same way', () => {
		expect(lc.verifyPostingSignature(account([[pub(keyA), 1]]), MSG, signHivejs(keyA, MSG))).toBe(pub(keyA));
	});

	test('any of several posting keys may sign, not only the first', () => {
		const acct = account([[pub(keyA), 1], [pub(keyB), 1]]);
		expect(lc.verifyPostingSignature(acct, MSG, signDhive(keyB, MSG))).toBe(pub(keyB));
	});

	test('a key that is not in the posting authority is refused', () => {
		expect(lc.verifyPostingSignature(account([[pub(keyA), 1]]), MSG, signDhive(keyC, MSG))).toBeNull();
	});

	test('a signature over a different message (other user or nonce) is refused', () => {
		const other = lc.loginMessage('bob', 'ab'.repeat(32));
		expect(lc.verifyPostingSignature(account([[pub(keyA), 1]]), MSG, signDhive(keyA, other))).toBeNull();
		const otherNonce = lc.loginMessage('alice', 'cd'.repeat(32));
		expect(lc.verifyPostingSignature(account([[pub(keyA), 1]]), MSG, signDhive(keyA, otherNonce))).toBeNull();
	});

	test('a key below the authority threshold on its own is refused', () => {
		expect(lc.verifyPostingSignature(account([[pub(keyA), 1], [pub(keyB), 1]], 2), MSG, signDhive(keyA, MSG))).toBeNull();
	});

	test('malformed signatures and accounts are refused without throwing', () => {
		const acct = account([[pub(keyA), 1]]);
		for (const sig of [undefined, null, '', 'zz', '00'.repeat(65), 'g'.repeat(130), { a: 1 }, ['x']]) {
			expect(lc.verifyPostingSignature(acct, MSG, sig)).toBeNull();
		}
		expect(lc.verifyPostingSignature(null, MSG, signDhive(keyA, MSG))).toBeNull();
		expect(lc.verifyPostingSignature({ posting: {} }, MSG, signDhive(keyA, MSG))).toBeNull();
	});
});

describe('validUsername', () => {
	test('accepts Hive account names only', () => {
		for (const ok of ['alice', 'actifit.pay', 'a-b.c1']) expect(lc.validUsername(ok)).toBe(true);
		for (const bad of ['', 'ab', 'Alice', '1abc', 'a'.repeat(17), { $ne: 1 }, ['alice'], null]) expect(lc.validUsername(bad)).toBe(false);
	});
});

const MONGO_URI = process.env.MONGO_TEST_URI;
(MONGO_URI ? describe : describe.skip)('challenges (real MongoDB)', () => {
	const { MongoClient } = require('mongodb');
	let client, db;
	beforeAll(async () => {
		client = await MongoClient.connect(MONGO_URI);
		db = client.db('login_challenge_test_' + Date.now());
	});
	afterAll(async () => { await db.dropDatabase(); await client.close(); });
	beforeEach(async () => { await db.collection('login_challenges').deleteMany({}); });

	test('a challenge is random, bound to the user, and usable once', async () => {
		const a = await lc.createChallenge(db, 'alice');
		const b = await lc.createChallenge(db, 'alice');
		expect(a.nonce).toMatch(/^[0-9a-f]{64}$/);
		expect(a.nonce).not.toBe(b.nonce);
		expect(a.message).toBe(lc.loginMessage('alice', a.nonce));
		expect(await lc.consumeChallenge(db, 'bob', a.nonce)).toBe(false);
		expect(await lc.consumeChallenge(db, 'alice', a.nonce)).toBe(true);
		expect(await lc.consumeChallenge(db, 'alice', a.nonce)).toBe(false);
	});

	test('an expired challenge is refused', async () => {
		let t = Date.now();
		const c = await lc.createChallenge(db, 'alice', () => t);
		t += lc.CHALLENGE_TTL_MS + 1000;
		expect(await lc.consumeChallenge(db, 'alice', c.nonce, () => t)).toBe(false);
	});

	test('concurrent use of one challenge: exactly one succeeds', async () => {
		const c = await lc.createChallenge(db, 'alice');
		const results = await Promise.all(Array.from({ length: 10 }, () => lc.consumeChallenge(db, 'alice', c.nonce)));
		expect(results.filter(Boolean)).toHaveLength(1);
	});

	test('malformed nonces are refused without a query', async () => {
		for (const n of [undefined, '', 'xyz', { $ne: null }, 'AB'.repeat(32)]) {
			expect(await lc.consumeChallenge(db, 'alice', n)).toBe(false);
		}
	});

	test('expired challenges get a TTL index', async () => {
		await lc.createChallenge(db, 'alice');
		await new Promise((r) => setTimeout(r, 200));
		const idx = await db.collection('login_challenges').indexes();
		expect(idx.some((i) => i.key.expires_at === 1 && i.expireAfterSeconds === 0)).toBe(true);
	});
});

(MONGO_URI ? describe : describe.skip)('login routes end to end (real MongoDB, real signatures)', () => {
	const { MongoClient } = require('mongodb');
	let client, db, completeLogin, handlers, deleted, chainAccount;
	const mockRes = () => ({ statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } });
	const call = async (fn, body) => { const res = mockRes(); await fn({ body }, res); return res; };

	beforeAll(async () => {
		client = await MongoClient.connect(MONGO_URI);
		db = client.db('login_routes_test_' + Date.now());
	});
	afterAll(async () => { await db.dropDatabase(); await client.close(); });
	beforeEach(() => {
		deleted = false;
		chainAccount = account([[pub(keyA), 1], [pub(keyB), 1]]);
		completeLogin = jest.fn(async (req, res, username, acct, src) => res.json({ success: true, token: 't', src }));
		handlers = lc.createHandlers({
			getDb: () => db,
			getAccount: async () => chainAccount,
			isDeleted: async () => deleted,
			completeLogin,
			log: () => {},
		});
	});

	const login = async (signKey, opts = {}) => {
		const ch = await call(handlers.challenge, { username: 'alice' });
		const message = opts.message || ch.body.message;
		const signature = (opts.signer || signDhive)(signKey, message);
		return { ch, res: await call(handlers.verify, { username: opts.as || 'alice', nonce: ch.body.nonce, signature, method: opts.method || 'keychain' }) };
	};

	test('challenge → Keychain signature → session', async () => {
		const { ch, res } = await login(keyA);
		expect(ch.body).toMatchObject({ success: true, expires_in: 120 });
		expect(res.body).toMatchObject({ success: true, src: 'signed-keychain' });
		expect(completeLogin).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'alice', chainAccount, 'signed-keychain');
	});

	test('a browser hive-js signature with the second posting key works too', async () => {
		const { res } = await login(keyB, { signer: signHivejs, method: 'posting' });
		expect(res.body).toMatchObject({ success: true, src: 'signed-posting' });
	});

	test('replaying a used challenge and signature is refused', async () => {
		const ch = await call(handlers.challenge, { username: 'alice' });
		const body = { username: 'alice', nonce: ch.body.nonce, signature: signDhive(keyA, ch.body.message), method: 'keychain' };
		expect((await call(handlers.verify, body)).statusCode).toBe(200);
		const again = await call(handlers.verify, body);
		expect(again.statusCode).toBe(403);
		expect(completeLogin).toHaveBeenCalledTimes(1);
	});

	test('a key outside the posting authority is refused, and the challenge is spent', async () => {
		const ch = await call(handlers.challenge, { username: 'alice' });
		const bad = await call(handlers.verify, { username: 'alice', nonce: ch.body.nonce, signature: signDhive(keyC, ch.body.message) });
		expect(bad.statusCode).toBe(403);
		const retry = await call(handlers.verify, { username: 'alice', nonce: ch.body.nonce, signature: signDhive(keyA, ch.body.message) });
		expect(retry.statusCode).toBe(403);
		expect(completeLogin).not.toHaveBeenCalled();
	});

	test('a challenge issued for one user cannot log in another', async () => {
		const { res } = await login(keyA, { as: 'bobby' });
		expect(res.statusCode).toBe(403);
		expect(completeLogin).not.toHaveBeenCalled();
	});

	test('deleted accounts are refused', async () => {
		deleted = true;
		expect((await login(keyA)).res.statusCode).toBe(403);
		expect(completeLogin).not.toHaveBeenCalled();
	});

	test('a chain lookup failure answers 503, never a session', async () => {
		chainAccount = null;
		expect((await login(keyA)).res.statusCode).toBe(503);
		expect(completeLogin).not.toHaveBeenCalled();
	});

	test('bad input is refused without touching the database', async () => {
		for (const body of [{}, { username: 'alice' }, { username: { $ne: 1 }, nonce: 'a', signature: 'b' }, { username: 'alice', nonce: ['x'], signature: 'b' }]) {
			expect((await call(handlers.verify, body)).statusCode).toBe(400);
		}
		expect((await call(handlers.challenge, { username: ['alice'] })).statusCode).toBe(400);
	});

	test('an unknown method is recorded as such, not trusted from the client', async () => {
		const { res } = await login(keyA, { method: 'admin' });
		expect(res.body.src).toBe('signed-unknown');
	});
});
