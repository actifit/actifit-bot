/**
 * Blurt RPC endpoint rotation.
 *
 * Background: a dead Blurt node used to be indistinguishable from a bad password.
 * fetchOneAccount returned null, validateAccountLogin returned {result:false}, and
 * /fetchUserData answered "403 Invalid user". On 2026-10-12 both configured nodes
 * went down together and Blurt login broke outright.
 *
 * The rotation has to live in our code: blurtjs ships a failover, but notifyError()
 * - which does the rotating - is only reached from call()/signedCall(), while every
 * generated method including getAccountsAsync goes through send() -> transport,
 * which never notifies it. So setting failover_threshold alone changes nothing for
 * this path, and these tests are what prove the rotation actually happens.
 *
 * No network: blurt.api.getAccountsAsync and setOptions are spied on the shared
 * module singleton that utils.js already holds a reference to.
 */

const blurt = require('@blurtfoundation/blurtjs');
const hive = require('@hiveio/hive-js');
const utils = require('../utils');

// utils.js does NOT require('./config.json') - getConfig() parses the file itself
// into a module-local object, so requiring the JSON here would hand back a
// different object and the overrides below would silently do nothing.
const config = utils.getConfig();

const ACCT = { name: 'actifit.pay', posting: { key_auths: [['BLT6EqeJ', 1]] } };

describe('Blurt RPC failover', () => {
  let origNode;
  let origAlts;
  let origOptions;

  beforeEach(() => {
    origNode = config.blurt_node;
    origAlts = config.alt_blurt_nodes;
    // Some tests below set blurt.api.options to drive the restore path. That is a
    // shared module singleton, so put it back afterwards.
    origOptions = blurt.api.options;
    // setOptions would really re-point the shared client; keep it inert.
    jest.spyOn(blurt.api, 'setOptions').mockImplementation(() => {});
  });

  afterEach(() => {
    config.blurt_node = origNode;
    config.alt_blurt_nodes = origAlts;
    blurt.api.options = origOptions;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('blurtNodes()', () => {
    it('lists the primary first, then the alternates', () => {
      config.blurt_node = 'https://primary.test';
      config.alt_blurt_nodes = ['https://alt1.test', 'https://alt2.test'];

      expect(utils.blurtNodes()).toEqual([
        'https://primary.test',
        'https://alt1.test',
        'https://alt2.test',
      ]);
    });

    it('de-duplicates when the primary is also listed as an alternate', () => {
      // This is the recommended config shape - the primary is repeated in the alt
      // list so blurtjs can line up its api_index - so it must not be tried twice.
      config.blurt_node = 'https://primary.test';
      config.alt_blurt_nodes = ['https://primary.test', 'https://alt1.test'];

      expect(utils.blurtNodes()).toEqual(['https://primary.test', 'https://alt1.test']);
    });

    it('treats a trailing slash as the same host', () => {
      // The live config has exactly this shape - an alt with a trailing slash - so a
      // plain string compare would miss the duplicate and try the same node twice.
      config.blurt_node = 'https://primary.test';
      config.alt_blurt_nodes = ['https://primary.test/', 'https://alt1.test'];

      expect(utils.blurtNodes()).toEqual(['https://primary.test', 'https://alt1.test']);
    });

    it('still returns the primary when no alternates are configured', () => {
      config.blurt_node = 'https://primary.test';
      delete config.alt_blurt_nodes;

      expect(utils.blurtNodes()).toEqual(['https://primary.test']);
    });

    it('ignores a non-array alt list rather than throwing', () => {
      config.blurt_node = 'https://primary.test';
      config.alt_blurt_nodes = 'https://oops-a-string.test';

      expect(utils.blurtNodes()).toEqual(['https://primary.test']);
    });
  });

  describe('fetchOneAccount rotation', () => {
    beforeEach(() => {
      config.blurt_node = 'https://dead.test';
      config.alt_blurt_nodes = ['https://alsodead.test', 'https://live.test'];
    });

    it('walks past failing endpoints and returns the account from a live one', async () => {
      const calls = [];
      jest.spyOn(blurt.api, 'setOptions').mockImplementation((o) => calls.push(o.url));
      jest.spyOn(blurt.api, 'getAccountsAsync').mockImplementation(() => {
        const current = calls[calls.length - 1];
        if (current === 'https://live.test') return Promise.resolve([ACCT]);
        return Promise.reject(new Error('HTTP 503'));
      });

      const out = await utils.fetchOneAccount(blurt, 'actifit.pay', 'test');

      expect(out).toEqual(ACCT);
      expect(calls).toEqual(['https://dead.test', 'https://alsodead.test', 'https://live.test']);
    });

    it('treats a 200-with-no-result as a failure and keeps going', async () => {
      // A desynced node answers 200 OK with result: null. That must not be read as
      // "this account does not exist".
      const calls = [];
      jest.spyOn(blurt.api, 'setOptions').mockImplementation((o) => calls.push(o.url));
      jest.spyOn(blurt.api, 'getAccountsAsync').mockImplementation(() => {
        const current = calls[calls.length - 1];
        if (current === 'https://live.test') return Promise.resolve([ACCT]);
        return Promise.resolve([null]);
      });

      const out = await utils.fetchOneAccount(blurt, 'actifit.pay', 'test');

      expect(out).toEqual(ACCT);
      expect(calls).toHaveLength(3);
    });

    it('stops at the first endpoint that answers', async () => {
      const calls = [];
      jest.spyOn(blurt.api, 'setOptions').mockImplementation((o) => calls.push(o.url));
      jest.spyOn(blurt.api, 'getAccountsAsync').mockResolvedValue([ACCT]);

      await utils.fetchOneAccount(blurt, 'actifit.pay', 'test');

      expect(calls).toEqual(['https://dead.test']);
    });

    it('returns null, not a rejection, when every endpoint fails', async () => {
      // validateAccountLogin depends on this: it turns a null into
      // {result:false, node_error:true} rather than letting the request blow up.
      jest.spyOn(blurt.api, 'getAccountsAsync').mockRejectedValue(new Error('HTTP 503'));

      await expect(utils.fetchOneAccount(blurt, 'actifit.pay', 'test')).resolves.toBeNull();
      expect(blurt.api.getAccountsAsync).toHaveBeenCalledTimes(3);
    });

    it('returns null for an account that genuinely does not exist anywhere', async () => {
      jest.spyOn(blurt.api, 'getAccountsAsync').mockResolvedValue([]);

      await expect(utils.fetchOneAccount(blurt, 'ghost', 'test')).resolves.toBeNull();
      expect(blurt.api.getAccountsAsync).toHaveBeenCalledTimes(3);
    });

    it('leaves the shared client on the endpoint that answered', async () => {
      // The pointer is a process-wide singleton, so where it ends up is what every
      // other Blurt caller uses next. Staying on a healthy node is the point.
      const calls = [];
      jest.spyOn(blurt.api, 'setOptions').mockImplementation((o) => calls.push(o.url));
      jest.spyOn(blurt.api, 'getAccountsAsync').mockImplementation(() => {
        return calls[calls.length - 1] === 'https://live.test'
          ? Promise.resolve([ACCT])
          : Promise.reject(new Error('HTTP 503'));
      });

      await utils.fetchOneAccount(blurt, 'actifit.pay', 'test');

      expect(calls[calls.length - 1]).toBe('https://live.test');
    });

    it('restores the original endpoint when every node fails', async () => {
      // Regression guard. Without this the rotation stranded the singleton on the
      // LAST endpoint tried - in the live config an NXDOMAIN host - breaking every
      // non-rotating Blurt caller (getChainInfo, getTransactionAsync used for payment
      // verification, all broadcasts) for the life of the process. Reachable with one
      // unauthenticated, unlimited GET /getAccountData using a nonexistent username,
      // because "no such account" walks the whole list exactly like an outage does.
      const calls = [];
      jest.spyOn(blurt.api, 'setOptions').mockImplementation((o) => calls.push(o.url));
      jest.spyOn(blurt.api, 'getAccountsAsync').mockRejectedValue(new Error('HTTP 503'));
      blurt.api.options = { url: 'https://entry.test' };

      await utils.fetchOneAccount(blurt, 'actifit.pay', 'test');

      expect(calls[calls.length - 1]).toBe('https://entry.test');
    });

    it('restores the original endpoint when the account simply does not exist', async () => {
      // Same guard, via the cheaper trigger: every node answers authoritatively with
      // [] and nothing is wrong with any of them.
      const calls = [];
      jest.spyOn(blurt.api, 'setOptions').mockImplementation((o) => calls.push(o.url));
      jest.spyOn(blurt.api, 'getAccountsAsync').mockResolvedValue([]);
      blurt.api.options = { url: 'https://entry.test' };

      await utils.fetchOneAccount(blurt, 'ghost', 'test');

      expect(calls[calls.length - 1]).toBe('https://entry.test');
    });

    it('gives up after MAX_BLURT_ENDPOINT_ATTEMPTS so a long config cannot outlive the socket', async () => {
      // Worst case is attempts x NODE_CALL_TIMEOUT_MS, against srvr.setTimeout(120000).
      config.alt_blurt_nodes = ['https://a.test', 'https://b.test', 'https://c.test',
        'https://d.test', 'https://e.test', 'https://f.test'];
      jest.spyOn(blurt.api, 'getAccountsAsync').mockRejectedValue(new Error('HTTP 503'));

      await utils.fetchOneAccount(blurt, 'actifit.pay', 'test');

      expect(blurt.api.getAccountsAsync.mock.calls.length).toBeLessThanOrEqual(4);
    });

    it('treats a hung node as a failure and moves on', async () => {
      // withTimeout is what turns a stalled node into a rotation rather than a hung
      // request. An implementation that dropped it would still pass every other test.
      jest.useFakeTimers();
      const calls = [];
      jest.spyOn(blurt.api, 'setOptions').mockImplementation((o) => calls.push(o.url));
      jest.spyOn(blurt.api, 'getAccountsAsync').mockImplementation(() => {
        return calls[calls.length - 1] === 'https://live.test'
          ? Promise.resolve([ACCT])
          : new Promise(() => {}); // never settles
      });

      const pending = utils.fetchOneAccount(blurt, 'actifit.pay', 'test');
      // Two hung endpoints ahead of the live one; let both time out.
      await jest.advanceTimersByTimeAsync(60000);
      const out = await pending;

      jest.useRealTimers();
      expect(out).toEqual(ACCT);
      expect(calls).toContain('https://live.test');
    });

    it('does not rotate for Hive, which has its own endpoint list', async () => {
      // hive-js gets alternative_api_endpoints wired up at module load, so adding a
      // second layer here would just multiply retries.
      const hiveSetOptions = jest.spyOn(hive.api, 'setOptions').mockImplementation(() => {});
      jest.spyOn(hive.api, 'getAccountsAsync').mockResolvedValue([ACCT]);

      const out = await utils.fetchOneAccount(hive, 'actifit.pay', 'test');

      expect(out).toEqual(ACCT);
      expect(hive.api.getAccountsAsync).toHaveBeenCalledTimes(1);
      expect(hiveSetOptions).not.toHaveBeenCalled();
    });
  });
});
