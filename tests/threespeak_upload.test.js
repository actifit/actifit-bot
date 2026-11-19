/**
 * threespeak_upload.js: upload tokens from 3Speak's embed service, issued per Actifit user.
 */

const tu = require('../threespeak_upload');

function fakeDb() {
	const rows = [];
	let seq = 0;
	return {
		rows,
		collection(name) {
			if (name !== tu.COLLECTION) throw new Error('unexpected collection ' + name);
			return {
				countDocuments: async (q) => rows.filter((r) => r.user === q.user && r.created >= q.created.$gte).length,
				insertOne: async (doc) => {
					const _id = ++seq;
					rows.push({ ...doc, _id });
					await new Promise((r) => setImmediate(r)); // let parallel requests interleave
					return { insertedId: _id };
				},
				deleteOne: async (q) => {
					const i = rows.findIndex((r) => r._id === q._id);
					if (i >= 0) rows.splice(i, 1);
					return {};
				},
				updateOne: async (q, u) => { Object.assign(rows.find((r) => r._id === q._id), u.$set); return {}; },
				find: (q) => {
					let out = rows.filter((r) => r.user === q.user && (!q.permlink || r.permlink !== undefined));
					const cur = {
						sort: () => { out = out.slice().sort((a, b) => b.created - a.created); return cur; },
						limit: (n) => { out = out.slice(0, n); return cur; },
						toArray: async () => out.map(({ permlink, embed_url, short, created }) => ({ permlink, embed_url, short, created })),
					};
					return cur;
				},
			};
		},
	};
}

const T0 = Date.UTC(2026, 10, 19, 12, 0, 0);

function okFetch(calls = []) {
	return async (url, opts) => {
		calls.push({ url, opts });
		const body = JSON.parse(opts.body);
		return {
			ok: true, status: 200,
			json: async () => ({
				token: 'tok-' + calls.length,
				upload_url: 'https://embed.3speak.tv/uploads',
				permlink: 'p' + calls.length,
				embed_url: 'https://play.3speak.tv/embed?v=' + body.owner + '/p' + calls.length,
				expires_at: '2026-11-19T12:10:00.000Z',
			}),
		};
	};
}

describe('issueUploadToken', () => {
	beforeEach(() => jest.spyOn(console, 'log').mockImplementation(() => {}));
	afterEach(() => jest.restoreAllMocks());

	test('asks 3Speak with the app key for the logged-in user and returns the token', async () => {
		const db = fakeDb();
		const calls = [];
		const out = await tu.issueUploadToken(db, 'alice', { apiKey: 'KEY', fetchImpl: okFetch(calls), now: () => T0 });
		expect(out.status).toBe(200);
		expect(out.body).toEqual({
			token: 'tok-1', upload_url: 'https://embed.3speak.tv/uploads', permlink: 'p1',
			embed_url: 'https://play.3speak.tv/embed?v=alice/p1', expires_at: '2026-11-19T12:10:00.000Z',
		});
		expect(calls[0].url).toBe('https://embed.3speak.tv/uploads/token');
		expect(calls[0].opts.headers['X-API-Key']).toBe('KEY');
		expect(JSON.parse(calls[0].opts.body)).toEqual({ owner: 'alice', frontend_app: 'actifit', short: false, ttl: 600 });
		expect(db.rows).toHaveLength(1);
		expect(db.rows[0]).toMatchObject({ user: 'alice', permlink: 'p1' });
	});

	test('the key is never sent back to the app', async () => {
		const out = await tu.issueUploadToken(fakeDb(), 'alice', { apiKey: 'SECRET-KEY', fetchImpl: okFetch(), now: () => T0 });
		expect(JSON.stringify(out.body)).not.toContain('SECRET-KEY');
	});

	test('no key configured: refused without calling 3Speak', async () => {
		const calls = [];
		const out = await tu.issueUploadToken(fakeDb(), 'alice', { apiKey: '', fetchImpl: okFetch(calls) });
		expect(out.status).toBe(503);
		expect(calls).toHaveLength(0);
	});

	test('short videos are flagged as such', async () => {
		const calls = [];
		await tu.issueUploadToken(fakeDb(), 'alice', { apiKey: 'K', short: true, fetchImpl: okFetch(calls), now: () => T0 });
		expect(JSON.parse(calls[0].opts.body).short).toBe(true);
	});

	test('each account gets at most DAILY_LIMIT tokens a day; others are unaffected; the limit rolls', async () => {
		const db = fakeDb();
		const f = okFetch();
		for (let i = 0; i < tu.DAILY_LIMIT; i++) {
			expect((await tu.issueUploadToken(db, 'alice', { apiKey: 'K', fetchImpl: f, now: () => T0 + i })).status).toBe(200);
		}
		expect((await tu.issueUploadToken(db, 'alice', { apiKey: 'K', fetchImpl: f, now: () => T0 + 100 })).status).toBe(429);
		expect((await tu.issueUploadToken(db, 'bob', { apiKey: 'K', fetchImpl: f, now: () => T0 + 100 })).status).toBe(200);
		const nextDay = T0 + 24 * 60 * 60 * 1000 + 50;
		expect((await tu.issueUploadToken(db, 'alice', { apiKey: 'K', fetchImpl: f, now: () => nextDay })).status).toBe(200);
	});

	test('parallel requests cannot get past the daily limit', async () => {
		const db = fakeDb();
		const slowFetch = async (url, opts) => {
			await new Promise((r) => setTimeout(r, 5));
			return okFetch()(url, opts);
		};
		const outs = await Promise.all(Array.from({ length: 40 }, () =>
			tu.issueUploadToken(db, 'alice', { apiKey: 'K', fetchImpl: slowFetch, now: () => T0 })));
		expect(outs.filter((o) => o.status === 200).length).toBeLessThanOrEqual(tu.DAILY_LIMIT);
		expect(outs.filter((o) => o.status === 200).length).toBeGreaterThan(0);
		expect(db.rows.length).toBeLessThanOrEqual(tu.DAILY_LIMIT);
	});

	test('a token that 3Speak did not issue is not listed', async () => {
		const db = fakeDb();
		db.rows.push({ _id: 999, user: 'alice', created: new Date(T0) }); // reserved, never filled
		expect(await tu.listUploads(db, 'alice')).toEqual([]);
	});

	test('3Speak errors answer 502, record nothing, and do not count against the limit', async () => {
		const db = fakeDb();
		const bad = async () => ({ ok: false, status: 401, json: async () => ({ error: 'Invalid API key' }) });
		const out = await tu.issueUploadToken(db, 'alice', { apiKey: 'K', fetchImpl: bad, now: () => T0 });
		expect(out.status).toBe(502);
		expect(db.rows).toHaveLength(0);
		expect(console.log).toHaveBeenCalledWith(expect.stringContaining('HTTP 401 Invalid API key'));
	});

	test('a network failure or a reply without a token answers 502', async () => {
		const thrower = async () => { throw new Error('timeout'); };
		expect((await tu.issueUploadToken(fakeDb(), 'a', { apiKey: 'K', fetchImpl: thrower })).status).toBe(502);
		const noToken = async () => ({ ok: true, status: 200, json: async () => ({ permlink: 'x' }) });
		expect((await tu.issueUploadToken(fakeDb(), 'a', { apiKey: 'K', fetchImpl: noToken })).status).toBe(502);
		const html = async () => ({ ok: false, status: 522, json: async () => { throw new Error('not json'); } });
		expect((await tu.issueUploadToken(fakeDb(), 'a', { apiKey: 'K', fetchImpl: html })).status).toBe(502);
	});

	test('missing embed_url in the reply is built from the user and permlink', async () => {
		const f = async () => ({ ok: true, status: 200, json: async () => ({ token: 't', permlink: 'zz' }) });
		const out = await tu.issueUploadToken(fakeDb(), 'carol', { apiKey: 'K', fetchImpl: f, now: () => T0 });
		expect(out.body.embed_url).toBe('https://play.3speak.tv/embed?v=carol/zz');
		expect(out.body.upload_url).toBe('https://embed.3speak.tv/uploads');
	});
});

describe('listUploads', () => {
	test('returns only that user\'s uploads, newest first', async () => {
		const db = fakeDb();
		const f = okFetch();
		await tu.issueUploadToken(db, 'alice', { apiKey: 'K', fetchImpl: f, now: () => T0 });
		await tu.issueUploadToken(db, 'bob', { apiKey: 'K', fetchImpl: f, now: () => T0 + 1 });
		await tu.issueUploadToken(db, 'alice', { apiKey: 'K', fetchImpl: f, now: () => T0 + 2 });
		const list = await tu.listUploads(db, 'alice');
		expect(list.map((r) => r.permlink)).toEqual(['p3', 'p1']);
		expect(list[0]).not.toHaveProperty('user');
	});
});
