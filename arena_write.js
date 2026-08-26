/**
 * Challenge Engine — F6 write helpers (Trello #180, §8 / §7.4).
 *
 * The engine is CHAIN-FIRST: clients broadcast `actifit_arena` custom_json ops
 * signed by the user's own Hive key (Keychain/HiveAuth), and the tailer (F1)
 * indexes them. So the backend's write surface is a PREPARE/VALIDATE helper — it
 * builds a well-formed op body and validates it (shape + I1/I6 via F1, plus the
 * §7.4 origin-tier gate) BEFORE the client spends a signature broadcasting it. It
 * does NOT broadcast (that's the signed client) and does NOT write the index
 * (that's the tailer).
 *
 * Tier gate (§7.4): a caller may only create challenges up to their tier —
 *   friendly  → friendly only; NO AFIT pool / afit rewards (badge/Merit only).
 *   community → friendly or community; may attach a pool.
 *   official  → any tier (the @actifit account).
 * The caller's tier MUST be derived server-side (from getRank/role), never taken
 * from the client — see the route wiring.
 *
 * Load-time safe: requires only ./arena (config/Firebase-free).
 */

'use strict';

const arena = require('./arena');

const KNOWN_TIERS = ['friendly', 'community', 'official'];
// Which origin_tiers a caller of the given tier may create.
const TIER_MAY_CREATE = {
	friendly: ['friendly'],
	community: ['friendly', 'community'],
	official: ['friendly', 'community', 'official'],
};
// A friendly-tier challenge is badge/Merit only — these are the ONLY reward keys
// it may carry (whitelist; anything else, incl. hive/hbd/afit, is rejected).
const FRIENDLY_REWARD_KEYS = ['merits', 'badges'];
// Ops only the @actifit official account may sign (per the F1 ingest checks).
const OFFICIAL_ONLY_OPS = ['enroll', 'settle'];

function buildJoinOp(challengeId) {
	return { op: 'join', v: 1, challenge_id: challengeId };
}
function buildLeaveOp(challengeId) {
	return { op: 'leave', v: 1, challenge_id: challengeId };
}
function buildCreateOp(p = {}) {
	return {
		op: 'challenge_create', v: 1,
		id: p.id, type: p.type,
		origin_tier: p.origin_tier || 'friendly',
		title: p.title || null,
		visibility: p.visibility || 'public',
		community: p.community || null,
		window: p.window,
		entry: p.entry || { mode: 'free' },
		scoring: p.scoring,
		rewards: p.rewards || null,
		pool_ref: p.pool_ref || null,
	};
}

/**
 * Validate a PROPOSED arena op against the F1 schema (I1/I6) and the §7.4 tier
 * gate for the caller. Returns { ok, errors, op } — the op body ready for the
 * client to broadcast when ok.
 * @param {object} op          the proposed op body
 * @param {object} [opts]      { callerTier = 'friendly' } — SERVER-derived
 */
function validateProposedOp(op, opts = {}) {
	// Normalize an unknown/misconfigured tier down to the safe floor (never MORE
	// permissive than friendly).
	let callerTier = opts.callerTier || 'friendly';
	if (!KNOWN_TIERS.includes(callerTier)) callerTier = 'friendly';

	const { valid, errors } = arena.validateArenaOp(op);
	const errs = valid ? [] : errors.slice();
	if (!op || typeof op !== 'object') return { ok: errs.length === 0, errors: errs, op };

	// Official-only ops: a non-official caller who broadcasts these is silently
	// rejected at ingest — the validate endpoint must say so up front, not mislead.
	if (OFFICIAL_ONLY_OPS.includes(op.op) && callerTier !== 'official') {
		errs.push(`op "${op.op}" is official-only (caller tier "${callerTier}")`);
	}
	// A state update INTO a terminal state is official/settle-only.
	if (op.op === 'challenge_update' && (op.state === 'settled' || op.state === 'archived') && callerTier !== 'official') {
		errs.push(`challenge_update to "${op.state}" is official-only`);
	}

	if (op.op === 'challenge_create') {
		const wanted = op.origin_tier || 'friendly';
		const allowed = TIER_MAY_CREATE[callerTier] || TIER_MAY_CREATE.friendly;
		if (!allowed.includes(wanted)) {
			errs.push(`caller tier "${callerTier}" may not create an "${wanted}" challenge (§7.4)`);
		}
		// A FRIENDLY-tier challenge is badge/Merit only — keyed on the CHALLENGE's
		// tier (not the caller), and a whitelist so no other value reward slips in.
		if (wanted === 'friendly') {
			if (op.pool_ref) errs.push('friendly-tier challenges may not attach a pool (§7.4)');
			const extra = (op.rewards && typeof op.rewards === 'object') ? Object.keys(op.rewards).filter((k) => !FRIENDLY_REWARD_KEYS.includes(k)) : [];
			if (extra.length) errs.push(`friendly-tier challenges may only reward ${FRIENDLY_REWARD_KEYS.join('/')}, not "${extra.join(', ')}" (§7.4)`);
		}
	}
	return { ok: errs.length === 0, errors: errs, op };
}

module.exports = {
	TIER_MAY_CREATE,
	buildJoinOp,
	buildLeaveOp,
	buildCreateOp,
	validateProposedOp,
};
