import type { ConformanceFixture, ConformanceEnv, TokenExchangeRequest } from '../types.js'
import { makeExpiredSubjectToken, assertErrorBody } from './helpers.js'

export const expiredToken: ConformanceFixture = {
  id:          'KAIF-002',
  name:        'Expired subject_token rejected',
  description: 'A subject_token with exp in the past must be rejected with invalid_grant',
  section:     '§2.1 step 3',
  required:    true,

  buildRequest(env: ConformanceEnv): Promise<TokenExchangeRequest> {
    return Promise.resolve({
      grant_type:         'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token:      makeExpiredSubjectToken(),
      subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      actor_token:        env.valid_svid_jwt,
      actor_token_type:   'urn:ietf:params:oauth:token-type:jwt',
      scope:              'invoke:completion',
    })
  },

  async assert(response: Response, body: unknown): Promise<void> {
    if (response.status !== 400) {
      throw new Error(
        `Expected HTTP 400 for expired subject_token, got ${response.status}`
      )
    }
    assertErrorBody(body, 'invalid_grant', 'KAIF-002')
  },
}
