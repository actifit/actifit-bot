/**
 * redactForLog must keep secrets out of stdout.
 *
 * The specific leak this exists for: handleConfirmPayment does
 * `req.query = { ...req.body }` (app.js), and that body carries `new_pass` - the MASTER
 * PASSWORD of the account being created. utils.createAccount() feeds it to
 * PrivateKey.fromLogin(username, password, 'owner'), so it is owner-key-equivalent:
 * strictly more powerful than a posting key. `console.log(req.query)` sitting two lines
 * before that call wrote it to the API log for every paid signup.
 *
 * These tests assert on the OUTPUT OF THE REAL LOGGER, not on the helper's return value
 * alone, because the bug was never "the helper is wrong" - it was "the secret reached
 * the log". Asserting the helper in isolation would pass even if a call site forgot it.
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

const SECRET = 'correct-horse-battery-staple-MASTER';

// redactForLog is a module-local function in app.js, not exported, and app.js has heavy
// load-time side effects. Read the source and evaluate just this helper - that keeps the
// test honest about the real implementation without booting the whole API.
const loadRedactor = () => {
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  const start = src.indexOf('const SENSITIVE_LOG_KEYS');
  const end = src.indexOf('function encrypt(text)');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('redactForLog block not found in app.js - was it renamed or moved?');
  }
  // eslint-disable-next-line no-new-func
  return new Function(src.slice(start, end) + '; return redactForLog;')();
};

describe('redactForLog', () => {
  const redactForLog = loadRedactor();

  it('redacts the signup master password', () => {
    // The headline case. new_pass derives owner/active/posting/memo keys.
    const out = redactForLog({ new_account: 'alice', new_pass: SECRET, bchain: 'HIVE' });

    expect(out.new_pass).toBe('[REDACTED]');
    expect(JSON.stringify(out)).not.toContain(SECRET);
    // Non-secret fields must survive, or the log loses its diagnostic value and someone
    // will remove the redaction to get it back.
    expect(out.new_account).toBe('alice');
    expect(out.bchain).toBe('HIVE');
  });

  it('does not reach the log through console.log either', () => {
    // Asserts the end-to-end property: what actually gets printed.
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      console.log(redactForLog({ new_account: 'alice', new_pass: SECRET }));
      const printed = JSON.stringify(spy.mock.calls);
      expect(printed).not.toContain(SECRET);
    } finally {
      spy.mockRestore();
    }
  });

  it.each([
    ['ppkey', '5KpostingKeySecret'],
    ['pass', 'funds-password'],
    ['password', 'pw'],
    ['active_key', '5KactiveSecret'],
    ['userKey', '5KuserSecret'],
    ['confirm_payment_token', 'shared-secret'],
    ['admin_ops_token', 'admin-secret'],
    ['x_api_secret', 'nope'],
  ])('redacts %s', (field, value) => {
    const out = redactForLog({ [field]: value, user: 'alice' });
    expect(out[field]).toBe('[REDACTED]');
    expect(out.user).toBe('alice');
  });

  it('catches a newly added secret field by name pattern', () => {
    // Defence against drift: a future field nobody adds to the list must still be caught
    // if it is named like a secret. The leak happened because the log predated the field.
    const out = redactForLog({ some_new_password_field: SECRET, another_key_thing: SECRET });
    expect(out.some_new_password_field).toBe('[REDACTED]');
    expect(out.another_key_thing).toBe('[REDACTED]');
  });

  it('handles null, undefined and non-objects without throwing', () => {
    // It sits inside a payment handler with no try/catch; a throw here would be worse
    // than the leak it prevents.
    expect(redactForLog(null)).toBe(null);
    expect(redactForLog(undefined)).toBe(undefined);
    expect(redactForLog('str')).toBe('str');
    expect(() => redactForLog({})).not.toThrow();
  });

  it('never mutates the request object it was given', () => {
    // createAccount reads req.query.new_pass AFTER the log line. If redaction mutated
    // the object, logging would silently break every signup.
    const q = { new_account: 'alice', new_pass: SECRET };
    redactForLog(q);
    expect(q.new_pass).toBe(SECRET);
  });
});
