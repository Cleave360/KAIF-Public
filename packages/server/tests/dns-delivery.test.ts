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
      tenant_id: 'tenant-dev',
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
      intent_id: 'intent:tenant-dev:run-auto-dns-live-912:node_6',
      intent_type: 'external_data_receive',
      intent_summary: 'Receive data from Foundry Agent for boundary node node_6',
      intent_hash: 'sha256:abcd1234',
    },
    kaif_subject: {
      human_sub: 'user@example.com',
      agent_id: 'lyra',
      agent_spiffe_id: 'spiffe://kindred.systems/ns/adaptive-layer/agent/lyra',
    },
    action: {
      operation: 'external-agent.invoke',
      scope: 'invoke:completion',
      audience: 'urn:kindred:foundry:kindred-1882:gpt-5-mini',
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
      tenant_id: 'tenant-dev',
      run_id: 'run-auto-dns-live-912',
      workflow_id: 'foundry_boundary_review_auto_recipe_v2',
      node_id: 'node_6',
    },
    authority: {
      human_sub: 'user@example.com',
      agent_id: 'lyra',
      agent_spiffe_id: 'spiffe://kindred.systems/ns/adaptive-layer/agent/lyra',
      delegation_id: 'deleg-123',
      token_jti: 'jti-123',
      scope: 'invoke:completion',
      audience: 'urn:kindred:foundry:kindred-1882:gpt-5-mini',
    },
    intent: {
      intent_mode: 'bound',
      intent_id: 'intent:tenant-dev:run-auto-dns-live-912:node_6',
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
    process.env['KAIF_DNS_AUTH_TOKEN'] = 'dev-department-head-token'

    const fetchImpl = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = input instanceof URL ? input.toString() : String(input)
      const body = JSON.parse(String(init?.body))
      const headers = init?.headers as Record<string, string>

      expect(headers['authorization']).toBe('Bearer dev-department-head-token')
      expect(headers['x-dns-auth-token']).toBe('dev-department-head-token')

      if (url.endsWith('/api/context/write')) {
        expect(body.run_id).toBe('run-auto-dns-live-912')
        expect(body.context_key).toBe('receipt:tenant-dev:run-auto-dns-live-912:c01f739f-d1b3-4a6e-93e5-953aab4e0a20')
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

  it('does not resume if context write fails', async () => {
    process.env['KAIF_DNS_DELIVERY_ENABLED'] = 'true'
    process.env['KAIF_DNS_BASE_URL'] = 'http://127.0.0.1:19082'
    process.env['KAIF_DNS_AUTH_TOKEN'] = 'dev-department-head-token'

    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: 'bad request' }), { status: 400, headers: { 'content-type': 'application/json' } }))

    const result = await deliverReceiptToDNS({
      request: makeRequest(),
      response: makeResponse(),
      deps: { fetchImpl: fetchImpl as typeof fetch },
    })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(result.context_write.status).toBe('error')
    expect(result.resume.status).toBe('skipped')
  })
})
