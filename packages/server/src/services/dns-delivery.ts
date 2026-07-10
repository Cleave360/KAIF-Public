import { loadConfig } from '../config.js'
import type { BoundaryAuthorizationRequest, BoundaryPermitResponse } from '../types/kaif.js'

export interface DNSDeliveryStatus {
  status: 'ok' | 'error' | 'skipped'
  status_code?: number
  error?: string
}

export interface DNSDeliveryResult {
  enabled: boolean
  context_key?: string
  context_write: DNSDeliveryStatus
  resume: DNSDeliveryStatus
}

interface DNSDeliveryDeps {
  fetchImpl?: typeof fetch
}

function parseProviderStatusCode(providerCode: string): number {
  const numeric = Number.parseInt(providerCode, 10)
  return Number.isFinite(numeric) ? numeric : 200
}

function normalizeReceiptStatus(status: BoundaryPermitResponse['receipt']['result']['status']): 'completed' | 'failed' {
  return status === 'success' ? 'completed' : 'failed'
}

function buildWrappedResult(receipt: BoundaryPermitResponse['receipt']): Record<string, unknown> {
  const payload = receipt.receipt_payload
  if (payload && typeof payload === 'object') {
    return payload as Record<string, unknown>
  }

  return {
    wrapper_version: 'foundry_boundary_wrapper_v1',
    status: normalizeReceiptStatus(receipt.result.status),
    agent_result: {
      schema_version: 'foundry_boundary_agent_response_v1',
      status: normalizeReceiptStatus(receipt.result.status),
      result_type: receipt.result.status === 'success' ? 'information_response' : 'error_response',
      result_summary: receipt.result.provider_message,
      artifacts: [],
      evidence: [],
      risks: [],
      missing_inputs: [],
      recommended_next_step: 'Continue DNS handling.',
    },
  }
}

function buildContextWritePayload(request: BoundaryAuthorizationRequest, response: BoundaryPermitResponse): {
  tenant_id: string
  context_key: string
  run_id: string
  node_id: string
  blueprint_id: string
  blueprint_version: string
  value: Record<string, unknown>
} {
  const requestId = request.route_context.request_id
  const runId = request.adaptive_envelope.run_id
  const tenantId = request.adaptive_envelope.tenant_id
  const workflowId = request.route_context.workflow_id
  const workflowVersion = request.route_context.workflow_version ?? request.adaptive_envelope.blueprint_version ?? 'v1'
  const nodeId = request.route_context.node_id
  const contextKey = `receipt:${tenantId}:${runId}:${requestId}`

  return {
    tenant_id: tenantId,
    context_key: contextKey,
    run_id: runId,
    node_id: nodeId,
    blueprint_id: request.adaptive_envelope.blueprint_id ?? workflowId,
    blueprint_version: request.adaptive_envelope.blueprint_version ?? workflowVersion,
    value: {
      decision: response.decision,
      receipt: {
        status: normalizeReceiptStatus(response.receipt.result.status),
        request_binding: {
          request_id: requestId,
          run_id: runId,
          workflow_id: workflowId,
          workflow_version: workflowVersion,
          node_id: nodeId,
          delegation_id: response.boundary.decision_id,
          intent_id: request.human_intent.intent_id ?? `intent:${tenantId}:${runId}:${nodeId}`,
        },
        platform: {
          provider_request_id: response.receipt.provider_request_id ?? 'unknown',
          provider_status_code: parseProviderStatusCode(response.receipt.result.provider_code),
        },
        result: buildWrappedResult(response.receipt),
        recorded_at: new Date(response.receipt.occurred_at_ms).toISOString(),
      },
    },
  }
}

function authHeaders(mode: 'bearer' | 'header' | 'both', token: string): Record<string, string> {
  if (mode === 'bearer') return { authorization: `Bearer ${token}` }
  if (mode === 'header') return { 'x-dns-auth-token': token }
  return {
    authorization: `Bearer ${token}`,
    'x-dns-auth-token': token,
  }
}

async function postJson(fetchImpl: typeof fetch, url: string, headers: Record<string, string>, body: unknown, timeoutMs: number): Promise<Response> {
  return fetchImpl(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
}

export async function deliverReceiptToDNS(params: {
  request: BoundaryAuthorizationRequest
  response: BoundaryPermitResponse
  deps?: DNSDeliveryDeps
}): Promise<DNSDeliveryResult> {
  const config = loadConfig()
  const fetchImpl = params.deps?.fetchImpl ?? fetch

  if (!config.dns_delivery_enabled) {
    return {
      enabled: false,
      context_write: { status: 'skipped' },
      resume: { status: 'skipped' },
    }
  }

  const baseUrl = config.dns_base_url
  const authToken = config.dns_auth_token
  const authMode = config.dns_auth_mode ?? 'bearer'

  if (!baseUrl || !authToken) {
    return {
      enabled: true,
      context_write: { status: 'error', error: 'dns delivery enabled but base url or auth token missing' },
      resume: { status: 'skipped' },
    }
  }

  const headers = authHeaders(authMode, authToken)
  const contextPayload = buildContextWritePayload(params.request, params.response)
  const contextWriteUrl = new URL('/api/context/write', baseUrl).toString()
  const resumeUrl = new URL('/api/workflow/v2/resume', baseUrl).toString()

  try {
    const contextResponse = await postJson(
      fetchImpl,
      contextWriteUrl,
      headers,
      contextPayload,
      config.dns_write_timeout_ms ?? 5000
    )

    if (!contextResponse.ok) {
      return {
        enabled: true,
        context_key: contextPayload.context_key,
        context_write: {
          status: 'error',
          status_code: contextResponse.status,
          error: 'dns context write failed',
        },
        resume: { status: 'skipped' },
      }
    }

    const resumeResponse = await postJson(
      fetchImpl,
      resumeUrl,
      headers,
      { run_id: params.request.adaptive_envelope.run_id },
      config.dns_resume_timeout_ms ?? 5000
    )

    if (!resumeResponse.ok) {
      return {
        enabled: true,
        context_key: contextPayload.context_key,
        context_write: { status: 'ok', status_code: contextResponse.status },
        resume: {
          status: 'error',
          status_code: resumeResponse.status,
          error: 'dns workflow resume failed',
        },
      }
    }

    return {
      enabled: true,
      context_key: contextPayload.context_key,
      context_write: { status: 'ok', status_code: contextResponse.status },
      resume: { status: 'ok', status_code: resumeResponse.status },
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'dns delivery failed'
    return {
      enabled: true,
      context_key: contextPayload.context_key,
      context_write: { status: 'error', error: message },
      resume: { status: 'skipped' },
    }
  }
}
