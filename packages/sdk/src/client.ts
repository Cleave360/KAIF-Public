import { readFileSync } from 'fs'
import { TokenCache } from './token-cache.js'

export interface KAIFClientConfig {
  server_url:       string   // e.g. http://kaif-server:8080
  spiffe_id:        string   // this agent's SPIFFE ID
  svid_path?:       string   // supported production mode today: SPIRE-managed JWT-SVID file path
  // Signed KAIF JWT returned by POST /provision as delegation_token.
  // This is the subject_token for RFC 8693 token exchange.
  // Passed from human principal to agent out-of-band after provisioning.
  delegation_token: string
}

const GRANT_TYPE   = 'urn:ietf:params:oauth:grant-type:token-exchange'
const SUBJECT_TYPE = 'urn:ietf:params:oauth:token-type:access_token'
const ACTOR_TYPE   = 'urn:ietf:params:oauth:token-type:jwt'

export class KAIFClient {
  private readonly config: KAIFClientConfig
  private readonly cache:  TokenCache

  constructor(config: KAIFClientConfig) {
    this.config = config
    this.cache  = new TokenCache()
  }

  // Returns a cached token if valid (>60s to expiry), or exchanges for a new one.
  async getToken(scope: string, audience: string): Promise<string> {
    const cacheKey = `${scope}:${audience}`
    const cached = this.cache.get(cacheKey)
    if (cached) return cached
    return this.refreshToken(scope, audience)
  }

  // Forces a fresh token exchange, bypassing the cache.
  async refreshToken(scope: string, audience: string): Promise<string> {
    const cacheKey = `${scope}:${audience}`
    const svid = this.readSVID()

    const body = new URLSearchParams({
      grant_type:         GRANT_TYPE,
      subject_token:      this.config.delegation_token,
      subject_token_type: SUBJECT_TYPE,
      actor_token:        svid,
      actor_token_type:   ACTOR_TYPE,
      scope,
      audience,
    })

    const res = await fetch(`${this.config.server_url}/oauth/token`, {
      method:  'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body:    body.toString(),
    })

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({
        error:             'server_error',
        error_description: res.statusText,
      })) as { error: string; error_description: string }
      throw new Error(
        `KAIF token exchange failed [HTTP ${res.status}]: ${errBody.error} — ${errBody.error_description}`
      )
    }

    const response = await res.json() as {
      access_token: string
      expires_in:   number
      scope:        string
    }

    const exp = Math.floor(Date.now() / 1000) + response.expires_in
    this.cache.set(cacheKey, response.access_token, exp, response.scope)

    return response.access_token
  }

  // Returns the Authorization header value: "Bearer <token>".
  async authHeader(scope: string, audience: string): Promise<string> {
    return `Bearer ${await this.getToken(scope, audience)}`
  }

  // Revokes all cached tokens and clears the cache.
  // Revocation failures are swallowed — the cache is always cleared.
  async revoke(): Promise<void> {
    const revocations: Promise<void>[] = []

    for (const [, entry] of this.cache.entries()) {
      const token = entry.access_token
      revocations.push(
        fetch(`${this.config.server_url}/revoke`, {
          method:  'POST',
          headers: {
            'content-type':  'application/json',
            'authorization': `Bearer ${token}`,
          },
          body: JSON.stringify({ token, reason: 'client_shutdown' }),
        }).then(() => { /* ignore response body */ }).catch(() => { /* swallow errors */ })
      )
    }

    await Promise.allSettled(revocations)
    this.cache.clear()
  }

  // Reads the JWT-SVID from svid_path. SPIRE rotates these — always re-read per exchange.
  // Direct Workload API socket retrieval is not implemented in this SDK yet.
  private readSVID(): string {
    if (!this.config.svid_path) {
      throw new Error(
        'KAIFClient: svid_path is required to read the JWT-SVID for token exchange'
      )
    }
    return readFileSync(this.config.svid_path, 'utf8').trim()
  }
}
