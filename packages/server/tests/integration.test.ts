/**
 * KAIF end-to-end integration test.
 * Runs the full auth flow in a single process: real Fastify via buildServer(),
 * real crypto, MockRedis. No network — SPIRE and IdP JWKS are injected.
 *
 * Each step depends on the previous; run sequentially via describe ordering.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import {
  generateKeyPair,
  exportJWK,
  SignJWT,
  jwtVerify,
  importJWK,
  createLocalJWKSet,
} from 'jose'
import type { JWK, KeyLike } from 'jose'
import type { FastifyInstance } from 'fastify'
import { MockRedis } from './mock-redis.js'
import { buildServer } from '../src/server.js'
import {
  signKAIFToken,
  _setSpireJWKS, _setRawSpireKeys, _resetSpireJWKSCache,
  _setIdpJWKS, _resetIdpJWKSCache,
} from '../src/crypto/jwt.js'
import { _setSpireBundleFetcher, _resetSpireBundleFetcher } from '../src/crypto/spire-bundle.js'
import { _resetKeyCache, getPublicJWK } from '../src/crypto/keys.js'
import { updateTrustScore } from '../src/services/trust-score.js'
import { verifyChain } from '../src/services/audit.js'
import type { KAIFTokenClaims, AuditEntry } from '../src/types/kaif.js'

// ── Constants ──────────────────────────────────────────────────────────────

const AGENTS_CONFIG = new URL('../config/agents.yaml', import.meta.url).pathname
const LYRA_SPIFFE   = 'spiffe://example.org/ns/adaptive-layer/agent/lyra'
const HUMAN         = 'kindred@kindredsystems.ai'
const GRANT_TYPE    = 'urn:ietf:params:oauth:grant-type:token-exchange'
const SUBJECT_TYPE  = 'urn:ietf:params:oauth:token-type:access_token'
const ACTOR_TYPE    = 'urn:ietf:params:oauth:token-type:jwt'

// ── Shared state — populated by beforeAll, read by steps ──────────────────

let app:           FastifyInstance
let redis:         MockRedis
let spirePrivKey:  KeyLike
let spireJWK:      JWK & { kid: string }
let idpPrivKey:    KeyLike
let subjectToken:  string   // KAIF-signed delegation grant token
let actorToken:    string   // SVID for lyra
let accessToken:   string   // from /oauth/token Step 3
let auditToken:    string   // audit:read token for protected endpoint checks
let accessTokenJti: string
let jwksKid:       string

function setEnv(): void {
  process.env['KAIF_ISSUER']                = 'https://auth.integration.test'
  process.env['KAIF_REDIS_URL']             = 'redis://localhost:6379'
  process.env['KAIF_SPIRE_BUNDLE_ENDPOINT'] = 'https://spire.integration.test:8081/'
  process.env['KAIF_SPIRE_TRUST_DOMAIN']    = 'kindred.systems'
  process.env['KAIF_IDP_JWKS_URL']          = 'https://idp.integration.test/.well-known/jwks.json'
  process.env['KAIF_IDP_ISSUER']            = 'https://idp.integration.test'
  process.env['KAIF_AGENTS_CONFIG_PATH']    = AGENTS_CONFIG
  process.env['KAIF_STRICT_REVOCATION']     = 'false'
  process.env['KAIF_LOG_LEVEL']             = 'silent'
  delete process.env['KAIF_PRIVATE_KEY_PATH']
}

// ── Setup ──────────────────────────────────────────────────────────────────

beforeAll(async () => {
  setEnv()

  _setSpireBundleFetcher(async () => ({ keys: [spireJWK] }))

  // Generate SPIRE keypair
  const spirePair = await generateKeyPair('RS256', { modulusLength: 2048 })
  spirePrivKey = spirePair.privateKey as KeyLike
  const spireRaw = await exportJWK(spirePair.publicKey)
  spireJWK = { ...spireRaw, kid: 'spire-integ', alg: 'RS256' }

  // Generate IdP keypair
  const idpPair = await generateKeyPair('RS256', { modulusLength: 2048 })
  idpPrivKey = idpPair.privateKey as KeyLike
  const idpRaw = await exportJWK(idpPair.publicKey)
  const idpJWK: JWK & { kid: string } = { ...idpRaw, kid: 'idp-integ', alg: 'RS256' }

  // Inject keys — no network calls
  _resetKeyCache()
  _resetSpireJWKSCache()
  _resetIdpJWKSCache()
  _setSpireJWKS(createLocalJWKSet({ keys: [spireJWK] }))
  _setRawSpireKeys([spireJWK])
  _setIdpJWKS(createLocalJWKSet({ keys: [idpJWK] }))

  // MockRedis + trust score for lyra: 0.85 → VERIFIED tier
  redis = new MockRedis()
  await updateTrustScore(redis as any, LYRA_SPIFFE, 0.85)

  // Build server — high rate limits so test burst doesn't trigger 429
  app = await buildServer({}, { redis: redis as any, rateLimits: { token: 10000, global: 10000 } })

  // Create delegation grant via /provision
  const now = Math.floor(Date.now() / 1000)
  const idToken = await new SignJWT({ sub: 'sub-geoff', email: HUMAN })
    .setProtectedHeader({ alg: 'RS256', kid: idpJWK.kid })
    .setIssuer('https://idp.integration.test')
    .setAudience('kaif-server')
    .setIssuedAt(now)
    .setExpirationTime(now + 900)
    .sign(idpPrivKey)

  // POST /provision — real path: IdP token → delegation JWT
  const provisionRes = await app.inject({
    method: 'POST', url: '/provision',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id_token: idToken, agent_id: 'lyra',
	      scope: 'invoke:completion vault:read:anthropic_key audit:read',
    }),
  })
  expect(provisionRes.statusCode).toBe(200)
  const { delegation_token } = provisionRes.json() as { delegation_token: string }
  // delegation_token is a KAIF-signed JWT — use it directly as subject_token.
  // No manual signKAIFToken() needed here; this proves the real flow works.
  subjectToken = delegation_token

  // SVID for lyra
  actorToken = await new SignJWT({ sub: LYRA_SPIFFE })
    .setProtectedHeader({ alg: 'RS256', kid: spireJWK.kid })
    .setIssuedAt(now)
    .setExpirationTime(now + 600)
    .sign(spirePrivKey)
})

afterAll(async () => {
  vi.unstubAllGlobals()
  _resetSpireBundleFetcher()
  await app?.close()
  redis?.reset()
})

// ── Integration steps ──────────────────────────────────────────────────────

describe('KAIF end-to-end integration', () => {

  // ── Step 1 — Health check ──────────────────────────────────────────

  it('Step 1 — GET /health returns 200 with status ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.status).toBe('ok')
    expect(body.redis).toBe('connected')
    expect(body.spire).toBe('reachable')
  })

  // ── Step 2 — JWKS ─────────────────────────────────────────────────

  it('Step 2 — GET /.well-known/jwks.json returns 200 with one key', async () => {
    const res = await app.inject({ method: 'GET', url: '/.well-known/jwks.json' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(Array.isArray(body.keys)).toBe(true)
    expect(body.keys).toHaveLength(1)
    jwksKid = body.keys[0].kid
    expect(typeof jwksKid).toBe('string')
    expect(jwksKid.length).toBeGreaterThan(0)
  })

  // ── Step 3 — Token exchange ────────────────────────────────────────

  it('Step 3 — POST /oauth/token returns 200 with access_token', async () => {
    const reqBody = new URLSearchParams({
      grant_type:         GRANT_TYPE,
      subject_token:      subjectToken,
      subject_token_type: SUBJECT_TYPE,
      actor_token:        actorToken,
      actor_token_type:   ACTOR_TYPE,
      scope:              'invoke:completion',
    }).toString()

    const res = await app.inject({
      method: 'POST', url: '/oauth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: reqBody,
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.token_type).toBe('Bearer')
    expect(body.issued_token_type).toBe(SUBJECT_TYPE)
    expect(typeof body.access_token).toBe('string')
    expect(body.scope).toBe('invoke:completion')

	    accessToken = body.access_token
	    const parts = accessToken.split('.')
	    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString())
	    accessTokenJti = payload.jti

	    const auditRes = await app.inject({
	      method: 'POST', url: '/oauth/token',
	      headers: { 'content-type': 'application/x-www-form-urlencoded' },
	      body: new URLSearchParams({
	        grant_type: GRANT_TYPE,
	        subject_token: subjectToken,
	        subject_token_type: SUBJECT_TYPE,
	        actor_token: actorToken,
	        actor_token_type: ACTOR_TYPE,
	        scope: 'audit:read',
	      }).toString(),
	    })
	    expect(auditRes.statusCode).toBe(200)
	    auditToken = auditRes.json().access_token
	  })

  // ── Step 4 — JWT claims ────────────────────────────────────────────

  it('Step 4 — returned JWT has correct claims', async () => {
    const publicJWK = await getPublicJWK()
    const key = await importJWK(publicJWK, 'RS256')
    const { payload } = await jwtVerify(accessToken, key, { algorithms: ['RS256'] })

    expect(payload.sub).toBe(HUMAN)
    expect((payload as any).actor?.sub).toBe(LYRA_SPIFFE)
    expect((payload as any).kaif?.trust_score).toBe(0.85)
    expect((payload as any).kaif?.trust_tier).toBe('VERIFIED')
    expect((payload as any).kaif?.delegation_depth).toBe(0)
    expect((payload as any).kaif?.principal_chain).toContain(HUMAN)
    expect(payload.scope).toBe('invoke:completion')

    // VERIFIED tier TTL is 900s (matches lyra delegation_ttl_seconds: 900)
    const exp = payload.exp!
    const iat = payload.iat!
    expect(exp - iat).toBe(900)
  })

  // ── Step 5 — Audit log ─────────────────────────────────────────────

  it('Step 5 — audit log has TOKEN_ISSUED entry linking to DELEGATION_PROVISIONED', async () => {
    const raw = redis.lists.get('kaif:audit:global')!
    expect(raw.length).toBeGreaterThanOrEqual(2)

    const entries = raw.map(r => JSON.parse(r) as AuditEntry)
    const delegation = entries.find(e => e.action === 'DELEGATION_PROVISIONED')!
    const issued     = entries.find(e => e.action === 'TOKEN_ISSUED')!

    expect(delegation).toBeDefined()
    expect(issued).toBeDefined()

    // TOKEN_ISSUED's prev_hash must equal DELEGATION_PROVISIONED's hash
    expect(issued.prev_hash).toBe(delegation.hash)

    // Both hashes are non-empty 64-char hex strings
    expect(issued.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(delegation.hash).toMatch(/^[0-9a-f]{64}$/)

    // Full chain integrity
    expect(await verifyChain(redis as any)).toBe(true)
  })

  // ── Step 6 — Introspect returns active ────────────────────────────

  it('Step 6 — POST /introspect returns active: true', async () => {
    const res = await app.inject({
      method: 'POST', url: '/introspect',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ token: accessToken }),
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.active).toBe(true)
    expect(body.sub).toBe(HUMAN)
    expect(body.jti).toBe(accessTokenJti)
  })

  // ── Step 7 — Revoke ───────────────────────────────────────────────

  it('Step 7 — POST /revoke revokes the token and writes audit entry', async () => {
    const res = await app.inject({
      method: 'POST', url: '/revoke',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ token: accessToken, reason: 'integration-test-revoke' }),
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.revoked).toBe(true)
    expect(body.jti).toBe(accessTokenJti)

    // TOKEN_REVOKED audit entry present
    const raw = redis.lists.get('kaif:audit:global')!
    const entries = raw.map(r => JSON.parse(r) as AuditEntry)
    const revoked = entries.find(e => e.action === 'TOKEN_REVOKED')!
    expect(revoked).toBeDefined()
    expect(revoked.detail).toContain(accessTokenJti)

	    expect(revoked.prev_hash).toMatch(/^[0-9a-f]{64}$/)
	    expect(await verifyChain(redis as any)).toBe(true)
  })

  // ── Step 8 — Introspect after revocation ──────────────────────────

  it('Step 8 — POST /introspect returns active: false after revocation', async () => {
    const res = await app.inject({
      method: 'POST', url: '/introspect',
      headers: {
	        authorization: `Bearer ${auditToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ token: accessToken }),
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().active).toBe(false)
  })

  // ── Step 9 — Trust score drop blocks issuance ─────────────────────

  it('Step 9 — trust score drop to 0.3 blocks token issuance with insufficient_trust', async () => {
    // Drop lyra's trust score to PROVISIONAL (0.3 < 0.5 STANDARD required)
    await updateTrustScore(redis as any, LYRA_SPIFFE, 0.3)

    // Create a fresh subject token (the old one's JTI was not revoked — only access token was)
    const now = Math.floor(Date.now() / 1000)
    const freshSubjectClaims: KAIFTokenClaims = {
      iss: 'https://auth.integration.test', sub: HUMAN,
      aud: 'https://api.integration.test', iat: now, exp: now + 900,
      jti: crypto.randomUUID(),
      scope: 'invoke:completion',
      actor: { sub: LYRA_SPIFFE, svid_thumbprint: 'pending' },
      may_act: { sub: LYRA_SPIFFE },
      kaif: {
        trust_score: 0.85, trust_tier: 'VERIFIED', delegation_depth: 0,
        delegation_id: crypto.randomUUID(), rollback_window: 'PT15M',
        principal_chain: [HUMAN],
      },
    }
    const freshSubjectToken = await signKAIFToken(freshSubjectClaims)
    const freshActorToken = await new SignJWT({ sub: LYRA_SPIFFE })
      .setProtectedHeader({ alg: 'RS256', kid: spireJWK.kid })
      .setIssuedAt(now).setExpirationTime(now + 600)
      .sign(spirePrivKey)

    const res = await app.inject({
      method: 'POST', url: '/oauth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: GRANT_TYPE, subject_token: freshSubjectToken,
        subject_token_type: SUBJECT_TYPE, actor_token: freshActorToken,
        actor_token_type: ACTOR_TYPE, scope: 'invoke:completion',
      }).toString(),
    })

    expect(res.statusCode).toBe(403)
    expect(res.json().error).toBe('insufficient_trust')
  })

  // ── Step 10 — Audit chain tamper detection ────────────────────────

  it('Step 10 — audit chain tamper detection: verifyChain detects and confirms restoration', async () => {
    const auditList = redis.lists.get('kaif:audit:global')!
    expect(auditList.length).toBeGreaterThanOrEqual(3)

    // Verify chain is currently intact
    expect(await verifyChain(redis as any)).toBe(true)

    // Tamper a middle entry: change detail without updating hash
    const tamperIndex = 1  // second entry (after genesis DELEGATION_PROVISIONED)
    const originalSerialized = auditList[tamperIndex]!
    const tampered = JSON.parse(originalSerialized) as AuditEntry
    tampered.detail = 'TAMPERED_BY_INTEGRATION_TEST'
    auditList[tamperIndex] = JSON.stringify(tampered)

    // Chain must be broken
    expect(await verifyChain(redis as any)).toBe(false)

    // Restore original entry
    auditList[tamperIndex] = originalSerialized

    // Chain must be intact again
    expect(await verifyChain(redis as any)).toBe(true)
  })
})
