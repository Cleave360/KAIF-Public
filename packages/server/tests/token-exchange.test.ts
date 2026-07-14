import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import {
  generateKeyPair,
  exportJWK,
  SignJWT,
  createLocalJWKSet,
} from 'jose'
import type { JWK, KeyLike } from 'jose'
import { MockRedis } from './mock-redis.js'
import { executeTokenExchange } from '../src/services/token-exchange.js'
import { signKAIFToken, _setSpireJWKS, _setRawSpireKeys, _resetSpireJWKSCache } from '../src/crypto/jwt.js'
import { _resetKeyCache } from '../src/crypto/keys.js'
import { revokeToken } from '../src/services/revocation.js'
import { updateTrustScore } from '../src/services/trust-score.js'
import type { KAIFTokenClaims } from '../src/types/kaif.js'

// ── Environment setup ──────────────────────────────────────────────

const AGENTS_CONFIG = new URL('../config/agents.yaml', import.meta.url).pathname

const originalEnv = { ...process.env }

function setTestEnv(): void {
  process.env['KAIF_ISSUER'] = 'https://auth.test.example'
  process.env['KAIF_REDIS_URL'] = 'redis://localhost:6379'
  process.env['KAIF_SPIRE_BUNDLE_ENDPOINT'] = 'https://localhost:8081/'
  process.env['KAIF_SPIRE_TRUST_DOMAIN'] = 'kindred.systems'
  process.env['KAIF_IDP_JWKS_URL'] = 'https://idp.example/.well-known/jwks.json'
  process.env['KAIF_IDP_ISSUER'] = 'https://idp.example'
  process.env['KAIF_AGENTS_CONFIG_PATH'] = AGENTS_CONFIG
  process.env['KAIF_STRICT_REVOCATION'] = 'false'
  delete process.env['KAIF_PRIVATE_KEY_PATH']
  delete process.env['KAIF_ALLOWED_AUDIENCES']
  delete process.env['KAIF_PORT']
  delete process.env['KAIF_HOST']
  delete process.env['KAIF_LOG_LEVEL']
}

afterAll(() => {
  Object.assign(process.env, originalEnv)
})

// ── Test fixtures ──────────────────────────────────────────────────

// SPIRE signing keypair (for mock SVIDs)
let spirePrivateKey: KeyLike
let spirePublicJWK: JWK & { kid: string }

// KAIF agent SPIFFE IDs (must match agents.yaml)
const LYRA_SPIFFE   = 'spiffe://example.org/ns/adaptive-layer/agent/lyra'   // STANDARD min
const ORION_SPIFFE  = 'spiffe://kindred.systems/ns/adaptive-layer/agent/orion'  // VERIFIED min, may delegate
const CIPHER_SPIFFE = 'spiffe://kindred.systems/ns/adaptive-layer/agent/cipher' // TRUSTED min
const MOCK_SPIFFE   = 'spiffe://kindred.systems/ns/examples/agent/mock'         // PROVISIONAL min, max_depth=0
const UNKNOWN_SPIFFE = 'spiffe://kindred.systems/ns/unknown/agent/x'

// Build a mock SVID JWT signed with the SPIRE key
async function makeSVID(spiffeId: string, ttlSeconds = 300): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({ sub: spiffeId })
    .setProtectedHeader({ alg: 'RS256', kid: spirePublicJWK.kid })
    .setIssuedAt(now)
    .setExpirationTime(now + ttlSeconds)
    .sign(spirePrivateKey)
}

// Build a subject token (KAIF-signed, simulates a provisioned delegation grant)
async function makeSubjectToken(opts: {
	  sub?: string
	  scope?: string
	  depth?: number
	  ttlSeconds?: number
	  actorSub?: string
	  svidThumbprint?: string
	}): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const ttl = opts.ttlSeconds ?? 600
  const claims: KAIFTokenClaims = {
    iss:   'https://auth.test.example',
    sub:   opts.sub ?? 'user@example.com',
    aud:   'https://api.example.com',
    iat:   now,
    exp:   now + ttl,
    jti:   crypto.randomUUID(),
    scope: opts.scope ?? 'vault:read:anthropic_key invoke:completion',
	    actor: { sub: opts.actorSub ?? LYRA_SPIFFE, svid_thumbprint: opts.svidThumbprint ?? 'pending' },
	    may_act: { sub: opts.actorSub ?? LYRA_SPIFFE },
    kaif: {
      trust_score:      0.6,
      trust_tier:       'STANDARD',
	      delegation_depth: opts.depth ?? 0,
      delegation_id:    crypto.randomUUID(),
      rollback_window:  'PT10M',
      principal_chain:  [opts.sub ?? 'user@example.com'],
    },
  }
  return signKAIFToken(claims)
}

// ── Setup ──────────────────────────────────────────────────────────

beforeAll(async () => {
  setTestEnv()

  // Generate SPIRE keypair once — shared across all tests
  const pair = await generateKeyPair('RS256', { modulusLength: 2048 })
  spirePrivateKey = pair.privateKey as KeyLike
  const rawPublicJWK = await exportJWK(pair.publicKey)
  spirePublicJWK = { ...rawPublicJWK, kid: 'spire-test-key-1', alg: 'RS256' }
})

beforeEach(() => {
  setTestEnv()
  _resetKeyCache()
  _resetSpireJWKSCache()
  _setSpireJWKS(createLocalJWKSet({ keys: [spirePublicJWK] }))
  _setRawSpireKeys([spirePublicJWK])
})

// ── Required test cases ────────────────────────────────────────────

describe('token exchange — required cases', () => {
  it('valid request returns well-formed KAIF JWT', async () => {
    const redis = new MockRedis()
    const subjectToken = await makeSubjectToken({ scope: 'vault:read:anthropic_key invoke:completion' })
    const actorToken = await makeSVID(LYRA_SPIFFE)

    // Default trust score for unknown agent is 0.5 (STANDARD), lyra requires STANDARD — pass
    const response = await executeTokenExchange({
      redis: redis as any,
      request: {
        grant_type:         'urn:ietf:params:oauth:grant-type:token-exchange',
        subject_token:      subjectToken,
        subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
        actor_token:        actorToken,
        actor_token_type:   'urn:ietf:params:oauth:token-type:jwt',
        scope:              'vault:read:anthropic_key',
      },
    })

    expect(response.token_type).toBe('Bearer')
    expect(response.issued_token_type).toBe('urn:ietf:params:oauth:token-type:access_token')
    expect(response.scope).toBe('vault:read:anthropic_key')
    expect(response.expires_in).toBeGreaterThan(0)
    expect(response.access_token).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/)
    const payload = JSON.parse(Buffer.from(response.access_token.split('.')[1]!, 'base64url').toString())
    expect(payload.cnf).toMatchObject({ jkt: expect.any(String) })
    expect(payload.cnf.jkt).toBe(payload.actor.svid_thumbprint)

    // Verify audit was written
    const auditLog = redis.lists.get('kaif:audit:global')
    expect(auditLog).toBeDefined()
    expect(auditLog!.length).toBeGreaterThan(0)
    const lastEntry = JSON.parse(auditLog![auditLog!.length - 1]!)
    expect(lastEntry.action).toBe('TOKEN_ISSUED')
  })

  it('expired subject_token returns invalid_grant', async () => {
    const redis = new MockRedis()
    // Create a token expired 60 seconds ago
    const subjectToken = await makeSubjectToken({ ttlSeconds: -60 })
    const actorToken = await makeSVID(LYRA_SPIFFE)

    await expect(
      executeTokenExchange({
        redis: redis as any,
        request: {
          grant_type:         'urn:ietf:params:oauth:grant-type:token-exchange',
          subject_token:      subjectToken,
          subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
          actor_token:        actorToken,
          actor_token_type:   'urn:ietf:params:oauth:token-type:jwt',
          scope:              'invoke:completion',
        },
      })
    ).rejects.toMatchObject({ code: 'invalid_grant' })
  })

  it('expired SVID returns invalid_client', async () => {
    const redis = new MockRedis()
    const subjectToken = await makeSubjectToken({})
    // SVID expired 60 seconds ago
    const expiredSVID = await makeSVID(LYRA_SPIFFE, -60)

    await expect(
      executeTokenExchange({
        redis: redis as any,
        request: {
          grant_type:         'urn:ietf:params:oauth:grant-type:token-exchange',
          subject_token:      subjectToken,
          subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
          actor_token:        expiredSVID,
          actor_token_type:   'urn:ietf:params:oauth:token-type:jwt',
          scope:              'invoke:completion',
        },
      })
    ).rejects.toMatchObject({ code: 'invalid_client' })
  })

  it('unknown SPIFFE ID returns access_denied', async () => {
    const redis = new MockRedis()
    const subjectToken = await makeSubjectToken({})
    const actorToken = await makeSVID(UNKNOWN_SPIFFE)

    await expect(
      executeTokenExchange({
        redis: redis as any,
        request: {
          grant_type:         'urn:ietf:params:oauth:grant-type:token-exchange',
          subject_token:      subjectToken,
          subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
          actor_token:        actorToken,
          actor_token_type:   'urn:ietf:params:oauth:token-type:jwt',
          scope:              'invoke:completion',
        },
      })
    ).rejects.toMatchObject({ code: 'access_denied' })
  })

  it('score below tier minimum returns insufficient_trust', async () => {
    const redis = new MockRedis()
    // Set lyra's trust score to PROVISIONAL (0.3), lyra requires STANDARD
    await updateTrustScore(redis as any, LYRA_SPIFFE, 0.3)

    const subjectToken = await makeSubjectToken({ scope: 'vault:read:anthropic_key invoke:completion' })
    const actorToken = await makeSVID(LYRA_SPIFFE)

    await expect(
      executeTokenExchange({
        redis: redis as any,
        request: {
          grant_type:         'urn:ietf:params:oauth:grant-type:token-exchange',
          subject_token:      subjectToken,
          subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
          actor_token:        actorToken,
          actor_token_type:   'urn:ietf:params:oauth:token-type:jwt',
          scope:              'invoke:completion',
        },
      })
    ).rejects.toMatchObject({ code: 'insufficient_trust' })
  })

	  it('direct grant for max_depth=0 agent succeeds at depth 0', async () => {
	    const redis = new MockRedis()
	    const subjectToken = await makeSubjectToken({
	      actorSub: MOCK_SPIFFE,
	      scope:    'invoke:completion',
	    })
	    const actorToken = await makeSVID(MOCK_SPIFFE)

	    const response = await executeTokenExchange({
	      redis: redis as any,
	      request: {
	        grant_type:         'urn:ietf:params:oauth:grant-type:token-exchange',
	        subject_token:      subjectToken,
	        subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
	        actor_token:        actorToken,
	        actor_token_type:   'urn:ietf:params:oauth:token-type:jwt',
	        scope:              'invoke:completion',
	      },
	    })

	    const payload = JSON.parse(Buffer.from(response.access_token.split('.')[1]!, 'base64url').toString())
	    expect(payload.kaif.delegation_depth).toBe(0)
	  })

	  it('subject_token may_act mismatch returns access_denied', async () => {
	    const redis = new MockRedis()
	    await updateTrustScore(redis as any, ORION_SPIFFE, 0.85)
	    const subjectToken = await makeSubjectToken({
	      actorSub: LYRA_SPIFFE,
	      scope:    'invoke:completion',
	    })
	    const actorToken = await makeSVID(ORION_SPIFFE)

	    await expect(
	      executeTokenExchange({
	        redis: redis as any,
	        request: {
	          grant_type:         'urn:ietf:params:oauth:grant-type:token-exchange',
	          subject_token:      subjectToken,
	          subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
	          actor_token:        actorToken,
	          actor_token_type:   'urn:ietf:params:oauth:token-type:jwt',
	          scope:              'invoke:completion',
	        },
	      })
	    ).rejects.toMatchObject({ code: 'access_denied' })
	  })

	  it('access-token subject from non-delegating parent returns access_denied', async () => {
	    const redis = new MockRedis()
	    const subjectToken = await makeSubjectToken({
	      actorSub:        LYRA_SPIFFE,
	      scope:           'invoke:completion',
	      svidThumbprint:  'sha256:already-bound',
	    })
	    const actorToken = await makeSVID(LYRA_SPIFFE)

	    await expect(
	      executeTokenExchange({
	        redis: redis as any,
	        request: {
	          grant_type:         'urn:ietf:params:oauth:grant-type:token-exchange',
	          subject_token:      subjectToken,
	          subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
	          actor_token:        actorToken,
	          actor_token_type:   'urn:ietf:params:oauth:token-type:jwt',
	          scope:              'invoke:completion',
	        },
	      })
	    ).rejects.toMatchObject({ code: 'access_denied' })
	  })

	  it('depth > max returns delegation_depth_exceeded', async () => {
	    const redis = new MockRedis()
	    await updateTrustScore(redis as any, CIPHER_SPIFFE, 0.95)
	    const subjectToken = await makeSubjectToken({
	      actorSub:       CIPHER_SPIFFE,
	      depth:          3,
	      scope:          'invoke:completion',
	      svidThumbprint: 'sha256:already-bound',
	    })
	    const actorToken = await makeSVID(CIPHER_SPIFFE)

    await expect(
      executeTokenExchange({
        redis: redis as any,
        request: {
          grant_type:         'urn:ietf:params:oauth:grant-type:token-exchange',
          subject_token:      subjectToken,
          subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
          actor_token:        actorToken,
          actor_token_type:   'urn:ietf:params:oauth:token-type:jwt',
	          scope:              'invoke:completion',
	        },
	      })
	    ).rejects.toMatchObject({ code: 'delegation_depth_exceeded' })
	  })

  it('requested scope not in ACL returns invalid_scope', async () => {
    const redis = new MockRedis()
    const subjectToken = await makeSubjectToken({ scope: 'admin:delete invoke:completion' })
    const actorToken = await makeSVID(LYRA_SPIFFE)

    // lyra's permitted_scopes do not include admin:delete
    await expect(
      executeTokenExchange({
        redis: redis as any,
        request: {
          grant_type:         'urn:ietf:params:oauth:grant-type:token-exchange',
          subject_token:      subjectToken,
          subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
          actor_token:        actorToken,
          actor_token_type:   'urn:ietf:params:oauth:token-type:jwt',
          scope:              'admin:delete',
        },
      })
    ).rejects.toMatchObject({ code: 'invalid_scope' })
  })

	  it('requested scope not in subject grant returns invalid_scope', async () => {
	    const redis = new MockRedis()
    // Subject token only grants invoke:completion, but request asks for vault:read:anthropic_key
    const subjectToken = await makeSubjectToken({ scope: 'invoke:completion' })
    const actorToken = await makeSVID(LYRA_SPIFFE)

    // vault:read:anthropic_key is in lyra's ACL but NOT in the subject token grant
    await expect(
      executeTokenExchange({
        redis: redis as any,
        request: {
          grant_type:         'urn:ietf:params:oauth:grant-type:token-exchange',
          subject_token:      subjectToken,
          subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
          actor_token:        actorToken,
          actor_token_type:   'urn:ietf:params:oauth:token-type:jwt',
          scope:              'vault:read:anthropic_key',
        },
      })
	    ).rejects.toMatchObject({ code: 'invalid_scope' })
	  })

	  it('missing requested scope returns invalid_scope', async () => {
	    const redis = new MockRedis()
	    const subjectToken = await makeSubjectToken({ scope: 'invoke:completion' })
	    const actorToken = await makeSVID(LYRA_SPIFFE)

	    await expect(
	      executeTokenExchange({
	        redis: redis as any,
	        request: {
	          grant_type:         'urn:ietf:params:oauth:grant-type:token-exchange',
	          subject_token:      subjectToken,
	          subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
	          actor_token:        actorToken,
	          actor_token_type:   'urn:ietf:params:oauth:token-type:jwt',
	        },
	      })
	    ).rejects.toMatchObject({ code: 'invalid_scope' })
	  })

  it('explicit unapproved audience returns access_denied', async () => {
    const redis = new MockRedis()
    const subjectToken = await makeSubjectToken({ scope: 'invoke:completion' })
    const actorToken = await makeSVID(LYRA_SPIFFE)

    await expect(
      executeTokenExchange({
        redis: redis as any,
        request: {
          grant_type:         'urn:ietf:params:oauth:grant-type:token-exchange',
          subject_token:      subjectToken,
          subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
          actor_token:        actorToken,
          actor_token_type:   'urn:ietf:params:oauth:token-type:jwt',
          scope:              'invoke:completion',
          audience:           'https://nonexistent-audience.conformance.kaif.test/v1',
        },
      })
    ).rejects.toMatchObject({ code: 'access_denied' })
  })

  it('explicit configured audience is accepted', async () => {
    process.env['KAIF_ALLOWED_AUDIENCES'] = 'https://api.example.com'

    const redis = new MockRedis()
    const subjectToken = await makeSubjectToken({ scope: 'invoke:completion' })
    const actorToken = await makeSVID(LYRA_SPIFFE)

    const response = await executeTokenExchange({
      redis: redis as any,
      request: {
        grant_type:         'urn:ietf:params:oauth:grant-type:token-exchange',
        subject_token:      subjectToken,
        subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
        actor_token:        actorToken,
        actor_token_type:   'urn:ietf:params:oauth:token-type:jwt',
        scope:              'invoke:completion',
        audience:           'https://api.example.com',
      },
    })

    const payload = JSON.parse(Buffer.from(response.access_token.split('.')[1]!, 'base64url').toString())
    expect(payload.aud).toBe('https://api.example.com')
  })

	  it('revoked subject_token returns invalid_grant', async () => {
    const redis = new MockRedis()
    const subjectToken = await makeSubjectToken({ scope: 'invoke:completion' })
    const actorToken = await makeSVID(LYRA_SPIFFE)

    // Decode the subject token JTI and revoke it
    const parts = subjectToken.split('.')
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString())
    const exp = payload.exp as number
    await revokeToken(redis as any, payload.jti as string, LYRA_SPIFFE, 'test revocation', exp)

    await expect(
      executeTokenExchange({
        redis: redis as any,
        request: {
          grant_type:         'urn:ietf:params:oauth:grant-type:token-exchange',
          subject_token:      subjectToken,
          subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
          actor_token:        actorToken,
          actor_token_type:   'urn:ietf:params:oauth:token-type:jwt',
          scope:              'invoke:completion',
        },
      })
    ).rejects.toMatchObject({ code: 'invalid_grant' })
  })
})
