import { loadConfig } from '../config.js'
import type { BoundaryAuthorizationRequest, BoundaryPermitResponse } from '../types/kaif.js'

export interface DNSDeliveryStatus {
  status: 'ok' | 'error' | 'skipped'
  operation?: 'context_write' | 'resume'
  status_code?: number
  error?: string
  attempts?: number
}

export interface DNSDeliveryResult {
  enabled: boolean
  context_key?: string
  context_write: DNSDeliveryStatus
  resume: DNSDeliveryStatus
}

interface DNSDeliveryDeps {
  fetchImpl?: typeof fetch
  waitImpl?: (ms: number) => Promise<void>
}

const DEFAULT_DNS_WRITE_TIMEOUT_MS = 15000
const DEFAULT_DNS_RESUME_TIMEOUT_MS = 10000
const DNS_DELIVERY_RETRIES = 3
const RETRY_BACKOFF_MS = [250, 500, 1000]

function parseProviderStatusCode(providerCode: string): number {
  const numeric = Number.parseInt(providerCode, 10)
  return Number.isFinite(numeric) ? numeric : 200
}

function normalizeReceiptStatus(status: BoundaryPermitResponse['receipt']['result']['status']): 'completed' | 'failed' {
  return status === 'success' ? 'completed' : 'failed'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function extractWrappedResultFromReceiptPayload(payload: unknown): Record<string, unknown> | null {
  if (!isRecord(payload)) return null

  const result = payload['result']
  if (!isRecord(result)) return null
  const content = result['content']
  if (typeof content !== 'string' || content.trim().length === 0) return null

  try {
    const parsed = JSON.parse(content) as unknown
    if (isRecord(parsed)) {
      return parsed
    }
  } catch {
    // Fall through to deterministic fallback shape.
  }

  return null
}

function buildWrappedResult(
  request: BoundaryAuthorizationRequest,
  receipt: BoundaryPermitResponse['receipt']
): Record<string, unknown> {
  const parsedWrapped = extractWrappedResultFromReceiptPayload(receipt.receipt_payload)
  if (parsedWrapped) {
    return parsedWrapped
  }

  const requestId = request.route_context.request_id
  const runId = request.adaptive_envelope.run_id
  const workflowId = request.route_context.workflow_id
  const workflowVersion = request.route_context.workflow_version ?? request.adaptive_envelope.blueprint_version ?? 'v1'
  const nodeId = request.route_context.node_id
  const normalizedStatus = normalizeReceiptStatus(receipt.result.status)

  return {
    wrapper_version: 'foundry_boundary_wrapper_v1',
    request_echo: {
      request_id: requestId,
      run_id: runId,
      workflow_id: workflowId,
      workflow_version: workflowVersion,
      node_id: nodeId,
    },
    status: normalizedStatus,
    agent_result: {
      schema_version: 'foundry_boundary_agent_response_v1',
      status: normalizedStatus,
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
        result: buildWrappedResult(request, response.receipt),
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

function partitionHeaders(request: BoundaryAuthorizationRequest): Record<string, string> {
  const headers: Record<string, string> = {}
  const canvasInstanceId = request.adaptive_envelope.ui_instance_id
  const workspaceId = request.adaptive_envelope.workspace_id
  const tenantId = request.adaptive_envelope.tenant_id

  if (canvasInstanceId.trim().length > 0) {
    headers['x-dns-canvas-instance-id'] = canvasInstanceId
  }
  if (workspaceId.trim().length > 0) {
    headers['x-dns-workspace-id'] = workspaceId
  }
  if (tenantId.trim().length > 0) {
    headers['x-dns-tenant-id'] = tenantId
  }

  return headers
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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message
  }
  return 'request failed'
}

async function postJsonWithRetry(params: {
  fetchImpl: typeof fetch
  waitImpl: (ms: number) => Promise<void>
  operation: 'context_write' | 'resume'
  url: string
  headers: Record<string, string>
  body: unknown
  timeoutMs: number
}): Promise<DNSDeliveryStatus> {
  const maxAttempts = DNS_DELIVERY_RETRIES + 1
  let lastStatusCode: number | undefined
  let lastError = 'request failed'

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await postJson(params.fetchImpl, params.url, params.headers, params.body, params.timeoutMs)
      lastStatusCode = response.status

      if (response.ok) {
        return {
          status: 'ok',
          operation: params.operation,
          status_code: response.status,
          attempts: attempt,
        }
      }

      lastError = `${params.operation} failed with status ${response.status}`
      if (attempt < maxAttempts && isRetryableStatus(response.status)) {
        await params.waitImpl(RETRY_BACKOFF_MS[Math.min(attempt - 1, RETRY_BACKOFF_MS.length - 1)] ?? 1000)
        continue
      }

      return {
        status: 'error',
        operation: params.operation,
        status_code: response.status,
        attempts: attempt,
        error: `${lastError} after ${attempt} attempt(s)`,
      }
    } catch (error) {
      lastError = describeError(error)
      if (attempt < maxAttempts) {
        await params.waitImpl(RETRY_BACKOFF_MS[Math.min(attempt - 1, RETRY_BACKOFF_MS.length - 1)] ?? 1000)
        continue
      }
    }
  }

  return {
    status: 'error',
    operation: params.operation,
    ...(lastStatusCode !== undefined ? { status_code: lastStatusCode } : {}),
    attempts: maxAttempts,
    error: `${params.operation} failed after ${maxAttempts} attempt(s): ${lastError}`,
  }
}

export async function deliverReceiptToDNS(params: {
  request: BoundaryAuthorizationRequest
  response: BoundaryPermitResponse
  deps?: DNSDeliveryDeps
}): Promise<DNSDeliveryResult> {
  const config = loadConfig()
  const fetchImpl = params.deps?.fetchImpl ?? fetch
  const waitImpl = params.deps?.waitImpl ?? sleep

  if (!config.dns_delivery_enabled) {
    return {
      enabled: false,
      context_write: { status: 'skipped', operation: 'context_write' },
      resume: { status: 'skipped', operation: 'resume' },
    }
  }

  const baseUrl = config.dns_base_url
  const authToken = config.dns_auth_token
  const authMode = config.dns_auth_mode ?? 'bearer'

  if (!baseUrl || !authToken) {
    return {
      enabled: true,
      context_write: { status: 'error', operation: 'context_write', error: 'dns delivery enabled but base url or auth token missing' },
      resume: { status: 'skipped', operation: 'resume' },
    }
  }

  const headers = {
    ...authHeaders(authMode, authToken),
    ...partitionHeaders(params.request),
  }
  const contextPayload = buildContextWritePayload(params.request, params.response)
  const contextWriteUrl = new URL('/api/context/write', baseUrl).toString()
  const resumeUrl = new URL('/api/workflow/v2/resume', baseUrl).toString()

  const contextWrite = await postJsonWithRetry({
    fetchImpl,
    waitImpl,
    operation: 'context_write',
    url: contextWriteUrl,
    headers,
    body: contextPayload,
    timeoutMs: config.dns_write_timeout_ms ?? DEFAULT_DNS_WRITE_TIMEOUT_MS,
  })

  if (contextWrite.status !== 'ok') {
    return {
      enabled: true,
      context_key: contextPayload.context_key,
      context_write: contextWrite,
      resume: { status: 'skipped', operation: 'resume' },
    }
  }

  const resume = await postJsonWithRetry({
    fetchImpl,
    waitImpl,
    operation: 'resume',
    url: resumeUrl,
    headers,
    body: { run_id: params.request.adaptive_envelope.run_id },
    timeoutMs: config.dns_resume_timeout_ms ?? DEFAULT_DNS_RESUME_TIMEOUT_MS,
  })

  return {
    enabled: true,
    context_key: contextPayload.context_key,
    context_write: contextWrite,
    resume,
  }
}
