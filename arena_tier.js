/**
 * Challenge Engine — tier policy + server-side tier derivation (Trello #180, §7.4).
 *
 * ONE source of truth for the origin-tier permission gate, shared by:
 *   - arena_write.validateProposedOp  — the ADVISORY prepare/validate endpoint.
 *   - arena.indexArenaOp              — the AUTHORITATIVE ingest gate (the tailer).
 *
 * The advisory endpoint is unauthenticated, so it can only ever *predict* the
 * outcome; the real gate is at ingest, keyed on the cryptographic SIGNER of the
 * custom_json (which the chain guarantees). Both call the SAME pure
 * `createTierErrors(op, callerTier)` so a "valid" prediction and a "would index"
 * decision can never drift.
 *
 * Tier model (§7.4):
 *   friendly  → any authenticated user. Badge/Merit rewards only; NO AFIT pool.
 *   community → verified / community leaders (an active moderator, or a caller a
 *               host-supplied predicate deems community). May attach a pool.
 *   official  → the @actifit account (+ any configured official-role accounts).
 *
 * Load-time safe: requires nothing (no config/Firebase/DB). The DB/rank/role
 * lookups are injected as async hooks by app.js, so this module stays pure and
 * unit-testable — and any hook that throws fails SAFE (down to a lower tier).
 */

'use strict';

const KNOWN_TIERS = ['friendly', 'community', 'official'];

// Which origin_tiers a caller of the given tier may create (§7.4).
const TIER_MAY_CREATE = {
	friendly: ['friendly'],
	community: ['friendly', 'community'],
	official: ['friendly', 'community', 'official'],
};

// A friendly-tier challenge is badge/Merit only — the ONLY reward keys it may
// carry (whitelist; hive/hbd/afit and anything else are rejected).
const FRIENDLY_REWARD_KEYS = ['merits', 'badges'];

// Ops only the @actifit official account may sign (per the F1 ingest checks).
const OFFICIAL_ONLY_OPS = ['enroll', 'settle'];

/** Normalize an unknown/misconfigured tier down to the safe 'friendly' floor. */
function normalizeTier(tier) {
	return KNOWN_TIERS.includes(tier) ? tier : 'friendly';
}

/**
 * The tier-gate errors for a proposed/observed op, given the CALLER's tier.
 * Pure — no schema validation here (the caller runs validateArenaOp separately);
 * this is only the §7.4 origin-tier / official-only / friendly-reward gate.
 * @returns {string[]} empty when the caller's tier permits the op.
 */
function createTierErrors(op, callerTier) {
	const errs = [];
	if (!op || typeof op !== 'object') return errs;
	const tier = normalizeTier(callerTier);

	// Official-only ops: a non-official caller who broadcasts these is silently
	// rejected at ingest — say so up front rather than mislead.
	if (OFFICIAL_ONLY_OPS.includes(op.op) && tier !== 'official') {
		errs.push(`op "${op.op}" is official-only (caller tier "${tier}")`);
	}
	// A state update INTO a terminal state is official/settle-only.
	if (op.op === 'challenge_update' && (op.state === 'settled' || op.state === 'archived') && tier !== 'official') {
		errs.push(`challenge_update to "${op.state}" is official-only`);
	}

	if (op.op === 'challenge_create') {
		const wanted = op.origin_tier || 'friendly';
		const allowed = TIER_MAY_CREATE[tier] || TIER_MAY_CREATE.friendly;
		if (!allowed.includes(wanted)) {
			errs.push(`caller tier "${tier}" may not create an "${wanted}" challenge (§7.4)`);
		}
		// A FRIENDLY-tier challenge is badge/Merit only — keyed on the CHALLENGE's
		// tier (not the caller), and a whitelist so no other value reward slips in.
		if (wanted === 'friendly') {
			if (op.pool_ref) errs.push('friendly-tier challenges may not attach a pool (§7.4)');
			const extra = (op.rewards && typeof op.rewards === 'object')
				? Object.keys(op.rewards).filter((k) => !FRIENDLY_REWARD_KEYS.includes(k))
				: [];
			if (extra.length) errs.push(`friendly-tier challenges may only reward ${FRIENDLY_REWARD_KEYS.join('/')}, not "${extra.join(', ')}" (§7.4)`);
		}
	}
	return errs;
}

/**
 * Derive a Hive account's arena tier, SERVER-SIDE. Never trust a client-supplied
 * tier — resolve it from who the account actually is.
 *
 * @param {string} username
 * @param {object} [opts]
 *   officialAccount    {string}   the @actifit account (default 'actifit')
 *   officialAccounts   {string[]} extra official-role accounts (admins)
 *   isCommunity        {(u)=>Promise<bool>|bool}  host predicate — e.g. isModerator
 *                      (or moderator OR rank>=threshold). Absent → skipped.
 * @returns {Promise<'friendly'|'community'|'official'>}
 */
async function resolveTier(username, opts = {}) {
	if (!username || typeof username !== 'string') return 'friendly';
	const official = opts.officialAccount || 'actifit';
	if (username === official) return 'official';
	if (Array.isArray(opts.officialAccounts) && opts.officialAccounts.includes(username)) return 'official';

	if (typeof opts.isCommunity === 'function') {
		try {
			if (await opts.isCommunity(username)) return 'community';
		} catch (e) {
			// Fail safe: a rank/role lookup error must never UPGRADE a caller.
		}
	}
	return 'friendly';
}

module.exports = {
	KNOWN_TIERS,
	TIER_MAY_CREATE,
	FRIENDLY_REWARD_KEYS,
	OFFICIAL_ONLY_OPS,
	normalizeTier,
	createTierErrors,
	resolveTier,
};
