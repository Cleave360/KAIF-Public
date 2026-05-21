import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import Fastify from 'fastify'
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from 'jose'
import type { JWK, KeyLike } from 'jose'
import { MockRedis } from '../mock-redis.js'
import { provisionRoute } from '../../src/routes/provision.js'
import { _setIdpJWKS, _resetIdpJWKSCache } from '../../src/crypto/jwt.js'

const AGENTS_CONFIG = new URL('../../config/agents.yaml', import.meta.url).pathname

// ── IdP keypair injected into jwt.ts — no network calls ──────────

let idpPrivateKey: KeyLike
let idpPublicJWK: JWK & { kid: string }

function setTestEnv() {
  process.env['KAIF_IDP_ISSUER']         = 'https://idp.test'
  process.env['KAIF_IDP_JWKS_URL']       = 'https://idp.test/.well-known/jwks.json'
  process.env['KAIF_AGENTS_CONFIG_PATH'] = AGENTS_CONFIG
}

beforeAll(async () => {
  setTestEnv()
  const pair = await generateKeyPair('RS256', { modulusLength: 2048 })
  idpPrivateKey = pair.privateKey as KeyLike
  const raw = await exportJWK(pair.publicKey)
  idpPublicJWK = { ...raw, kid: 'idp-provision-test', alg: 'RS256' }
})

beforeEach(() => {
  setTestEnv()
  _resetIdpJWKSCache()
  _setIdpJWKS(createLocalJWKSet({ keys: [idpPublicJWK] }))
})

async function makeIdToken(email = 'user@example.com', ttl = 300): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({ sub: 'sub-12345', email })
    .setProtectedHeader({ alg: 'RS256', kid: idpPublicJWK.kid })
    .setIssuer('https://idp.test')
    .setAudience('kaif-server')
    .setIssuedAt(now)
    .setExpirationTime(now + ttl)
    .sign(idpPrivateKey)
}

function makeApp(redis: MockRedis) {
  const app = Fastify({ logger: false })
  app.register(provisionRoute, { redis: redis as any, issuer: 'https://kaif.test' })
  return app
}

describe('POST /provision', () => {
  it('valid id_token + known agent returns 200 with delegation_id and delegation_token', async () => {
    const redis = new MockRedis()
    const app = makeApp(redis)
    const idToken = await makeIdToken()

    const res = await app.inject({
      method: 'POST', url: '/provision',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id_token: idToken, agent_id: 'lyra', scope: 'invoke:completion' }),
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(typeof body.delegation_id).toBe('string')
    expect(body.delegation_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(body.agent_id).toBe('lyra')
    expect(body.scope).toBe('invoke:completion')
    expect(body.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000))
    // delegation_token is the signed JWT the agent uses as subject_token
    expect(typeof body.delegation_token).toBe('string')
    expect(body.delegation_token.split('.').length).toBe(3)  // compact JWS
  })

  it('invalid id_token returns 401', async () => {
    const redis = new MockRedis()
    const app = makeApp(redis)

    const res = await app.inject({
      method: 'POST', url: '/provision',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id_token: 'not.a.jwt', agent_id: 'lyra', scope: 'invoke:completion' }),
    })

    expect(res.statusCode).toBe(401)
    expect(res.json().error).toBe('invalid_client')
  })

  it('unknown agent_id returns 400', async () => {
    const redis = new MockRedis()
    const app = makeApp(redis)
    const idToken = await makeIdToken()

    const res = await app.inject({
      method: 'POST', url: '/provision',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id_token: idToken, agent_id: 'unknown-agent', scope: 'invoke:completion' }),
    })

    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('invalid_request')
  })

  it('scope overreach returns 400 invalid_scope', async () => {
    const redis = new MockRedis()
    const app = makeApp(redis)
    const idToken = await makeIdToken()

    // lyra only has vault:read:anthropic_key, invoke:completion, audit:read
    const res = await app.inject({
      method: 'POST', url: '/provision',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id_token: idToken, agent_id: 'lyra', scope: 'admin:delete vault:write:*' }),
    })

    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('invalid_scope')
  })

  it('ttl_seconds clamped to 86400 max', async () => {
    const redis = new MockRedis()
    const app = makeApp(redis)
    const idToken = await makeIdToken('user@example.com', 999999)

    const res = await app.inject({
      method: 'POST', url: '/provision',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id_token: idToken, agent_id: 'lyra',
        scope: 'invoke:completion', ttl_seconds: 999999,
      }),
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    const ttlActual = body.expires_at - Math.floor(Date.now() / 1000)
    expect(ttlActual).toBeLessThanOrEqual(86400 + 5)  // small clock margin
  })

  it('delegation written to Redis with correct TTL', async () => {
    const redis = new MockRedis()
    const app = makeApp(redis)
    const idToken = await makeIdToken()

    const res = await app.inject({
      method: 'POST', url: '/provision',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id_token: idToken, agent_id: 'lyra', scope: 'invoke:completion', ttl_seconds: 300 }),
    })

    const { delegation_id } = res.json()
    const stored = await redis.get(`kaif:delegation:${delegation_id}`)
    expect(stored).not.toBeNull()

    const grant = JSON.parse(stored!)
    expect(grant.human_principal).toBe('user@example.com')
    expect(grant.granted_scopes).toContain('invoke:completion')

    // Verify the entry has a TTL set (expireAt should be close to now + 300s)
    const entry = (redis as any).strings.get(`kaif:delegation:${delegation_id}`)
    const expectedExpireAt = Date.now() + 300 * 1000
    expect(Math.abs(entry.expireAt - expectedExpireAt)).toBeLessThan(3000)
  })

  it('audit entry DELEGATION_PROVISIONED written', async () => {
    const redis = new MockRedis()
    const app = makeApp(redis)
    const idToken = await makeIdToken()

    await app.inject({
      method: 'POST', url: '/provision',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id_token: idToken, agent_id: 'lyra', scope: 'invoke:completion' }),
    })

    const auditRaw = await redis.lrange('kaif:audit:global', -1, -1)
    const lastEntry = JSON.parse(auditRaw[0]!)
    expect(lastEntry.action).toBe('DELEGATION_PROVISIONED')
    expect(lastEntry.human_id).toBe('user@example.com')
  })
})
