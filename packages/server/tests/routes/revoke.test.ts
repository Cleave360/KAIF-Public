import { describe, it, expect, beforeEach, beforeAll } from 'vitest'
import Fastify from 'fastify'
import { generateKeyPair, exportJWK, createLocalJWKSet } from 'jose'
import type { JWK, KeyLike } from 'jose'
import { MockRedis } from '../mock-redis.js'
import { revokeRoute } from '../../src/routes/revoke.js'
import { introspectRoute } from '../../src/routes/introspect.js'
import { signKAIFToken, _setSpireJWKS, _setRawSpireKeys, _resetSpireJWKSCache } from '../../src/crypto/jwt.js'
import { _resetKeyCache } from '../../src/crypto/keys.js'
import { revokeToken } from '../../src/services/revocation.js'
import type { KAIFTokenClaims } from '../../src/types/kaif.js'

let spirePrivateKey: KeyLike
let spirePublicJWK: JWK & { kid: string }

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { modulusLength: 2048 })
  spirePrivateKey = pair.privateKey as KeyLike
  const raw = await exportJWK(pair.publicKey)
  spirePublicJWK = { ...raw, kid: 'spire-revoke-test', alg: 'RS256' }
})

beforeEach(() => {
  _resetKeyCache()
  _resetSpireJWKSCache()
  _setSpireJWKS(createLocalJWKSet({ keys: [spirePublicJWK] }))
  _setRawSpireKeys([spirePublicJWK])
})

async function makeAuthToken(scope = 'admin:revoke audit:read'): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const claims: KAIFTokenClaims = {
    iss: 'https://auth.test.example', sub: 'user@example.com',
    aud: 'https://api.example.com', iat: now, exp: now + 600,
    jti: crypto.randomUUID(), scope,
    actor: { sub: 'spiffe://test', svid_thumbprint: 'sha256:test' },
    may_act: { sub: 'spiffe://test' },
    kaif: {
      trust_score: 0.6, trust_tier: 'STANDARD', delegation_depth: 1,
      delegation_id: crypto.randomUUID(), rollback_window: 'PT10M',
      principal_chain: ['user@example.com'],
    },
  }
  return signKAIFToken(claims)
}

async function makeTargetToken(ttl = 600): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const claims: KAIFTokenClaims = {
    iss: 'https://auth.test.example', sub: 'user@example.com',
    aud: 'https://api.example.com', iat: now, exp: now + ttl,
    jti: crypto.randomUUID(), scope: 'vault:read:anthropic_key',
    actor: { sub: 'spiffe://example.org/ns/adaptive-layer/agent/lyra', svid_thumbprint: 'sha256:test' },
    may_act: { sub: 'spiffe://example.org/ns/adaptive-layer/agent/lyra' },
    kaif: {
      trust_score: 0.6, trust_tier: 'STANDARD', delegation_depth: 1,
      delegation_id: crypto.randomUUID(), rollback_window: 'PT10M',
      principal_chain: ['user@example.com'],
    },
  }
  return signKAIFToken(claims)
}

function makeRevokeApp(redis: MockRedis) {
  const app = Fastify({ logger: false })
  app.register(revokeRoute, { redis: redis as any })
  return app
}

describe('POST /revoke', () => {
  it('valid token is revoked — subsequent introspect returns active: false', async () => {
    const redis = new MockRedis()
    const revokeApp = makeRevokeApp(redis)
    const introspectApp = Fastify({ logger: false })
    introspectApp.register(introspectRoute, { redis: redis as any })

    const authToken = await makeAuthToken()
    const targetToken = await makeTargetToken()

    // Revoke
    const revokeRes = await revokeApp.inject({
      method: 'POST', url: '/revoke',
      headers: { authorization: `Bearer ${authToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ token: targetToken }),
    })
    expect(revokeRes.statusCode).toBe(200)
    expect(revokeRes.json().revoked).toBe(true)

    // Introspect after revocation
    const introspectRes = await introspectApp.inject({
      method: 'POST', url: '/introspect',
      headers: { authorization: `Bearer ${authToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ token: targetToken }),
    })
    expect(introspectRes.statusCode).toBe(200)
    expect(introspectRes.json().active).toBe(false)
  })

  it('already-revoked token returns 200 (idempotent)', async () => {
    const redis = new MockRedis()
    const app = makeRevokeApp(redis)
    const authToken = await makeAuthToken()
    const targetToken = await makeTargetToken()

    const body = JSON.stringify({ token: targetToken })
    const headers = { authorization: `Bearer ${authToken}`, 'content-type': 'application/json' }

    const first  = await app.inject({ method: 'POST', url: '/revoke', headers, body })
    const second = await app.inject({ method: 'POST', url: '/revoke', headers, body })

    expect(first.statusCode).toBe(200)
    expect(second.statusCode).toBe(200)
    expect(second.json().revoked).toBe(true)
  })

  it('token without jti returns 400', async () => {
    const redis = new MockRedis()
    const app = makeRevokeApp(redis)
    const authToken = await makeAuthToken()

    // Build a JWT without jti — manually base64url encode a payload without jti
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
    const payload = Buffer.from(JSON.stringify({ sub: 'user', exp: 9999999999 })).toString('base64url')
    const noJtiToken = `${header}.${payload}.fakesig`

    const res = await app.inject({
      method: 'POST', url: '/revoke',
      headers: { authorization: `Bearer ${authToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ token: noJtiToken }),
    })

    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('invalid_request')
  })

	  it('unauthenticated caller returns 401', async () => {
    const redis = new MockRedis()
    const app = makeRevokeApp(redis)
    const targetToken = await makeTargetToken()

    const res = await app.inject({
      method: 'POST', url: '/revoke',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: targetToken }),
    })

	    expect(res.statusCode).toBe(401)
	    expect(res.json().error).toBe('invalid_client')
	  })

	  it('token may revoke itself without admin:revoke', async () => {
	    const redis = new MockRedis()
	    const app = makeRevokeApp(redis)
	    const selfToken = await makeAuthToken('invoke:completion')

	    const res = await app.inject({
	      method: 'POST', url: '/revoke',
	      headers: { authorization: `Bearer ${selfToken}`, 'content-type': 'application/json' },
	      body: JSON.stringify({ token: selfToken }),
	    })

	    expect(res.statusCode).toBe(200)
	    expect(res.json().revoked).toBe(true)
	  })

	  it('token without admin:revoke cannot revoke another token', async () => {
	    const redis = new MockRedis()
	    const app = makeRevokeApp(redis)
	    const authToken = await makeAuthToken('invoke:completion')
	    const targetToken = await makeTargetToken()

	    const res = await app.inject({
	      method: 'POST', url: '/revoke',
	      headers: { authorization: `Bearer ${authToken}`, 'content-type': 'application/json' },
	      body: JSON.stringify({ token: targetToken }),
	    })

	    expect(res.statusCode).toBe(403)
	    expect(res.json().error).toBe('insufficient_scope')
	  })

	  it('revoked bearer token returns 401', async () => {
	    const redis = new MockRedis()
	    const app = makeRevokeApp(redis)
	    const authToken = await makeAuthToken()
	    const targetToken = await makeTargetToken()
	    const authPayload = JSON.parse(Buffer.from(authToken.split('.')[1]!, 'base64url').toString())
	    await revokeToken(redis as any, authPayload.jti, 'spiffe://test', 'auth revoked', authPayload.exp)

	    const res = await app.inject({
	      method: 'POST', url: '/revoke',
	      headers: { authorization: `Bearer ${authToken}`, 'content-type': 'application/json' },
	      body: JSON.stringify({ token: targetToken }),
	    })

	    expect(res.statusCode).toBe(401)
	    expect(res.json().error).toBe('invalid_client')
	  })

  it('audit entry TOKEN_REVOKED written', async () => {
    const redis = new MockRedis()
    const app = makeRevokeApp(redis)
    const authToken = await makeAuthToken()
    const targetToken = await makeTargetToken()

    await app.inject({
      method: 'POST', url: '/revoke',
      headers: { authorization: `Bearer ${authToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ token: targetToken, reason: 'manual-test' }),
    })

    const auditRaw = await redis.lrange('kaif:audit:global', -1, -1)
    const lastEntry = JSON.parse(auditRaw[0]!)
    expect(lastEntry.action).toBe('TOKEN_REVOKED')
    expect(lastEntry.detail).toContain('manual-test')
  })
})
