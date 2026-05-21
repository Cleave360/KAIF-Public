import type { ConformanceFixture, ConformanceEnv, TokenExchangeRequest } from '../types.js'
import { buildHappyRequest, doTokenExchange, assertErrorBody } from './helpers.js'

export const revokedJti: ConformanceFixture = {
  id:          'KAIF-004',
  name:        'Revoked JTI rejected',
  description: 'A token that has been revoked must be rejected with invalid_grant on subsequent exchange',
  section:     '§3.1',
  required:    true,

  async buildRequest(env: ConformanceEnv): Promise<TokenExchangeRequest> {
    // Step 1: Perform a valid token exchange to get a KAIF JWT
    const exchanged = await doTokenExchange(env.server_url, buildHappyRequest(env))
    const tokenToRevoke = exchanged.access_token

    // Step 2: Revoke that token
	    const revokeResp = await fetch(`${env.server_url}/revoke`, {
	      method: 'POST',
	      headers: {
	        'Content-Type':  'application/json',
	        'Authorization': `Bearer ${tokenToRevoke}`,
	      },
	      body: JSON.stringify({ token: tokenToRevoke, reason: 'kaif-conformance-004' }),
	    })
    if (!revokeResp.ok) {
      throw new Error(`POST /revoke failed with status ${revokeResp.status} — cannot complete KAIF-004`)
    }

    // Step 3: Return a new exchange request using the now-revoked token as subject_token
    return {
      grant_type:         'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token:      tokenToRevoke,
      subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      actor_token:        env.valid_svid_jwt,
      actor_token_type:   'urn:ietf:params:oauth:token-type:jwt',
      scope:              'invoke:completion',
    }
  },

  async assert(response: Response, body: unknown): Promise<void> {
    if (response.status !== 400) {
      throw new Error(
        `Expected HTTP 400 for revoked subject_token, got ${response.status}`
      )
    }
    assertErrorBody(body, 'invalid_grant', 'KAIF-004')

    // Advisory: check error_description mentions revocation
    const b = body as Record<string, unknown>
    const desc = String(b['error_description'] ?? '').toLowerCase()
    const mentionsRevocation = ['revok', 'jti', 'denylist', 'deny'].some(kw => desc.includes(kw))
    if (!mentionsRevocation) {
      // Not a hard failure — the error code is correct — but good practice
      console.warn('  [KAIF-004] advisory: error_description does not mention revocation')
    }
  },
}
