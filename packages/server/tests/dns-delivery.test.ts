import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deliverReceiptToDNS } from '../src/services/dns-delivery.js'
import type { BoundaryAuthorizationRequest, BoundaryPermitResponse } from '../src/types/kaif.js'

const originalEnv = { ...process.env }

function setBaseEnv(): void {
  process.env['KAIF_ISSUER'] = 'https://auth.test'
  process.env['KAIF_REDIS_URL'] = 'redis://localhost:6379'
  process.env['KAIF_SPIRE_BUNDLE_ENDPOINT'] = 'https://spire.test/'
  process.env['KAIF_SPIRE_TRUST_DOMAIN'] = 'kindred.systems'
  process.env['KAIF_IDP_JWKS_URL'] = 'https://idp.test/jwks'
  process.env['KAIF_IDP_ISSUER'] = 'https://idp.test'
  process.env['KAIF_AGENTS_CONFIG_PATH'] = new URL('../config/agents.yaml', import.meta.url).pathname
}

function makeRequest(): BoundaryAuthorizationRequest {
  return {
    adaptive_envelope: {
      envelope_version: 'v1',
      tenant_id: 'tenant-example',
      workspace_id: 'ws-dns',
      project_id: 'digital-nervous-system',
      blueprint_id: 'foundry_boundary_review_auto_recipe_v2',
      blueprint_version: 'v2',
      run_id: 'run-auto-dns-live-912',
      principal_id: 'user@example.com',
      principal_type: 'human',
      ui_instance_id: 'canvas-1',
    },
    route_context: {
      workflow_id: 'foundry_boundary_review_auto_recipe_v2',
      workflow_version: 'v2',
      node_id: 'node_6',
      request_id: 'c01f739f-d1b3-4a6e-93e5-953aab4e0a20',
    },
    human_intent: {
      intent_mode: 'bound',
      intent_id: 'intent:tenant-example:run-auto-dns-live-912:node_6',
      intent_type: 'external_data_receive',
      intent_summary: 'Receive data from Foundry Agent for boundary node node_6',
      intent_hash: 'sha256:abcd1234',
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
      resource: 'dns.change-request',
    },
    subject_token: 'subject-token',
    actor_token: 'actor-token',
    subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
    actor_token_type: 'urn:ietf:params:oauth:token-type:jwt',
  }
}

function makeResponse(): BoundaryPermitResponse {
  return {
    decision: 'permit',
    boundary: {
      request_id: 'c01f739f-d1b3-4a6e-93e5-953aab4e0a20',
      decision_id: 'dec-123',
      tenant_id: 'tenant-example',
      run_id: 'run-auto-dns-live-912',
      workflow_id: 'foundry_boundary_review_auto_recipe_v2',
      node_id: 'node_6',
    },
    authority: {
      human_sub: 'user@example.com',
      agent_id: 'lyra',
      agent_spiffe_id: 'spiffe://example.org/ns/adaptive-layer/agent/lyra',
      delegation_id: 'deleg-123',
      token_jti: 'jti-123',
      scope: 'invoke:completion',
      audience: 'urn:example:foundry:example-resource:gpt-5-mini',
    },
    intent: {
      intent_mode: 'bound',
      intent_id: 'intent:tenant-example:run-auto-dns-live-912:node_6',
      intent_type: 'external_data_receive',
      intent_hash: 'sha256:abcd1234',
    },
    attestation: {
      trust_tier: 'STANDARD',
      trust_score: 0.6,
      delegation_depth: 0,
    },
    evidence: {
      audit_event_id: 'audit-123',
      audit_hash: 'a'.repeat(64),
      prev_hash: '0'.repeat(64),
      recorded_at: new Date().toISOString(),
    },
    token: {
      access_token: 'token',
      token_type: 'Bearer',
      expires_in: 600,
      issued_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      scope: 'invoke:completion',
    },
    receipt: {
      receipt_version: 'v1',
      receipt_id: 'receipt-123',
      decision_id: 'dec-123',
      request_id: 'c01f739f-d1b3-4a6e-93e5-953aab4e0a20',
      run_id: 'run-auto-dns-live-912',
      target_system: 'foundry',
      occurred_at_ms: Date.now(),
      result: {
        status: 'success',
        provider_code: '200',
        provider_message: 'ok',
      },
      provider_request_id: 'foundry-req-123',
      receipt_payload: {
        wrapper_version: 'foundry_boundary_wrapper_v1',
        status: 'completed',
      },
      delegation_id: 'deleg-123',
      token_jti: 'jti-123',
    },
  }
}

describe('deliverReceiptToDNS', () => {
  beforeEach(() => {
    process.env = { ...originalEnv }
    setBaseEnv()
    delete process.env['KAIF_DNS_DELIVERY_ENABLED']
    delete process.env['KAIF_DNS_BASE_URL']
    delete process.env['KAIF_DNS_AUTH_MODE']
    delete process.env['KAIF_DNS_AUTH_TOKEN']
    delete process.env['KAIF_DNS_WRITE_TIMEOUT_MS']
    delete process.env['KAIF_DNS_RESUME_TIMEOUT_MS']
  })

  afterEach(() => {
    process.env = { ...originalEnv }
    vi.restoreAllMocks()
  })

  it('skips delivery when feature flag is disabled', async () => {
    const result = await deliverReceiptToDNS({
      request: makeRequest(),
      response: makeResponse(),
    })

    expect(result.enabled).toBe(false)
    expect(result.context_write.status).toBe('skipped')
    expect(result.resume.status).toBe('skipped')
  })

  it('writes context then resumes workflow when enabled', async () => {
    process.env['KAIF_DNS_DELIVERY_ENABLED'] = 'true'
    process.env['KAIF_DNS_BASE_URL'] = 'http://127.0.0.1:19082'
    process.env['KAIF_DNS_AUTH_MODE'] = 'both'
    process.env['KAIF_DNS_AUTH_TOKEN'] = 'dev-example-token'

    const fetchImpl = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = input instanceof URL ? input.toString() : String(input)
      const body = JSON.parse(String(init?.body))
      const headers = init?.headers as Record<string, string>

      expect(headers['authorization']).toBe('Bearer dev-example-token')
      expect(headers['x-dns-auth-token']).toBe('dev-example-token')
      expect(headers['x-dns-canvas-instance-id']).toBe('canvas-1')
      expect(headers['x-dns-workspace-id']).toBe('ws-dns')
      expect(headers['x-dns-tenant-id']).toBe('tenant-example')

      if (url.endsWith('/api/context/write')) {
        expect(body.run_id).toBe('run-auto-dns-live-912')
        expect(body.context_key).toBe('receipt:tenant-example:run-auto-dns-live-912:c01f739f-d1b3-4a6e-93e5-953aab4e0a20')
        expect(body.value.decision).toBe('permit')
        expect(body.value.receipt.request_binding.request_id).toBe('c01f739f-d1b3-4a6e-93e5-953aab4e0a20')
        expect(body.value.receipt.request_binding.run_id).toBe('run-auto-dns-live-912')
        expect(body.value.receipt.request_binding.workflow_id).toBe('foundry_boundary_review_auto_recipe_v2')
        expect(body.value.receipt.request_binding.workflow_version).toBe('v2')
        expect(body.value.receipt.request_binding.node_id).toBe('node_6')
        expect(body.value.receipt.platform.provider_status_code).toBe(200)
        expect(body.value.receipt.result.wrapper_version).toBe('foundry_boundary_wrapper_v1')
        expect(body.value.receipt.result.request_echo.request_id).toBe('c01f739f-d1b3-4a6e-93e5-953aab4e0a20')
        expect(body.value.receipt.result.request_echo.run_id).toBe('run-auto-dns-live-912')
        expect(body.value.receipt.result.request_echo.workflow_id).toBe('foundry_boundary_review_auto_recipe_v2')
        expect(body.value.receipt.result.request_echo.workflow_version).toBe('v2')
        expect(body.value.receipt.result.request_echo.node_id).toBe('node_6')
        expect(body.value.receipt.result.status).toBe('completed')
        expect(body.value.receipt.result.agent_result.schema_version).toBe('foundry_boundary_agent_response_v1')
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
      }

      expect(url.endsWith('/api/workflow/v2/resume')).toBe(true)
      expect(body.run_id).toBe('run-auto-dns-live-912')
      return new Response(JSON.stringify({ resumed: true }), { status: 200, headers: { 'content-type': 'application/json' } })
    })

    const result = await deliverReceiptToDNS({
      request: makeRequest(),
      response: makeResponse(),
      deps: { fetchImpl: fetchImpl as typeof fetch },
    })

    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(result.enabled).toBe(true)
    expect(result.context_write.status).toBe('ok')
    expect(result.resume.status).toBe('ok')
  })

  it('parses wrapped result JSON from receipt_payload.result.content when available', async () => {
    process.env['KAIF_DNS_DELIVERY_ENABLED'] = 'true'
    process.env['KAIF_DNS_BASE_URL'] = 'http://127.0.0.1:19082'
    process.env['KAIF_DNS_AUTH_TOKEN'] = 'dev-example-token'

    const response = makeResponse()
    response.receipt.receipt_payload = {
      result: {
        content: JSON.stringify({
          wrapper_version: 'foundry_boundary_wrapper_v1',
          request_echo: {
            request_id: 'c01f739f-d1b3-4a6e-93e5-953aab4e0a20',
            run_id: 'run-auto-dns-live-912',
            workflow_id: 'foundry_boundary_review_auto_recipe_v2',
            workflow_version: 'v2',
            node_id: 'node_6',
          },
          status: 'completed',
          agent_result: {
            schema_version: 'foundry_boundary_agent_response_v1',
            status: 'completed',
            result_type: 'information_response',
            result_summary: 'Boundary task completed.',
            artifacts: [],
            evidence: [],
            risks: [],
            missing_inputs: [],
            recommended_next_step: 'Continue DNS handling.',
          },
        }),
      },
    }

    const fetchImpl = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = input instanceof URL ? input.toString() : String(input)
      const body = JSON.parse(String(init?.body))
      const headers = init?.headers as Record<string, string>

      expect(headers['x-dns-canvas-instance-id']).toBe('canvas-1')
      expect(headers['x-dns-workspace-id']).toBe('ws-dns')
      expect(headers['x-dns-tenant-id']).toBe('tenant-example')

      if (url.endsWith('/api/context/write')) {
        expect(body.value.receipt.result.agent_result.result_summary).toBe('Boundary task completed.')
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
      }

      return new Response(JSON.stringify({ resumed: true }), { status: 200, headers: { 'content-type': 'application/json' } })
    })

    const result = await deliverReceiptToDNS({
      request: makeRequest(),
      response,
      deps: { fetchImpl: fetchImpl as typeof fetch },
    })

    expect(result.context_write.status).toBe('ok')
    expect(result.resume.status).toBe('ok')
  })

  it('does not resume if context write fails', async () => {
    process.env['KAIF_DNS_DELIVERY_ENABLED'] = 'true'
    process.env['KAIF_DNS_BASE_URL'] = 'http://127.0.0.1:19082'
    process.env['KAIF_DNS_AUTH_TOKEN'] = 'dev-example-token'

    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: 'bad request' }), { status: 400, headers: { 'content-type': 'application/json' } }))

    const result = await deliverReceiptToDNS({
      request: makeRequest(),
      response: makeResponse(),
      deps: { fetchImpl: fetchImpl as typeof fetch },
    })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(result.context_write.status).toBe('error')
    expect(result.context_write.operation).toBe('context_write')
    expect(result.resume.status).toBe('skipped')
    expect(result.resume.operation).toBe('resume')
  })

  it('retries transient context write failures up to three times before succeeding', async () => {
    process.env['KAIF_DNS_DELIVERY_ENABLED'] = 'true'
    process.env['KAIF_DNS_BASE_URL'] = 'http://127.0.0.1:19082'
    process.env['KAIF_DNS_AUTH_TOKEN'] = 'dev-example-token'

    let contextAttempts = 0
    const fetchImpl = vi.fn(async (input: URL | RequestInfo) => {
      const url = input instanceof URL ? input.toString() : String(input)

      if (url.endsWith('/api/context/write')) {
        contextAttempts += 1
        if (contextAttempts < 4) {
          return new Response(JSON.stringify({ error: 'busy' }), { status: 503, headers: { 'content-type': 'application/json' } })
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
      }

      return new Response(JSON.stringify({ resumed: true }), { status: 200, headers: { 'content-type': 'application/json' } })
    })

    const waitImpl = vi.fn(async () => undefined)

    const result = await deliverReceiptToDNS({
      request: makeRequest(),
      response: makeResponse(),
      deps: { fetchImpl: fetchImpl as typeof fetch, waitImpl },
    })

    expect(result.context_write.status).toBe('ok')
    expect(result.context_write.attempts).toBe(4)
    expect(result.resume.status).toBe('ok')
    expect(waitImpl).toHaveBeenCalledTimes(3)
    expect(fetchImpl).toHaveBeenCalledTimes(5)
  })

  it('fails closed after three retries when context write times out', async () => {
    process.env['KAIF_DNS_DELIVERY_ENABLED'] = 'true'
    process.env['KAIF_DNS_BASE_URL'] = 'http://127.0.0.1:19082'
    process.env['KAIF_DNS_AUTH_TOKEN'] = 'dev-example-token'

    const fetchImpl = vi.fn(async () => {
      throw new Error('The operation was aborted due to timeout')
    })

    const waitImpl = vi.fn(async () => undefined)

    const result = await deliverReceiptToDNS({
      request: makeRequest(),
      response: makeResponse(),
      deps: { fetchImpl: fetchImpl as typeof fetch, waitImpl },
    })

    expect(fetchImpl).toHaveBeenCalledTimes(4)
    expect(waitImpl).toHaveBeenCalledTimes(3)
    expect(result.context_write.status).toBe('error')
    expect(result.context_write.operation).toBe('context_write')
    expect(result.context_write.attempts).toBe(4)
    expect(result.context_write.error).toContain('context_write failed after 4 attempt(s)')
    expect(result.resume.status).toBe('skipped')
  })
})
