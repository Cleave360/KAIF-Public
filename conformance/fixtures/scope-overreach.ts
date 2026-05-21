import type { ConformanceFixture, ConformanceEnv, TokenExchangeRequest } from '../types.js'
import { assertErrorBody } from './helpers.js'

// A scope that cannot appear in any real agent's permitted_scopes
const INVALID_SCOPE = 'admin:superpower:conformance-overreach-test'

export const scopeOverreach: ConformanceFixture = {
  id:          'KAIF-006',
  name:        'Scope overreach rejected',
  description: 'Requesting a scope not in the agent\'s permitted_scopes must return invalid_scope',
  section:     '§1.3',
  required:    true,

  buildRequest(env: ConformanceEnv): Promise<TokenExchangeRequest> {
    return Promise.resolve({
      grant_type:         'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token:      env.human_grant_token,
      subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      actor_token:        env.valid_svid_jwt,
      actor_token_type:   'urn:ietf:params:oauth:token-type:jwt',
      scope:              INVALID_SCOPE,
    })
  },

  async assert(response: Response, body: unknown): Promise<void> {
    if (response.status !== 400) {
      throw new Error(
        `Expected HTTP 400 for scope overreach, got ${response.status}`
      )
    }
    assertErrorBody(body, 'invalid_scope', 'KAIF-006')

    const b = body as Record<string, unknown>
    if ('access_token' in b) {
      throw new Error('Response must NOT contain access_token when scope is denied')
    }
  },
}
