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
      // The owner key derived from (username, password). createAccount compares this
      // against the on-chain key to tell its OWN half-completed attempt from a name a
      // stranger happens to hold on Blurt.
      fromLogin: () => ({ createPublic: () => 'BLTOURKEY' }),
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

// Every broadcast each chain performs, so a test can assert that a chain was used -
// or, just as importantly, was NOT. Without these, a mutation that creates an account
// on a chain nobody asked for passes silently.
let hiveSends = [];
let blurtSends = [];

const OUR_KEY = 'BLTOURKEY';
const STRANGER_KEY = 'BLTSOMEONEELSE';

/** Script a chain: existence check for the NEW account, then the creator lookup. */
const script = (lib, sends, { existsThrows = false, exists = false, broadcastThrows = false,
  ownerKey = OUR_KEY, claimed = 500 } = {}) => {
  lib.__Client.__db = (method, params) => {
    const name = params && params[0] && params[0][0];
    if (name === 'newguy') {
      if (existsThrows) return Promise.reject(new Error('HTTP 503'));
      return Promise.resolve(exists
        ? [{ name: 'newguy', owner: { key_auths: [[ownerKey, 1]] } }]
        : []);
    }
    return Promise.resolve([{ pending_claimed_accounts: claimed }]); // creator lookup
  };
  lib.__Client.__send = (ops) => {
    sends.push(ops);
    return broadcastThrows ? Promise.reject(new Error('broadcast failed')) : Promise.resolve({ id: 'tx' });
  };
};

describe('createAccount — partial success must not read as success', () => {
  let origNode, origAlts;

  beforeEach(() => {
    origNode = config.blurt_node;
    origAlts = config.alt_blurt_nodes;
    config.blurt_node = 'https://b1.test';
    config.alt_blurt_nodes = ['https://b1.test'];
    hiveSends = [];
    blurtSends = [];
    script(dhive, hiveSends, {});
    script(dblurt, blurtSends, {});
  });

  afterEach(() => {
    config.blurt_node = origNode;
    config.alt_blurt_nodes = origAlts;
  });

  it('reports FAILURE when Hive was requested but its leg was skipped, even though Blurt succeeded', async () => {
    // THE BUG. Both chains requested (empty cur_bchain), Hive existence check throws
    // so the Hive leg never runs, Blurt succeeds. Reporting true here burns the memo
    // and pays the referral for an account the user did not get.
    script(dhive, hiveSends, { existsThrows: true });

    await expect(utils.createAccount('newguy', 'pass', '')).resolves.toBe(false);
    // The signup is about to be reported as failed, so Blurt must NOT have been
    // created: a 100 BLURT account that no record references and nothing reconciles.
    expect(blurtSends).toHaveLength(0);
    expect(hiveSends).toHaveLength(0);
  });

  it('reports FAILURE when Hive was requested and its broadcast failed, even though Blurt succeeded', async () => {
    script(dhive, hiveSends, { broadcastThrows: true });

    await expect(utils.createAccount('newguy', 'pass', '')).resolves.toBe(false);
    expect(blurtSends).toHaveLength(0);
  });

  it('creates BOTH chains when both are requested and both are healthy', async () => {
    // The premise every "even though Blurt succeeded" test leans on, and which nothing
    // asserted: a dual-chain request must actually reach Blurt.
    await expect(utils.createAccount('newguy', 'pass', '')).resolves.toBe(true);
    expect(hiveSends).toHaveLength(1);
    expect(blurtSends).toHaveLength(1);
  });

  it('still reports SUCCESS when Hive succeeded and only Blurt was skipped', async () => {
    // The tolerance the Blurt failover work exists to provide. Fixing the reverse
    // direction must not undo it.
    script(dblurt, blurtSends, { existsThrows: true });

    await expect(utils.createAccount('newguy', 'pass', '')).resolves.toBe(true);
  });

  it('still reports SUCCESS when Hive succeeded and the Blurt broadcast failed', async () => {
    script(dblurt, blurtSends, { broadcastThrows: true });

    await expect(utils.createAccount('newguy', 'pass', '')).resolves.toBe(true);
  });

  it('reports SUCCESS for a Blurt-only request that succeeded', async () => {
    // Nobody asked for Hive, so Hive is irrelevant to the verdict.
    script(dhive, hiveSends, { existsThrows: true });

    await expect(utils.createAccount('newguy', 'pass', 'BLURT')).resolves.toBe(true);
    // And nobody asked for Hive, so no claimed token or 3 HIVE may be spent on it.
    expect(hiveSends).toHaveLength(0);
    expect(blurtSends).toHaveLength(1);
  });

  it('reports FAILURE for a Blurt-only request that failed', async () => {
    script(dblurt, blurtSends, { broadcastThrows: true });

    await expect(utils.createAccount('newguy', 'pass', 'BLURT')).resolves.toBe(false);
  });

  it('reports SUCCESS for a Hive-only request that succeeded, Blurt being down', async () => {
    script(dblurt, blurtSends, { existsThrows: true });

    await expect(utils.createAccount('newguy', 'pass', 'HIVE|')).resolves.toBe(true);
    expect(hiveSends).toHaveLength(1);
    // No 100 BLURT spent on a chain the caller did not ask for.
    expect(blurtSends).toHaveLength(0);
  });

  it('creates nothing for a chain value that names neither chain', async () => {
    // cur_bchain is unvalidated at the route, and `.includes` is case-sensitive, so
    // 'STEEM|' and 'hive' both request nothing. Failing closed is what keeps the caller
    // from storing the memo and paying a referral for a signup that created nothing.
    await expect(utils.createAccount('newguy', 'pass', 'STEEM|')).resolves.toBe(false);
    expect(hiveSends).toHaveLength(0);
    expect(blurtSends).toHaveLength(0);
  });

  it('reports FAILURE for a Hive-only request whose broadcast failed', async () => {
    script(dhive, hiveSends, { broadcastThrows: true });

    await expect(utils.createAccount('newguy', 'pass', 'HIVE|')).resolves.toBe(false);
  });

  it('refuses outright when the account already exists on Hive', async () => {
    // Unchanged behaviour, pinned so the new branching cannot swallow it.
    script(dhive, hiveSends, { exists: true });

    await expect(utils.createAccount('newguy', 'pass', '')).resolves.toBe(false);
  });

  describe('retry after a half-completed signup', () => {
    it('creates the missing Hive account when Blurt already exists', async () => {
      // The scenario the fix would otherwise have STRANDED. Attempt one created the
      // Blurt account and failed on Hive. Reporting failure (correctly) sends the user
      // back to retry — but "already exists" used to abort the WHOLE call from either
      // chain's check, so every retry tripped the Blurt check and returned false before
      // reaching Hive. The user could never get the account they paid for.
      script(dblurt, blurtSends, { exists: true });   // Blurt account is already there
      script(dhive, hiveSends, {});                  // Hive is free and healthy

      await expect(utils.createAccount('newguy', 'pass', '')).resolves.toBe(true);
    });

    it('does not re-broadcast a Blurt account that already exists', async () => {
      let blurtSends = 0;
      script(dblurt, blurtSends, { exists: true });
      dblurt.__Client.__send = () => { blurtSends += 1; return Promise.resolve({ id: 'tx' }); };
      script(dhive, hiveSends, {});

      await utils.createAccount('newguy', 'pass', '');

      expect(blurtSends).toBe(0);
    });

    it('refuses when the Blurt name belongs to someone else, rather than delivering half a signup', async () => {
      // The existing account's owner key does NOT match the one derived from these
      // credentials, so it is not an earlier attempt of ours. The web client charges
      // double when Blurt is ticked, so quietly delivering Hive only and reporting
      // success would take the money and hand over half of what was asked for.
      script(dblurt, blurtSends, { exists: true, ownerKey: STRANGER_KEY });

      await expect(utils.createAccount('newguy', 'pass', '')).resolves.toBe(false);
      expect(hiveSends).toHaveLength(0);
      expect(blurtSends).toHaveLength(0);
    });

    it('still refuses a Blurt-only request when the Blurt account already exists', async () => {
      // Nobody asked for Hive here, so an existing Blurt account IS the refusal.
      script(dblurt, blurtSends, { exists: true });

      await expect(utils.createAccount('newguy', 'pass', 'BLURT')).resolves.toBe(false);
    });
  });
});
