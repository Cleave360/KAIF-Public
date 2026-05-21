import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Fastify from 'fastify'
import { MockRedis } from '../mock-redis.js'
import { healthRoute } from '../../src/routes/health.js'

const TEST_VERSION = '0.1.0-test'
const SPIRE_ENDPOINT = 'http://spire.test:8081/bundles/jwt'

function makeApp(redis: MockRedis, fetchImpl?: typeof fetch) {
  const app = Fastify({ logger: false })
  if (fetchImpl) vi.stubGlobal('fetch', fetchImpl)
  app.register(healthRoute, {
    redis: redis as any,
    spireEndpoint: SPIRE_ENDPOINT,
    version: TEST_VERSION,
  })
  return app
}

describe('GET /health', () => {
  let redis: MockRedis

  beforeEach(() => {
    redis = new MockRedis()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns 200 with status ok when Redis and SPIRE reachable', async () => {
    const app = makeApp(
      redis,
      async () => new Response(null, { status: 200 }) as Response
    )
    const res = await app.inject({ method: 'GET', url: '/health' })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.status).toBe('ok')
    expect(body.redis).toBe('connected')
    expect(body.spire).toBe('reachable')
    expect(typeof body.uptime).toBe('number')
    expect(body.version).toBe(TEST_VERSION)
  })

  it('returns 200 with status degraded when Redis unreachable', async () => {
    redis.ping = async () => { throw new Error('ECONNREFUSED') }
    const app = makeApp(
      redis,
      async () => new Response(null, { status: 200 }) as Response
    )
    const res = await app.inject({ method: 'GET', url: '/health' })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.status).toBe('degraded')
    expect(body.redis).toBe('disconnected')
    expect(body.spire).toBe('reachable')
  })

  it('returns 200 with status degraded when SPIRE unreachable', async () => {
    const app = makeApp(
      redis,
      async () => { throw new Error('ECONNREFUSED') }
    )
    const res = await app.inject({ method: 'GET', url: '/health' })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.status).toBe('degraded')
    expect(body.redis).toBe('connected')
    expect(body.spire).toBe('unreachable')
  })

  it('response shape matches schema exactly', async () => {
    const app = makeApp(
      redis,
      async () => new Response(null, { status: 200 }) as Response
    )
    const res = await app.inject({ method: 'GET', url: '/health' })
    const body = res.json()

    expect(Object.keys(body).sort()).toEqual(['redis', 'spire', 'status', 'uptime', 'version'].sort())
    expect(['ok', 'degraded']).toContain(body.status)
    expect(['connected', 'disconnected']).toContain(body.redis)
    expect(['reachable', 'unreachable']).toContain(body.spire)
  })
})
