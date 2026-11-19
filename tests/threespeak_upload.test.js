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
				upload_url: 'https://embed2.3speak.tv/uploads',
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
			token: 'tok-1', upload_url: 'https://embed2.3speak.tv/uploads', permlink: 'p1',
			embed_url: 'https://play.3speak.tv/embed?v=alice/p1', expires_at: '2026-11-19T12:10:00.000Z',
		});
		expect(calls[0].url).toBe('https://embed2.3speak.tv/uploads/token');
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
		expect(out.body.upload_url).toBe('https://embed2.3speak.tv/uploads');
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

describe('linkPendingUploads', () => {
	function linkDb(rows) {
		return {
			rows,
			collection: () => ({
				find: (q) => {
					let out = rows.filter((r) => r.permlink !== undefined && r.linked === undefined && r.created >= q.created.$gte);
					const cur = {
						sort: () => { out = out.slice().sort((a, b) => b.created - a.created); return cur; },
						limit: (n) => { out = out.slice(0, n); return cur; },
						toArray: async () => out,
					};
					return cur;
				},
				updateOne: async (q, u) => { Object.assign(rows.find((r) => r._id === q._id), u.$set); return {}; },
			}),
		};
	}
	const post = (author, permlink) => ({
		author, permlink, title: 'My run', body: 'https://play.3speak.tv/embed?v=' + author + '/' + permlink,
		json_metadata: JSON.stringify({ tags: ['hive-193552', 'actifit', 7] }),
	});
	const empty = { author: '', permlink: '' }; // condenser get_content for a missing post
	const linkFetch = (calls, status = 200) => async (url, opts) => {
		calls.push({ url, opts });
		return { ok: status < 300, status, json: async () => (status < 300 ? { success: true } : { error: 'nope' }) };
	};

	test('links an upload once its report post is on chain, and only once', async () => {
		const db = linkDb([
			{ _id: 1, user: 'alice', permlink: 'p1', created: new Date(T0 - 60000) },
			{ _id: 2, user: 'bob', permlink: 'p2', created: new Date(T0 - 60000) }, // not posted yet
		]);
		const calls = [];
		const getContent = async (a, p) => (a === 'alice' ? post(a, p) : empty);
		const out = await tu.linkPendingUploads(db, { apiKey: 'sk_k', getContent, fetchImpl: linkFetch(calls), now: () => T0 });
		expect(out).toEqual({ checked: 2, linked: 1, failed: 0 });
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe('https://embed2.3speak.tv/video/p1/hive');
		expect(calls[0].opts.headers['X-API-Key']).toBe('sk_k');
		const body = JSON.parse(calls[0].opts.body);
		expect(body).toMatchObject({ hive_author: 'alice', hive_permlink: 'p1', hive_title: 'My run', hive_tags: ['hive-193552', 'actifit'] });
		expect(db.rows[0].linked).toBeInstanceOf(Date);
		expect(db.rows[1].linked).toBeUndefined();

		const again = await tu.linkPendingUploads(db, { apiKey: 'sk_k', getContent, fetchImpl: linkFetch(calls), now: () => T0 });
		expect(again.linked).toBe(0);
		expect(calls).toHaveLength(1);
	});

	test('a 3Speak failure leaves the upload unlinked so the next run retries it', async () => {
		const db = linkDb([{ _id: 1, user: 'alice', permlink: 'p1', created: new Date(T0) }]);
		const calls = [];
		const out = await tu.linkPendingUploads(db, { apiKey: 'sk_k', getContent: async (a, p) => post(a, p), fetchImpl: linkFetch(calls, 503), now: () => T0 });
		expect(out).toEqual({ checked: 1, linked: 0, failed: 1 });
		expect(db.rows[0].linked).toBeUndefined();
	});

	test('a Hive read error is counted and does not stop the other uploads', async () => {
		const db = linkDb([
			{ _id: 1, user: 'alice', permlink: 'p1', created: new Date(T0) },
			{ _id: 2, user: 'bob', permlink: 'p2', created: new Date(T0 - 1000) },
		]);
		const calls = [];
		const getContent = async (a, p) => { if (a === 'alice') throw new Error('node down'); return post(a, p); };
		const out = await tu.linkPendingUploads(db, { apiKey: 'sk_k', getContent, fetchImpl: linkFetch(calls), now: () => T0 });
		expect(out).toEqual({ checked: 2, linked: 1, failed: 1 });
		expect(db.rows[1].linked).toBeInstanceOf(Date);
	});

	test('never links someone else\'s post, old uploads, or without a key', async () => {
		const db = linkDb([
			{ _id: 1, user: 'alice', permlink: 'p1', created: new Date(T0) },
			{ _id: 2, user: 'carol', permlink: 'p3', created: new Date(T0 - 4 * 24 * 3600 * 1000) }, // past the window
		]);
		const calls = [];
		const seen = [];
		const getContent = async (a, p) => { seen.push(a); return post('mallory', p); };
		const out = await tu.linkPendingUploads(db, { apiKey: 'sk_k', getContent, fetchImpl: linkFetch(calls), now: () => T0 });
		expect(out.linked).toBe(0);
		expect(seen).toEqual(['alice']);
		expect(calls).toHaveLength(0);
		const none = await tu.linkPendingUploads(db, { getContent, fetchImpl: linkFetch(calls), now: () => T0 });
		expect(none).toEqual({ checked: 0, linked: 0, failed: 0 });
	});
});
