/**
 * Challenge Engine — F1 foundation (Trello #175, epic #171).
 *
 * On-chain-of-record layer for "The Arena". Challenge definitions, participation
 * and settled results are broadcast as `actifit_arena` custom_json ops on Hive;
 * this module is the authority that *interprets* those ops and materialises them
 * into the MongoDB index the API reads from. See the web repo spec
 * `tasks/challenge-engine-spec.md` §3.1–3.3, §3.9–3.10 for the full contract.
 *
 * Scope of F1 (this file):
 *   - the `actifit_arena` op schema + names          (§3.10)
 *   - op validation incl. the compliance invariants checkable at ingest (I1, I6)
 *   - the challenge lifecycle state machine           (§3.1)
 *   - `indexArenaOp` — apply ONE op to the index (the core of the chain-tailer)
 *   - `ensureArenaIndexes` — collection indexes
 *
 * Deliberately NOT in F1: the block-stream loop that feeds `indexArenaOp`
 * (reuses the existing custom_json streaming in app.js), verification/anti-cheat
 * (F2, #176), aggregation (F3), Merits (F4), pools/payout + HTTP API (F5/F6).
 *
 * Design notes:
 *   - Dependency-injected: every function takes `db` (and options). This module
 *     requires no config/Firebase at load time, so it is unit-testable in
 *     isolation (mirrors the `delegations.__setTestDb` pattern).
 *   - Chain is the source of truth: the signer of the op is authoritative. A
 *     `join` counts for whoever SIGNED it, never a self-asserted `entity` field.
 *   - Idempotent: natural keys (`challenges.id`, participant `challenge_id+entity`)
 *     make re-applying the same op a no-op, so a re-tailed block is safe.
 */

'use strict';

// ---- on-chain op namespace + names (§3.10) -------------------------------

const ARENA_JSON_ID = 'actifit_arena';

const OPS = {
	CHALLENGE_CREATE: 'challenge_create',
	CHALLENGE_UPDATE: 'challenge_update',
	JOIN: 'join',
	ENROLL: 'enroll',
	LEAVE: 'leave',
	SETTLE: 'settle',
};
const OP_NAMES = Object.values(OPS);

const COLLECTIONS = {
	CHALLENGES: 'challenges',
	PARTICIPANTS: 'challenge_participants',
};

// ---- enumerations (the schema contract) ----------------------------------

const CHALLENGE_TYPES = [
	'duel', 'league_fixture', 'daily_focus', 'squad_goal', 'brawl',
	'liveops', 'content_contest',
];
const ORIGIN_TIERS = ['friendly', 'community', 'official'];
const ENTITY_KINDS = ['user', 'squad'];
const VISIBILITIES = ['public', 'community', 'private'];

// I1 — entry is never a fee (no `fee` here, by construction).
const ENTRY_MODES = ['free', 'activity_gated'];
// The only sub-keys an activity-gate may carry (keeps monetary fields out — I1).
const GATE_ALLOWED_KEYS = ['min_activity'];
// I6 — outcomes are decided by verified effort/goal, never chance.
const SCORING_RULES = ['max', 'threshold', 'head_to_head'];

// Highest `op.v` (§3.10) this build understands; newer major versions are rejected.
const SUPPORTED_OP_VERSION = 1;

// ---- lifecycle state machine (§3.1) --------------------------------------

const STATES = [
	'draft', 'open', 'active', 'resolving', 'settled', 'archived', 'cancelled',
];

const TRANSITIONS = {
	draft: ['open', 'cancelled'],
	open: ['active', 'cancelled'],
	active: ['resolving', 'cancelled'],
	resolving: ['settled', 'cancelled'],
	settled: ['archived'],
	archived: [],
	cancelled: [],
};

/** True if `from → to` is a permitted challenge state transition. */
function canTransition(from, to) {
	if (from === to) return false;
	return Array.isArray(TRANSITIONS[from]) && TRANSITIONS[from].includes(to);
}

// ---- helpers -------------------------------------------------------------

// Terminal states — no op (not even settle) may move a challenge out of these.
const TERMINAL_STATES = ['settled', 'archived', 'cancelled'];

// Monetary keys that must never ride on an entry (house rule: no fee/stake/wager
// — invariant I1). Rejected at validation AND stripped by the stored-doc whitelist.
const FORBIDDEN_ENTRY_KEYS = ['fee', 'entry_fee', 'stake', 'buy_in', 'buyin', 'wager', 'ante', 'pot'];

function isNonEmptyString(v) {
	return typeof v === 'string' && v.length > 0;
}

/** Shallow-pick only the allowed keys from an object (drops unknown fields). */
function pick(obj, keys) {
	const out = {};
	if (obj && typeof obj === 'object') {
		for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
	}
	return out;
}

/**
 * Build the stored `entry` sub-doc, whitelisting BOTH the entry and its nested
 * `gate` so no monetary field (even one buried in gate) reaches the index (I1).
 */
function buildEntry(entry) {
	const out = { mode: 'free', ...pick(entry, ['mode']) };
	if (entry && typeof entry.gate === 'object' && entry.gate !== null) {
		out.gate = pick(entry.gate, GATE_ALLOWED_KEYS);
	}
	return out;
}

/** True for a MongoDB duplicate-key (unique index) error. */
function isDuplicateKeyError(e) {
	return !!e && (e.code === 11000 || e.code === 11001 || /E11000/.test(String(e && e.message)));
}

function isValidWindow(w) {
	if (!w || typeof w !== 'object') return false;
	const start = Date.parse(w.start);
	const end = Date.parse(w.end);
	if (Number.isNaN(start) || Number.isNaN(end)) return false;
	return start < end;
}

/** The account that authorised an op — its posting (or active) signer. */
function opSigner(chainOp) {
	if (!chainOp || typeof chainOp !== 'object') return null;
	const posting = Array.isArray(chainOp.required_posting_auths) ? chainOp.required_posting_auths : [];
	const active = Array.isArray(chainOp.required_auths) ? chainOp.required_auths : [];
	return posting[0] || active[0] || null;
}

/** Parse the custom_json payload (string or already-parsed object). */
function parseArenaJson(chainOp) {
	if (!chainOp || chainOp.id !== ARENA_JSON_ID) return null;
	let payload = chainOp.json;
	if (typeof payload === 'string') {
		try { payload = JSON.parse(payload); } catch (e) { return null; }
	}
	return (payload && typeof payload === 'object') ? payload : null;
}

// ---- op validation (§3.10 + invariants I1, I6) ---------------------------

/**
 * Validate a parsed `actifit_arena` op body against the schema and the
 * compliance invariants that are checkable at ingest time.
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateArenaOp(op) {
	const errors = [];
	if (!op || typeof op !== 'object') {
		return { valid: false, errors: ['op must be an object'] };
	}
	if (!OP_NAMES.includes(op.op)) {
		return { valid: false, errors: [`unknown op "${op.op}"`] };
	}
	// §3.10/§12.9 — every op carries a version; reject a newer major we can't parse.
	if (op.v !== undefined) {
		if (!Number.isInteger(op.v) || op.v < 1) errors.push(`invalid op version "${op.v}"`);
		else if (op.v > SUPPORTED_OP_VERSION) errors.push(`unsupported op version ${op.v} (max ${SUPPORTED_OP_VERSION})`);
	}

	switch (op.op) {
		case OPS.CHALLENGE_CREATE: {
			if (!isNonEmptyString(op.id)) errors.push('challenge_create: missing id');
			if (!CHALLENGE_TYPES.includes(op.type)) errors.push(`challenge_create: invalid type "${op.type}"`);
			if (op.origin_tier !== undefined && !ORIGIN_TIERS.includes(op.origin_tier)) {
				errors.push(`challenge_create: invalid origin_tier "${op.origin_tier}"`);
			}
			if (op.participants_kind !== undefined && !ENTITY_KINDS.includes(op.participants_kind)) {
				errors.push(`challenge_create: invalid participants_kind "${op.participants_kind}"`);
			}
			if (op.visibility !== undefined && !VISIBILITIES.includes(op.visibility)) {
				errors.push(`challenge_create: invalid visibility "${op.visibility}"`);
			}
			if (!isValidWindow(op.window)) errors.push('challenge_create: invalid window (need start<end ISO)');

			const entry = op.entry || {};
			// I1 — entry is skill/goal, never a fee.
			if (entry.mode !== undefined && !ENTRY_MODES.includes(entry.mode)) {
				errors.push(`challenge_create: entry.mode "${entry.mode}" not allowed (no fee entry — invariant I1)`);
			}
			// I1 — reject any monetary field smuggled onto the entry OR its nested gate,
			// even when mode is valid.
			const monetary = [
				...Object.keys(entry),
				...(entry.gate && typeof entry.gate === 'object' ? Object.keys(entry.gate) : []),
			].filter((k) => FORBIDDEN_ENTRY_KEYS.includes(k));
			if (monetary.length) {
				errors.push(`challenge_create: entry may not carry monetary field(s) "${[...new Set(monetary)].join(', ')}" (no fee/stake/wager — invariant I1)`);
			}
			const scoring = op.scoring || {};
			if (!isNonEmptyString(scoring.metric)) errors.push('challenge_create: missing scoring.metric');
			// I6 — outcome decided by verified effort/goal, never chance.
			if (!SCORING_RULES.includes(scoring.rule)) {
				errors.push(`challenge_create: scoring.rule "${scoring.rule}" not allowed (invariant I6)`);
			}
			break;
		}
		case OPS.CHALLENGE_UPDATE: {
			if (!isNonEmptyString(op.id)) errors.push('challenge_update: missing id');
			if (!STATES.includes(op.state)) errors.push(`challenge_update: invalid state "${op.state}"`);
			break;
		}
		case OPS.JOIN:
		case OPS.LEAVE: {
			if (!isNonEmptyString(op.challenge_id)) errors.push(`${op.op}: missing challenge_id`);
			break;
		}
		case OPS.ENROLL: {
			if (!isNonEmptyString(op.challenge_id)) errors.push('enroll: missing challenge_id');
			if (!Array.isArray(op.entities) || op.entities.length === 0) errors.push('enroll: entities must be a non-empty array');
			break;
		}
		case OPS.SETTLE: {
			if (!isNonEmptyString(op.challenge_id)) errors.push('settle: missing challenge_id');
			if (!Array.isArray(op.standings)) errors.push('settle: standings must be an array');
			if (!Array.isArray(op.rewards)) errors.push('settle: rewards must be an array');
			break;
		}
		default:
			errors.push(`unhandled op "${op.op}"`);
	}

	return { valid: errors.length === 0, errors };
}

// ---- the indexer: apply ONE op to the DB index ---------------------------

/**
 * Apply a single `actifit_arena` custom_json op to the MongoDB index.
 *
 * @param {object} db        MongoDB handle (native driver, dependency-injected).
 * @param {object} chainOp   The custom_json op as seen on chain:
 *                           { id, json, required_posting_auths, required_auths,
 *                             trx_id, block_num, timestamp }.
 * @param {object} [opts]    { officialAccount = 'actifit' } — the account allowed
 *                           to sign official/system ops (enroll, settle, official
 *                           challenge creation, state updates).
 * @returns {Promise<{ ok: boolean, action?: string, reason?: string, noop?: boolean, count?: number }>}
 *          `ok:true` with `noop:true` is a benign idempotent replay. A
 *          non-conforming op is NOT written (ok:false) — the invariants gate
 *          what "counts" even though anyone can post a raw custom_json.
 */
async function indexArenaOp(db, chainOp, opts = {}) {
	const officialAccount = opts.officialAccount || 'actifit';

	const op = parseArenaJson(chainOp);
	if (!op) return { ok: false, reason: 'not an actifit_arena op / unparseable json' };

	const { valid, errors } = validateArenaOp(op);
	if (!valid) return { ok: false, reason: `invalid op: ${errors.join('; ')}` };

	const signer = opSigner(chainOp);
	if (!signer) return { ok: false, reason: 'no signer on op' };

	const trx_id = chainOp.trx_id || null;
	const block_num = chainOp.block_num || null;
	const at = chainOp.timestamp || null;

	// The trx_id is the idempotency key; refuse an op that lacks one rather than
	// let a null key collapse the replay checks below (two distinct null-trx ops
	// on the same natural key would look like a replay).
	if (!trx_id) return { ok: false, reason: 'op has no trx_id' };

	const challenges = db.collection(COLLECTIONS.CHALLENGES);
	const participants = db.collection(COLLECTIONS.PARTICIPANTS);

	switch (op.op) {
		case OPS.CHALLENGE_CREATE: {
			const origin_tier = op.origin_tier || 'friendly';
			// Official challenges must be signed by the official account.
			if (origin_tier === 'official' && signer !== officialAccount) {
				return { ok: false, reason: 'official challenge must be signed by the official account' };
			}
			const existing = await challenges.findOne({ id: op.id });
			if (existing) {
				// Idempotent: the same broadcast re-tailed is a no-op success; a
				// DIFFERENT op reusing the id is a genuine collision -> reject.
				if (existing.source && existing.source.trx_id === trx_id) {
					return { ok: true, action: 'challenge_created', noop: true };
				}
				return { ok: false, reason: 'challenge id already exists' };
			}

			const doc = {
				id: op.id,
				v: op.v || 1,
				type: op.type,
				title: op.title || null,
				state: 'open',
				origin_tier,
				visibility: op.visibility || 'public',
				community: op.community || null,
				participants_kind: op.participants_kind || 'user',
				// Only whitelisted sub-fields are stored — an attacker's extra keys
				// (e.g. a smuggled entry.fee, incl. one nested under entry.gate)
				// never reach the on-chain-of-record index.
				window: pick(op.window, ['start', 'end', 'tz']),
				entry: buildEntry(op.entry),
				scoring: pick(op.scoring, ['metric', 'rule', 'threshold']),
				rewards: op.rewards || null,
				pool_ref: op.pool_ref || null,
				parent_id: op.parent_id || null,
				created_by: signer,
				source: { trx_id, block_num },
				audit: { created_at: at },
			};
			try {
				await challenges.insertOne(doc);
			} catch (e) {
				// Unique-index race (a concurrent tailer pass beat us): treat as no-op.
				if (isDuplicateKeyError(e)) return { ok: true, action: 'challenge_created', noop: true };
				throw e;
			}
			return { ok: true, action: 'challenge_created' };
		}

		case OPS.CHALLENGE_UPDATE: {
			const ch = await challenges.findOne({ id: op.id });
			if (!ch) return { ok: false, reason: 'unknown challenge' };
			// Only the creator or the official account may drive state.
			if (signer !== ch.created_by && signer !== officialAccount) {
				return { ok: false, reason: 'not authorised to update challenge' };
			}
			// Idempotent: a replayed update landing on the current state is a no-op,
			// not an "illegal self-transition".
			if (ch.state === op.state) {
				return { ok: true, action: 'challenge_updated', noop: true };
			}
			// Terminal states are authoritative: `settled` is reached ONLY via the
			// official settle op, and only the official account may archive. This stops
			// a (Friendly-tier) creator from self-settling and pre-empting official
			// settlement.
			if (op.state === 'settled') {
				return { ok: false, reason: 'settled is reached only via the settle op' };
			}
			if (op.state === 'archived' && signer !== officialAccount) {
				return { ok: false, reason: 'only the official account may archive a challenge' };
			}
			if (!canTransition(ch.state, op.state)) {
				return { ok: false, reason: `illegal transition ${ch.state} -> ${op.state}` };
			}
			await challenges.updateOne({ id: op.id }, { $set: { state: op.state } });
			return { ok: true, action: 'challenge_updated' };
		}

		case OPS.JOIN: {
			const ch = await challenges.findOne({ id: op.challenge_id });
			if (!ch) return { ok: false, reason: 'unknown challenge' };
			if (!['open', 'active'].includes(ch.state)) {
				return { ok: false, reason: `challenge not joinable in state ${ch.state}` };
			}
			// The participant is whoever SIGNED the join — never a self-asserted name.
			const entity = signer;
			const already = await participants.findOne({ challenge_id: op.challenge_id, entity });
			if (already) {
				// Same broadcast re-tailed -> no-op success; a distinct re-join -> reject.
				if (already.source && already.source.trx_id === trx_id) {
					return { ok: true, action: 'joined', noop: true };
				}
				return { ok: false, reason: 'already joined' };
			}

			try {
				await participants.insertOne({
					challenge_id: op.challenge_id,
					entity_kind: ch.participants_kind || 'user',
					entity,
					cohort: op.cohort || null,
					score: null,
					state: 'enrolled',
					result: null,
					flags: [],
					source: { trx_id, block_num },
					joined_at: at,
				});
			} catch (e) {
				if (isDuplicateKeyError(e)) return { ok: true, action: 'joined', noop: true };
				throw e;
			}
			return { ok: true, action: 'joined' };
		}

		case OPS.ENROLL: {
			// System (auto) enrolment — official account only.
			if (signer !== officialAccount) {
				return { ok: false, reason: 'enroll must be signed by the official account' };
			}
			const ch = await challenges.findOne({ id: op.challenge_id });
			if (!ch) return { ok: false, reason: 'unknown challenge' };

			let enrolled = 0;
			for (const entity of op.entities) {
				if (!isNonEmptyString(entity)) continue;
				const already = await participants.findOne({ challenge_id: op.challenge_id, entity });
				if (already) continue;
				await participants.insertOne({
					challenge_id: op.challenge_id,
					entity_kind: ch.participants_kind || 'user',
					entity,
					cohort: op.cohort || null,
					score: null,
					state: 'enrolled',
					result: null,
					flags: [],
					source: { trx_id, block_num },
					joined_at: at,
				});
				enrolled++;
			}
			return { ok: true, action: 'enrolled', count: enrolled };
		}

		case OPS.LEAVE: {
			const p = await participants.findOne({ challenge_id: op.challenge_id, entity: signer });
			if (!p) return { ok: false, reason: 'not a participant' };
			await participants.updateOne(
				{ challenge_id: op.challenge_id, entity: signer },
				{ $set: { state: 'left' } }
			);
			return { ok: true, action: 'left' };
		}

		case OPS.SETTLE: {
			// Settlement is authoritative + official-signed only.
			if (signer !== officialAccount) {
				return { ok: false, reason: 'settle must be signed by the official account' };
			}
			const ch = await challenges.findOne({ id: op.challenge_id });
			if (!ch) return { ok: false, reason: 'unknown challenge' };
			// Idempotent: the same settle broadcast re-tailed is a no-op success.
			if (ch.source && ch.source.settle_trx_id === trx_id) {
				return { ok: true, action: 'settled', noop: true };
			}
			// A challenge can only be settled from a LIVE state — never resurrected
			// from a terminal state (cancelled / settled / archived).
			if (TERMINAL_STATES.includes(ch.state)) {
				return { ok: false, reason: `cannot settle a ${ch.state} challenge` };
			}

			// Record each participant's final rank/outcome + reward reference.
			for (const row of op.standings) {
				if (!row || !isNonEmptyString(row.entity)) continue;
				const reward = (op.rewards || []).find((r) => r && r.entity === row.entity) || null;
				await participants.updateOne(
					{ challenge_id: op.challenge_id, entity: row.entity },
					{ $set: {
						state: 'settled',
						result: {
							rank: row.rank != null ? row.rank : null,
							score_verified: row.score_verified != null ? row.score_verified : null,
							reward: reward ? {
								afit: reward.afit || 0,
								merits: reward.merits || 0,
								badges: reward.badges || [],
								he_tx: reward.he_tx || null,
							} : null,
						},
					} }
				);
			}
			// Whole-object $set (not dotted paths) so `audit`/`source` nest correctly
			// and the settle_trx_id replay-guard above is readable back.
			await challenges.updateOne(
				{ id: op.challenge_id },
				{ $set: {
					state: 'settled',
					audit: { ...(ch.audit || {}), settled_at: at },
					source: { ...(ch.source || {}), settle_trx_id: trx_id },
				} }
			);
			return { ok: true, action: 'settled' };
		}

		default:
			return { ok: false, reason: `unhandled op "${op.op}"` };
	}
}

// ---- index setup ---------------------------------------------------------

/**
 * Ensure the MongoDB indexes the engine relies on. Safe no-op where the driver
 * exposes no `createIndex` (e.g. the in-memory test mock).
 */
async function ensureArenaIndexes(db) {
	const challenges = db.collection(COLLECTIONS.CHALLENGES);
	const participants = db.collection(COLLECTIONS.PARTICIPANTS);
	if (typeof challenges.createIndex === 'function') {
		await challenges.createIndex({ id: 1 }, { unique: true });
		await challenges.createIndex({ state: 1, type: 1 });
		await challenges.createIndex({ community: 1 });
	}
	if (typeof participants.createIndex === 'function') {
		await participants.createIndex({ challenge_id: 1, entity: 1 }, { unique: true });
		await participants.createIndex({ entity: 1 });
	}
}

module.exports = {
	ARENA_JSON_ID,
	OPS,
	OP_NAMES,
	COLLECTIONS,
	CHALLENGE_TYPES,
	ORIGIN_TIERS,
	ENTITY_KINDS,
	ENTRY_MODES,
	SCORING_RULES,
	STATES,
	TRANSITIONS,
	canTransition,
	opSigner,
	parseArenaJson,
	validateArenaOp,
	indexArenaOp,
	ensureArenaIndexes,
};
