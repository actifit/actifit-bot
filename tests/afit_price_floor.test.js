const { MIN_AFIT_HIVE_PRICE, flooredAfitHivePrice } = require('../afit_price_floor');

describe('flooredAfitHivePrice', () => {
	test('the floor is 0.0002 HIVE', () => {
		expect(MIN_AFIT_HIVE_PRICE).toBe(0.0002);
	});

	test('keeps a market price above the floor', () => {
		expect(flooredAfitHivePrice('0.00035001')).toBeCloseTo(0.00035001, 10);
		expect(flooredAfitHivePrice(0.001)).toBe(0.001);
	});

	test('raises a dust price to the floor (the 2026-11-03 sale at 0.00001011)', () => {
		expect(flooredAfitHivePrice('0.00001011')).toBe(MIN_AFIT_HIVE_PRICE);
	});

	test('uses the floor when the price is missing or not a number', () => {
		for (const bad of [undefined, null, '', 'abc', NaN, 0, -1, Infinity]) {
			expect(flooredAfitHivePrice(bad)).toBe(MIN_AFIT_HIVE_PRICE);
		}
	});

	test('a 100 AFIT gadget costs at least 0.02 HIVE', () => {
		const itemPrice = 100 * flooredAfitHivePrice('0.00001011');
		expect((Math.floor(itemPrice * 1000) - 1) / 1000).toBeCloseTo(0.019, 10);
	});
});
