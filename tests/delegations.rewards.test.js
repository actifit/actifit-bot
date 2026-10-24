/**
 * Delegator AFIT rewards: per-job pause switches, and the checks that stop stored
 * delegation rows the chain does not back from paying out.
 *
 * The reward tests use a real MongoDB (set MONGO_TEST_URI); they are skipped without it.
 * Chain lookups go through a fake node client passed in by the test.
 */
const { MongoClient, ObjectId } = require('mongodb');
const utils = require('../utils');
const d = require('../delegations');

describe('delegations - per-job pause switches', () => {
	const prevEnv = process.env.NODE_ENV;
	afterEach(() => { process.env.NODE_ENV = prevEnv; });

	test('only delegator rewards run; value-moving jobs and unknown names stay paused', () => {
		process.env.NODE_ENV = 'production';
		expect(d.payoutsPaused('delegatorRewards')).toBe(false);
		for (const job of ['afitMove', 'gadgetPrize', 'bscBridge', 'redeemDelegations', 'someNewJob']) {
			expect(d.payoutsPaused(job)).toBe(true);
		}
	});
});

const MONGO_URI = process.env.MONGO_TEST_URI;
const describeDb = MONGO_URI ? describe : describe.skip;

describeDb('delegations - delegator reward checks', () => {
	let client;
	let db;
	const TRX = 'hive_delegation_transactions';
	const ACT = 'hive_active_delegations';
	const longAgo = new Date('2025-01-01T00:00:00Z');
	const end = new Date('2026-10-22T00:00:00Z');
	const start = new Date('2026-10-20T00:00:00Z');
	const days = 2;

	// chain: delegator -> HP delegated to us now (1 vest = 1 HP, see __setChainTotals)
	let chainHp;
	let chainFails;
	let otherDelegator; // name -> the delegator the fake node wrongly answers with
	const fakeNode = {
		database: {
			call: async (method, [delegator, delegatee]) => {
				expect(method).toBe('get_vesting_delegations');
				if (chainFails) throw new Error('rpc down');
				if (otherDelegator[delegator]) return [{ delegator: otherDelegator[delegator], delegatee, vesting_shares: '50000.000000 VESTS' }];
				const hp = chainHp[delegator] || 0;
				return hp > 0 ? [{ delegator, delegatee, vesting_shares: hp.toFixed(6) + ' VESTS' }] : [];
			},
		},
	};

	async function seed(rows) {
		await db.collection(TRX).insertMany(rows.map(([delegator, steem_power, tx_date]) => ({ delegator, steem_power, tx_date: tx_date || longAgo, vesting_shares: steem_power + ' VESTS' })));
		await db.collection(ACT).insertMany(rows.map(([delegator, steem_power, tx_date]) => ({ _id: delegator, delegator, steem_power, tx_date: tx_date || longAgo })));
	}

	beforeAll(async () => {
		client = await new MongoClient(MONGO_URI).connect();
		db = client.db('deleg_rewards_test_' + Date.now());
		d.__setTestDb(db);
		d.__setChainTotals(1, 1);
	});
	afterAll(async () => {
		if (db) await db.dropDatabase();
		if (client) await client.close();
	});
	beforeEach(async () => {
		await db.dropDatabase();
		chainHp = {};
		chainFails = false;
		otherDelegator = {};
		jest.spyOn(utils, 'rewardCap').mockReturnValue(1e9); // no multiplier unless a test sets one
	});
	afterEach(() => jest.restoreAllMocks());

	const byUser = (r) => Object.fromEntries(r.rows.map((x) => [x.orig_account, x]));

	test('pays chain-backed delegators 2 days x HP', async () => {
		await seed([['alice', 1000], ['bob', 500]]);
		chainHp = { alice: 1000, bob: 500 };
		const r = await d.computeDelegationRewards('HIVE', fakeNode, TRX, ACT, start, end, days);
		const u = byUser(r);
		expect(u.alice.token_count).toBeCloseTo(2000, 2);
		expect(u.bob.token_count).toBeCloseTo(1000, 2);
		expect(u.alice.date).toEqual(end);
		expect(r.skipped).toEqual([]);
	});

	test('a stored row with no delegation on chain pays nothing', async () => {
		await seed([['alice', 1000], ['mallory', 100000]]);
		chainHp = { alice: 1000 };
		const r = await d.computeDelegationRewards('HIVE', fakeNode, TRX, ACT, start, end, days);
		expect(byUser(r).mallory).toBeUndefined();
		expect(r.skipped).toEqual([['mallory', 'no delegation on chain']]);
	});

	test('a stored amount above the chain amount is capped to the chain amount', async () => {
		await seed([['carol', 5000]]);
		chainHp = { carol: 100 };
		const r = await d.computeDelegationRewards('HIVE', fakeNode, TRX, ACT, start, end, days);
		expect(byUser(r).carol.token_count).toBeCloseTo(200, 2);
		expect(r.capped.length).toBe(1);
	});

	test('alt redirects come only from the pinned list, never from the collection', async () => {
		// erikah -> erikahfit is in the pinned list. The collection holds a forged-old-id row
		// for bob and an "edited" erikah row; both must be ignored.
		await seed([['erikah', 1000], ['bob', 500]]);
		chainHp = { erikah: 1000, bob: 500 };
		await db.collection('delegation_alt_beneficiaries').insertMany([
			{ _id: ObjectId.createFromTime(Date.parse('2019-01-01T00:00:00Z') / 1000), delegator: 'bob', reward_benefit: '1', alt_account: 'attacker' },
			{ _id: ObjectId.createFromTime(Date.parse('2019-02-18T00:00:00Z') / 1000), delegator: 'erikah', reward_benefit: '1', alt_account: 'attacker' },
		]);
		const r = await d.computeDelegationRewards('HIVE', fakeNode, TRX, ACT, start, end, days);
		const u = byUser(r);
		expect(u.erikah.user).toBe('erikahfit');
		expect(u.erikah.reward_activity).toBe('Delegation On Behalf');
		expect(u.bob.user).toBe('bob');
		expect(u.bob.reward_activity).toBe('Delegation');
	});

	test('a shrunk active-delegations collection does not move the multiplier', async () => {
		utils.rewardCap.mockReturnValue(750); // chain HP 1500 -> multiplier 0.5
		await db.collection(TRX).insertMany([
			{ delegator: 'alice', steem_power: 1000, tx_date: longAgo, vesting_shares: '1000 VESTS' },
			{ delegator: 'bob', steem_power: 500, tx_date: longAgo, vesting_shares: '500 VESTS' },
		]);
		await db.collection(ACT).insertOne({ _id: 'alice', delegator: 'alice', steem_power: 1, tx_date: longAgo });
		chainHp = { alice: 1000, bob: 500 };
		const r = await d.computeDelegationRewards('HIVE', fakeNode, TRX, ACT, start, end, days);
		expect(r.multiplier).toBeCloseTo(0.5, 6);
		expect(r.total).toBeCloseTo(1500, 2);
	});

	test('a whale who changed delegation after the window does not stop the day', async () => {
		utils.rewardCap.mockReturnValue(1000);
		const users = Array.from({ length: 10 }, (_, k) => ['user' + k, 1000]);
		await seed(users);
		const later = new Date(end.getTime() + 3 * 3600e3);
		await db.collection(TRX).insertMany([
			{ delegator: 'whale', steem_power: 1000, tx_date: longAgo, vesting_shares: '1000 VESTS' },
			{ delegator: 'whale', steem_power: 1100, tx_date: later, vesting_shares: '1100 VESTS' },
		]);
		await db.collection(ACT).insertOne({ _id: 'whale', delegator: 'whale', steem_power: 1100, tx_date: later });
		chainHp = Object.fromEntries(users.map(([n]) => [n, 1000]));
		chainHp.whale = 1100;
		const r = await d.computeDelegationRewards('HIVE', fakeNode, TRX, ACT, start, end, days);
		expect(r.total).toBeLessThanOrEqual(2 * 1000 * 1.001);
		expect(byUser(r).whale).toBeDefined();
	});

	test('an invalid account name is skipped, the rest are paid', async () => {
		await seed([['alice', 1000], ['NOT-A-VALID-ACCOUNT-NAME', 1000]]);
		chainHp = { alice: 1000, 'NOT-A-VALID-ACCOUNT-NAME': 1000 };
		const r = await d.computeDelegationRewards('HIVE', fakeNode, TRX, ACT, start, end, days);
		expect(Object.keys(byUser(r))).toEqual(['alice']);
		expect(r.skipped[0][1]).toBe('not a valid account name');
	});

	test('a chain answer about a different delegator counts as no delegation', async () => {
		await seed([['alice', 1000], ['whal', 50000]]);
		chainHp = { alice: 1000 };
		otherDelegator = { whal: 'whale' }; // the node answers with whale's delegation
		const r = await d.computeDelegationRewards('HIVE', fakeNode, TRX, ACT, start, end, days);
		expect(byUser(r).whal).toBeUndefined();
	});

	test('nobody to pay stops the day', async () => {
		await seed([['mallory', 1000]]);
		await expect(d.computeDelegationRewards('HIVE', fakeNode, TRX, ACT, start, end, days)).rejects.toThrow(/no delegator would be paid/);
	});

	test('an empty delegation history stops the day too', async () => {
		await expect(d.computeDelegationRewards('HIVE', fakeNode, TRX, ACT, start, end, days)).rejects.toThrow(/no delegator would be paid/);
	});

	test('a sharp drop in payees from the previous day stops the day', async () => {
		const prev = new Date(end.getTime() - 24 * 3600e3);
		await db.collection('token_transactions').insertMany(Array.from({ length: 100 }, (_, k) => ({ user: 'p' + k, reward_activity: 'Delegation', date: prev, token_count: 1 })));
		await seed([['alice', 1000]]);
		chainHp = { alice: 1000 };
		await expect(d.computeDelegationRewards('HIVE', fakeNode, TRX, ACT, start, end, days)).rejects.toThrow(/payees dropped/);
	});

	test('a chain lookup failure pays nothing', async () => {
		await seed([['alice', 1000]]);
		chainFails = true;
		await expect(d.computeDelegationRewards('HIVE', fakeNode, TRX, ACT, start, end, days)).rejects.toThrow('rpc down');
	});

	test('the multiplier still applies when total HP is above the cap', async () => {
		utils.rewardCap.mockReturnValue(750); // total HP 1500 -> multiplier 0.5
		await seed([['alice', 1000], ['bob', 500]]);
		chainHp = { alice: 1000, bob: 500 };
		const r = await d.computeDelegationRewards('HIVE', fakeNode, TRX, ACT, start, end, days);
		expect(r.multiplier).toBeCloseTo(0.5, 6);
		expect(byUser(r).alice.token_count).toBeCloseTo(1000, 2);
		expect(r.total).toBeCloseTo(1500, 2);
	});

	test('processTokenRewards writes once per day; a rerun does not double-pay', async () => {
		await seed([['alice', 1000], ['bob', 500]]);
		chainHp = { alice: 1000, bob: 500 };
		await d.processTokenRewards('HIVE', fakeNode, null, TRX, ACT, start, end, days);
		await d.processTokenRewards('HIVE', fakeNode, null, TRX, ACT, start, end, days);
		const rows = await db.collection('token_transactions').find({ reward_activity: /^Delegation/ }).toArray();
		expect(rows.length).toBe(2);
		expect(rows.reduce((a, r) => a + r.token_count, 0)).toBeCloseTo(3000, 2);
	});
});
