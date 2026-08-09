/*
 * Unit tests for the signup AFIT reward ceiling.
 *
 * These mirror the logic in app.js (capSignupAfitReward / cryptoUsdPrice /
 * promoSignupAfitReward). app.js cannot be imported directly here -- requiring
 * it boots the whole Express app, connects to Mongo and initialises Firebase --
 * so the functions are reproduced verbatim and pinned by these tests. If you
 * change the originals, change them here too.
 */
const SIGNUP_AFIT_USD_PER_LOT = 5;
const SIGNUP_AFIT_PER_LOT = 100;
const PROMO_MAX_AFIT_REWARD_DEFAULT = 100;

// AFIT at $0.01, HIVE at $0.25
const exchangeAfitPrice = {
  afitHiveLastUsdPrice: 0.01,
  afitHiveLastPrice: 0.04,
  afitSteemLastUsdPrice: 0.01,
  afitSteemLastPrice: 0.05,
};
const config = {};

const cryptoUsdPrice = function (currency) {
  const cur = (currency || '').toUpperCase();
  if (cur === 'HBD' || cur === 'SBD') return 1;
  if (cur === 'HIVE') return exchangeAfitPrice.afitHiveLastUsdPrice / exchangeAfitPrice.afitHiveLastPrice;
  if (cur === 'STEEM') return exchangeAfitPrice.afitSteemLastUsdPrice / exchangeAfitPrice.afitSteemLastPrice;
  return NaN;
};

const capSignupAfitReward = function (requestedReward, verifiedPayment) {
  const requested = parseFloat(requestedReward);
  if (!isFinite(requested) || requested <= 0) return 0;
  if (!verifiedPayment || !isFinite(parseFloat(verifiedPayment.amount))) return 0;
  const unitUsd = cryptoUsdPrice(verifiedPayment.currency);
  const afitUsdPrice = parseFloat(exchangeAfitPrice.afitHiveLastUsdPrice);
  if (!isFinite(unitUsd) || unitUsd <= 0 || !isFinite(afitUsdPrice) || afitUsdPrice <= 0) return 0;
  const verifiedUsd = parseFloat(verifiedPayment.amount) * unitUsd;
  const lots = Math.max(1, Math.floor(verifiedUsd / SIGNUP_AFIT_USD_PER_LOT));
  const ceiling = Math.floor(Math.min(verifiedUsd / afitUsdPrice, SIGNUP_AFIT_PER_LOT * lots));
  return requested > ceiling ? ceiling : requested;
};

const promoSignupAfitReward = function (promoMatch, requestedReward) {
  const maxAllowed = parseFloat(config.promoMaxAfitReward) > 0
    ? parseFloat(config.promoMaxAfitReward) : PROMO_MAX_AFIT_REWARD_DEFAULT;
  const fromRecord = parseFloat(promoMatch && promoMatch.signup_reward_amount);
  if (isFinite(fromRecord) && fromRecord >= 0) return Math.min(fromRecord, maxAllowed);
  const requested = parseFloat(requestedReward);
  if (!isFinite(requested) || requested <= 0) return 0;
  return requested > maxAllowed ? maxAllowed : requested;
};

describe('capSignupAfitReward', () => {
  const paid8Hive = { amount: 8, currency: 'HIVE' };   // 8 * 0.25 = $2

  test('refuses any reward when no payment was verified', () => {
    expect(capSignupAfitReward(100000, undefined)).toBe(0);
    expect(capSignupAfitReward(100, null)).toBe(0);
    expect(capSignupAfitReward(100, { amount: 'abc', currency: 'HIVE' })).toBe(0);
  });

  test('blocks the inflated-usd_invest bypass — ceiling ignores client figures', () => {
    // attacker sends a dust transfer but asks for 100000 AFIT
    const dust = { amount: 0.001, currency: 'HIVE' };
    expect(capSignupAfitReward(100000, dust)).toBeLessThan(1);
  });

  test('allows a legitimate $2 signup its full entitlement', () => {
    // $2 / $0.01 = 200 AFIT, but one lot caps at 100
    expect(capSignupAfitReward(100, paid8Hive)).toBe(100);
  });

  test('caps a request above the entitlement', () => {
    expect(capSignupAfitReward(5000, paid8Hive)).toBe(100);
  });

  test('never raises a modest request', () => {
    expect(capSignupAfitReward(25, paid8Hive)).toBe(25);
  });

  test('scales lots with larger verified payments', () => {
    // 80 HIVE = $20 => 4 lots => cap 400; $20/$0.01 = 2000 => ceiling 400
    expect(capSignupAfitReward(10000, { amount: 80, currency: 'HIVE' })).toBe(400);
  });

  test('prices HBD as dollar-pegged', () => {
    // 2 HBD = $2 => same entitlement as 8 HIVE
    expect(capSignupAfitReward(100, { amount: 2, currency: 'HBD' })).toBe(100);
  });

  test('refuses when the currency cannot be priced', () => {
    expect(capSignupAfitReward(100, { amount: 10, currency: 'DOGE' })).toBe(0);
  });

  test('rejects non-positive or malformed requests', () => {
    expect(capSignupAfitReward(0, paid8Hive)).toBe(0);
    expect(capSignupAfitReward(-5, paid8Hive)).toBe(0);
    expect(capSignupAfitReward('abc', paid8Hive)).toBe(0);
  });
});

describe('promoSignupAfitReward', () => {
  test('prefers an explicit amount on the promo record', () => {
    expect(promoSignupAfitReward({ signup_reward_amount: 40 }, 99999)).toBe(40);
  });

  test('caps an explicit record amount at the server maximum', () => {
    expect(promoSignupAfitReward({ signup_reward_amount: 99999 }, 10)).toBe(100);
  });

  test('caps a client request when the record carries only boolean gates', () => {
    // existing production promo docs look like this
    expect(promoSignupAfitReward({ signup_reward: true, referrer_reward: true }, 100000)).toBe(100);
  });

  test('leaves a modest client request unchanged for legacy records', () => {
    expect(promoSignupAfitReward({ signup_reward: true }, 50)).toBe(50);
  });

  test('returns 0 for malformed requests', () => {
    expect(promoSignupAfitReward({ signup_reward: true }, 'abc')).toBe(0);
  });
});
