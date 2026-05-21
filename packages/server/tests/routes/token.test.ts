import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import Fastify from 'fastify'
import rateLimit from '@fastify/rate-limit'
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet, jwtVerify, importJWK } from 'jose'
import type { JWK, KeyLike } from 'jose'
import { MockRedis } from '../mock-redis.js'
import { tokenRoute } from '../../src/routes/token.js'
import {
  signKAIFToken,
  _setSpireJWKS,
  _setRawSpireKeys,
  _resetSpireJWKSCache,
} from '../../src/crypto/jwt.js'
import { _resetKeyCache, getPublicJWK } from '../../src/crypto/keys.js'
import { updateTrustScore } from '../../src/services/trust-score.js'
import type { KAIFTokenClaims } from '../../src/types/kaif.js'

const AGENTS_CONFIG = new URL('../../config/agents.yaml', import.meta.url).pathname
const LYRA_SPIFFE   = 'spiffe://kindred.systems/ns/adaptive-layer/agent/lyra'
const UNKNOWN_SPIFFE = 'spiffe://kindred.systems/ns/unknown/agent/x'

const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:token-exchange'
const SUBJECT_TYPE = 'urn:ietf:params:oauth:token-type:access_token'
const ACTOR_TYPE = 'urn:ietf:params:oauth:token-type:jwt'

let spirePrivateKey: KeyLike
let spirePublicJWK: JWK & { kid: string }

function setTestEnv() {
  process.env['KAIF_ISSUER']             = 'https://auth.test.example'
  process.env['KAIF_REDIS_URL']          = 'redis://localhost:6379'
  process.env['KAIF_SPIRE_BUNDLE_ENDPOINT'] = 'http://spire.test:8081'
  process.env['KAIF_SPIRE_TRUST_DOMAIN'] = 'kindred.systems'
  process.env['KAIF_IDP_JWKS_URL']       = 'https://idp.test/.well-known/jwks.json'
  process.env['KAIF_IDP_ISSUER']         = 'https://idp.test'
  process.env['KAIF_AGENTS_CONFIG_PATH'] = AGENTS_CONFIG
  process.env['KAIF_STRICT_REVOCATION']  = 'false'
  delete process.env['KAIF_PRIVATE_KEY_PATH']
}

beforeAll(async () => {
  setTestEnv()
  const pair = await generateKeyPair('RS256', { modulusLength: 2048 })
  spirePrivateKey = pair.privateKey as KeyLike
  const raw = await exportJWK(pair.publicKey)
  spirePublicJWK = { ...raw, kid: 'spire-token-test', alg: 'RS256' }
})

beforeEach(() => {
  setTestEnv()
  _resetKeyCache()
  _resetSpireJWKSCache()
  _setSpireJWKS(createLocalJWKSet({ keys: [spirePublicJWK] }))
  _setRawSpireKeys([spirePublicJWK])
})

async function makeSVID(spiffeId: string, ttl = 300): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({ sub: spiffeId })
    .setProtectedHeader({ alg: 'RS256', kid: spirePublicJWK.kid })
    .setIssuedAt(now).setExpirationTime(now + ttl)
    .sign(spirePrivateKey)
}

async function makeSubjectToken(scope = 'vault:read:anthropic_key invoke:completion', depth = 0): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const claims: KAIFTokenClaims = {
    iss: 'https://auth.test.example', sub: 'user@example.com',
    aud: 'https://api.example.com', iat: now, exp: now + 600,
    jti: crypto.randomUUID(), scope,
    actor: { sub: LYRA_SPIFFE, svid_thumbprint: 'pending' },
    may_act: { sub: LYRA_SPIFFE },
    kaif: {
      trust_score: 0.6, trust_tier: 'STANDARD', delegation_depth: depth,
      delegation_id: crypto.randomUUID(), rollback_window: 'PT10M',
      principal_chain: ['user@example.com'],
    },
  }
  return signKAIFToken(claims)
}

function formBody(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString()
}

function makeApp(redis: MockRedis) {
  const app = Fastify({ logger: false })
  app.register(tokenRoute, { redis: redis as any })
  return app
}

describe('POST /oauth/token', () => {
  it('valid request returns 200 with well-formed TokenExchangeResponse', async () => {
    const redis = new MockRedis()
    const app = makeApp(redis)
    const subjectToken = await makeSubjectToken()
    const actorToken = await makeSVID(LYRA_SPIFFE)

    const res = await app.inject({
      method: 'POST', url: '/oauth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: formBody({
        grant_type: GRANT_TYPE, subject_token: subjectToken,
        subject_token_type: SUBJECT_TYPE, actor_token: actorToken,
        actor_token_type: ACTOR_TYPE, scope: 'vault:read:anthropic_key',
      }),
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.token_type).toBe('Bearer')
    expect(body.issued_token_type).toBe(SUBJECT_TYPE)
    expect(typeof body.access_token).toBe('string')
    expect(body.expires_in).toBeGreaterThan(0)
    expect(body.scope).toBe('vault:read:anthropic_key')
  })

  it('returned JWT is verifiable with our JWKS', async () => {
    const redis = new MockRedis()
    const app = makeApp(redis)
    const subjectToken = await makeSubjectToken()
    const actorToken = await makeSVID(LYRA_SPIFFE)

    const res = await app.inject({
      method: 'POST', url: '/oauth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: formBody({
        grant_type: GRANT_TYPE, subject_token: subjectToken,
        subject_token_type: SUBJECT_TYPE, actor_token: actorToken,
        actor_token_type: ACTOR_TYPE, scope: 'invoke:completion',
      }),
    })

    const { access_token } = res.json()
    const publicJWK = await getPublicJWK()
    const key = await importJWK(publicJWK, 'RS256')
    const { payload } = await jwtVerify(access_token, key, { algorithms: ['RS256'] })
    expect(payload.sub).toBe('user@example.com')
    expect((payload as any).kaif?.trust_tier).toBe('STANDARD')
  })

  it('wrong grant_type returns 400 invalid_request', async () => {
    const redis = new MockRedis()
    const app = makeApp(redis)

    const res = await app.inject({
      method: 'POST', url: '/oauth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: formBody({
        grant_type: 'urn:ietf:params:oauth:grant-type:authorization_code',
        subject_token: 'x', subject_token_type: SUBJECT_TYPE,
        actor_token: 'y', actor_token_type: ACTOR_TYPE,
      }),
    })

    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('invalid_request')
  })

  it('missing subject_token returns 400 invalid_request', async () => {
    const redis = new MockRedis()
    const app = makeApp(redis)

    const res = await app.inject({
      method: 'POST', url: '/oauth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: formBody({
        grant_type: GRANT_TYPE,
        subject_token_type: SUBJECT_TYPE,
        actor_token: 'y', actor_token_type: ACTOR_TYPE,
      }),
    })

    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('invalid_request')
  })

  it('expired subject_token returns 400 invalid_grant', async () => {
    const redis = new MockRedis()
    const app = makeApp(redis)
    const now = Math.floor(Date.now() / 1000)
    const expiredClaims: KAIFTokenClaims = {
      iss: 'https://auth.test.example', sub: 'user@example.com',
      aud: 'https://api.example.com', iat: now - 120, exp: now - 60,
      jti: crypto.randomUUID(), scope: 'invoke:completion',
      actor: { sub: LYRA_SPIFFE, svid_thumbprint: 'sha256:test' },
      may_act: { sub: LYRA_SPIFFE },
      kaif: {
        trust_score: 0.6, trust_tier: 'STANDARD', delegation_depth: 0,
        delegation_id: crypto.randomUUID(), rollback_window: 'PT10M',
        principal_chain: ['user@example.com'],
      },
    }
    const expiredToken = await signKAIFToken(expiredClaims)
    const actorToken = await makeSVID(LYRA_SPIFFE)

    const res = await app.inject({
      method: 'POST', url: '/oauth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: formBody({
        grant_type: GRANT_TYPE, subject_token: expiredToken,
        subject_token_type: SUBJECT_TYPE, actor_token: actorToken,
        actor_token_type: ACTOR_TYPE, scope: 'invoke:completion',
      }),
    })

    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('invalid_grant')
  })

  it('unknown SPIFFE ID returns 403 access_denied', async () => {
    const redis = new MockRedis()
    const app = makeApp(redis)
    const subjectToken = await makeSubjectToken()
    const actorToken = await makeSVID(UNKNOWN_SPIFFE)

    const res = await app.inject({
      method: 'POST', url: '/oauth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: formBody({
        grant_type: GRANT_TYPE, subject_token: subjectToken,
        subject_token_type: SUBJECT_TYPE, actor_token: actorToken,
        actor_token_type: ACTOR_TYPE, scope: 'invoke:completion',
      }),
    })

    expect(res.statusCode).toBe(403)
    expect(res.json().error).toBe('access_denied')
  })

  it('scope overreach returns 400 invalid_scope', async () => {
    const redis = new MockRedis()
    const app = makeApp(redis)
    const subjectToken = await makeSubjectToken('invoke:completion')
    const actorToken = await makeSVID(LYRA_SPIFFE)

    const res = await app.inject({
      method: 'POST', url: '/oauth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: formBody({
        grant_type: GRANT_TYPE, subject_token: subjectToken,
        subject_token_type: SUBJECT_TYPE, actor_token: actorToken,
        actor_token_type: ACTOR_TYPE, scope: 'admin:delete',
      }),
    })

    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('invalid_scope')
  })

  it('trust score below minimum returns 403 insufficient_trust', async () => {
    const redis = new MockRedis()
    // Set lyra trust score below STANDARD threshold
    await updateTrustScore(redis as any, LYRA_SPIFFE, 0.3)
    const app = makeApp(redis)
    const subjectToken = await makeSubjectToken()
    const actorToken = await makeSVID(LYRA_SPIFFE)

    const res = await app.inject({
      method: 'POST', url: '/oauth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: formBody({
        grant_type: GRANT_TYPE, subject_token: subjectToken,
        subject_token_type: SUBJECT_TYPE, actor_token: actorToken,
        actor_token_type: ACTOR_TYPE, scope: 'invoke:completion',
      }),
    })

    expect(res.statusCode).toBe(403)
    expect(res.json().error).toBe('insufficient_trust')
  })

  it('rate limit triggers 429 with Retry-After', async () => {
    const redis = new MockRedis()
    const app = Fastify({ logger: false })
    // Register rate-limit globally with a very low max so tests aren't slow
    await app.register(rateLimit, { global: false })
    app.register(tokenRoute, { redis: redis as any, rateLimit: 2 })

    const subjectToken = await makeSubjectToken()
    const actorToken = await makeSVID(LYRA_SPIFFE)
    const reqBody = formBody({
      grant_type: GRANT_TYPE, subject_token: subjectToken,
      subject_token_type: SUBJECT_TYPE, actor_token: actorToken,
      actor_token_type: ACTOR_TYPE, scope: 'invoke:completion',
    })
    const headers = { 'content-type': 'application/x-www-form-urlencoded' }

    // Fire requests until we get a 429
    let got429 = false
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({ method: 'POST', url: '/oauth/token', headers, body: reqBody })
      if (res.statusCode === 429) { got429 = true; break }
    }
    expect(got429).toBe(true)
  })
})
