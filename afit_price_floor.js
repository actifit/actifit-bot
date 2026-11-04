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

/* The AFIT/HIVE price to use: the market last price, but never below the floor. */
function flooredAfitHivePrice(marketPrice) {
	const price = parseFloat(marketPrice);
	if (!Number.isFinite(price) || price < MIN_AFIT_HIVE_PRICE) return MIN_AFIT_HIVE_PRICE;
	return price;
}

module.exports = { MIN_AFIT_HIVE_PRICE, flooredAfitHivePrice };
