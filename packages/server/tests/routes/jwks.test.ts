import { describe, it, expect, beforeEach } from 'vitest'
import Fastify from 'fastify'
import { _resetKeyCache } from '../../src/crypto/keys.js'
import { jwksRoute } from '../../src/routes/jwks.js'

describe('GET /.well-known/jwks.json', () => {
  beforeEach(() => {
    _resetKeyCache()
  })

  function makeApp() {
    const app = Fastify({ logger: false })
    app.register(jwksRoute)
    return app
  }

  it('returns 200 with valid JWKS shape', async () => {
    const app = makeApp()
    const res = await app.inject({ method: 'GET', url: '/.well-known/jwks.json' })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(Array.isArray(body.keys)).toBe(true)
  })

  it('keys array contains exactly one key', async () => {
    const app = makeApp()
    const res = await app.inject({ method: 'GET', url: '/.well-known/jwks.json' })
    const body = res.json()
    expect(body.keys).toHaveLength(1)
  })

  it('key has kid, kty, alg, use fields', async () => {
    const app = makeApp()
    const res = await app.inject({ method: 'GET', url: '/.well-known/jwks.json' })
    const key = res.json().keys[0]

    expect(typeof key.kid).toBe('string')
    expect(key.kid.length).toBeGreaterThan(0)
    expect(key.kty).toBe('RSA')
    expect(key.alg).toBe('RS256')
    expect(key.use).toBe('sig')
  })

  it('Cache-Control header is present', async () => {
    const app = makeApp()
    const res = await app.inject({ method: 'GET', url: '/.well-known/jwks.json' })
    expect(res.headers['cache-control']).toBe('public, max-age=3600')
  })

  it('private key fields are absent from response', async () => {
    const app = makeApp()
    const res = await app.inject({ method: 'GET', url: '/.well-known/jwks.json' })
    const key = res.json().keys[0]

    // Security Rule 4: private key never leaves process memory
    expect(key.d).toBeUndefined()
    expect(key.p).toBeUndefined()
    expect(key.q).toBeUndefined()
  })
})
