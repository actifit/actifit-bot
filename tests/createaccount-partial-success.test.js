/**
 * createAccount must not report a partial creation as success.
 *
 * The signup is PAID FOR on Hive — claimed account tokens, creator config.account.
 * Blurt is best-effort alongside it. Once the existence checks gained skip flags, a
 * leg could be SKIPPED rather than merely attempted, and
 * `return (hiveAccountSuccess || blurtAccountSuccess)` stopped meaning what it used
 * to: with both chains requested and the Hive existence check throwing, the Hive leg
 * was skipped, Blurt succeeded, and the OR returned true.
 *
 * The caller then stored the signup with the memo, paid the referral reward, and
 * answered accountCreated:true — for a user who paid for a Hive account, received a
 * Blurt-only one, and could no longer retry, because the memo answers
 * memo_already_used and a promo code promo_code_exhausted. Before the skip flags
 * existed, that same node error threw and the signup stayed retryable.
 *
 * The asymmetry these tests pin is deliberate: Hive must succeed when requested;
 * Blurt failing alongside it is tolerated. That tolerance is the whole point of the
 * Blurt failover work and must not be undone while fixing the reverse direction.
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

// Both chain libraries are routed through a per-test script so each leg can be made
// to succeed, fail, or throw on its existence check independently.
const makeLib = (which) => {
  class Client {
    constructor(url) { this.url = url; }
    get database() { return { call: (m, p) => Client.__db(m, p) }; }
    get broadcast() { return { sendOperations: (ops, key) => Client.__send(ops, key) }; }
  }
  Client.__db = () => { throw new Error('no db script set for ' + which); };
  Client.__send = () => Promise.resolve({ id: 'tx' });
  return {
    Client,
    PrivateKey: {
      fromString: () => ({}),
      fromLogin: () => ({ createPublic: () => 'PUBKEY' }),
    },
    __Client: Client,
  };
};
jest.mock('@hiveio/dhive', () => makeLib('dhive'), { virtual: false });
jest.mock('dblurt', () => makeLib('dblurt'), { virtual: false });

const dhive = require('@hiveio/dhive');
const dblurt = require('dblurt');
const utils = require('../utils');
const config = utils.getConfig();

// A creator account with plenty of claimed tokens, so the cheap create path is taken.
const CREATOR = [{ pending_claimed_accounts: 500 }];

/** Script a chain: existence check for the NEW account, then the creator lookup. */
const script = (lib, { existsThrows = false, exists = false, broadcastThrows = false } = {}) => {
  lib.__Client.__db = (method, params) => {
    const name = params && params[0] && params[0][0];
    if (name === 'newguy') {
      if (existsThrows) return Promise.reject(new Error('HTTP 503'));
      return Promise.resolve(exists ? [{ name: 'newguy' }] : []);
    }
    return Promise.resolve(CREATOR); // creator lookup
  };
  lib.__Client.__send = () => (broadcastThrows
    ? Promise.reject(new Error('broadcast failed'))
    : Promise.resolve({ id: 'tx' }));
};

describe('createAccount — partial success must not read as success', () => {
  let origNode, origAlts;

  beforeEach(() => {
    origNode = config.blurt_node;
    origAlts = config.alt_blurt_nodes;
    config.blurt_node = 'https://b1.test';
    config.alt_blurt_nodes = ['https://b1.test'];
    script(dhive, {});
    script(dblurt, {});
  });

  afterEach(() => {
    config.blurt_node = origNode;
    config.alt_blurt_nodes = origAlts;
  });

  it('reports FAILURE when Hive was requested but its leg was skipped, even though Blurt succeeded', async () => {
    // THE BUG. Both chains requested (empty cur_bchain), Hive existence check throws
    // so the Hive leg never runs, Blurt succeeds. Reporting true here burns the memo
    // and pays the referral for an account the user did not get.
    script(dhive, { existsThrows: true });

    await expect(utils.createAccount('newguy', 'pass', '')).resolves.toBe(false);
  });

  it('reports FAILURE when Hive was requested and its broadcast failed, even though Blurt succeeded', async () => {
    script(dhive, { broadcastThrows: true });

    await expect(utils.createAccount('newguy', 'pass', '')).resolves.toBe(false);
  });

  it('still reports SUCCESS when Hive succeeded and only Blurt was skipped', async () => {
    // The tolerance the Blurt failover work exists to provide. Fixing the reverse
    // direction must not undo it.
    script(dblurt, { existsThrows: true });

    await expect(utils.createAccount('newguy', 'pass', '')).resolves.toBe(true);
  });

  it('still reports SUCCESS when Hive succeeded and the Blurt broadcast failed', async () => {
    script(dblurt, { broadcastThrows: true });

    await expect(utils.createAccount('newguy', 'pass', '')).resolves.toBe(true);
  });

  it('reports SUCCESS for a Blurt-only request that succeeded', async () => {
    // Nobody asked for Hive, so Hive is irrelevant to the verdict.
    script(dhive, { existsThrows: true });

    await expect(utils.createAccount('newguy', 'pass', 'BLURT')).resolves.toBe(true);
  });

  it('reports FAILURE for a Blurt-only request that failed', async () => {
    script(dblurt, { broadcastThrows: true });

    await expect(utils.createAccount('newguy', 'pass', 'BLURT')).resolves.toBe(false);
  });

  it('reports SUCCESS for a Hive-only request that succeeded, Blurt being down', async () => {
    script(dblurt, { existsThrows: true });

    await expect(utils.createAccount('newguy', 'pass', 'HIVE|')).resolves.toBe(true);
  });

  it('reports FAILURE for a Hive-only request whose broadcast failed', async () => {
    script(dhive, { broadcastThrows: true });

    await expect(utils.createAccount('newguy', 'pass', 'HIVE|')).resolves.toBe(false);
  });

  it('refuses outright when the account already exists on Hive', async () => {
    // Unchanged behaviour, pinned so the new branching cannot swallow it.
    script(dhive, { exists: true });

    await expect(utils.createAccount('newguy', 'pass', '')).resolves.toBe(false);
  });
});
