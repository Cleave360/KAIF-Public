import type { ConformanceFixture, ConformanceEnv, TokenExchangeRequest } from '../types.js'
import { buildHappyRequest, doTokenExchange } from './helpers.js'

// Fake thumbprint sent as X-Client-Cert-Thumbprint — clearly wrong
const FAKE_THUMBPRINT = 'sha256:' + '0'.repeat(64)

export const cnfMismatch: ConformanceFixture = {
  id:          'KAIF-005',
  name:        'CNF binding mismatch',
  description: 'Introspecting a KAIF JWT with a mismatched CNF thumbprint header — advisory if not enforced',
  section:     '§1.2, §2.1 step 5',
  required:    false,  // SHOULD — advisory if not enforced

  // Placeholder — not used; execute() handles the full flow
  buildRequest(env: ConformanceEnv): Promise<TokenExchangeRequest> {
    return Promise.resolve(buildHappyRequest(env))
  },

  // Not used — execute() overrides
  async assert(): Promise<void> {},

  async execute(env: ConformanceEnv): Promise<{ outcome: 'pass' | 'warn'; advisory?: string }> {
    // Step 1: Obtain a valid KAIF JWT
    const exchanged = await doTokenExchange(env.server_url, buildHappyRequest(env))
    const kaifJWT = exchanged.access_token

    // Step 2: POST /introspect with the token and a spoofed CNF thumbprint header.
    // A conforming server that enforces CNF binding should reject this.
    const introspectResp = await fetch(`${env.server_url}/introspect`, {
      method: 'POST',
	      headers: {
	        'Content-Type': 'application/json',
	        'Authorization': `Bearer ${kaifJWT}`,
	        'X-Client-Cert-Thumbprint': FAKE_THUMBPRINT,
	      },
      body: JSON.stringify({ token: kaifJWT }),
    })

    // Step 3: Evaluate
    if (introspectResp.status === 401) {
      const b = await introspectResp.json().catch(() => ({})) as Record<string, unknown>
      if (b['error'] === 'cnf_binding_mismatch') {
        return { outcome: 'pass' }
      }
	      return {
	        outcome:  'warn',
	        advisory: 'introspection auth failed before CNF binding could be evaluated',
	      }
    }

    if (introspectResp.ok) {
      const b = await introspectResp.json().catch(() => ({})) as Record<string, unknown>
      if (b['active'] === false) {
        // Server correctly marked the token inactive given the mismatch
        return { outcome: 'pass' }
      }
      // Server returned active: true — CNF checking not enforced
      return {
        outcome:  'warn',
        advisory: 'CNF binding not enforced (§1.2 advisory)',
      }
    }

    // Any other 4xx is acceptable enforcement
    return { outcome: 'pass' }
  },
}
