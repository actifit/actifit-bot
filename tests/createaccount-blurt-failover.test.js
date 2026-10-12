/**
 * dblurt endpoint rotation for createAccount.
 *
 * #120 added rotation for the blurtjs client (fetchOneAccount), but createAccount
 * talks to Blurt through a SEPARATE library, the dblurt `blurtClient`. That path had
 * no failover and no try/catch, so on 2026-10-12 a single Blurt node answering
 * HTTP 503 threw straight out of createAccount and killed an otherwise-healthy Hive
 * signup. blurtCallWithFailover is the rotation that closes that gap.
 *
 * We mock the `dblurt` module so each `new dblurt.Client(url)` is routed by its url,
 * letting us drive per-endpoint success/failure with no network.
 */

jest.mock('dblurt', () => {
  class Client {
    constructor(url) { this.url = url; }
    get database() {
      const self = this;
      return { call: (method, params) => Client.__router(self.url, method, params) };
    }
  }
  // default router: fail loudly if a test forgot to set one
  Client.__router = () => { throw new Error('no router set'); };
  return {
    Client,
    PrivateKey: { fromString: () => ({}), fromLogin: () => ({ createPublic: () => '' }) },
  };
});

const dblurt = require('dblurt');
const utils = require('../utils');

// getConfig() returns utils.js's own module-local config object, so mutating it here
// is what blurtNodes() actually reads (see tests/blurt-failover.test.js for why
// requiring config.json directly would not work).
const config = utils.getConfig();

const A = 'https://blurt-a.example';
const B = 'https://blurt-b.example';
const C = 'https://blurt-c.example';

describe('blurtCallWithFailover', () => {
  let origNode, origAlt;
  beforeEach(() => {
    origNode = config.blurt_node;
    origAlt = config.alt_blurt_nodes;
    config.blurt_node = A;
    config.alt_blurt_nodes = [B, C];
  });
  afterEach(() => {
    config.blurt_node = origNode;
    config.alt_blurt_nodes = origAlt;
    dblurt.Client.__router = () => { throw new Error('no router set'); };
  });

  test('returns the first endpoint that answers and stops there', async () => {
    const seen = [];
    dblurt.Client.__router = (url) => {
      seen.push(url);
      if (url === A) throw new Error('HTTP 503: Service Temporarily Unavailable');
      return [{ name: 'someuser' }];
    };
    const res = await utils.blurtCallWithFailover(
      (c) => c.database.call('get_accounts', [['someuser']]),
      'get_accounts someuser'
    );
    expect(res).toEqual([{ name: 'someuser' }]);
    expect(seen).toEqual([A, B]); // did not go on to C
  });

  test('rejects only after trying every endpoint', async () => {
    const seen = [];
    dblurt.Client.__router = (url) => { seen.push(url); throw new Error('down'); };
    await expect(
      utils.blurtCallWithFailover((c) => c.database.call('get_accounts', [['x']]), 'all-fail')
    ).rejects.toThrow();
    expect(seen).toEqual([A, B, C]);
  });

  test('uses only the primary when no alternates are configured', async () => {
    config.alt_blurt_nodes = [];
    const seen = [];
    dblurt.Client.__router = (url) => { seen.push(url); return [{ name: 'y' }]; };
    const res = await utils.blurtCallWithFailover((c) => c.database.call('get_accounts', [['y']]), 'primary-only');
    expect(res).toEqual([{ name: 'y' }]);
    expect(seen).toEqual([A]);
  });

  test('a later healthy node recovers after earlier nodes fail', async () => {
    const seen = [];
    dblurt.Client.__router = (url) => {
      seen.push(url);
      if (url === A || url === B) throw new Error('503');
      return [];
    };
    const res = await utils.blurtCallWithFailover((c) => c.database.call('get_accounts', [['z']]), 'recover');
    expect(res).toEqual([]);
    expect(seen).toEqual([A, B, C]);
  });

  test('rotates past an ASYNC rejection (the real dblurt 503 shape) and recovers', async () => {
    // real dblurt database.call returns a promise that REJECTS on a 503, not a sync throw
    const seen = [];
    dblurt.Client.__router = (url) => {
      seen.push(url);
      if (url === A) return Promise.reject(new Error('HTTP 503: Service Temporarily Unavailable'));
      return Promise.resolve([{ name: 'async-ok' }]);
    };
    const res = await utils.blurtCallWithFailover((c) => c.database.call('get_accounts', [['x']]), 'async');
    expect(res).toEqual([{ name: 'async-ok' }]);
    expect(seen).toEqual([A, B]);
  });

  test('rejects after every endpoint rejects asynchronously', async () => {
    const seen = [];
    dblurt.Client.__router = (url) => { seen.push(url); return Promise.reject(new Error('async down')); };
    await expect(
      utils.blurtCallWithFailover((c) => c.database.call('get_accounts', [['x']]), 'async-all-fail')
    ).rejects.toThrow();
    expect(seen).toEqual([A, B, C]);
  });
});
