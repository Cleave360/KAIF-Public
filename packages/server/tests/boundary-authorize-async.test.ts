import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'crypto'
import type { AuditAction } from '../src/types/kaif.js'

const originalEnv = { ...process.env }

const {
  appendAuditMock,
  executeTokenExchangeMock,
  invokeFoundryMock,
  deliverReceiptToDNSMock,
} = vi.hoisted(() => {
  return {
    appendAuditMock: vi.fn(async (_redis: unknown, params: { action: AuditAction, detail: string }) => ({
      id: randomUUID(),
      ts: new Date().toISOString(),
      action: params.action,
      detail: params.detail,
      hash: 'a'.repeat(64),
      prev_hash: '0'.repeat(64),
    })),
    executeTokenExchangeMock: vi.fn(async () => ({
      access_token: makeToken(),
      token_type: 'Bearer' as const,
      expires_in: 600,
      issued_token_type: 'urn:ietf:params:oauth:token-type:access_token' as const,
      scope: 'invoke:completion',
    })),
    invokeFoundryMock: vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200))
      return {
        status: 200,
        headers: {},
        body: {
          status: 'completed',
          output_text: 'ok',
        },
      }
    }),
    deliverReceiptToDNSMock: vi.fn(async () => ({
      enabled: true,
      context_write: { status: 'ok' as const, status_code: 200, attempts: 1 },
      resume: { status: 'ok' as const, status_code: 200, attempts: 1 },
    })),
  }
})

vi.mock('../src/services/audit.js', () => ({
  appendAudit: appendAuditMock,
}))

vi.mock('../src/services/token-exchange.js', () => ({
  executeTokenExchange: executeTokenExchangeMock,
}))

vi.mock('../src/services/foundry.js', () => ({
  invokeFoundry: invokeFoundryMock,
}))

vi.mock('../src/services/dns-delivery.js', () => ({
  deliverReceiptToDNS: deliverReceiptToDNSMock,
}))

function makeToken(): string {
  const claims = {
    iss: 'https://auth.test',
    sub: 'user@example.com',
    aud: 'urn:example:foundry:example-resource:gpt-5-mini',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 600,
    jti: 'jti-test-123',
    scope: 'invoke:completion',
    actor: {
      sub: 'spiffe://example.org/ns/adaptive-layer/agent/lyra',
      svid_thumbprint: 'sha256:test',
    },
    may_act: {
      sub: 'spiffe://example.org/ns/adaptive-layer/agent/lyra',
    },
    kaif: {
      trust_score: 0.6,
      trust_tier: 'STANDARD',
      delegation_depth: 0,
      delegation_id: 'deleg-test-123',
      rollback_window: 'PT10M',
      principal_chain: ['user@example.com'],
    },
  }

  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  return `header.${payload}.signature`
}

function makeRequest(): Record<string, unknown> {
  return {
    adaptive_envelope: {
      envelope_version: 'v1',
      tenant_id: 'tenant-example',
      workspace_id: 'ws-dns',
      project_id: 'digital-nervous-system',
      blueprint_id: 'foundry_boundary_review_auto_recipe_v2',
      blueprint_version: 'v2',
      run_id: 'run-auto-dns-live-test',
      principal_id: 'user@example.com',
      principal_type: 'human',
      ui_instance_id: 'canvas-mrei8c78-ubjplv',
    },
    route_context: {
      workflow_id: 'foundry_boundary_review_auto_recipe_v2',
      workflow_version: 'v2',
      node_id: 'node_6',
      runtime_node_id: 'external_boundary_http',
      request_id: 'req-test-123',
    },
    human_intent: {
      intent_mode: 'bound',
      intent_id: 'intent:test',
      intent_type: 'external_data_receive',
      intent_summary: 'Receive data from Foundry',
      intent_hash: 'sha256:test',
    },
    kaif_subject: {
      human_sub: 'user@example.com',
      agent_id: 'lyra',
      agent_spiffe_id: 'spiffe://example.org/ns/adaptive-layer/agent/lyra',
    },
    action: {
      operation: 'external-agent.invoke',
      scope: 'invoke:completion',
      audience: 'urn:example:foundry:example-resource:gpt-5-mini',
      resource: 'foundry-agent',
    },
    subject_token: 'subject-token',
    actor_token: 'actor-token',
    subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
    actor_token_type: 'urn:ietf:params:oauth:token-type:jwt',
  }
}

function setBaseEnv(): void {
  process.env['KAIF_ISSUER'] = 'https://auth.test'
  process.env['KAIF_REDIS_URL'] = 'redis://localhost:6379'
  process.env['KAIF_SPIRE_BUNDLE_ENDPOINT'] = 'https://spire.test/'
  process.env['KAIF_SPIRE_TRUST_DOMAIN'] = 'kindred.systems'
  process.env['KAIF_IDP_JWKS_URL'] = 'https://idp.test/jwks'
  process.env['KAIF_IDP_ISSUER'] = 'https://idp.test'
  process.env['KAIF_AGENTS_CONFIG_PATH'] = new URL('../config/agents.yaml', import.meta.url).pathname
}

describe('authorizeBoundary async contract', () => {
  beforeEach(() => {
    process.env = { ...originalEnv }
    setBaseEnv()
    appendAuditMock.mockClear()
    executeTokenExchangeMock.mockClear()
    invokeFoundryMock.mockClear()
    deliverReceiptToDNSMock.mockClear()
  })

  afterEach(() => {
    process.env = { ...originalEnv }
    vi.restoreAllMocks()
  })

  it('returns accepted permit immediately and continues asynchronously', async () => {
    const { authorizeBoundary } = await import('../src/services/boundary.js')

    const startedAt = Date.now()
    const response = await authorizeBoundary({
      redis: {} as never,
      rawRequest: makeRequest(),
    })
    const elapsed = Date.now() - startedAt

    expect(response.decision).toBe('permit')
    expect(response.status).toBe('accepted')
    expect(response.async).toBe(true)
    expect(response.receipt.result.status).toBe('paused')
    expect(response.receipt.result.provider_code).toBe('pending')
    expect(elapsed).toBeLessThan(120)

    expect(invokeFoundryMock).toHaveBeenCalledTimes(0)
    await new Promise((resolve) => setTimeout(resolve, 260))

    expect(invokeFoundryMock).toHaveBeenCalledTimes(1)
    expect(deliverReceiptToDNSMock).toHaveBeenCalledTimes(1)

    const actions = appendAuditMock.mock.calls.map((call) => call[1]?.action)
    expect(actions).toContain('BOUNDARY_PERMIT')
    expect(actions).toContain('BOUNDARY_RECEIPT')
  })

  it('retries transient foundry failure and succeeds on second attempt', async () => {
    invokeFoundryMock
      .mockImplementationOnce(async () => ({
        status: 429,
        headers: {},
        body: {
          error: {
            code: 'rate_limit_exceeded',
            message: 'too many requests',
          },
        },
      }))
      .mockImplementationOnce(async () => ({
        status: 200,
        headers: {},
        body: {
          status: 'completed',
          output_text: 'ok after retry',
        },
      }))

    const { authorizeBoundary } = await import('../src/services/boundary.js')

    const response = await authorizeBoundary({
      redis: {} as never,
      rawRequest: makeRequest(),
    })

    expect(response.status).toBe('accepted')
    expect(response.async).toBe(true)

    await new Promise((resolve) => setTimeout(resolve, 600))

    expect(invokeFoundryMock).toHaveBeenCalledTimes(2)
    expect(deliverReceiptToDNSMock).toHaveBeenCalledTimes(1)

    const receiptAudit = appendAuditMock.mock.calls
      .map((call) => call[1])
      .find((entry) => entry?.action === 'BOUNDARY_RECEIPT')

    expect(receiptAudit?.detail).toContain('status=success')
    expect(receiptAudit?.detail).toContain('provider_code=200')
  })
})
