import type { ConformanceFixture, ConformanceEnv, TokenExchangeRequest } from '../types.js'

// A deliberately non-existent audience — no conforming server should accept it
const INVALID_AUDIENCE = 'https://nonexistent-audience.conformance.kaif.test/v1'

export const wrongAudience: ConformanceFixture = {
  id:          'KAIF-003',
  name:        'Wrong audience rejected',
  description: 'A token exchange requesting an unpermitted audience must not return 200',
  section:     '§2.1 step 2',
  required:    true,

  buildRequest(env: ConformanceEnv): Promise<TokenExchangeRequest> {
    return Promise.resolve({
      grant_type:         'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token:      env.human_grant_token,
      subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      actor_token:        env.valid_svid_jwt,
      actor_token_type:   'urn:ietf:params:oauth:token-type:jwt',
      scope:              'invoke:completion',
      audience:           INVALID_AUDIENCE,
    })
  },

  async assert(response: Response, body: unknown): Promise<void> {
    if (response.status === 200) {
      throw new Error(
        `Server accepted an invalid audience "${INVALID_AUDIENCE}" — must NOT return 200`
      )
    }

    const b = body as Record<string, unknown>
    const allowed = ['invalid_request', 'access_denied', 'invalid_grant']
    if (!allowed.includes(String(b['error'] ?? ''))) {
      throw new Error(
        `Expected error to be one of ${allowed.join('|')}, got "${String(b['error'])}"`
      )
    }
  },
}
