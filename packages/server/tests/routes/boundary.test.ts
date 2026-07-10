import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose'
import type { JWK, KeyLike } from 'jose'
import { MockRedis } from '../mock-redis.js'
import { boundaryRoute } from '../../src/routes/boundary.js'
import type { FoundryRequestOptions } from '../../src/services/foundry.js'
import {
  _resetSpireJWKSCache,
  _setRawSpireKeys,
  _setSpireJWKS,
  signKAIFToken,
} from '../../src/crypto/jwt.js'
import { _resetKeyCache } from '../../src/crypto/keys.js'
import type { BoundaryAuthorizationRequest, KAIFTokenClaims } from '../../src/types/kaif.js'

const AGENTS_CONFIG = new URL('../../config/agents.yaml', import.meta.url).pathname
const LYRA_SPIFFE = 'spiffe://kindred.systems/ns/adaptive-layer/agent/lyra'

let spirePrivateKey: KeyLike
let spirePublicJWK: JWK & { kid: string }

function setTestEnv() {
  process.env['KAIF_ISSUER'] = 'https://auth.test.example'
  process.env['KAIF_REDIS_URL'] = 'redis://localhost:6379'
  process.env['KAIF_SPIRE_BUNDLE_ENDPOINT'] = 'http://spire.test:8081'
  process.env['KAIF_SPIRE_TRUST_DOMAIN'] = 'kindred.systems'
  process.env['KAIF_IDP_JWKS_URL'] = 'https://idp.test/.well-known/jwks.json'
  process.env['KAIF_IDP_ISSUER'] = 'https://idp.test'
  process.env['KAIF_AGENTS_CONFIG_PATH'] = AGENTS_CONFIG
  process.env['KAIF_ALLOWED_AUDIENCES'] = 'https://auth.test.example,urn:external-agent-platform'
  process.env['KAIF_STRICT_REVOCATION'] = 'false'
  process.env['KAIF_FOUNDRY_PROJECT_ENDPOINT'] = 'https://kindred-1882-resource.cognitiveservices.azure.com'
  process.env['KAIF_FOUNDRY_API_VERSION'] = '2024-02-15-preview'
  process.env['KAIF_FOUNDRY_AUTH_MODE'] = 'api_key'
  process.env['KAIF_FOUNDRY_API_KEY'] = 'test-foundry-key'
  process.env['KAIF_FOUNDRY_INVOKE_PATH'] = '/openai/deployments/gpt-5-mini/chat/completions'
  delete process.env['KAIF_PRIVATE_KEY_PATH']
}

beforeAll(async () => {
  setTestEnv()
  const pair = await generateKeyPair('RS256', { modulusLength: 2048 })
  spirePrivateKey = pair.privateKey as KeyLike
  const raw = await exportJWK(pair.publicKey)
  spirePublicJWK = { ...raw, kid: 'spire-boundary-test', alg: 'RS256' }
})

beforeEach(() => {
  setTestEnv()
  vi.stubGlobal('fetch', vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string> | undefined
    expect(headers?.['api-key']).toBe('test-foundry-key')
    return new Response(JSON.stringify({
      id: 'chatcmpl-test',
      choices: [{ message: { role: 'assistant', content: 'Boundary acknowledged.' } }],
    }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'x-ms-request-id': 'foundry-req-123',
      },
    })
  }))
  _resetKeyCache()
  _resetSpireJWKSCache()
  _setSpireJWKS(createLocalJWKSet({ keys: [spirePublicJWK] }))
  _setRawSpireKeys([spirePublicJWK])
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function makeSVID(spiffeId: string, ttl = 300): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({ sub: spiffeId })
    .setProtectedHeader({ alg: 'RS256', kid: spirePublicJWK.kid })
    .setIssuedAt(now)
    .setExpirationTime(now + ttl)
    .sign(spirePrivateKey)
}

async function makeSubjectToken(scope = 'invoke:completion', depth = 0): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const claims: KAIFTokenClaims = {
    iss: 'https://auth.test.example',
    sub: 'user@example.com',
    aud: 'https://auth.test.example',
    iat: now,
    exp: now + 600,
    jti: crypto.randomUUID(),
    scope,
    actor: { sub: LYRA_SPIFFE, svid_thumbprint: 'pending' },
    may_act: { sub: LYRA_SPIFFE },
    kaif: {
      trust_score: 0.6,
      trust_tier: 'STANDARD',
      delegation_depth: depth,
      delegation_id: crypto.randomUUID(),
      rollback_window: 'PT10M',
      principal_chain: ['user@example.com'],
    },
  }
  return signKAIFToken(claims)
}

function makeRequest(overrides: Partial<BoundaryAuthorizationRequest> = {}): BoundaryAuthorizationRequest {
  return {
    adaptive_envelope: {
      envelope_version: 'v1',
      tenant_id: 'tenant-dev',
      workspace_id: 'ws-dns',
      project_id: 'digital-nervous-system',
      blueprint_id: 'foundry_boundary_review_auto_recipe_v2',
      blueprint_version: 'v2',
      run_id: 'run-dns-001',
      principal_id: 'user@example.com',
      principal_type: 'human',
      ui_instance_id: 'canvas-1',
    },
    route_context: {
      workflow_id: 'foundry_boundary_review_auto_recipe_v2',
      workflow_version: 'v2',
      node_id: 'node_5',
      runtime_node_id: 'external_boundary_http',
      node_number: 5,
      request_id: 'req-123',
    },
    human_intent: {
      intent_mode: 'bound',
      intent_id: 'intent-123',
      intent_type: 'external_data_receive',
      intent_summary: 'Receive data from Foundry Agent for boundary node node_5',
      intent_scope: ['foundry.receive'],
      intent_hash: 'sha256:abcd1234',
    },
    kaif_subject: {
      human_sub: 'user@example.com',
      agent_id: 'lyra',
      agent_spiffe_id: LYRA_SPIFFE,
    },
    action: {
      operation: 'external-agent.invoke',
      scope: 'invoke:completion',
      audience: 'urn:external-agent-platform',
      resource: 'dns.change-request',
    },
    governance: {
      policy_version: 'v1',
      minted_agent_ref: 'aps://agents/dns-final-agent',
      minted_skill_refs: ['aps://skills/dns-change'],
    },
    subject_token: 'subject-token-placeholder',
    actor_token: 'actor-token-placeholder',
    subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
    actor_token_type: 'urn:ietf:params:oauth:token-type:jwt',
    ...overrides,
  }
}

function makeApp(redis: MockRedis, foundry?: FoundryRequestOptions) {
  const app = Fastify({ logger: false })
  app.register(boundaryRoute, { redis: redis as any, foundry })
  return app
}

describe('POST /v1/boundary/authorize', () => {
  it('returns a structured permit response for a valid boundary request', async () => {
    const redis = new MockRedis()
    const app = makeApp(redis, {
      tokenProvider: async () => ({ token: 'foundry-token' }),
    })
    const subjectToken = await makeSubjectToken()
    const actorToken = await makeSVID(LYRA_SPIFFE)

    const res = await app.inject({
      method: 'POST',
      url: '/v1/boundary/authorize',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(makeRequest({
        subject_token: subjectToken,
        actor_token: actorToken,
      })),
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.decision).toBe('permit')
    expect(body.boundary.request_id).toBe('req-123')
    expect(body.boundary.workflow_id).toBe('foundry_boundary_review_auto_recipe_v2')
    expect(body.authority.agent_spiffe_id).toBe(LYRA_SPIFFE)
    expect(body.authority.scope).toBe('invoke:completion')
    expect(body.authority.audience).toBe('urn:external-agent-platform')
    expect(body.intent.intent_hash).toBe('sha256:abcd1234')
    expect(body.token.token_type).toBe('Bearer')
    expect(typeof body.token.access_token).toBe('string')
    expect(body.evidence.audit_hash).toMatch(/^[a-f0-9]{64}$/)
    expect(body.receipt.receipt_version).toBe('v1')
    expect(body.receipt.result.status).toBe('success')
    expect(body.receipt.provider_request_id).toBe('foundry-req-123')
    expect(body.receipt.token_jti).toBe(body.authority.token_jti)
    expect(body.receipt.delegation_id).toBe(body.authority.delegation_id)

    const auditRaw = await redis.lrange('kaif:audit:global', 0, -1)
    const auditActions = auditRaw.map((entry) => JSON.parse(entry).action)
    expect(auditActions).toContain('BOUNDARY_PERMIT')
    expect(auditActions).toContain('BOUNDARY_RECEIPT')
  })

  it('returns a structured deny response when node_id is missing', async () => {
    const redis = new MockRedis()
    const app = makeApp(redis, {
      tokenProvider: async () => ({ token: 'foundry-token' }),
    })

    const invalid = makeRequest()
    ;(invalid.route_context as any).node_id = ''

    const res = await app.inject({
      method: 'POST',
      url: '/v1/boundary/authorize',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(invalid),
    })

    expect(res.statusCode).toBe(400)
    const body = res.json()
    expect(body.decision).toBe('deny')
    expect(body.error.code).toBe('invalid_request')
    expect(body.boundary.request_id).toBe('req-123')
    expect(body.boundary.node_id).toBeNull()
  })

  it('uses the Foundry project agent mode when configured', async () => {
    process.env['KAIF_FOUNDRY_PROJECT_ENDPOINT'] = 'https://kindred-1882-resource.services.ai.azure.com/api/projects/kindred-1882'
    process.env['KAIF_FOUNDRY_API_VERSION'] = '2025-05-15-preview'
    process.env['KAIF_FOUNDRY_MODE'] = 'project_agent'
    process.env['KAIF_FOUNDRY_AUTH_MODE'] = 'azure_ad'
    process.env['KAIF_FOUNDRY_AAD_SCOPE'] = 'https://ai.azure.com/.default'
    process.env['KAIF_FOUNDRY_MODEL'] = 'gpt-5-mini'
    process.env['KAIF_FOUNDRY_AGENT_NAME'] = 'BoundaryAgent'
    process.env['KAIF_FOUNDRY_AGENT_VERSION'] = '2'
    delete process.env['KAIF_FOUNDRY_INVOKE_PATH']

    vi.stubGlobal('fetch', vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = input instanceof URL ? input.toString() : String(input)
      expect(url).toContain('/api/projects/kindred-1882/openai/v1/responses')
      const headers = init?.headers as Record<string, string> | undefined
      expect(headers?.['authorization']).toBe('Bearer foundry-token')
      const body = JSON.parse(String(init?.body))
      expect(body.model).toBe('gpt-5-mini')
      expect(body.agent_reference).toEqual({
        name: 'BoundaryAgent',
        version: '2',
        type: 'agent_reference',
      })
      expect(Array.isArray(body.input)).toBe(true)
      return new Response(JSON.stringify({
        id: 'resp_test_123',
        object: 'response',
        status: 'completed',
        model: 'gpt-5-mini',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'output_text',
                text: '{"wrapper_version":"foundry_boundary_wrapper_v1"}',
              },
            ],
          },
        ],
      }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-ms-request-id': 'foundry-project-req-123',
        },
      })
    }))

    const redis = new MockRedis()
    const app = makeApp(redis, {
      tokenProvider: async () => ({ token: 'foundry-token' }),
    })
    const subjectToken = await makeSubjectToken()
    const actorToken = await makeSVID(LYRA_SPIFFE)

    const res = await app.inject({
      method: 'POST',
      url: '/v1/boundary/authorize',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(makeRequest({
        subject_token: subjectToken,
        actor_token: actorToken,
      })),
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.decision).toBe('permit')
    expect(body.receipt.result.status).toBe('success')
    expect(body.receipt.receipt_payload.result.content).toContain('foundry_boundary_wrapper_v1')
  })

  it('returns a structured deny response when bound human intent is incomplete', async () => {
    const redis = new MockRedis()
    const app = makeApp(redis)

    const invalid = makeRequest()
    ;(invalid.human_intent as any).intent_hash = ''

    const res = await app.inject({
      method: 'POST',
      url: '/v1/boundary/authorize',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(invalid),
    })

    expect(res.statusCode).toBe(400)
    const body = res.json()
    expect(body.decision).toBe('deny')
    expect(body.error.code).toBe('invalid_request')
    expect(body.intent.intent_mode).toBe('bound')
  })

  it('returns a structured deny response when actor identity is invalid', async () => {
    const redis = new MockRedis()
    const app = makeApp(redis)
    const subjectToken = await makeSubjectToken()

    const res = await app.inject({
      method: 'POST',
      url: '/v1/boundary/authorize',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(makeRequest({
        subject_token: subjectToken,
        actor_token: 'not-a-valid-svid',
      })),
    })

    expect(res.statusCode).toBe(401)
    const body = res.json()
    expect(body.decision).toBe('deny')
    expect(body.error.code).toBe('invalid_client')

    const auditRaw = await redis.lrange('kaif:audit:global', -1, -1)
    const auditEntry = JSON.parse(auditRaw[0]!)
    expect(auditEntry.action).toBe('BOUNDARY_DENY')
  })
})
