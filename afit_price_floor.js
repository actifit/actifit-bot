'use strict';

/*
 * Lowest AFIT price, in HIVE, that the server will price anything at.
 *
 * AFIT's Hive-Engine market is thin: one small sale into the lowest bid sets the last price.
 * On 2026-11-03 a 702 AFIT sale at 0.00001011 HIVE did that, and gadgets paid in HIVE
 * (AFIT price x AFIT/HIVE last price) dropped to 0.001 HIVE each. AFIT traded around
 * 0.0002 HIVE in the week before, so that is the floor.
 */
const MIN_AFIT_HIVE_PRICE = 0.0002;

/*
 * The cheapest sell offer counts only up to this price. On a near-empty order book a single
 * silly offer (say 1 HIVE per AFIT) would otherwise make HIVE gadget buys absurdly expensive.
 * A real price rise still comes through the last price.
 */
const MAX_ASK_AFIT_HIVE_PRICE = 10 * MIN_AFIT_HIVE_PRICE;

function toPrice(value) {
	const price = parseFloat(value);
	return Number.isFinite(price) && price > 0 ? price : 0;
}

/* The AFIT/HIVE price to use: the market last price, but never below the floor. */
function flooredAfitHivePrice(marketPrice) {
	return Math.max(MIN_AFIT_HIVE_PRICE, toPrice(marketPrice));
}

/*
 * The AFIT/HIVE price for pricing things (gadgets, signup cap): the highest of the floor,
 * the last price, and the cheapest sell offer (capped). Paying in HIVE then costs about what
 * buying the AFIT on the market would. The cheapest offer is hard to fake: lowering it means
 * offering AFIT cheaply to anyone, who can buy it all.
 */
function pricingAfitHivePrice(metrics) {
	const m = metrics || {};
	const ask = Math.min(toPrice(m.lowestAsk), MAX_ASK_AFIT_HIVE_PRICE);
	return Math.max(flooredAfitHivePrice(m.lastPrice), ask);
}

module.exports = { MIN_AFIT_HIVE_PRICE, MAX_ASK_AFIT_HIVE_PRICE, flooredAfitHivePrice, pricingAfitHivePrice };
