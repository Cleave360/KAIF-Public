import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'crypto'
import Fastify from 'fastify'
import { MockRedis } from '../mock-redis.js'
import { relyingRoute } from '../../src/routes/relying.js'
import { signKAIFToken } from '../../src/crypto/jwt.js'
import { _resetKeyCache } from '../../src/crypto/keys.js'
import type { KAIFTokenClaims } from '../../src/types/kaif.js'

function makeApp(redis: MockRedis, opts: {
  auditAppendUrl?: string
  classCDegradedOpen?: boolean
} = {}) {
  const app = Fastify({ logger: false })
  app.register(relyingRoute, {
    redis: redis as any,
    tenantAddress: 'tenant-dev',
    ...(opts.auditAppendUrl ? { governanceAuditAppendUrl: opts.auditAppendUrl } : {}),
    governanceWorkspaceId:  'ws-kaif',
    governanceProjectId:    'kaif',
    governanceUiInstanceId: 'ui-kaif',
    classCDegradedOpen:     opts.classCDegradedOpen ?? false,
  })
  return app
}

async function makeAuthToken(scope = 'invoke:completion'): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const claims: KAIFTokenClaims = {
    iss:   'https://auth.test.example',
    sub:   'user@example.com',
    aud:   'https://api.example.com',
    iat:   now,
    exp:   now + 300,
    jti:   randomUUID(),
    scope,
    actor: { sub: 'spiffe://kindred.systems/ns/adaptive-layer/agent/lyra', svid_thumbprint: 'sha256:test' },
    may_act: { sub: 'spiffe://kindred.systems/ns/adaptive-layer/agent/lyra' },
    kaif: {
      trust_score: 0.6, trust_tier: 'STANDARD', delegation_depth: 0,
      delegation_id: randomUUID(), rollback_window: 'PT5M',
      principal_chain: ['user@example.com'],
    },
  }
  return signKAIFToken(claims)
}

describe('Day7b relying-party failure-mode endpoints', () => {
  beforeEach(() => {
    _resetKeyCache()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('Class A fails closed when governance evidence endpoint is unavailable', async () => {
    const redis = new MockRedis()
    const app = makeApp(redis)
    const token = await makeAuthToken()

    const res = await app.inject({
      method: 'POST',
      url: '/relying/class-a/authorize',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ run_id: 'run-day7b-test' }),
    })

    expect(res.statusCode).toBe(503)
    expect(res.json()).toMatchObject({
      authorized: false,
      class: 'A',
      policy_decision: 'halt',
      status: 'rejected',
      governance_available: false,
      degraded: false,
    })
  })

  it('Class C fails closed by default when governance is unavailable', async () => {
    const redis = new MockRedis()
    const app = makeApp(redis)
    const token = await makeAuthToken()

    const res = await app.inject({
      method: 'POST',
      url: '/relying/class-c/authorize',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ run_id: 'run-day7b-test' }),
    })

    expect(res.statusCode).toBe(503)
    expect(res.json()).toMatchObject({
      authorized: false,
      class: 'C',
      policy_decision: 'halt',
      status: 'rejected',
      degraded: false,
    })
  })

  it('Class C can degraded-open only when explicitly enabled', async () => {
    const redis = new MockRedis()
    const app = makeApp(redis, { classCDegradedOpen: true })
    const token = await makeAuthToken()

    const res = await app.inject({
      method: 'POST',
      url: '/relying/class-c/authorize',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ run_id: 'run-day7b-test' }),
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      authorized: true,
      class: 'C',
      policy_decision: 'allow',
      status: 'success',
      governance_available: false,
      degraded: true,
      evidence_marker: 'kaif.introspect.degraded',
    })
  })

  it('posts canonical Adaptive auth evidence when governance is available', async () => {
    const redis = new MockRedis()
    const posted: unknown[] = []
    vi.stubGlobal('fetch', async (_url: string | URL, init?: RequestInit) => {
      posted.push(JSON.parse(String(init?.body)))
      return new Response(null, { status: 202 })
    })
    const app = makeApp(redis, { auditAppendUrl: 'http://adaptive.test/v1/audit/append' })
    const token = await makeAuthToken()

    const res = await app.inject({
      method: 'POST',
      url: '/relying/class-a/authorize',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ run_id: 'run-day7b-test', resource: 'vault' }),
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      authorized: true,
      class: 'A',
      policy_decision: 'allow',
      governance_available: true,
    })
    expect(posted).toHaveLength(1)
    expect(posted[0]).toMatchObject({
      layer: 'auth',
      envelope: {
        envelope_version: 'v1',
        tenant_id: 'tenant-dev',
        workspace_id: 'ws-kaif',
        project_id: 'kaif',
        run_id: 'run-day7b-test',
        principal_id: 'kaif-server',
        principal_type: 'service',
        ui_instance_id: 'ui-kaif',
      },
      event: {
        event_type: 'kaif.introspect.ok',
        executor: 'kaif',
        command_preview: 'kaif auth decision',
        policy_decision: 'allow',
        status: 'success',
        source_system: 'KAIF',
      },
    })
    expect((posted[0] as any).event.command_hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('requires invoke:completion scope', async () => {
    const redis = new MockRedis()
    const app = makeApp(redis)
    const token = await makeAuthToken('audit:read')

    const res = await app.inject({
      method: 'POST',
      url: '/relying/class-a/authorize',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ run_id: 'run-day7b-test' }),
    })

    expect(res.statusCode).toBe(403)
    expect(res.json().error).toBe('insufficient_scope')
  })
})
