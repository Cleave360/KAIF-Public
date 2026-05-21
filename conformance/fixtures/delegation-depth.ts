import type { ConformanceFixture, ConformanceEnv, TokenExchangeRequest } from '../types.js'
import { buildHappyRequest, doTokenExchange } from './helpers.js'

export const delegationDepth: ConformanceFixture = {
  id:          'KAIF-007',
  name:        'Sub-delegation/depth enforcement',
  description: 'A token issued to the test agent must not be usable for unauthorized sub-delegation',
  section:     '§1.4, §2.1',
  required:    true,

  async buildRequest(env: ConformanceEnv): Promise<TokenExchangeRequest> {
    const exchanged = await doTokenExchange(env.server_url, buildHappyRequest(env))

    return {
      grant_type:         'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token:      exchanged.access_token,
      subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      actor_token:        env.valid_svid_jwt,
      actor_token_type:   'urn:ietf:params:oauth:token-type:jwt',
      scope:              'invoke:completion',
    }
  },

  async assert(response: Response, body: unknown): Promise<void> {
    if (response.status === 200) {
      throw new Error('Server accepted unauthorized sub-delegation request')
    }

    const b = body as Record<string, unknown>
    const allowed = ['delegation_depth_exceeded', 'access_denied', 'invalid_grant']
    if (!allowed.includes(String(b['error'] ?? ''))) {
      throw new Error(
        `Expected error to be one of ${allowed.join('|')}, got "${String(b['error'])}"`
      )
    }
  },
}
