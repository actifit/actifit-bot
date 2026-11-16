/**
 * /getAccountData?markErrors=1: a failed lookup is reported as {error: true} instead of null,
 * so the Android earnings sheet can tell "no Blurt account" from "Blurt nodes are down".
 * Without the flag the response is unchanged (null), for the website, iOS and older apps.
 *
 * Intercepts BlurtApi.prototype.send, the same way blurt-failover.test.js does. No network.
 */

const blurt = require('@blurtfoundation/blurtjs');
const hive = require('@hiveio/hive-js');
const utils = require('../utils');

const config = utils.getConfig();
const BlurtApi = blurt.api.constructor;
const ACCT = { name: 'someuser', balance: '12.000 BLURT' };
const NODES = ['https://node-a.test', 'https://node-b.test'];

function stubBlurt(router){
  return jest.spyOn(BlurtApi.prototype, 'send').mockImplementation(function (api, data, cb) {
    try {
      cb(null, router(this.options.uri));
    } catch (err) {
      cb(err);
    }
  });
}

describe('getAccountData error marker (Blurt)', () => {
  let origNode;
  let origAlts;

  beforeEach(() => {
    origNode = config.blurt_node;
    origAlts = config.alt_blurt_nodes;
    config.blurt_node = NODES[0];
    config.alt_blurt_nodes = [NODES[1]];
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    if (origNode === undefined) delete config.blurt_node; else config.blurt_node = origNode;
    if (origAlts === undefined) delete config.alt_blurt_nodes; else config.alt_blurt_nodes = origAlts;
    jest.restoreAllMocks();
  });

  const down = () => { throw new Error('503'); };

  test('every node failing gives {error: true} with markErrors', async () => {
    stubBlurt(down);
    const out = await utils.getAccountData('someuser', 'BLURT', { markErrors: true });
    expect(out.BLURT).toEqual({ error: true });
  });

  test('every node failing still gives null without markErrors (unchanged contract)', async () => {
    stubBlurt(down);
    const out = await utils.getAccountData('someuser', 'BLURT');
    expect(out.BLURT).toBeNull();
  });

  test('a node answering with no account is a real "no account": null even with markErrors', async () => {
    stubBlurt(() => []);
    const out = await utils.getAccountData('someuser', 'BLURT', { markErrors: true });
    expect(out.BLURT).toBeNull();
  });

  test('first node down, second answers "no account": null, not an error', async () => {
    stubBlurt((url) => { if (url.startsWith(NODES[0])) throw new Error('503'); return []; });
    const out = await utils.getAccountData('someuser', 'BLURT', { markErrors: true });
    expect(out.BLURT).toBeNull();
  });

  test('an existing account is returned as-is', async () => {
    stubBlurt(() => [ACCT]);
    const out = await utils.getAccountData('someuser', 'BLURT', { markErrors: true });
    expect(out.BLURT).toEqual(ACCT);
  });

  test('every node answering result: null (desynced) is a failure, not "no account"', async () => {
    stubBlurt(() => null);
    const out = await utils.getAccountData('someuser', 'BLURT', { markErrors: true });
    expect(out.BLURT).toEqual({ error: true });
  });

  test('one desynced node and one "no account" answer: null', async () => {
    stubBlurt((url) => (url.startsWith(NODES[0]) ? null : []));
    const out = await utils.getAccountData('someuser', 'BLURT', { markErrors: true });
    expect(out.BLURT).toBeNull();
  });
});

describe('getAccountData error marker (Hive)', () => {
  afterEach(() => jest.restoreAllMocks());
  beforeEach(() => jest.spyOn(console, 'log').mockImplementation(() => {}));

  test('a failing Hive lookup gives {error: true} with markErrors, null without', async () => {
    jest.spyOn(hive.api, 'getAccountsAsync').mockRejectedValue(new Error('503'));
    expect((await utils.getAccountData('someuser', 'HIVE', { markErrors: true })).HIVE).toEqual({ error: true });
    expect((await utils.getAccountData('someuser', 'HIVE')).HIVE).toBeNull();
  });

  test('a Hive node answering result: null is a failure', async () => {
    jest.spyOn(hive.api, 'getAccountsAsync').mockResolvedValue(null);
    expect((await utils.getAccountData('someuser', 'HIVE', { markErrors: true })).HIVE).toEqual({ error: true });
  });

  test('a Hive "no account" answer stays null', async () => {
    jest.spyOn(hive.api, 'getAccountsAsync').mockResolvedValue([]);
    expect((await utils.getAccountData('someuser', 'HIVE', { markErrors: true })).HIVE).toBeNull();
  });
});
