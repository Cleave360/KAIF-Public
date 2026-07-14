import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createLocalJWKSet, exportJWK, exportPKCS8, generateKeyPair, SignJWT } from 'jose'
import { createPublicKey, randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import type { JWK, KeyLike } from 'jose'
import { buildServer } from '../src/server.js'
import { _resetKeyCache } from '../src/crypto/keys.js'
import { _resetIdpJWKSCache, _resetSpireJWKSCache, _setIdpJWKS, _setRawSpireKeys, _setSpireJWKS } from '../src/crypto/jwt.js'
import { MockRedis } from './mock-redis.js'
import { updateTrustScore } from '../src/services/trust-score.js'

const AGENTS_CONFIG = new URL('../config/agents.yaml', import.meta.url).pathname
const LYRA_SPIFFE = 'spiffe://example.org/ns/adaptive-layer/agent/lyra'
const HUMAN = 'geoff@kindred.systems'

const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:token-exchange'
const SUBJECT_TYPE = 'urn:ietf:params:oauth:token-type:access_token'
const ACTOR_TYPE = 'urn:ietf:params:oauth:token-type:jwt'

let dir: string
let redis: MockRedis
let appA: FastifyInstance
let appB: FastifyInstance
let spirePrivKey: KeyLike
let spireJwk: JWK & { kid: string }
let idpPrivKey: KeyLike
let idpJwk: JWK & { kid: string }
let actorToken: string
let oldAccessToken: string
let newAccessToken: string

function setBaseEnv(): void {
  process.env['KAIF_ISSUER'] = 'https://auth.rotation.test'
  process.env['KAIF_REDIS_URL'] = 'redis://localhost:6379'
  process.env['KAIF_SPIRE_BUNDLE_ENDPOINT'] = 'https://spire.rotation.test:8081/'
  process.env['KAIF_SPIRE_TRUST_DOMAIN'] = 'kindred.systems'
  process.env['KAIF_IDP_JWKS_URL'] = 'https://idp.rotation.test/.well-known/jwks.json'
  process.env['KAIF_IDP_ISSUER'] = 'https://idp.rotation.test'
  process.env['KAIF_AGENTS_CONFIG_PATH'] = AGENTS_CONFIG
  process.env['KAIF_STRICT_REVOCATION'] = 'false'
  process.env['KAIF_LOG_LEVEL'] = 'silent'
}

async function writePrivateKey(path: string, key: KeyLike): Promise<void> {
  await writeFile(path, await exportPKCS8(key, 'RS256'))
}

async function writePublicKey(path: string, jwk: JWK): Promise<void> {
  const publicOnly = Object.fromEntries(
    Object.entries(jwk).filter(([key]) => ['kty', 'n', 'e'].includes(key))
  ) as JWK
  const pem = createPublicKey({ key: publicOnly, format: 'jwk' })
    .export({ format: 'pem', type: 'spki' })
    .toString()
  await writeFile(path, pem)
}

async function provisionGrant(app: FastifyInstance): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const idToken = await new SignJWT({ sub: 'sub-geoff', email: HUMAN })
    .setProtectedHeader({ alg: 'RS256', kid: idpJwk.kid })
    .setIssuer('https://idp.rotation.test')
    .setAudience('kaif-server')
    .setIssuedAt(now)
    .setExpirationTime(now + 900)
    .sign(idpPrivKey)

  const res = await app.inject({
    method: 'POST',
    url: '/provision',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id_token: idToken,
      agent_id: 'lyra',
      scope: 'invoke:completion audit:read',
    }),
  })

  expect(res.statusCode).toBe(200)
  return res.json<{ delegation_token: string }>().delegation_token
}

async function exchange(app: FastifyInstance, subjectToken: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/oauth/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: GRANT_TYPE,
      subject_token: subjectToken,
      subject_token_type: SUBJECT_TYPE,
      actor_token: actorToken,
      actor_token_type: ACTOR_TYPE,
      scope: 'invoke:completion',
    }).toString(),
  })

  expect(res.statusCode).toBe(200)
  return res.json<{ access_token: string }>().access_token
}

beforeAll(async () => {
  setBaseEnv()
  dir = await mkdtemp(join(tmpdir(), 'kaif-rotation-integ-'))

  const spirePair = await generateKeyPair('RS256', { modulusLength: 2048 })
  spirePrivKey = spirePair.privateKey as KeyLike
  const spireRaw = await exportJWK(spirePair.publicKey)
  spireJwk = { ...spireRaw, kid: 'spire-rotation', alg: 'RS256' }

  const idpPair = await generateKeyPair('RS256', { modulusLength: 2048 })
  idpPrivKey = idpPair.privateKey as KeyLike
  const idpRaw = await exportJWK(idpPair.publicKey)
  idpJwk = { ...idpRaw, kid: 'idp-rotation', alg: 'RS256' }

  _resetKeyCache()
  _resetSpireJWKSCache()
  _resetIdpJWKSCache()
  _setSpireJWKS(createLocalJWKSet({ keys: [spireJwk] }))
  _setRawSpireKeys([spireJwk])
  _setIdpJWKS(createLocalJWKSet({ keys: [idpJwk] }))

  redis = new MockRedis()
  await updateTrustScore(redis as any, LYRA_SPIFFE, 0.85)

  const now = Math.floor(Date.now() / 1000)
  actorToken = await new SignJWT({ sub: LYRA_SPIFFE })
    .setProtectedHeader({ alg: 'RS256', kid: spireJwk.kid })
    .setIssuedAt(now)
    .setExpirationTime(now + 600)
    .sign(spirePrivKey)

  const activeAPath = join(dir, 'active-a.pem')
  const activeBPath = join(dir, 'active-b.pem')
  const retainedAPath = join(dir, 'retained-a-public.pem')

  const keyA = await generateKeyPair('RS256', { modulusLength: 2048 })
  const keyB = await generateKeyPair('RS256', { modulusLength: 2048 })
  await writePrivateKey(activeAPath, keyA.privateKey as KeyLike)
  await writePrivateKey(activeBPath, keyB.privateKey as KeyLike)
  await writePublicKey(retainedAPath, await exportJWK(keyA.publicKey))

  process.env['KAIF_PRIVATE_KEY_PATH'] = activeAPath
  delete process.env['KAIF_RETAINED_KEY_PATHS']
  _resetKeyCache()
  appA = await buildServer({}, { redis: redis as any, rateLimits: { token: 10000, global: 10000 } })

  const grantA = await provisionGrant(appA)
  oldAccessToken = await exchange(appA, grantA)

  process.env['KAIF_PRIVATE_KEY_PATH'] = activeBPath
  process.env['KAIF_RETAINED_KEY_PATHS'] = retainedAPath
  _resetKeyCache()
  appB = await buildServer({}, { redis: redis as any, rateLimits: { token: 10000, global: 10000 } })

  const grantB = await provisionGrant(appB)
  newAccessToken = await exchange(appB, grantB)
})

afterAll(async () => {
  vi.unstubAllGlobals()
  await appA?.close()
  await appB?.close()
  redis?.reset()
  await rm(dir, { recursive: true, force: true })
  delete process.env['KAIF_PRIVATE_KEY_PATH']
  delete process.env['KAIF_RETAINED_KEY_PATHS']
  _resetKeyCache()
})

describe('key rotation rolling verification', () => {
  it('publishes both active and retained keys after rotation', async () => {
    const res = await appB.inject({ method: 'GET', url: '/.well-known/jwks.json' })
    expect(res.statusCode).toBe(200)
    const body = res.json<{ keys: Array<{ kid: string }> }>()
    expect(body.keys).toHaveLength(2)
  })

  it('introspects a token signed before rotation as active after restart', async () => {
    const res = await appB.inject({
      method: 'POST',
      url: '/introspect',
      headers: {
        authorization: `Bearer ${oldAccessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ token: oldAccessToken }),
    })

    expect(res.statusCode).toBe(200)
    expect(res.json<{ active: boolean }>().active).toBe(true)
  })

  it('issues tokens signed by the new active key after rotation', async () => {
    const res = await appB.inject({
      method: 'POST',
      url: '/introspect',
      headers: {
        authorization: `Bearer ${newAccessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ token: newAccessToken }),
    })

    expect(res.statusCode).toBe(200)
    expect(res.json<{ active: boolean }>().active).toBe(true)
  })
})
