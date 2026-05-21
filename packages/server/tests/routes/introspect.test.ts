import { describe, it, expect, beforeEach, beforeAll } from 'vitest'
import Fastify from 'fastify'
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from 'jose'
import type { JWK, KeyLike } from 'jose'
import { MockRedis } from '../mock-redis.js'
import { introspectRoute } from '../../src/routes/introspect.js'
import { signKAIFToken, _setSpireJWKS, _setRawSpireKeys, _resetSpireJWKSCache } from '../../src/crypto/jwt.js'
import { _resetKeyCache } from '../../src/crypto/keys.js'
import { revokeToken } from '../../src/services/revocation.js'
import type { KAIFTokenClaims } from '../../src/types/kaif.js'

// ── Shared SPIRE keypair (for valid actor tokens in auth headers) ──
let spirePrivateKey: KeyLike
let spirePublicJWK: JWK & { kid: string }

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { modulusLength: 2048 })
  spirePrivateKey = pair.privateKey as KeyLike
  const raw = await exportJWK(pair.publicKey)
  spirePublicJWK = { ...raw, kid: 'spire-introspect-test', alg: 'RS256' }
})

beforeEach(() => {
  _resetKeyCache()
  _resetSpireJWKSCache()
  _setSpireJWKS(createLocalJWKSet({ keys: [spirePublicJWK] }))
  _setRawSpireKeys([spirePublicJWK])
})

// Minimal valid KAIFTokenClaims for a bearer token
async function makeAuthToken(ttlSeconds = 300, scope = 'audit:read'): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const claims: KAIFTokenClaims = {
    iss:   'https://auth.test.example',
    sub:   'user@example.com',
    aud:   'https://api.example.com',
    iat:   now,
    exp:   now + ttlSeconds,
    jti:   crypto.randomUUID(),
	    scope,
    actor: { sub: 'spiffe://test', svid_thumbprint: 'sha256:test' },
    may_act: { sub: 'spiffe://test' },
    kaif: {
      trust_score: 0.6, trust_tier: 'STANDARD', delegation_depth: 1,
      delegation_id: crypto.randomUUID(), rollback_window: 'PT5M',
      principal_chain: ['user@example.com'],
    },
  }
  return signKAIFToken(claims)
}

function makeApp(redis: MockRedis) {
  const app = Fastify({ logger: false })
  app.register(introspectRoute, { redis: redis as any })
  return app
}

describe('POST /introspect', () => {
  it('valid active token returns { active: true } with claims', async () => {
    const redis = new MockRedis()
    const app = makeApp(redis)
    const authToken = await makeAuthToken()
    const targetToken = await makeAuthToken()

    const res = await app.inject({
      method: 'POST',
      url: '/introspect',
      headers: { authorization: `Bearer ${authToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ token: targetToken }),
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.active).toBe(true)
    expect(body.sub).toBe('user@example.com')
    expect(typeof body.jti).toBe('string')
  })

  it('expired token returns { active: false }', async () => {
    const redis = new MockRedis()
    const app = makeApp(redis)
    const authToken = await makeAuthToken()
    // Sign a token expired 60 seconds ago
    const now = Math.floor(Date.now() / 1000)
    const claims: KAIFTokenClaims = {
      iss: 'https://auth.test.example', sub: 'user@example.com',
      aud: 'https://api.example.com', iat: now - 120, exp: now - 60,
      jti: crypto.randomUUID(), scope: 'invoke:completion',
      actor: { sub: 'spiffe://test', svid_thumbprint: 'sha256:test' },
      may_act: { sub: 'spiffe://test' },
      kaif: {
        trust_score: 0.6, trust_tier: 'STANDARD', delegation_depth: 1,
        delegation_id: crypto.randomUUID(), rollback_window: 'PT5M',
        principal_chain: ['user@example.com'],
      },
    }
    const expiredToken = await signKAIFToken(claims)

    const res = await app.inject({
      method: 'POST',
      url: '/introspect',
      headers: { authorization: `Bearer ${authToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ token: expiredToken }),
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().active).toBe(false)
  })

  it('tampered token returns { active: false }', async () => {
    const redis = new MockRedis()
    const app = makeApp(redis)
    const authToken = await makeAuthToken()
    const validToken = await makeAuthToken()
    // Tamper the signature
    const [h, p] = validToken.split('.')
    const tamperedToken = `${h}.${p}.invalidsignature`

    const res = await app.inject({
      method: 'POST',
      url: '/introspect',
      headers: { authorization: `Bearer ${authToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ token: tamperedToken }),
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().active).toBe(false)
  })

  it('revoked JTI returns { active: false }', async () => {
    const redis = new MockRedis()
    const app = makeApp(redis)
    const authToken = await makeAuthToken()
    const targetToken = await makeAuthToken()

    // Decode and revoke the JTI
    const payload = JSON.parse(Buffer.from(targetToken.split('.')[1]!, 'base64url').toString())
    await revokeToken(redis as any, payload.jti, 'spiffe://test', 'test', payload.exp)

    const res = await app.inject({
      method: 'POST',
      url: '/introspect',
      headers: { authorization: `Bearer ${authToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ token: targetToken }),
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().active).toBe(false)
  })

  it('missing token field returns 400', async () => {
    const redis = new MockRedis()
    const app = makeApp(redis)
    const authToken = await makeAuthToken()

    const res = await app.inject({
      method: 'POST',
      url: '/introspect',
      headers: { authorization: `Bearer ${authToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })

    expect(res.statusCode).toBe(400)
  })

	  it('unauthenticated caller returns 401', async () => {
    const redis = new MockRedis()
    const app = makeApp(redis)
    const targetToken = await makeAuthToken()

    const res = await app.inject({
      method: 'POST',
      url: '/introspect',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: targetToken }),
    })

	    expect(res.statusCode).toBe(401)
	    expect(res.json().error).toBe('invalid_client')
	  })

	  it('token may introspect itself without audit:read', async () => {
	    const redis = new MockRedis()
	    const app = makeApp(redis)
	    const selfToken = await makeAuthToken(300, 'invoke:completion')

	    const res = await app.inject({
	      method: 'POST',
	      url: '/introspect',
	      headers: { authorization: `Bearer ${selfToken}`, 'content-type': 'application/json' },
	      body: JSON.stringify({ token: selfToken }),
	    })

	    expect(res.statusCode).toBe(200)
	    expect(res.json().active).toBe(true)
	  })

	  it('token without audit:read cannot introspect another token', async () => {
	    const redis = new MockRedis()
	    const app = makeApp(redis)
	    const authToken = await makeAuthToken(300, 'invoke:completion')
	    const targetToken = await makeAuthToken()

	    const res = await app.inject({
	      method: 'POST',
	      url: '/introspect',
	      headers: { authorization: `Bearer ${authToken}`, 'content-type': 'application/json' },
	      body: JSON.stringify({ token: targetToken }),
	    })

	    expect(res.statusCode).toBe(403)
	    expect(res.json().error).toBe('insufficient_scope')
	  })

	  it('revoked bearer token returns 401', async () => {
	    const redis = new MockRedis()
	    const app = makeApp(redis)
	    const authToken = await makeAuthToken()
	    const targetToken = await makeAuthToken()
	    const authPayload = JSON.parse(Buffer.from(authToken.split('.')[1]!, 'base64url').toString())
	    await revokeToken(redis as any, authPayload.jti, 'spiffe://test', 'auth revoked', authPayload.exp)

	    const res = await app.inject({
	      method: 'POST',
	      url: '/introspect',
	      headers: { authorization: `Bearer ${authToken}`, 'content-type': 'application/json' },
	      body: JSON.stringify({ token: targetToken }),
	    })

	    expect(res.statusCode).toBe(401)
	    expect(res.json().error).toBe('invalid_client')
	  })
	})
