/**
 * Blurt RPC endpoint rotation.
 *
 * Background: a dead Blurt node was indistinguishable from a bad password.
 * fetchOneAccount returned null, validateAccountLogin turned that into
 * {result:false}, and /fetchUserData answered "403 Invalid user". On 2026-10-12 both
 * configured nodes went down together and Blurt login broke outright.
 *
 * The rotation cannot use blurtjs's own failover: notifyError() - which does the
 * rotating - is only reached from call()/signedCall(), while every generated method
 * including getAccountsAsync goes through send() -> transport, which never notifies.
 *
 * HOW THESE TESTS INTERCEPT, and why it is not the obvious way:
 *
 * fetchOneAccount builds a PRIVATE client per attempt (`new BlurtApi({url})`) and
 * never re-points the blurt.api singleton. So stubbing `blurt.api.getAccountsAsync`
 * would test nothing - the code under test does not call it. The generated methods
 * are own properties assigned per instance, so there is nothing to stub on the
 * prototype either.
 *
 * Instead we stub `BlurtApi.prototype.send`, which every generated method funnels
 * through, and route on `this.options.uri` - the instance's REAL resolved endpoint.
 * That keeps the real constructor, the real getAccountsAsync wrapper and the real
 * parameter marshalling in the test, and means assertions are made against actual
 * client state rather than against a spy's call log.
 *
 * That distinction matters: an earlier version of this suite stubbed setOptions inert
 * and asserted the call log, which let a mutation that reintroduced the original
 * process-wide stranding bug pass all 16 tests.
 *
 * No network.
 */

const blurt = require('@blurtfoundation/blurtjs');
const hive = require('@hiveio/hive-js');
const utils = require('../utils');

// utils.js does NOT require('./config.json') - getConfig() parses the file itself
// into a module-local object, so requiring the JSON here would hand back a different
// object and the overrides below would silently do nothing.
const config = utils.getConfig();

const BlurtApi = blurt.api.constructor;
const ACCT = { name: 'actifit.pay', posting: { key_auths: [['BLT6EqeJ', 1]] } };

/**
 * Stub the transport for every per-attempt client.
 * `router(url, params)` returns the account array, or throws to simulate a failure.
 * Records the endpoint of every dispatched call, in order.
 */
const tried = [];
function stubBlurt(router){
  return jest.spyOn(BlurtApi.prototype, 'send').mockImplementation(function (api, data, cb) {
    const url = this.options.uri;
    tried.push(url);
    try {
      const out = router(url, data.params);
      if (out === '__hang__') return; // never calls back
      cb(null, out);
    } catch (err) {
      cb(err);
    }
  });
}

describe('Blurt RPC failover', () => {
  let origNode;
  let origAlts;
  let singletonUrlBefore;

  beforeEach(() => {
    tried.length = 0;
    origNode = config.blurt_node;
    origAlts = config.alt_blurt_nodes;
    singletonUrlBefore = blurt.api.options.url;
  });

  afterEach(() => {
    if (origNode === undefined) delete config.blurt_node; else config.blurt_node = origNode;
    if (origAlts === undefined) delete config.alt_blurt_nodes; else config.alt_blurt_nodes = origAlts;
    // The implementation must never move the singleton, but put it back if it did -
    // otherwise one leak poisons the next test's baseline and the singleton guards
    // below silently stop guarding anything.
    if (blurt.api.options.url !== singletonUrlBefore){
      blurt.api.setOptions({ url: singletonUrlBefore });
    }
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
      // The recommended config shape repeats the primary in the alt list, so it must
      // not be tried twice.
      config.blurt_node = 'https://primary.test';
      config.alt_blurt_nodes = ['https://primary.test', 'https://alt1.test'];

      expect(utils.blurtNodes()).toEqual(['https://primary.test', 'https://alt1.test']);
    });

    it('treats a trailing slash as the same host', () => {
      // The live config has exactly this shape.
      config.blurt_node = 'https://primary.test';
      config.alt_blurt_nodes = ['https://primary.test/', 'https://alt1.test'];

      expect(utils.blurtNodes()).toEqual(['https://primary.test', 'https://alt1.test']);
    });

    it('drops junk entries instead of turning them into endpoints', () => {
      // Normalisation runs BEFORE filtering, so an entry of only slashes becomes ''
      // and must not survive as a blank endpoint burning an attempt. Without the
      // scheme test, String(undefined) would become the literal endpoint "undefined".
      config.blurt_node = 'https://primary.test';
      config.alt_blurt_nodes = ['/', '', '   ', null, undefined, 42, 'rpc.no-scheme.test', 'https://ok.test'];

      expect(utils.blurtNodes()).toEqual(['https://primary.test', 'https://ok.test']);
    });

    it('returns an empty list when nothing usable is configured', () => {
      delete config.blurt_node;
      delete config.alt_blurt_nodes;

      expect(utils.blurtNodes()).toEqual([]);
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

    it('caps the list so a long config cannot outlive the socket timeout', () => {
      // Worst case is attempts x NODE_CALL_TIMEOUT_MS (10s), plus a Hive lookup, against
      // srvr.setTimeout(120000). Four is the number that keeps that at 50s.
      config.blurt_node = 'https://p.test';
      config.alt_blurt_nodes = ['https://a.test', 'https://b.test', 'https://c.test',
        'https://d.test', 'https://e.test'];

      expect(utils.blurtNodes()).toEqual([
        'https://p.test', 'https://a.test', 'https://b.test', 'https://c.test',
      ]);
    });
  });

  describe('fetchOneAccount rotation', () => {
    beforeEach(() => {
      config.blurt_node = 'https://dead.test';
      config.alt_blurt_nodes = ['https://alsodead.test', 'https://live.test'];
    });

    it('walks past failing endpoints and returns the account from a live one', async () => {
      stubBlurt((url) => {
        if (url === 'https://live.test') return [ACCT];
        throw new Error('HTTP 503');
      });

      const out = await utils.fetchOneAccount(blurt, 'actifit.pay', 'test');

      expect(out).toEqual(ACCT);
      expect(tried).toEqual(['https://dead.test', 'https://alsodead.test', 'https://live.test']);
    });

    it('asks for the account as an array, the shape the RPC expects', async () => {
      // getAccountsAsync(name) instead of getAccountsAsync([name]) breaks every lookup
      // on both chains and is otherwise invisible to these tests.
      let seen = null;
      stubBlurt((url, params) => { seen = params; return [ACCT]; });

      await utils.fetchOneAccount(blurt, 'actifit.pay', 'test');

      expect(seen).toEqual([['actifit.pay']]);
    });

    it('never re-points the shared blurt.api singleton', async () => {
      // THE load-bearing guarantee. Re-pointing the singleton meant two overlapping
      // walks could strand the process on a dead node, and exposed every other Blurt
      // caller (payment verification, broadcasts) to whatever node a walk had reached.
      stubBlurt((url) => {
        if (url === 'https://live.test') return [ACCT];
        throw new Error('HTTP 503');
      });

      await utils.fetchOneAccount(blurt, 'actifit.pay', 'test');

      expect(blurt.api.options.url).toBe(singletonUrlBefore);
    });

    it('leaves the singleton alone even when every endpoint fails', async () => {
      stubBlurt(() => { throw new Error('HTTP 503'); });

      await utils.fetchOneAccount(blurt, 'actifit.pay', 'test');

      expect(blurt.api.options.url).toBe(singletonUrlBefore);
    });

    it('two overlapping walks cannot disturb each other', async () => {
      // Reproduces the interleaving that broke the previous revision: one lookup for a
      // real account and one for a typo, in flight together.
      stubBlurt((url, params) => {
        if (params[0][0] === 'ghost') throw new Error('HTTP 503');
        if (url === 'https://live.test') return [ACCT];
        throw new Error('HTTP 503');
      });

      const [real, ghost] = await Promise.all([
        utils.fetchOneAccount(blurt, 'actifit.pay', 'A'),
        utils.fetchOneAccount(blurt, 'ghost', 'B'),
      ]);

      expect(real).toEqual(ACCT);
      expect(ghost).toBeNull();
      expect(blurt.api.options.url).toBe(singletonUrlBefore);
    });

    it('treats a 200-with-no-result as a failure and keeps going', async () => {
      // A desynced node answers 200 OK with result: null. That must not be read as
      // "this account does not exist".
      stubBlurt((url) => (url === 'https://live.test' ? [ACCT] : [null]));

      const out = await utils.fetchOneAccount(blurt, 'actifit.pay', 'test');

      expect(out).toEqual(ACCT);
      expect(tried).toHaveLength(3);
    });

    it('stops at the first endpoint that answers', async () => {
      stubBlurt(() => [ACCT]);

      await utils.fetchOneAccount(blurt, 'actifit.pay', 'test');

      expect(tried).toEqual(['https://dead.test']);
    });

    it('returns null, not a rejection, when every endpoint fails', async () => {
      // validateAccountLogin depends on this: it turns a null into
      // {result:false, node_error:true} rather than letting the request blow up.
      stubBlurt(() => { throw new Error('HTTP 503'); });

      await expect(utils.fetchOneAccount(blurt, 'actifit.pay', 'test')).resolves.toBeNull();
      expect(tried).toEqual(['https://dead.test', 'https://alsodead.test', 'https://live.test']);
    });

    it('returns null for an account that genuinely does not exist anywhere', async () => {
      stubBlurt(() => []);

      await expect(utils.fetchOneAccount(blurt, 'ghost', 'test')).resolves.toBeNull();
      expect(tried).toHaveLength(3);
    });

    it('attempts no more than the cap, whatever the config says', async () => {
      config.alt_blurt_nodes = ['https://a.test', 'https://b.test', 'https://c.test',
        'https://d.test', 'https://e.test', 'https://f.test'];
      stubBlurt(() => { throw new Error('HTTP 503'); });

      await utils.fetchOneAccount(blurt, 'actifit.pay', 'test');

      expect(tried).toEqual(['https://dead.test', 'https://a.test', 'https://b.test', 'https://c.test']);
    });

    it('makes no call and says so loudly when no endpoint is configured', async () => {
      // config-example.json ships without these keys, so this is the shape a freshly
      // provisioned host starts from. Silence here would be the same undiagnosable
      // failure this change exists to end.
      delete config.blurt_node;
      delete config.alt_blurt_nodes;
      const log = jest.spyOn(console, 'log').mockImplementation(() => {});
      stubBlurt(() => [ACCT]);

      const out = await utils.fetchOneAccount(blurt, 'actifit.pay', 'test');

      expect(out).toBeNull();
      expect(tried).toEqual([]);
      expect(log.mock.calls.flat().join(' ')).toMatch(/no usable Blurt endpoint configured/);
    });

    it('treats a hung node as a failure and moves on', async () => {
      // withTimeout is what turns a stalled node into a rotation rather than a hung
      // request. An implementation that dropped it would pass every other test here.
      jest.useFakeTimers();
      stubBlurt((url) => (url === 'https://live.test' ? [ACCT] : '__hang__'));

      const pending = utils.fetchOneAccount(blurt, 'actifit.pay', 'test');
      // Nothing should have given up before the timeout elapses.
      await jest.advanceTimersByTimeAsync(9000);
      expect(tried).toEqual(['https://dead.test']);
      // Past it, the walk moves on and reaches the live node.
      await jest.advanceTimersByTimeAsync(20000);
      const out = await pending;

      expect(out).toEqual(ACCT);
      expect(tried).toEqual(['https://dead.test', 'https://alsodead.test', 'https://live.test']);
    });

    it('does not rotate for Hive, which has its own endpoint list', async () => {
      // hive-js gets alternative_api_endpoints wired up at module load, so adding a
      // second layer here would just multiply retries. hive.api is a different class,
      // so the Blurt stub cannot reach it.
      jest.spyOn(hive.api, 'getAccountsAsync').mockResolvedValue([ACCT]);

      const out = await utils.fetchOneAccount(hive, 'actifit.pay', 'test');

      expect(out).toEqual(ACCT);
      expect(hive.api.getAccountsAsync).toHaveBeenCalledTimes(1);
      expect(hive.api.getAccountsAsync).toHaveBeenCalledWith(['actifit.pay']);
      expect(tried).toEqual([]);
    });
  });
});
