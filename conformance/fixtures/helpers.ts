import { createSign, generateKeyPairSync } from 'crypto'
import type { TokenExchangeRequest, ConformanceEnv } from '../types.js'

// ── URL-encoded form body ─────────────────────────────────────────

export function toFormBody(req: Record<string, string | undefined>): string {
  return Object.entries(req)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&')
}

// ── JWT payload decoder (no signature verification) ───────────────

export function decodeJWTPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split('.')
  if (parts.length !== 3) throw new Error(`Invalid JWT: expected 3 parts, got ${parts.length}`)
  const raw = Buffer.from(parts[1]!, 'base64url').toString('utf-8')
  return JSON.parse(raw) as Record<string, unknown>
}

// ── Standard happy-path token exchange ───────────────────────────

export function buildHappyRequest(env: ConformanceEnv, scope = 'invoke:completion'): TokenExchangeRequest {
  return {
    grant_type:         'urn:ietf:params:oauth:grant-type:token-exchange',
    subject_token:      env.human_grant_token,
    subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
    actor_token:        env.valid_svid_jwt,
    actor_token_type:   'urn:ietf:params:oauth:token-type:jwt',
    scope,
  }
}

// Execute a token exchange and return the parsed response body.
// Throws if the exchange fails.
export async function doTokenExchange(
  serverUrl: string,
  req: TokenExchangeRequest
): Promise<{ access_token: string; expires_in: number; scope: string }> {
  const resp = await fetch(`${serverUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: toFormBody(req as unknown as Record<string, string | undefined>),
  })
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({})) as Record<string, unknown>
    throw new Error(
      `Token exchange failed ${resp.status}: ${body['error'] ?? 'unknown'} — ${body['error_description'] ?? ''}`
    )
  }
  return resp.json() as Promise<{ access_token: string; expires_in: number; scope: string }>
}

// ── Self-signed expired JWT (for KAIF-002) ────────────────────────
// Uses a fresh ephemeral RSA key — the server MUST reject this
// either for bad signature or for expiry.

function base64url(data: Buffer): string {
  return data.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

export function makeExpiredSubjectToken(): string {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })

  const now = Math.floor(Date.now() / 1000)
  const header = JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'conformance-expired-key' })
  const payload = JSON.stringify({
    iss: 'https://conformance.kaif.test/idp',
    sub: 'conformance-test@kaif.test',
    aud: 'kaif-conformance-test',
    iat: now - 120,
    exp: now - 60,   // explicitly expired
    jti: `conf-002-${now}`,
  })

  const h = base64url(Buffer.from(header))
  const p = base64url(Buffer.from(payload))
  const signing_input = `${h}.${p}`

  const sig = createSign('sha256').update(signing_input).sign(privateKey)
  return `${signing_input}.${base64url(sig)}`
}

// ── Error body assertion helpers ──────────────────────────────────

export function assertErrorBody(
  body: unknown,
  expectedError: string,
  context: string
): void {
  const b = body as Record<string, unknown>
  if (b['error'] !== expectedError) {
    throw new Error(
      `${context}: expected error="${expectedError}", got "${String(b['error'])}"`
    )
  }
  const desc = b['error_description']
  if (typeof desc !== 'string' || desc.trim().length === 0) {
    throw new Error(`${context}: error_description is absent or empty`)
  }
}
