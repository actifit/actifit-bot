/**
 * Endpoint rotation for Blurt WRITES.
 *
 * processSteemTrx is every Blurt write this service performs — reward claims, votes,
 * transfers, comments and web posts all funnel through /performTrx and /performTrxPost.
 * It used blurtjs's broadcast, bound to a module-level singleton pinned at load: one
 * node, one attempt, no retry. A public node throttling writes (observed: HTTP 429 on
 * claim_reward_balance) failed the user's action outright.
 *
 * Two properties matter here and both are asserted below:
 *   - it rotates, so one throttled node is not the end of the attempt;
 *   - TaPoS and the broadcast come from the SAME node. A broadcast is three sequential
 *     calls; taking the reference block from one node and broadcasting to another
 *     produces a transaction the chain rejects. That is precisely the hazard that ruled
 *     out rotating the shared blurtjs singleton, so it must not be reintroduced here.
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

// Records which endpoint served each step, so a TaPoS/broadcast split is visible.
const calls = [];
jest.mock('dblurt', () => {
  class Client {
    constructor(url) { this.url = url; }
    get database() {
      const self = this;
      return {
        getDynamicGlobalProperties: () => {
          calls.push({ step: 'props', url: self.url });
          return Client.__props(self.url);
        },
      };
    }
    get broadcast() {
      const self = this;
      return {
        sign: (tx) => ({ ...tx, signatures: ['sig'] }),
        send: (tx) => {
          calls.push({ step: 'send', url: self.url, tx });
          return Client.__send(self.url, tx);
        },
      };
    }
  }
  const GOOD_PROPS = {
    head_block_number: 0x1234abcd,
    head_block_id: '0123456789abcdef0123456789abcdef01234567',
    time: '2026-10-12T20:00:00',
  };
  Client.__props = () => Promise.resolve(GOOD_PROPS);
  Client.__send = () => Promise.resolve({ id: 'txid', block_num: 999, trx_num: 0, expired: false });
  return { Client, PrivateKey: { fromString: (w) => { if (w === 'BAD') throw new Error('invalid wif'); return { wif: w }; } } };
});

const dblurt = require('dblurt');
const utils = require('../utils');
const config = utils.getConfig();

const A = 'https://b1.test';
const B = 'https://b2.test';
const C = 'https://b3.test';
const OPS = [['claim_reward_balance', { account: 'alice' }]];

describe('Blurt broadcast failover', () => {
  let origNode, origAlts;

  beforeEach(() => {
    calls.length = 0;
    origNode = config.blurt_node;
    origAlts = config.alt_blurt_nodes;
    config.blurt_node = A;
    config.alt_blurt_nodes = [A, B, C];
    dblurt.Client.__props = () => Promise.resolve({
      head_block_number: 0x1234abcd,
      head_block_id: '0123456789abcdef0123456789abcdef01234567',
      time: '2026-10-12T20:00:00',
    });
    dblurt.Client.__send = () => Promise.resolve({ id: 'txid', block_num: 999, trx_num: 0, expired: false });
  });

  afterEach(() => {
    config.blurt_node = origNode;
    config.alt_blurt_nodes = origAlts;
  });

  it('rotates past a node that throttles the write and succeeds on the next', async () => {
    // The reported production failure: HTTP 429 on claim_reward_balance.
    dblurt.Client.__send = (url) => (url === A
      ? Promise.reject(new Error('HTTP 429: Too Many Requests'))
      : Promise.resolve({ id: 'txid', block_num: 999, expired: false }));

    const out = await utils.broadcastBlurtWithFailover(OPS, '5Kposting', 'test');

    expect(out.error).toBeUndefined();
    expect(out.id).toBe('txid');
    expect(calls.filter((c) => c.step === 'send').map((c) => c.url)).toEqual([A, B]);
  });

  it('returns ref_block_num, which is what the routes read as success', async () => {
    // /performTrx and /performTrxPost both do `if (!performTrx.tx.ref_block_num)` ->
    // error. dblurt's confirmation does not carry it, so without this a successful
    // Blurt broadcast would be reported to the user as a failure.
    const out = await utils.broadcastBlurtWithFailover(OPS, '5Kposting', 'test');

    expect(out.ref_block_num).toBe(0x1234abcd & 0xffff);
    expect(typeof out.ref_block_prefix).toBe('number');
  });

  it('takes TaPoS and broadcasts from the SAME node on every attempt', async () => {
    // A reference block from one node broadcast to another is rejected by the chain.
    dblurt.Client.__send = (url) => (url === C
      ? Promise.resolve({ id: 'txid', block_num: 999, expired: false })
      : Promise.reject(new Error('HTTP 503')));

    await utils.broadcastBlurtWithFailover(OPS, '5Kposting', 'test');

    // Steps must pair up: props@X, send@X, props@Y, send@Y, ...
    for (let i = 0; i < calls.length; i += 2) {
      expect(calls[i].step).toBe('props');
      expect(calls[i + 1].step).toBe('send');
      expect(calls[i].url).toBe(calls[i + 1].url);
    }
    expect(calls).toHaveLength(6);
  });

  it('returns an error object, not a rejection, when every node fails', async () => {
    // processSteemTrx has no try/catch around this, and its callers are async handlers
    // with none either — a throw would end the process.
    dblurt.Client.__send = () => Promise.reject(new Error('HTTP 429: Too Many Requests'));

    const out = await utils.broadcastBlurtWithFailover(OPS, '5Kposting', 'test');

    expect(out.error).toMatch(/429/);
    expect(out.ref_block_num).toBeUndefined();
  });

  it('treats an expired transaction as a failure and tries the next node', async () => {
    let n = 0;
    dblurt.Client.__send = () => {
      n += 1;
      return Promise.resolve(n === 1 ? { id: 'x', expired: true } : { id: 'txid', block_num: 9, expired: false });
    };

    const out = await utils.broadcastBlurtWithFailover(OPS, '5Kposting', 'test');

    expect(out.error).toBeUndefined();
    expect(out.id).toBe('txid');
  });

  it('rejects an unusable key without broadcasting anything', async () => {
    const out = await utils.broadcastBlurtWithFailover(OPS, 'BAD', 'test');

    expect(out.error).toMatch(/invalid Blurt key/);
    expect(calls).toHaveLength(0);
  });
});
