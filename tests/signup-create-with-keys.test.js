/**
 * createHiveAccountWithKeys: the app derives the new account's keys on the phone and
 * sends only the public keys, so the server never holds a signup password.
 *
 * What these tests pin:
 * - only well-formed, distinct public keys that are not ours reach the chain;
 * - an account already on chain with these exact keys is reported as
 *   exists_with_same_keys, never as success: keys are public, so only the route's own
 *   signup record can prove the caller made the original request;
 * - no claimed token means no account unless the caller passes allowFee === true;
 * - the legacy password signup builds the same operation through the shared code and
 *   still reports a broadcast error as failure.
 */

const path = require('path');

const mockConfigFs = () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    readFileSync: jest.fn((filePath, options) => {
      if (path.basename(filePath) === 'config.json') {
        return actual.readFileSync(path.join(__dirname, 'test-config.json'), options);
      }
      return actual.readFileSync(filePath, options);
    }),
  };
};
jest.doMock('node:fs', mockConfigFs);
jest.doMock('fs', mockConfigFs);
jest.doMock('firebase-admin', () => ({
  initializeApp: jest.fn(),
  credential: { cert: jest.fn(() => 'mock-cert') },
  messaging: jest.fn(() => ({ sendAll: jest.fn(), sendEach: jest.fn() })),
}));

// Real key classes, scripted chain: every database call and broadcast goes through
// the per-test functions below.
jest.mock('@hiveio/dhive', () => {
  const actual = jest.requireActual('@hiveio/dhive');
  class Client {
    get database() {
      return {
        call: (m, p) => Client.__db(m, p),
        getChainProperties: () => Client.__props(),
      };
    }
    get broadcast() { return { sendOperations: (ops, key) => Client.__send(ops, key) }; }
  }
  Client.__db = () => Promise.reject(new Error('no db script'));
  Client.__props = () => Promise.resolve({ account_creation_fee: '3.000 HIVE' });
  Client.__send = () => Promise.resolve({ id: 'tx' });
  return { ...actual, Client };
});
jest.mock('dblurt', () => {
  class Client {
    get database() { return { call: () => Promise.resolve([]) }; }
    get broadcast() { return { sendOperations: () => Promise.resolve({ id: 'tx' }) }; }
  }
  return { Client, PrivateKey: { fromString: () => ({}), fromLogin: () => ({ createPublic: () => 'BLTX' }) } };
});

const dhive = require('@hiveio/dhive');
const utils = require('../utils');
const { Types } = require('@hiveio/dhive/lib/chain/serializer');
const ByteBuffer = require('bytebuffer');
const config = utils.getConfig();

// Shared with the Android app's key-derivation tests (dhive PrivateKey.fromLogin).
const VECTOR_USER = 'actifit-test';
const VECTOR_PASS = 'P5KtestvectorpasswordONE';
const VECTOR_OWNER = 'STM5TYWxLMC57AdGrZp8Z2iryQdfu9WZ3RSqmA1qAL45nYT2BxAdk';

const keysFor = (user, pass) => {
  const out = {};
  for (const role of ['owner', 'active', 'posting', 'memo']) {
    out[role] = dhive.PrivateKey.fromLogin(user, pass, role).createPublic().toString();
  }
  return out;
};
const KEYS = keysFor(VECTOR_USER, VECTOR_PASS);
// Valid checksum and STM encoding, but the point is not on secp256k1.
const OFF_CURVE = 'STM4tVMTu4hrMTGeAQpAEzueCYqEESJQgkaH9DVJNnzK1mzLqr2dv';

let sends;
let dbCalls;
const OUR_ACTIVE = dhive.PrivateKey.fromSeed('actifit-test-active-key');

/** Script the chain: what the new name and our creator account look like. */
/** Script the chain: what the new name and our creator account look like. */
const chain = ({ existing = null, claimed = 5, creator = true, broadcastThrows = false, afterBroadcast = null,
  lookupThrows = false } = {}) => {
  let broadcasted = false;
  dhive.Client.__db = (method, params) => {
    const name = params[0][0];
    dbCalls.push(name);
    if (lookupThrows) return Promise.reject(new Error('HTTP 503'));
    if (name === config.account) return Promise.resolve(creator ? [{ name, pending_claimed_accounts: claimed }] : []);
    const acct = broadcasted && afterBroadcast ? afterBroadcast : existing;
    return Promise.resolve(acct ? [acct] : []);
  };
  dhive.Client.__send = (ops) => {
    sends.push(ops);
    broadcasted = true;
    return broadcastThrows ? Promise.reject(new Error('socket hang up')) : Promise.resolve({ id: 'tx' });
  };
};

const single = (key) => ({ weight_threshold: 1, account_auths: [], key_auths: [[key, 1]] });
/** An account on chain exactly as we would have created it for `keys`. */
const onChain = (keys, recovery = config.account) => ({
  name: 'newguy', owner: single(keys.owner), active: single(keys.active), posting: single(keys.posting),
  memo_key: keys.memo, recovery_account: recovery,
});

let origActive;
let origPkey;
beforeEach(() => {
  sends = [];
  dbCalls = [];
  origActive = config.active_key;
  origPkey = config.rewards_account_pkey;
  config.active_key = OUR_ACTIVE.toString();
  dhive.Client.__props = () => Promise.resolve({ account_creation_fee: '3.000 HIVE' });
  chain();
});
afterEach(() => {
  config.active_key = origActive;
  if (origPkey === undefined) delete config.rewards_account_pkey; else config.rewards_account_pkey = origPkey;
});

describe('createHiveAccountWithKeys', () => {
  it('derives the shared test vector the Android app is checked against', () => {
    expect(KEYS.owner).toBe(VECTOR_OWNER);
  });

  it('creates the account with a claimed token, using exactly the keys it was given', async () => {
    await expect(utils.createHiveAccountWithKeys('newguy', KEYS)).resolves.toEqual({ created: true, reason: 'created' });
    expect(sends).toHaveLength(1);
    const [[type, op]] = sends[0];
    expect(type).toBe('create_claimed_account');
    expect(op.creator).toBe(config.account);
    expect(op.new_account_name).toBe('newguy');
    expect(op.owner.key_auths).toEqual([[KEYS.owner, 1]]);
    expect(op.active.key_auths).toEqual([[KEYS.active, 1]]);
    expect(op.posting.key_auths).toEqual([[KEYS.posting, 1]]);
    expect(op.memo_key).toBe(KEYS.memo);
    expect(op.fee).toBeUndefined();
    // The op must serialize as a real Hive operation.
    expect(() => Types.Operation(new ByteBuffer(ByteBuffer.DEFAULT_CAPACITY, ByteBuffer.LITTLE_ENDIAN), sends[0][0])).not.toThrow();
  });

  it('refuses rather than paying a fee when no claimed token is left', async () => {
    chain({ claimed: 0 });
    await expect(utils.createHiveAccountWithKeys('newguy', KEYS)).resolves.toEqual({ created: false, reason: 'no_account_token' });
    expect(sends).toHaveLength(0);
  });

  it('pays the fee the chain asks for, only when the caller allows it with true', async () => {
    chain({ claimed: 0 });
    dhive.Client.__props = () => Promise.resolve({ account_creation_fee: '3.500 HIVE' });
    await expect(utils.createHiveAccountWithKeys('newguy', KEYS, { allowFee: true })).resolves.toEqual({ created: true, reason: 'created' });
    const [[type, op]] = sends[0];
    expect(type).toBe('account_create');
    expect(op.fee).toBe('3.500 HIVE');
  });

  it.each([['the string "true"', 'true'], ['1', 1]])('does not pay a fee for allowFee = %s', async (_label, value) => {
    chain({ claimed: 0 });
    await expect(utils.createHiveAccountWithKeys('newguy', KEYS, { allowFee: value })).resolves.toEqual({ created: false, reason: 'no_account_token' });
    expect(sends).toHaveLength(0);
  });

  it.each([
    ['too short', 'ab'],
    ['too long', 'abcdefghijklmnopq'],
    ['uppercase', 'NewGuy'],
    ['starts with a digit', '1newguy'],
    ['ends with a dash', 'newguy-'],
    ['short segment', 'new.ab'],
    ['not a string', ['newguy']],
    ['an object', { $ne: null }],
  ])('rejects a username that is %s, before touching the chain', async (_label, name) => {
    await expect(utils.createHiveAccountWithKeys(name, KEYS)).resolves.toEqual({ created: false, reason: 'invalid_username' });
    expect(dbCalls).toHaveLength(0);
  });

  it('accepts dotted and dashed names Hive allows', () => {
    expect(utils.isValidHiveAccountName('new-guy.fit')).toBe(true);
    expect(utils.isValidHiveAccountName('abc')).toBe(true);
  });

  it.each([
    ['missing a role', () => ({ owner: KEYS.owner, active: KEYS.active, posting: KEYS.posting })],
    ['a role only on the prototype', () => Object.assign(Object.create({ memo: KEYS.memo }), { owner: KEYS.owner, active: KEYS.active, posting: KEYS.posting })],
    ['not an object', () => 'STM...'],
    ['a key that is not a string', () => ({ ...KEYS, memo: { $gt: '' } })],
    ['a bad checksum', () => ({ ...KEYS, posting: KEYS.posting.slice(0, -1) + (KEYS.posting.endsWith('1') ? '2' : '1') })],
    ['the wrong prefix', () => ({ ...KEYS, active: 'BLT' + KEYS.active.slice(3) })],
    ['a point off the curve', () => ({ ...KEYS, memo: OFF_CURVE })],
    ['the same key in two roles', () => ({ ...KEYS, active: KEYS.owner })],
    ['our own active key', () => ({ ...KEYS, posting: OUR_ACTIVE.createPublic().toString() })],
  ])('rejects keys with %s, before touching the chain', async (_label, make) => {
    await expect(utils.createHiveAccountWithKeys('newguy', make())).resolves.toEqual({ created: false, reason: 'invalid_keys' });
    expect(dbCalls).toHaveLength(0);
  });

  it('rejects one of our keys stored under a field not named *_key', async () => {
    const other = dhive.PrivateKey.fromSeed('actifit-test-rewards-key');
    config.rewards_account_pkey = other.toString();
    await expect(utils.createHiveAccountWithKeys('newguy', { ...KEYS, memo: other.createPublic().toString() }))
      .resolves.toEqual({ created: false, reason: 'invalid_keys' });
  });

  it('reports exists_with_same_keys (not success) when the account is already on chain with these keys', async () => {
    // Keys are public, so this alone cannot prove the caller made the original request.
    chain({ existing: onChain(KEYS) });
    await expect(utils.createHiveAccountWithKeys('newguy', KEYS)).resolves.toEqual({ created: false, reason: 'exists_with_same_keys' });
    expect(sends).toHaveLength(0);
  });

  it.each([
    ['another owner key', () => ({ ...onChain(KEYS), owner: single(keysFor('newguy', 'else').owner) })],
    ['another active key', () => ({ ...onChain(KEYS), active: single(keysFor('newguy', 'else').active) })],
    ['another memo key', () => ({ ...onChain(KEYS), memo_key: keysFor('newguy', 'else').memo })],
    ['a second owner key', () => ({ ...onChain(KEYS), owner: { ...single(KEYS.owner), key_auths: [[KEYS.owner, 1], [keysFor('x', 'y').owner, 1]] } })],
    ['an account auth on posting', () => ({ ...onChain(KEYS), posting: { ...single(KEYS.posting), account_auths: [['someone', 1]] } })],
    ['another recovery account', () => onChain(KEYS, 'someone')],
    ['an unexpected shape', () => ({ name: 'newguy' })],
  ])('reports username_taken when the existing account has %s', async (_label, make) => {
    chain({ existing: make() });
    await expect(utils.createHiveAccountWithKeys('newguy', KEYS)).resolves.toEqual({ created: false, reason: 'username_taken' });
    expect(sends).toHaveLength(0);
  });

  it('reports exists_with_same_keys when the broadcast errors but the account then shows up with these keys', async () => {
    chain({ broadcastThrows: true, afterBroadcast: onChain(KEYS) });
    await expect(utils.createHiveAccountWithKeys('newguy', KEYS)).resolves.toEqual({ created: false, reason: 'exists_with_same_keys' });
  });

  it('reports creation_failed when the broadcast errors and the name is still absent', async () => {
    chain({ broadcastThrows: true });
    await expect(utils.createHiveAccountWithKeys('newguy', KEYS)).resolves.toEqual({ created: false, reason: 'creation_failed' });
  });

  it('reports creation_failed when the broadcast errors and the name now holds other keys', async () => {
    chain({ broadcastThrows: true, afterBroadcast: onChain(keysFor('newguy', 'x')) });
    await expect(utils.createHiveAccountWithKeys('newguy', KEYS)).resolves.toEqual({ created: false, reason: 'creation_failed' });
  });

  it('reports node_down and broadcasts nothing when the chain cannot be read', async () => {
    chain({ lookupThrows: true });
    await expect(utils.createHiveAccountWithKeys('newguy', KEYS)).resolves.toEqual({ created: false, reason: 'node_down' });
    expect(sends).toHaveLength(0);
  });

  it('reports node_down when our creator account comes back empty', async () => {
    chain({ creator: false });
    await expect(utils.createHiveAccountWithKeys('newguy', KEYS)).resolves.toEqual({ created: false, reason: 'node_down' });
    expect(sends).toHaveLength(0);
  });

  it('reports node_down when the fee cannot be read', async () => {
    chain({ claimed: 0 });
    dhive.Client.__props = () => Promise.reject(new Error('HTTP 503'));
    await expect(utils.createHiveAccountWithKeys('newguy', KEYS, { allowFee: true })).resolves.toEqual({ created: false, reason: 'node_down' });
    expect(sends).toHaveLength(0);
  });
});

describe('createAccount (legacy password signup) through the shared create', () => {
  it('still creates the account from the password-derived keys', async () => {
    await expect(utils.createAccount(VECTOR_USER, VECTOR_PASS, 'HIVE|')).resolves.toBe(true);
    const [[type, op]] = sends[0];
    expect(type).toBe('create_claimed_account');
    expect(String(op.owner.key_auths[0][0])).toBe(VECTOR_OWNER);
    expect(String(op.memo_key)).toBe(KEYS.memo);
  });

  it('still pays 3 HIVE when no claimed token is left (unchanged; that route stays disabled)', async () => {
    chain({ claimed: 0 });
    await expect(utils.createAccount(VECTOR_USER, VECTOR_PASS, 'HIVE|')).resolves.toBe(true);
    const [[type, op]] = sends[0];
    expect(type).toBe('account_create');
    expect(op.fee).toBe('3.000 HIVE');
  });

  it('still reports failure on a broadcast error, even if the account then shows up', async () => {
    // Unchanged on purpose: that route claims its memo non-atomically, so reading a
    // landed account as success would let a double tap record the signup twice.
    chain({ broadcastThrows: true, afterBroadcast: onChain(KEYS) });
    await expect(utils.createAccount(VECTOR_USER, VECTOR_PASS, 'HIVE|')).resolves.toBe(false);
  });
});
