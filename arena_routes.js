/**
 * Challenge Engine — Express READ routes (Trello #180, §8). Thin HTTP wrappers
 * over arena_api.js, mounted from app.js. Kept separate so they can be tested on
 * a bare Express app without loading the config/Firebase-bound server.
 *
 * `getDb` is a callback returning the current Mongo handle (app.js sets `db`
 * asynchronously after connect), so routes resolve it per-request.
 *
 * Reads are public and sanitized in arena_api; `includeNonPublic` is NEVER
 * forwarded from the query string, so private challenges don't leak.
 *
 * Load-time safe: requires only ./arena_api, ./arena_write (config/Firebase-free)
 * and express (a library).
 */

'use strict';

const express = require('express');
const arenaApi = require('./arena_api');
const arenaWrite = require('./arena_write');

function intOr(v, dflt) {
	return (v !== undefined && v !== '' && !Number.isNaN(Number(v))) ? parseInt(v, 10) : dflt;
}

function registerArenaRoutes(app, getDb, opts = {}) {
	const log = typeof opts.log === 'function' ? opts.log : () => {};
	const fail = (res, name, err) => { log(err, 'api'); res.status(500).send({ error: name }); };
	// Optional rate-limit middleware for these public, unauthenticated reads.
	const mw = typeof opts.limiter === 'function' ? [opts.limiter] : [];

	app.get('/arena/challenges', ...mw, async (req, res) => {
		try {
			const { type, state, community, origin_tier, entity } = req.query;
			res.send(await arenaApi.listChallenges(getDb(), { type, state, community, origin_tier, entity }));
		} catch (err) { fail(res, 'arena_challenges', err); }
	});

	app.get('/arena/challenges/:id', ...mw, async (req, res) => {
		try {
			const c = await arenaApi.getChallenge(getDb(), req.params.id);
			if (!c) return res.status(404).send({ error: 'not found' });
			res.send(c);
		} catch (err) { fail(res, 'arena_challenge', err); }
	});

	app.get('/arena/standings', ...mw, async (req, res) => {
		try {
			const { id, scope, cohort } = req.query;
			res.send(await arenaApi.getStandings(getDb(), { id, scope, cohort }));
		} catch (err) { fail(res, 'arena_standings', err); }
	});

	app.get('/arena/merits/:user', ...mw, async (req, res) => {
		try {
			res.send(await arenaApi.getMerits(getDb(), req.params.user, { limit: intOr(req.query.limit) }));
		} catch (err) { fail(res, 'arena_merits', err); }
	});

	app.get('/arena/shop', ...mw, async (req, res) => {
		try {
			res.send(await arenaApi.getShop(getDb(), { inStockOnly: req.query.inStockOnly === 'true' }));
		} catch (err) { fail(res, 'arena_shop', err); }
	});

	app.get('/arena/pools/:id', ...mw, async (req, res) => {
		try {
			const p = await arenaApi.getPool(getDb(), req.params.id);
			if (!p) return res.status(404).send({ error: 'not found' });
			res.send(p);
		} catch (err) { fail(res, 'arena_pool', err); }
	});

	app.get('/arena/events/:user', ...mw, async (req, res) => {
		try {
			res.send(await arenaApi.listEvents(getDb(), req.params.user, { limit: intOr(req.query.limit) }));
		} catch (err) { fail(res, 'arena_events', err); }
	});

	// WRITE (prepare/validate). Chain-first: this validates a PROPOSED op + gates
	// it by the caller's tier; the CLIENT broadcasts the returned op (signed by
	// their key). callerTier is derived server-side via opts.resolveTier (never
	// trusted from the request); defaults to the safe 'friendly' floor.
	const json = express.json({ limit: '16kb' }); // op bodies are tiny
	// Convert a body-parser error (malformed JSON / too large) into the clean
	// {error} envelope instead of Express's default stack-leaking handler.
	const jsonErr = (err, req, res, next) => (err ? res.status(400).send({ error: 'invalid request body' }) : next());
	app.post('/arena/ops/validate', ...mw, json, jsonErr, async (req, res) => {
		try {
			const op = req.body && req.body.op;
			const callerTier = typeof opts.resolveTier === 'function' ? await opts.resolveTier(req) : 'friendly';
			res.send(arenaWrite.validateProposedOp(op, { callerTier }));
		} catch (err) { fail(res, 'arena_validate', err); }
	});
}

module.exports = { registerArenaRoutes };
