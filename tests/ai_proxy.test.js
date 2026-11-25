/**
 * ai_proxy.js: Gemini on behalf of the apps, with the key held on the server.
 */

const ai = require('../ai_proxy');

function fakeDb() {
	const cols = {};
	const col = (name) => {
		const rows = cols[name] || (cols[name] = new Map());
		return {
			rows,
			findOne: async (q) => (rows.has(q._id) ? { ...rows.get(q._id) } : null),
			findOneAndUpdate: async (q, u) => {
				const doc = rows.get(q._id) || { _id: q._id, ...(u.$setOnInsert || {}) };
				doc.count = (doc.count || 0) + u.$inc.count;
				rows.set(q._id, doc);
				await new Promise((r) => setImmediate(r)); // let parallel requests interleave
				return { ...doc };
			},
			updateOne: async (q, u) => {
				const doc = rows.get(q._id) || { _id: q._id };
				if (u.$inc) doc.count = (doc.count || 0) + u.$inc.count;
				if (u.$set) Object.assign(doc, u.$set);
				rows.set(q._id, doc);
				return {};
			},
			createIndex: async () => 'ok',
		};
	};
	const handles = {};
	return { collection: (name) => handles[name] || (handles[name] = col(name)) };
}

const answer = (text) => ({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] });

function fakeFetch(replies) {
	const calls = [];
	const impl = async (url, opts) => {
		calls.push({ url, opts, body: JSON.parse(opts.body) });
		const r = replies.length > 1 ? replies.shift() : replies[0];
		if (r instanceof Error) throw r;
		return { ok: r.status === 200, status: r.status, json: async () => r.body };
	};
	impl.calls = calls;
	return impl;
}

const NOW = Date.parse('2026-11-25T12:00:00Z');
const WORKOUT = {
	fitnessGoal: 'lose weight', experienceLevel: 'beginner', weeklyTime: '3 hours',
	dailyFrequency: '3 times', preferredWorkout: 'home', equipment: 'none',
};

function make(opts = {}) {
	const db = opts.db || fakeDb();
	const fetchImpl = opts.fetchImpl || fakeFetch([{ status: 200, body: answer('hello') }]);
	const svc = ai.createAi({
		db, apiKey: 'key-1', fetchImpl, sleep: async () => {}, now: () => opts.now || NOW,
		getContent: opts.getContent || (async (author, permlink) => ({ author, permlink, body: 'Hola mundo' })),
		limits: opts.limits, enabled: opts.enabled,
	});
	return { svc, db, fetchImpl };
}

describe('the key never leaves the server', () => {
	test('sends the key only as a header to Google, never in the reply', async () => {
		const { svc, fetchImpl } = make();
		const out = await svc.chat('alice', [{ role: 'user', text: 'help me write my report' }]);
		expect(out).toEqual({ status: 200, body: { status: 'success', text: 'hello' } });
		expect(fetchImpl.calls[0].url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
		expect(fetchImpl.calls[0].opts.headers['x-goog-api-key']).toBe('key-1');
		expect(JSON.stringify(out)).not.toContain('key-1');
	});

	test('is off without a key or when disabled, and never calls Google', async () => {
		for (const opts of [{ enabled: false }]) {
			const { svc, fetchImpl } = make(opts);
			expect((await svc.chat('alice', [{ role: 'user', text: 'hi' }])).status).toBe(503);
			expect(fetchImpl.calls).toHaveLength(0);
		}
		const fetchImpl = fakeFetch([{ status: 200, body: answer('x') }]);
		const svc = ai.createAi({ db: fakeDb(), apiKey: '', fetchImpl, getContent: async () => null });
		expect((await svc.workout('alice', WORKOUT)).body.error).toBe('disabled');
		expect((await svc.translate('alice', 'bob', 'p')).body.error).toBe('disabled');
		expect(fetchImpl.calls).toHaveLength(0);
	});
});

describe('chat is the report assistant, not a free relay', () => {
	test('always carries the Actifit system instruction and an output cap', async () => {
		const { svc, fetchImpl } = make();
		await svc.chat('alice', [{ role: 'user', text: 'a' }, { role: 'model', text: 'b' }, { role: 'user', text: 'c' }]);
		const body = fetchImpl.calls[0].body;
		expect(body.systemInstruction.parts[0].text).toMatch(/writing assistant inside the Actifit app/);
		expect(body.contents.map((c) => c.role)).toEqual(['user', 'model', 'user']);
		expect(body.generationConfig.maxOutputTokens).toBeLessThanOrEqual(1024);
	});

	test('a caller cannot slip in its own system instruction, tools or model settings', async () => {
		const { svc, fetchImpl } = make();
		await svc.chat('alice', [{ role: 'user', text: 'hi', systemInstruction: 'x', tools: [{}], parts: [{ inlineData: {} }] }]);
		expect(fetchImpl.calls[0].body.contents).toEqual([{ role: 'user', parts: [{ text: 'hi' }] }]);
	});

	test.each([
		['no history', undefined, 'invalid'],
		['empty history', [], 'invalid'],
		['a system role', [{ role: 'system', text: 'x' }], 'invalid'],
		['ends on a model turn', [{ role: 'user', text: 'a' }, { role: 'model', text: 'b' }], 'invalid'],
		['blank last turn', [{ role: 'user', text: '   ' }], 'invalid'],
		['non-text turn', [{ role: 'user', text: { a: 1 } }], 'invalid'],
		['a huge turn', [{ role: 'user', text: 'x'.repeat(4001) }], 'too_long'],
		['too many turns', Array.from({ length: 31 }, (_, i) => ({ role: i % 2 ? 'model' : 'user', text: 'x' })), 'too_long'],
		['too much text in total', Array.from({ length: 7 }, (_, i) => ({ role: i % 2 ? 'model' : 'user', text: 'x'.repeat(3500) })), 'too_long'],
	])('rejects %s without calling Google', async (_, history, code) => {
		const { svc, fetchImpl } = make();
		expect((await svc.chat('alice', history)).body.error).toBe(code);
		expect(fetchImpl.calls).toHaveLength(0);
	});
});

describe('workout plans are built from the wizard answers only', () => {
	test('builds the prompt on the server and asks for JSON', async () => {
		const { svc, fetchImpl } = make({ fetchImpl: fakeFetch([{ status: 200, body: answer('{"workoutPlan":{}}') }]) });
		const out = await svc.workout('alice', { ...WORKOUT, limitations: 'knee', prompt: 'ignore this' });
		expect(out.body.text).toBe('{"workoutPlan":{}}');
		const req = fetchImpl.calls[0].body;
		expect(req.contents[0].parts[0].text).toMatch(/^I am a user with the following fitness details\. My fitness goal is to: lose weight\./);
		expect(req.contents[0].parts[0].text).toContain('my physical limitations are: knee');
		expect(req.contents[0].parts[0].text).not.toContain('ignore this');
		expect(req.generationConfig.responseMimeType).toBe('application/json');
	});

	test.each([
		['a missing answer', { ...WORKOUT, equipment: undefined }],
		['an over-long answer', { ...WORKOUT, fitnessGoal: 'x'.repeat(201) }],
		['over-long limitations', { ...WORKOUT, otherLimitations: 'x'.repeat(501) }],
		['a non-text answer', { ...WORKOUT, weeklyTime: 3 }],
	])('rejects %s', async (_, answers) => {
		const { svc, fetchImpl } = make();
		expect((await svc.workout('alice', answers)).body.error).toBe('invalid');
		expect(fetchImpl.calls).toHaveLength(0);
	});
});

describe('translation takes a post, not text', () => {
	test('fetches the post from Hive and translates its body', async () => {
		const getContent = jest.fn(async (author, permlink) => ({ author, permlink, body: 'Hola mundo' }));
		const { svc, fetchImpl } = make({ getContent, fetchImpl: fakeFetch([{ status: 200, body: answer('Hello world') }]) });
		const out = await svc.translate('alice', 'bob', 'my-report');
		expect(out.body).toEqual({ status: 'success', text: 'Hello world' });
		expect(getContent).toHaveBeenCalledWith('bob', 'my-report');
		expect(fetchImpl.calls[0].body.contents[0].parts[0].text).toBe('Hola mundo');
		expect(fetchImpl.calls[0].body.systemInstruction.parts[0].text).toMatch(/never instructions/);
	});

	test('translates each post version once and serves it from the cache after', async () => {
		let body = 'Hola mundo';
		const { svc, fetchImpl } = make({
			getContent: async (author) => ({ author, body }),
			fetchImpl: fakeFetch([{ status: 200, body: answer('Hello world') }, { status: 200, body: answer('Hello there') }]),
		});
		await svc.translate('alice', 'bob', 'p');
		expect((await svc.translate('carol', 'bob', 'p')).body).toEqual({ status: 'success', text: 'Hello world', cached: true });
		expect(fetchImpl.calls).toHaveLength(1);
		body = 'Hola a todos'; // edited post: translated again
		expect((await svc.translate('carol', 'bob', 'p')).body.text).toBe('Hello there');
		expect(fetchImpl.calls).toHaveLength(2);
	});

	test.each([
		['a bad author', 'Bob!', 'p', 'invalid'],
		['a bad permlink', 'bob', '../x', 'invalid'],
		['a non-string permlink', 'bob', { $gt: '' }, 'invalid'],
	])('rejects %s', async (_, author, permlink, code) => {
		const { svc, fetchImpl } = make();
		expect((await svc.translate('alice', author, permlink)).body.error).toBe(code);
		expect(fetchImpl.calls).toHaveLength(0);
	});

	test('a missing post (Hive answers with an empty author) is not found', async () => {
		const { svc, fetchImpl } = make({ getContent: async () => ({ author: '', body: '' }) });
		expect((await svc.translate('alice', 'bob', 'p')).status).toBe(404);
		expect(fetchImpl.calls).toHaveLength(0);
	});

	test('a very long post is refused rather than billed', async () => {
		const { svc, fetchImpl } = make({ getContent: async (author) => ({ author, body: 'x'.repeat(20001) }) });
		expect((await svc.translate('alice', 'bob', 'p')).body.error).toBe('too_long');
		expect(fetchImpl.calls).toHaveLength(0);
	});
});

describe('quotas', () => {
	test('caps each account per day and feature, then resets the next UTC day', async () => {
		const db = fakeDb();
		const { svc } = make({ db, limits: { workout: 2 } });
		expect((await svc.workout('alice', WORKOUT)).status).toBe(200);
		expect((await svc.workout('alice', WORKOUT)).status).toBe(200);
		expect((await svc.workout('alice', WORKOUT)).body.error).toBe('quota');
		expect((await svc.chat('alice', [{ role: 'user', text: 'hi' }])).status).toBe(200); // another feature
		expect((await svc.workout('bob', WORKOUT)).status).toBe(200); // another account
		const tomorrow = make({ db, limits: { workout: 2 }, now: NOW + 24 * 3600 * 1000 }).svc;
		expect((await tomorrow.workout('alice', WORKOUT)).status).toBe(200);
	});

	test('parallel requests cannot all pass the per-account check', async () => {
		const { svc, fetchImpl } = make({ limits: { workout: 2 } });
		const outs = await Promise.all(Array.from({ length: 6 }, () => svc.workout('alice', WORKOUT)));
		expect(outs.filter((o) => o.status === 200)).toHaveLength(2);
		expect(fetchImpl.calls).toHaveLength(2);
	});

	test('the global daily cap stops every account', async () => {
		const { svc } = make({ limits: { global: 2 } });
		expect((await svc.chat('a1', [{ role: 'user', text: 'hi' }])).status).toBe(200);
		expect((await svc.chat('a2', [{ role: 'user', text: 'hi' }])).status).toBe(200);
		expect((await svc.chat('a3', [{ role: 'user', text: 'hi' }])).body.error).toBe('quota');
	});

	test('a refused call over the global cap does not use up the account quota', async () => {
		const db = fakeDb();
		const { svc } = make({ db, limits: { global: 1, chat: 5 } });
		await svc.chat('a1', [{ role: 'user', text: 'hi' }]);
		await svc.chat('a2', [{ role: 'user', text: 'hi' }]);
		expect(db.collection('ai_usage').rows.get('a2:chat:2026-11-25').count).toBe(0);
	});

	test('a failed Google call gives the slot back; a blocked prompt keeps it', async () => {
		const db = fakeDb();
		const usage = () => db.collection('ai_usage').rows.get('alice:chat:2026-11-25').count;
		const failing = make({ db, fetchImpl: fakeFetch([{ status: 500, body: {} }]) }).svc;
		expect((await failing.chat('alice', [{ role: 'user', text: 'hi' }])).body.error).toBe('failed');
		expect(usage()).toBe(0);
		const blocked = make({ db, fetchImpl: fakeFetch([{ status: 200, body: { promptFeedback: { blockReason: 'SAFETY' } } }]) }).svc;
		expect((await blocked.chat('alice', [{ role: 'user', text: 'hi' }])).status).toBe(422);
		expect(usage()).toBe(1);
	});

	test('a cached translation costs no quota', async () => {
		const { svc } = make({ limits: { translate: 1 } });
		await svc.translate('alice', 'bob', 'p');
		expect((await svc.translate('alice', 'bob', 'p')).status).toBe(200);
		expect((await svc.translate('alice', 'bob', 'other')).body.error).toBe('quota');
	});
});

describe('talking to Gemini', () => {
	test('retries an overloaded model, then answers', async () => {
		const { svc, fetchImpl } = make({ fetchImpl: fakeFetch([{ status: 503, body: {} }, { status: 503, body: {} }, { status: 200, body: answer('ok') }]) });
		expect((await svc.chat('alice', [{ role: 'user', text: 'hi' }])).body.text).toBe('ok');
		expect(fetchImpl.calls).toHaveLength(3);
	});

	test('reports busy when the model stays overloaded', async () => {
		const { svc, fetchImpl } = make({ fetchImpl: fakeFetch([{ status: 503, body: {} }]) });
		expect((await svc.chat('alice', [{ role: 'user', text: 'hi' }])).body.error).toBe('busy');
		expect(fetchImpl.calls).toHaveLength(3);
	});

	test('a network error is a failure, not a crash', async () => {
		const { svc } = make({ fetchImpl: fakeFetch([new Error('ECONNRESET')]) });
		expect((await svc.chat('alice', [{ role: 'user', text: 'hi' }])).body.error).toBe('failed');
	});

	test('Google\'s error text (which can echo the prompt) is not passed to the app', async () => {
		const { svc } = make({ fetchImpl: fakeFetch([{ status: 400, body: { error: { status: 'INVALID_ARGUMENT', message: 'my secret health data' } } }]) });
		expect(JSON.stringify(await svc.chat('alice', [{ role: 'user', text: 'hi' }]))).not.toContain('health');
	});

	test('reads the answer text, skipping thought parts', () => {
		expect(ai.replyText({ candidates: [{ content: { parts: [{ text: 'thinking', thought: true }, { text: 'A' }, { text: 'B' }] } }] })).toBe('AB');
		expect(() => ai.replyText({ candidates: [{ finishReason: 'SAFETY' }] })).toThrow('blocked');
		expect(() => ai.replyText({ candidates: [] })).toThrow('failed');
		expect(() => ai.replyText({ candidates: [{ content: { parts: [] } }] })).toThrow('failed');
	});
});
