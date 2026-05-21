export type TrustTier = 'PROVISIONAL' | 'STANDARD' | 'VERIFIED' | 'TRUSTED'

export const VALID_TRUST_TIERS: readonly TrustTier[] = [
  'PROVISIONAL', 'STANDARD', 'VERIFIED', 'TRUSTED',
]

export interface ConformanceEnv {
  server_url:        string  // base URL, no trailing slash
  valid_svid_jwt:    string  // a valid JWT-SVID for the test agent
  human_grant_token: string  // a valid human delegation grant token
  test_agent_id:     string  // SPIFFE ID of the test agent
}

export interface TokenExchangeRequest {
  grant_type:         'urn:ietf:params:oauth:grant-type:token-exchange'
  subject_token:      string
  subject_token_type: 'urn:ietf:params:oauth:token-type:access_token'
  actor_token:        string
  actor_token_type:   'urn:ietf:params:oauth:token-type:jwt'
  scope?:             string
  audience?:          string
  resource?:          string
}

export type FixtureOutcome = 'pass' | 'fail' | 'warn' | 'skip'

export interface FixtureRun {
  id:         string
  name:       string
  required:   boolean
  result:     FixtureOutcome
  elapsed_ms: number
  error:      string | null
  advisory?:  string
}

export interface ConformanceFixture {
  id:          string
  name:        string
  description: string
  section:     string
  required:    boolean

  // Build the request to send to POST /oauth/token
  buildRequest(env: ConformanceEnv): Promise<TokenExchangeRequest>

  // Assert the response is correct — throw with message if not
  assert(response: Response, body: unknown, env?: ConformanceEnv): Promise<void>

  // Optional override for fixtures that test non-/oauth/token endpoints
  execute?(env: ConformanceEnv): Promise<{ outcome: 'pass' | 'warn'; advisory?: string }>
}

export interface SuiteResult {
  suite:      string
  target:     string
  timestamp:  string
  elapsed_ms: number
  result:     'PASS' | 'FAIL'
  summary: {
    pass: number
    fail: number
    warn: number
    skip: number
  }
  fixtures: Array<{
    id:         string
    name:       string
    result:     'PASS' | 'FAIL' | 'WARN' | 'SKIP'
    elapsed_ms: number
    error:      string | null
  }>
}
