/**
 * GET /fetchUserData (fetch_user_data.js) - session restore on page load.
 *
 * The bug: the route checked the posting key stored with the session, but the
 * signed-challenge login stores none, so it failed for every session and the website
 * logged typed-key users out on each page load.
 */

const { createFetchUserDataHandler } = require('../fetch_user_data');

const mockRes = () => {
	const res = { statusCode: 200 };
	res.status = jest.fn((c) => { res.statusCode = c; return res; });
	res.json = jest.fn((b) => { res.body = b; return res; });
	return res;
};
const alice = { name: 'alice', posting: { key_auths: [['STMpub', 1]] }, balance: '1.000 HIVE' };

describe('fetchUserData', () => {
	test('an authenticated session gets its account from the chain - no stored key needed', async () => {
		const getAccountData = jest.fn().mockResolvedValue({ HIVE: alice });
		const res = mockRes();
		// what checkHdrs leaves for a signed-challenge session: verified user, no ppkey
		await createFetchUserDataHandler({ getAccountData })({ query: { user: 'alice', bchain: '' } }, res);
		expect(getAccountData).toHaveBeenCalledWith('alice', 'HIVE');
		expect(res.statusCode).toBe(200);
		expect(res.body).toEqual({ success: true, userdata: alice });
	});

	test('the response shape the website reads is unchanged ({success, userdata})', async () => {
		const res = mockRes();
		await createFetchUserDataHandler({ getAccountData: async () => ({ BLURT: alice }) })(
			{ query: { user: 'alice', bchain: 'BLURT' } }, res);
		expect(res.body.success).toBe(true);
		expect(res.body.userdata.name).toBe('alice');
	});

	test.each([
		['the node returned nothing', async () => ({ HIVE: null })],
		['the node returned another account', async () => ({ HIVE: { name: 'mallory' } })],
		['the lookup threw', async () => { throw new Error('node down'); }]
	])('%s -> 503, not a 200 with someone else\'s data', async (_, getAccountData) => {
		const res = mockRes();
		await createFetchUserDataHandler({ getAccountData })({ query: { user: 'alice' } }, res);
		expect(res.statusCode).toBe(503);
		expect(res.body.success).toBe(false);
	});
});
