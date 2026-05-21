import type { ConformanceFixture, ConformanceEnv, TokenExchangeRequest } from '../types.js'
import { VALID_TRUST_TIERS } from '../types.js'
import { buildHappyRequest, decodeJWTPayload } from './helpers.js'

export const happyPath: ConformanceFixture = {
  id:          'KAIF-001',
  name:        'Happy path token exchange',
  description: 'Valid subject_token + valid actor_token + valid scope returns a well-formed KAIF JWT',
  section:     '§1.1, §1.2',
  required:    true,

  buildRequest(env: ConformanceEnv): Promise<TokenExchangeRequest> {
    return Promise.resolve(buildHappyRequest(env))
  },

  async assert(response: Response, body: unknown, env?: ConformanceEnv): Promise<void> {
    if (!response.ok) {
      const b = body as Record<string, unknown>
      throw new Error(`Expected 200, got ${response.status}: ${String(b['error'] ?? 'unknown')}`)
    }

    const b = body as Record<string, unknown>

    if (typeof b['access_token'] !== 'string' || b['access_token'].length === 0) {
      throw new Error('access_token is absent or empty')
    }
    if (b['token_type'] !== 'Bearer') {
      throw new Error(`token_type must be "Bearer", got "${String(b['token_type'])}"`)
    }
    const expiresIn = b['expires_in']
    if (typeof expiresIn !== 'number' || expiresIn <= 0) {
      throw new Error(`expires_in must be a positive number, got ${String(expiresIn)}`)
    }
    if (typeof b['scope'] !== 'string' || b['scope'].length === 0) {
      throw new Error('scope is absent or empty in response')
    }

    // Decode the KAIF JWT and inspect claims
    const claims = decodeJWTPayload(b['access_token'] as string)

    const actor = claims['actor'] as Record<string, unknown> | undefined
    if (!actor || actor['sub'] !== env?.test_agent_id) {
      throw new Error(
        `actor.sub must equal test agent "${env?.test_agent_id}", got "${String(actor?.['sub'])}"`
      )
    }

    const kaif = claims['kaif'] as Record<string, unknown> | undefined
    if (!kaif) {
      throw new Error('KAIF JWT missing "kaif" extension claim')
    }

    const depth = kaif['delegation_depth']
    if (depth !== 0) {
      throw new Error(`kaif.delegation_depth must be 0 for direct human grants, got ${String(depth)}`)
    }

    const tier = kaif['trust_tier']
    if (!VALID_TRUST_TIERS.includes(tier as never)) {
      throw new Error(
        `kaif.trust_tier "${String(tier)}" is not a valid tier — expected one of ${VALID_TRUST_TIERS.join(', ')}`
      )
    }
  },
}
