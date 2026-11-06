const { MIN_AFIT_HIVE_PRICE, MAX_ASK_AFIT_HIVE_PRICE, flooredAfitHivePrice, pricingAfitHivePrice } = require('../afit_price_floor');

describe('pricingAfitHivePrice', () => {
	test('uses the cheapest offer when it is above the floor and the last price (2026-11-05 book)', () => {
		expect(pricingAfitHivePrice({ lastPrice: '0.00001011', lowestAsk: '0.00033900' })).toBeCloseTo(0.000339, 10);
	});

	test('a 100 AFIT gadget then costs what buying 100 AFIT on the market costs', () => {
		const itemPrice = 100 * pricingAfitHivePrice({ lastPrice: '0.00001011', lowestAsk: '0.00033900' });
		expect(itemPrice).toBeCloseTo(0.0339, 10);
	});

	test('uses the last price when it is the highest', () => {
		expect(pricingAfitHivePrice({ lastPrice: '0.0005', lowestAsk: '0.0004' })).toBe(0.0005);
	});

	test('a dumped cheapest offer still cannot go below the floor', () => {
		expect(pricingAfitHivePrice({ lastPrice: '0.00001', lowestAsk: '0.00001' })).toBe(MIN_AFIT_HIVE_PRICE);
	});

	test('a silly high offer on an empty book counts only up to the cap', () => {
		expect(pricingAfitHivePrice({ lastPrice: '0.00001', lowestAsk: '1' })).toBe(MAX_ASK_AFIT_HIVE_PRICE);
		expect(MAX_ASK_AFIT_HIVE_PRICE).toBeCloseTo(0.002, 10);
	});

	test('a real price rise still comes through the last price, above the cap', () => {
		expect(pricingAfitHivePrice({ lastPrice: '0.005', lowestAsk: '0.0051' })).toBe(0.005);
	});

	test('no offers, bad fields or no metrics fall back to the floor', () => {
		expect(pricingAfitHivePrice({ lastPrice: '0.00001', lowestAsk: '0' })).toBe(MIN_AFIT_HIVE_PRICE);
		expect(pricingAfitHivePrice({ lastPrice: 'abc', lowestAsk: undefined })).toBe(MIN_AFIT_HIVE_PRICE);
		expect(pricingAfitHivePrice(undefined)).toBe(MIN_AFIT_HIVE_PRICE);
	});
});

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
