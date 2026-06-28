import { randomUUID } from 'crypto'
import type { Redis } from 'ioredis'
import type {
  TokenExchangeRequest,
  TokenExchangeResponse,
  KAIFTokenClaims,
  ParsedSVID,
} from '../types/kaif.js'
import { KAIFError } from '../errors.js'
import { verifyJWT, signKAIFToken } from '../crypto/jwt.js'
import { isRevoked } from './revocation.js'
import { getTrustScore, resolveTier, assertTierMinimum } from './trust-score.js'
import { getAgentACL, validateScopes } from './acl.js'
import { validateSpiffeID } from './svid.js'
import { appendAudit } from './audit.js'
import { loadConfig } from '../config.js'
import { validateSVID } from './svid.js'

type JWTPayload = Record<string, unknown>

function secondsToDuration(seconds: number): string {
  // Convert seconds to ISO 8601 duration, e.g. 600 → "PT10M"
  if (seconds < 60) return `PT${seconds}S`
  const minutes = Math.floor(seconds / 60)
  const rem = seconds % 60
  return rem > 0 ? `PT${minutes}M${rem}S` : `PT${minutes}M`
}

function isKAIFToken(payload: JWTPayload): boolean {
  return typeof payload['kaif'] === 'object' && payload['kaif'] !== null
}

function extractObject(payload: JWTPayload, claim: string): Record<string, unknown> | null {
  const value = payload[claim]
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null
}

function extractActorSub(payload: JWTPayload): string | null {
  const actor = extractObject(payload, 'actor')
  return typeof actor?.['sub'] === 'string' ? actor['sub'] : null
}

function extractMayActSub(payload: JWTPayload): string | null {
  const mayAct = extractObject(payload, 'may_act')
  return typeof mayAct?.['sub'] === 'string' ? mayAct['sub'] : null
}

function extractDelegationDepth(payload: JWTPayload): number {
  const kaif = extractObject(payload, 'kaif')
  const depth = kaif?.['delegation_depth']
  return typeof depth === 'number' ? depth : 0
}

function isProvisionedDelegationGrant(payload: JWTPayload): boolean {
  const actor = extractObject(payload, 'actor')
  return isKAIFToken(payload) && actor?.['svid_thumbprint'] === 'pending'
}

function extractPrincipalChain(payload: JWTPayload): string[] {
  if (isKAIFToken(payload)) {
    const kaif = payload['kaif'] as Record<string, unknown>
    if (Array.isArray(kaif['principal_chain'])) {
      return kaif['principal_chain'] as string[]
    }
  }
  return []
}

function extractHumanPrincipal(payload: JWTPayload): string {
  if (typeof payload['sub'] === 'string') return payload['sub']
  throw new KAIFError('invalid_grant', 'subject_token missing sub claim')
}

function extractGrantedScopes(payload: JWTPayload): string[] {
  const scopeStr = typeof payload['scope'] === 'string' ? payload['scope'] : ''
  if (!scopeStr) return []
  return scopeStr.split(' ').filter(Boolean)
}

function extractDefaultAudience(payload: JWTPayload, fallback: string): string {
  if (typeof payload['aud'] === 'string') return payload['aud']
  if (Array.isArray(payload['aud']) && typeof payload['aud'][0] === 'string') {
    return payload['aud'][0]
  }
  return fallback
}

export async function executeTokenExchange(params: {
  redis:        Redis
  request:      TokenExchangeRequest
  client_cert?: Buffer
}): Promise<TokenExchangeResponse> {
  const { redis, request } = params
  const config = loadConfig()

  // ── Step 1: Validate subject_token ─────────────────────────────

  let subjectPayload: JWTPayload
  try {
    subjectPayload = await verifyJWT(request.subject_token) as JWTPayload
  } catch (err) {
    // Try IdP JWKS path (Phase 3 enhancement — for now treat as invalid)
    throw new KAIFError('invalid_grant', 'subject_token is invalid or expired')
  }

  const subjectJti = typeof subjectPayload['jti'] === 'string' ? subjectPayload['jti'] : null

  if (subjectJti && await isRevoked(redis, subjectJti)) {
    throw new KAIFError('invalid_grant', 'subject_token has been revoked')
  }

  // ── Step 2: Validate actor_token (JWT-SVID) ────────────────────

  let svid: ParsedSVID
  try {
    svid = await validateSVID(request.actor_token)
  } catch {
    throw new KAIFError('invalid_client', 'actor_token (SVID) is invalid or expired')
  }

  if (!validateSpiffeID(svid.spiffe_id)) {
    throw new KAIFError('invalid_client', 'actor_token contains invalid SPIFFE ID')
  }

  const agentACL = getAgentACL(svid.spiffe_id)
  if (!agentACL) {
    throw new KAIFError('access_denied', `Agent ${svid.spiffe_id} is not registered in ACL`)
  }

  // ── Step 3: Parse and validate requested scopes ────────────────

  const requestedScopes = request.scope
    ? request.scope.split(' ').filter(Boolean)
    : []

  if (requestedScopes.length === 0) {
    throw new KAIFError('invalid_scope', 'scope is required')
  }

  // Check against ACL
  const aclCheck = validateScopes(requestedScopes, agentACL.permitted_scopes)
  if (!aclCheck.valid) {
    throw new KAIFError(
      'invalid_scope',
      `Scopes not permitted by ACL: ${aclCheck.denied.join(', ')}`
    )
  }

  // Check against subject token grant
  const grantedScopes = extractGrantedScopes(subjectPayload)
  if (grantedScopes.length === 0) {
    throw new KAIFError('invalid_grant', 'subject_token missing granted scope')
  }

  const grantCheck = validateScopes(requestedScopes, grantedScopes)
  if (!grantCheck.valid) {
    throw new KAIFError(
      'invalid_scope',
      `Scopes not included in subject token grant: ${grantCheck.denied.join(', ')}`
    )
  }

  // ── Step 3b: Bind the grant to the SPIRE-attested actor ───────────

  const subjectActorSub = extractActorSub(subjectPayload)
  const subjectMayActSub = extractMayActSub(subjectPayload)
  const allowedActor = subjectMayActSub ?? subjectActorSub
  if (!allowedActor) {
    throw new KAIFError('invalid_grant', 'subject_token missing actor or may_act claim')
  }

  if (allowedActor !== svid.spiffe_id) {
    throw new KAIFError(
      'access_denied',
      `subject_token may_act ${allowedActor} does not match actor_token ${svid.spiffe_id}`
    )
  }

  const provisionedGrant = isProvisionedDelegationGrant(subjectPayload)
  if (isKAIFToken(subjectPayload) && !provisionedGrant) {
    if (!subjectActorSub) {
      throw new KAIFError('invalid_grant', 'subject_token missing actor.sub claim')
    }

    const parentACL = getAgentACL(subjectActorSub)
    if (!parentACL) {
      throw new KAIFError('access_denied', `Parent actor ${subjectActorSub} is not registered in ACL`)
    }

    if (!parentACL.may_sub_delegate) {
      throw new KAIFError('access_denied', `Parent actor ${subjectActorSub} may not sub-delegate`)
    }

    if (parentACL.human_principal_required && extractPrincipalChain(subjectPayload).length === 0) {
      throw new KAIFError('invalid_grant', 'subject_token missing required human principal chain')
    }
  }

  // ── Step 4: Trust score check ──────────────────────────────────

  const authorizationTierSignal = await getTrustScore(redis, svid.spiffe_id)
  const tierConfig = resolveTier(authorizationTierSignal.score)
  assertTierMinimum(authorizationTierSignal.score, agentACL.trust_tier_minimum)

  // ── Step 5: Compute delegation depth ──────────────────────────

  const parentDepth = isKAIFToken(subjectPayload) ? extractDelegationDepth(subjectPayload) : 0
  const delegationDepth = provisionedGrant ? parentDepth : parentDepth + 1

  // Validate depth is integer >= 0 (Security Rule 10)
  if (!Number.isInteger(delegationDepth) || delegationDepth < 0) {
    throw new KAIFError('invalid_request', 'delegation_depth must be an integer >= 0')
  }

  const maxDelegationDepth = Math.min(agentACL.max_delegation_depth, tierConfig.maxDepth)
  if (delegationDepth > maxDelegationDepth) {
    throw new KAIFError(
      'delegation_depth_exceeded',
      `Delegation depth ${delegationDepth} exceeds agent maximum of ${maxDelegationDepth}`
    )
  }

  // ── Step 6: RFC 8705 thumbprint (if client cert provided) ──────

  // client_cert binding reserved for Phase 3 (mTLS route); skip if absent

  // ── Step 7: Resolve TTL from trust tier ────────────────────────

  const ttl = Math.min(tierConfig.tokenTTL, agentACL.delegation_ttl_seconds)
  const now = Math.floor(Date.now() / 1000)
  const exp = now + ttl

  // ── Step 8: Mint KAIF JWT ──────────────────────────────────────

  const humanPrincipal = extractHumanPrincipal(subjectPayload)
  const parentChain = extractPrincipalChain(subjectPayload)
  const principalChain = parentChain.includes(humanPrincipal)
    ? parentChain
    : [...parentChain, humanPrincipal]

  const jti = randomUUID()
  if (request.audience && !config.allowed_audiences.includes(request.audience)) {
    throw new KAIFError('access_denied', `audience is not permitted: ${request.audience}`)
  }

  const audience = request.audience ?? extractDefaultAudience(subjectPayload, config.issuer)

  const claims: KAIFTokenClaims = {
    iss:   config.issuer,
    sub:   humanPrincipal,
    aud:   audience,
    iat:   now,
    exp,
    jti,
    scope: requestedScopes.join(' '),
    actor: {
      sub:             svid.spiffe_id,
      svid_thumbprint: svid.thumbprint,
    },
    cnf: { jkt: svid.thumbprint },
    may_act: { sub: svid.spiffe_id },
    kaif: {
    trust_score:      authorizationTierSignal.score,
      trust_tier:       tierConfig.tier,
      delegation_depth: delegationDepth,
      delegation_id:    randomUUID(),
      rollback_window:  secondsToDuration(ttl),
      principal_chain:  principalChain,
    },
  }

  const accessToken = await signKAIFToken(claims)

  // ── Step 9: Write audit entry ──────────────────────────────────

  await appendAudit(redis, {
    action:   'TOKEN_ISSUED',
    detail:   `jti=${jti} agent=${svid.spiffe_id} scope=${claims.scope} depth=${delegationDepth}`,
    agent_id: svid.spiffe_id,
    human_id: humanPrincipal,
  })

  // ── Step 10: Return response ───────────────────────────────────

  return {
    access_token:      accessToken,
    issued_token_type: 'urn:ietf:params:oauth:token-type:access_token',
    token_type:        'Bearer',
    expires_in:        ttl,
    scope:             claims.scope,
  }
}
