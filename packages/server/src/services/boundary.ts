import { createHash, randomUUID } from 'crypto'
import type { Redis } from 'ioredis'
import { loadConfig } from '../config.js'
import { KAIFError } from '../errors.js'
import type {
  BoundaryAuthorizationRequest,
  BoundaryDenyResponse,
  BoundaryPermitResponse,
  BoundaryDecisionContext,
  BoundaryEvidence,
  BoundaryHumanIntent,
  KAIFTokenClaims,
} from '../types/kaif.js'
import { appendAudit } from './audit.js'
import { getAgentACLByName, validateScopes } from './acl.js'
import { executeTokenExchange } from './token-exchange.js'
import { invokeFoundry, type FoundryRequestOptions } from './foundry.js'
import { deliverReceiptToDNS } from './dns-delivery.js'

const SUBJECT_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token'
const ACTOR_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:jwt'
const FOUNDRY_RETRY_BACKOFF_MS = [100, 250, 500]

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new KAIFError('invalid_request', `${path} must be a non-empty string`)
  }
  return value.trim()
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function asOptionalNullableString(value: unknown): string | null | undefined {
  if (value === null) return null
  return asOptionalString(value)
}

function asOptionalStringArray(value: unknown, path: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    throw new KAIFError('invalid_request', `${path} must be an array of strings`)
  }
  return value.map((item, index) => asNonEmptyString(item, `${path}[${index}]`))
}

function asOptionalNumber(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new KAIFError('invalid_request', `${path} must be a number`)
  }
  return value
}

function parseIntent(raw: unknown): BoundaryHumanIntent {
  if (!isRecord(raw)) {
    throw new KAIFError('invalid_request', 'human_intent must be an object')
  }

  const intentMode = asNonEmptyString(raw['intent_mode'], 'human_intent.intent_mode')
  if (intentMode !== 'bound' && intentMode !== 'abstracted') {
    throw new KAIFError('invalid_request', 'human_intent.intent_mode must be bound or abstracted')
  }

  if (intentMode === 'bound') {
    const intentHash = asNonEmptyString(raw['intent_hash'], 'human_intent.intent_hash')
    if (!intentHash.startsWith('sha256:')) {
      throw new KAIFError('invalid_request', 'human_intent.intent_hash must use sha256: prefix')
    }
    const intent: BoundaryHumanIntent = {
      intent_mode: 'bound',
      intent_id: asNonEmptyString(raw['intent_id'], 'human_intent.intent_id'),
      intent_type: asNonEmptyString(raw['intent_type'], 'human_intent.intent_type'),
      intent_summary: asNonEmptyString(raw['intent_summary'], 'human_intent.intent_summary'),
      intent_hash: intentHash,
    }
    const intentScope = asOptionalStringArray(raw['intent_scope'], 'human_intent.intent_scope')
    if (intentScope) intent.intent_scope = intentScope
    return intent
  }

  return {
    intent_mode: 'abstracted',
    intent_absence_reason: asNonEmptyString(
      raw['intent_absence_reason'],
      'human_intent.intent_absence_reason'
    ),
  }
}

function parseBoundaryRequest(raw: unknown): BoundaryAuthorizationRequest {
  if (!isRecord(raw)) {
    throw new KAIFError('invalid_request', 'request body must be a JSON object')
  }

  const adaptiveEnvelope = raw['adaptive_envelope']
  if (!isRecord(adaptiveEnvelope)) {
    throw new KAIFError('invalid_request', 'adaptive_envelope must be an object')
  }

  const routeContext = raw['route_context']
  if (!isRecord(routeContext)) {
    throw new KAIFError('invalid_request', 'route_context must be an object')
  }

  const kaifSubject = raw['kaif_subject']
  if (!isRecord(kaifSubject)) {
    throw new KAIFError('invalid_request', 'kaif_subject must be an object')
  }

  const action = raw['action']
  if (!isRecord(action)) {
    throw new KAIFError('invalid_request', 'action must be an object')
  }

  const governance = raw['governance']
  if (governance !== undefined && !isRecord(governance)) {
    throw new KAIFError('invalid_request', 'governance must be an object when present')
  }

  const adaptiveEnvelopeOut: BoundaryAuthorizationRequest['adaptive_envelope'] = {
      envelope_version: asNonEmptyString(adaptiveEnvelope['envelope_version'], 'adaptive_envelope.envelope_version'),
      tenant_id: asNonEmptyString(adaptiveEnvelope['tenant_id'], 'adaptive_envelope.tenant_id'),
      workspace_id: asNonEmptyString(adaptiveEnvelope['workspace_id'], 'adaptive_envelope.workspace_id'),
      project_id: asNonEmptyString(adaptiveEnvelope['project_id'], 'adaptive_envelope.project_id'),
      run_id: asNonEmptyString(adaptiveEnvelope['run_id'], 'adaptive_envelope.run_id'),
      principal_id: asNonEmptyString(adaptiveEnvelope['principal_id'], 'adaptive_envelope.principal_id'),
      principal_type: asNonEmptyString(adaptiveEnvelope['principal_type'], 'adaptive_envelope.principal_type'),
      ui_instance_id: asNonEmptyString(adaptiveEnvelope['ui_instance_id'], 'adaptive_envelope.ui_instance_id'),
    }
  const blueprintId = asOptionalString(adaptiveEnvelope['blueprint_id'])
  const blueprintVersion = asOptionalString(adaptiveEnvelope['blueprint_version'])
  const agentGlobalId = asOptionalNullableString(adaptiveEnvelope['agent_global_id'])
  const purchaseId = asOptionalNullableString(adaptiveEnvelope['purchase_id'])
  const agentInstanceId = asOptionalNullableString(adaptiveEnvelope['agent_instance_id'])
  const agentKeyId = asOptionalNullableString(adaptiveEnvelope['agent_key_id'])
  const policyHash = asOptionalNullableString(adaptiveEnvelope['policy_hash'])
  const leaseId = asOptionalNullableString(adaptiveEnvelope['lease_id'])
  if (blueprintId !== undefined) adaptiveEnvelopeOut.blueprint_id = blueprintId
  if (blueprintVersion !== undefined) adaptiveEnvelopeOut.blueprint_version = blueprintVersion
  if (agentGlobalId !== undefined) adaptiveEnvelopeOut.agent_global_id = agentGlobalId
  if (purchaseId !== undefined) adaptiveEnvelopeOut.purchase_id = purchaseId
  if (agentInstanceId !== undefined) adaptiveEnvelopeOut.agent_instance_id = agentInstanceId
  if (agentKeyId !== undefined) adaptiveEnvelopeOut.agent_key_id = agentKeyId
  if (policyHash !== undefined) adaptiveEnvelopeOut.policy_hash = policyHash
  if (leaseId !== undefined) adaptiveEnvelopeOut.lease_id = leaseId

  const routeContextOut: BoundaryAuthorizationRequest['route_context'] = {
      workflow_id: asNonEmptyString(routeContext['workflow_id'], 'route_context.workflow_id'),
      node_id: asNonEmptyString(routeContext['node_id'], 'route_context.node_id'),
      request_id: asNonEmptyString(routeContext['request_id'], 'route_context.request_id'),
    }
  const workflowVersion = asOptionalString(routeContext['workflow_version'])
  const runtimeNodeId = asOptionalString(routeContext['runtime_node_id'])
  const nodeNumber = asOptionalNumber(routeContext['node_number'], 'route_context.node_number')
  if (workflowVersion !== undefined) routeContextOut.workflow_version = workflowVersion
  if (runtimeNodeId !== undefined) routeContextOut.runtime_node_id = runtimeNodeId
  if (nodeNumber !== undefined) routeContextOut.node_number = nodeNumber

  const actionOut: BoundaryAuthorizationRequest['action'] = {
      operation: asNonEmptyString(action['operation'], 'action.operation'),
      scope: asNonEmptyString(action['scope'], 'action.scope'),
      audience: asNonEmptyString(action['audience'], 'action.audience'),
    }
  const actionResource = asOptionalString(action['resource'])
  if (actionResource !== undefined) actionOut.resource = actionResource

  const request: BoundaryAuthorizationRequest = {
    adaptive_envelope: adaptiveEnvelopeOut,
    route_context: routeContextOut,
    human_intent: parseIntent(raw['human_intent']),
    kaif_subject: {
      human_sub: asNonEmptyString(kaifSubject['human_sub'], 'kaif_subject.human_sub'),
      agent_id: asNonEmptyString(kaifSubject['agent_id'], 'kaif_subject.agent_id'),
      agent_spiffe_id: asNonEmptyString(kaifSubject['agent_spiffe_id'], 'kaif_subject.agent_spiffe_id'),
    },
    action: actionOut,
    subject_token: asNonEmptyString(raw['subject_token'], 'subject_token'),
    actor_token: asNonEmptyString(raw['actor_token'], 'actor_token'),
    subject_token_type: asNonEmptyString(raw['subject_token_type'], 'subject_token_type') as BoundaryAuthorizationRequest['subject_token_type'],
    actor_token_type: asNonEmptyString(raw['actor_token_type'], 'actor_token_type') as BoundaryAuthorizationRequest['actor_token_type'],
  }
  if (governance) {
    const governanceOut: NonNullable<BoundaryAuthorizationRequest['governance']> = {}
    const policyVersion = asOptionalString(governance['policy_version'])
    const mintedAgentRef = asOptionalString(governance['minted_agent_ref'])
    const mintedSkillRefs = asOptionalStringArray(governance['minted_skill_refs'], 'governance.minted_skill_refs')
    if (policyVersion !== undefined) governanceOut.policy_version = policyVersion
    if (mintedAgentRef !== undefined) governanceOut.minted_agent_ref = mintedAgentRef
    if (mintedSkillRefs !== undefined) governanceOut.minted_skill_refs = mintedSkillRefs
    request.governance = governanceOut
  }

  if (request.subject_token_type !== SUBJECT_TOKEN_TYPE) {
    throw new KAIFError('invalid_request', `subject_token_type must be ${SUBJECT_TOKEN_TYPE}`)
  }
  if (request.actor_token_type !== ACTOR_TOKEN_TYPE) {
    throw new KAIFError('invalid_request', `actor_token_type must be ${ACTOR_TOKEN_TYPE}`)
  }
  if (request.adaptive_envelope.blueprint_id && request.route_context.workflow_id !== request.adaptive_envelope.blueprint_id) {
    throw new KAIFError('invalid_request', 'route_context.workflow_id must match adaptive_envelope.blueprint_id when present')
  }

  const declaredAgent = getAgentACLByName(request.kaif_subject.agent_id)
  if (!declaredAgent) {
    throw new KAIFError('access_denied', `Unknown kaif_subject.agent_id: ${request.kaif_subject.agent_id}`)
  }
  if (declaredAgent.spiffe_id !== request.kaif_subject.agent_spiffe_id) {
    throw new KAIFError('invalid_request', 'kaif_subject.agent_spiffe_id does not match configured agent_id')
  }

  const requestedScopes = request.action.scope.split(' ').filter(Boolean)
  if (requestedScopes.length === 0) {
    throw new KAIFError('invalid_scope', 'action.scope must contain at least one scope')
  }
  const scopeCheck = validateScopes(requestedScopes, declaredAgent.permitted_scopes)
  if (!scopeCheck.valid) {
    throw new KAIFError('invalid_scope', `action.scope not permitted for agent: ${scopeCheck.denied.join(', ')}`)
  }

  return request
}

function decodeKAIFClaims(accessToken: string): KAIFTokenClaims {
  const parts = accessToken.split('.')
  if (parts.length !== 3 || !parts[1]) {
    throw new KAIFError('server_error', 'KAIF emitted malformed access token')
  }

  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as KAIFTokenClaims
  } catch {
    throw new KAIFError('server_error', 'Unable to decode KAIF access token')
  }
}

function boundaryContextFromUnknown(raw: unknown, decisionId: string): BoundaryDecisionContext {
  const record = isRecord(raw) ? raw : {}
  const adaptiveEnvelope = isRecord(record['adaptive_envelope']) ? record['adaptive_envelope'] : {}
  const routeContext = isRecord(record['route_context']) ? record['route_context'] : {}

  return {
    request_id: asOptionalString(routeContext['request_id']) ?? null,
    decision_id: decisionId,
    tenant_id: asOptionalString(adaptiveEnvelope['tenant_id']) ?? null,
    run_id: asOptionalString(adaptiveEnvelope['run_id']) ?? null,
    workflow_id: asOptionalString(routeContext['workflow_id']) ?? null,
    node_id: asOptionalString(routeContext['node_id']) ?? null,
  }
}

function intentFromUnknown(raw: unknown): BoundaryDenyResponse['intent'] {
  if (!isRecord(raw)) return { intent_mode: null }
  const humanIntent = isRecord(raw['human_intent']) ? raw['human_intent'] : {}
  const intentMode = asOptionalString(humanIntent['intent_mode'])
  if (intentMode !== 'bound' && intentMode !== 'abstracted') {
    return { intent_mode: null }
  }
  const intent: BoundaryDenyResponse['intent'] = { intent_mode: intentMode }
  const intentId = asOptionalString(humanIntent['intent_id'])
  const intentType = asOptionalString(humanIntent['intent_type'])
  const intentHash = asOptionalString(humanIntent['intent_hash'])
  if (intentId !== undefined) intent.intent_id = intentId
  if (intentType !== undefined) intent.intent_type = intentType
  if (intentHash !== undefined) intent.intent_hash = intentHash
  return intent
}

function buildEvidence(entry: Awaited<ReturnType<typeof appendAudit>>): BoundaryEvidence {
  return {
    audit_event_id: entry.id,
    audit_hash: entry.hash,
    prev_hash: entry.prev_hash,
    recorded_at: entry.ts,
  }
}

function firstHeader(headers: Record<string, string>, names: string[]): string | undefined {
  for (const name of names) {
    const exact = headers[name]
    if (exact) return exact
    const lower = headers[name.toLowerCase()]
    if (lower) return lower
  }
  return undefined
}

function redactedPreview(body: unknown): string | undefined {
  if (body === null || body === undefined) return undefined
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  const trimmed = text.trim()
  if (!trimmed) return undefined
  return trimmed.length > 280 ? `${trimmed.slice(0, 280)}...` : trimmed
}

function hashBody(body: unknown): string | undefined {
  if (body === null || body === undefined) return undefined
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return `sha256:${createHash('sha256').update(text).digest('hex')}`
}

function buildBoundaryPrompt(request: BoundaryAuthorizationRequest): string {
  const prompt = request.human_intent.intent_mode === 'bound'
    ? request.human_intent.intent_summary
    : request.action.resource ?? request.action.operation

  return [
    'You are the external model behind a KAIF-authorized boundary request.',
    'Return a concise, factual answer that follows the requested task.',
    'Do not claim actions you did not perform.',
    'If structured data is returned, keep it compact and directly relevant to the request.',
    '',
    `Intent: ${prompt}`,
    `Resource: ${request.action.resource ?? 'unspecified'}`,
    `Workflow: ${request.route_context.workflow_id}`,
    `Node: ${request.route_context.node_id}`,
    'Return only the information needed by the caller.',
  ].join('\n')
}

function buildRequestEchoPrompt(request: BoundaryAuthorizationRequest): string {
  return [
    'Use these exact correlation fields in request_echo.',
    'Do not invent or omit them.',
    `request_id: ${request.route_context.request_id}`,
    `run_id: ${request.adaptive_envelope.run_id}`,
    `workflow_id: ${request.route_context.workflow_id}`,
    `workflow_version: ${request.route_context.workflow_version ?? 'null'}`,
    `node_id: ${request.route_context.node_id}`,
  ].join('\n')
}

function buildProjectAgentInput(
  request: BoundaryAuthorizationRequest,
  messages?: unknown[]
): Array<{ role: string, content: string }> {
  const requestEchoPrompt = buildRequestEchoPrompt(request)

  if (Array.isArray(messages) && messages.length > 0) {
    const normalizedMessages = messages.flatMap((message) => {
      if (!isRecord(message)) return []
      const content = message['content']
      if (typeof content === 'string') {
        return [content]
      }
      return []
    })

    return [
      {
        role: 'user',
        content: [
          requestEchoPrompt,
          ...normalizedMessages,
        ].join('\n\n'),
      },
    ]
  }

  return [
    {
      role: 'user',
      content: [
        requestEchoPrompt,
        buildBoundaryPrompt(request),
      ].join('\n\n'),
    },
  ]
}

function buildFoundryBody(rawRequest: unknown, request: BoundaryAuthorizationRequest): unknown {
  const config = loadConfig()
  const record = isRecord(rawRequest) ? rawRequest : {}
  const explicitRequest = record['foundry_request']
  if (isRecord(explicitRequest) || Array.isArray(explicitRequest)) return explicitRequest

  const payload = record['payload']
  if (isRecord(payload) || Array.isArray(payload)) return payload

  const messages = record['messages']
  if (Array.isArray(messages)) {
    if (config.foundry_mode === 'project_agent') {
      return {
        model: config.foundry_model,
        input: buildProjectAgentInput(request, messages),
        agent_reference: {
          name: config.foundry_agent_name,
          version: config.foundry_agent_version,
          type: 'agent_reference',
        },
      }
    }
    return { messages }
  }

  const prompt = buildBoundaryPrompt(request)

  if (config.foundry_mode === 'project_agent') {
    return {
      model: config.foundry_model,
      input: buildProjectAgentInput(request),
      agent_reference: {
        name: config.foundry_agent_name,
        version: config.foundry_agent_version,
        type: 'agent_reference',
      },
    }
  }

  return {
    messages: [
      {
        role: 'system',
        content: 'You are the external model behind a KAIF-authorized boundary request.',
      },
      {
        role: 'user',
        content: prompt,
      },
    ],
  }
}

function extractResponseOutputText(body: Record<string, unknown>): string | undefined {
  if (typeof body['output_text'] === 'string' && body['output_text'].trim().length > 0) {
    return body['output_text']
  }

  const output = body['output']
  if (!Array.isArray(output)) return undefined

  const fragments: string[] = []
  for (const item of output) {
    if (!isRecord(item)) continue
    const content = item['content']
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (!isRecord(part)) continue
      if (typeof part['text'] === 'string' && part['text'].trim().length > 0) {
        fragments.push(part['text'])
      }
    }
  }

  return fragments.length > 0 ? fragments.join('\n') : undefined
}

function summarizeFoundryPayload(body: unknown): unknown {
  if (typeof body === 'string') {
    return { content: body }
  }

  if (!isRecord(body)) return body

  const summary: Record<string, unknown> = {}

  if (typeof body['id'] === 'string') summary['id'] = body['id']
  if (typeof body['object'] === 'string') summary['object'] = body['object']
  if (typeof body['model'] === 'string') summary['model'] = body['model']
  if (typeof body['status'] === 'string') summary['status'] = body['status']
  if (typeof body['created'] === 'number') summary['created'] = body['created']
  if (typeof body['created_at'] === 'number') summary['created_at'] = body['created_at']
  if (isRecord(body['usage'])) summary['usage'] = body['usage']

  const outputText = extractResponseOutputText(body)
  if (outputText !== undefined) {
    summary['result'] = { content: outputText }
  }

  const choices = body['choices']
  if (summary['result'] === undefined && Array.isArray(choices) && choices.length > 0) {
    const firstChoice = choices[0]
    if (isRecord(firstChoice)) {
      const message = isRecord(firstChoice['message']) ? firstChoice['message'] : null
      summary['result'] = {
        ...(typeof firstChoice['finish_reason'] === 'string' ? { finish_reason: firstChoice['finish_reason'] } : {}),
        ...(typeof firstChoice['index'] === 'number' ? { index: firstChoice['index'] } : {}),
        ...(message && typeof message['role'] === 'string' ? { role: message['role'] } : {}),
        ...(message && typeof message['content'] === 'string' ? { content: message['content'] } : {}),
      }
    }
  }

  const error = body['error']
  if (isRecord(error)) {
    summary['error'] = {
      ...(typeof error['message'] === 'string' ? { message: error['message'] } : {}),
      ...(typeof error['type'] === 'string' ? { type: error['type'] } : {}),
      ...(typeof error['param'] === 'string' ? { param: error['param'] } : {}),
      ...(typeof error['code'] === 'string' ? { code: error['code'] } : {}),
    }
  }

  return Object.keys(summary).length > 0 ? summary : body
}

function mapFoundryStatus(status: number, body: unknown): 'success' | 'rejected' | 'error' | 'paused' {
  if (isRecord(body) && typeof body['status'] === 'string') {
    if (body['status'] === 'completed') return 'success'
    if (body['status'] === 'in_progress' || body['status'] === 'queued') return 'paused'
    if (body['status'] === 'failed' || body['status'] === 'incomplete') return 'error'
  }
  if (status === 202) return 'paused'
  if (status >= 200 && status < 300) return 'success'
  if (status === 401 || status === 403 || status === 429) return 'rejected'
  if (isRecord(body)) {
    const error = body['error']
    if (isRecord(error) && typeof error['code'] === 'string' && error['code'].toLowerCase().includes('rate')) {
      return 'paused'
    }
  }
  return 'error'
}

function providerMessage(status: number, body: unknown): string {
  if (isRecord(body)) {
    const error = body['error']
    if (isRecord(error)) {
      const message = error['message']
      const code = error['code']
      if (typeof message === 'string' && message.length > 0) {
        return message
      }
      if (typeof code === 'string' && code.length > 0) {
        return code
      }
    }
  }
  if (typeof body === 'string' && body.trim().length > 0) {
    return body.trim().slice(0, 280)
  }
  return status >= 200 && status < 300 ? 'ok' : `provider returned status ${status}`
}

function providerCode(status: number, body: unknown): string {
  if (isRecord(body)) {
    const error = body['error']
    if (isRecord(error) && typeof error['code'] === 'string' && error['code'].length > 0) {
      return error['code']
    }
  }
  return String(status)
}

function isRetryableFoundryResponse(status: number, body: unknown): boolean {
  if (status === 429 || (status >= 500 && status <= 599)) {
    return true
  }

  if (isRecord(body)) {
    const error = body['error']
    if (isRecord(error)) {
      const code = typeof error['code'] === 'string' ? error['code'].toLowerCase() : ''
      if (code.includes('rate_limit') || code.includes('timeout') || code.includes('server_error')) {
        return true
      }
    }
  }

  return false
}

interface BoundaryPermitContext {
  request: BoundaryAuthorizationRequest
  decisionId: string
  claims: KAIFTokenClaims
  exchange: Awaited<ReturnType<typeof executeTokenExchange>>
  auditEntry: Awaited<ReturnType<typeof appendAudit>>
}

function buildPermitResponse(
  context: BoundaryPermitContext,
  receipt: BoundaryPermitResponse['receipt'],
  delivery?: BoundaryPermitResponse['delivery']
): BoundaryPermitResponse {
  const { request, decisionId, claims, exchange, auditEntry } = context
  const response: BoundaryPermitResponse = {
    decision: 'permit',
    boundary: {
      request_id: request.route_context.request_id,
      decision_id: decisionId,
      tenant_id: request.adaptive_envelope.tenant_id,
      run_id: request.adaptive_envelope.run_id,
      workflow_id: request.route_context.workflow_id,
      node_id: request.route_context.node_id,
    },
    authority: {
      human_sub: request.kaif_subject.human_sub,
      agent_id: request.kaif_subject.agent_id,
      agent_spiffe_id: request.kaif_subject.agent_spiffe_id,
      delegation_id: claims.kaif.delegation_id,
      token_jti: claims.jti,
      scope: exchange.scope,
      audience: Array.isArray(claims.aud) ? claims.aud[0] ?? request.action.audience : claims.aud,
    },
    intent: {
      intent_mode: request.human_intent.intent_mode,
      ...(request.human_intent.intent_id ? { intent_id: request.human_intent.intent_id } : {}),
      ...(request.human_intent.intent_type ? { intent_type: request.human_intent.intent_type } : {}),
      ...(request.human_intent.intent_hash ? { intent_hash: request.human_intent.intent_hash } : {}),
    },
    attestation: {
      trust_tier: claims.kaif.trust_tier,
      trust_score: claims.kaif.trust_score,
      delegation_depth: claims.kaif.delegation_depth,
      ...(claims.cnf ? { cnf: claims.cnf } : {}),
    },
    evidence: buildEvidence(auditEntry),
    token: {
      access_token: exchange.access_token,
      token_type: exchange.token_type,
      expires_in: exchange.expires_in,
      issued_token_type: exchange.issued_token_type,
      scope: exchange.scope,
    },
    receipt,
  }

  if (delivery) {
    response.delivery = delivery
  }

  return response
}

async function runPermitContinuation(params: {
  redis: Redis
  context: BoundaryPermitContext
  foundryBody: unknown
  foundry?: FoundryRequestOptions
}): Promise<void> {
  const { redis, context, foundryBody, foundry } = params
  const { request, decisionId, claims } = context
  const foundryStartedAt = Date.now()
  const maxAttempts = FOUNDRY_RETRY_BACKOFF_MS.length + 1
  let attemptUsed = 1

  let receipt: BoundaryPermitResponse['receipt']
  try {
    let foundryResponse: Awaited<ReturnType<typeof invokeFoundry>> | null = null
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const response = await invokeFoundry({
          method: 'POST',
          body: foundryBody,
          headers: {
            'x-kaif-decision-id': decisionId,
            'x-kaif-request-id': request.route_context.request_id,
            'x-kaif-run-id': request.adaptive_envelope.run_id,
            'x-kaif-tenant-id': request.adaptive_envelope.tenant_id,
            'x-kaif-delegation-id': claims.kaif.delegation_id,
            'x-kaif-token-jti': claims.jti,
            'x-kaif-input-hash': hashBody(foundryBody) ?? 'sha256:missing',
            'x-kaif-node-id': request.route_context.node_id,
            'x-kaif-workflow-id': request.route_context.workflow_id,
          },
        }, foundry)

        attemptUsed = attempt
        if (attempt < maxAttempts && isRetryableFoundryResponse(response.status, response.body)) {
          await sleep(FOUNDRY_RETRY_BACKOFF_MS[attempt - 1] ?? 100)
          continue
        }

        foundryResponse = response
        break
      } catch (err) {
        attemptUsed = attempt
        if (attempt < maxAttempts) {
          await sleep(FOUNDRY_RETRY_BACKOFF_MS[attempt - 1] ?? 100)
          continue
        }
        throw err
      }
    }

    if (!foundryResponse) {
      throw new Error('Foundry invocation did not return a response')
    }

    const foundryReceipt: BoundaryPermitResponse['receipt'] = {
      receipt_version: 'v1',
      receipt_id: randomUUID(),
      decision_id: decisionId,
      request_id: request.route_context.request_id,
      run_id: request.adaptive_envelope.run_id,
      target_system: 'foundry',
      occurred_at_ms: Date.now(),
      result: {
        status: mapFoundryStatus(foundryResponse.status, foundryResponse.body),
        provider_code: providerCode(foundryResponse.status, foundryResponse.body),
        provider_message: `${providerMessage(foundryResponse.status, foundryResponse.body)}${attemptUsed > 1 ? ` (attempt ${attemptUsed}/${maxAttempts})` : ''}`,
      },
      latency_ms: Date.now() - foundryStartedAt,
      receipt_payload: summarizeFoundryPayload(foundryResponse.body),
      delegation_id: claims.kaif.delegation_id,
      token_jti: claims.jti,
    }
    const providerRequestId = firstHeader(foundryResponse.headers, ['x-ms-request-id', 'apim-request-id', 'x-request-id'])
    const providerSessionId = firstHeader(foundryResponse.headers, ['x-ms-session-id'])
    const outputHash = hashBody(foundryResponse.body)
    const outputPreview = redactedPreview(foundryResponse.body)
    if (providerRequestId !== undefined) foundryReceipt.provider_request_id = providerRequestId
    if (providerSessionId !== undefined) foundryReceipt.provider_session_id = providerSessionId
    if (outputHash !== undefined) foundryReceipt.output_hash = outputHash
    if (outputPreview !== undefined) foundryReceipt.output_preview = outputPreview
    receipt = foundryReceipt
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'Foundry transport failure'
    receipt = {
      receipt_version: 'v1',
      receipt_id: randomUUID(),
      decision_id: decisionId,
      request_id: request.route_context.request_id,
      run_id: request.adaptive_envelope.run_id,
      target_system: 'foundry',
      occurred_at_ms: Date.now(),
      result: {
        status: 'error',
        provider_code: 'transport_error',
        provider_message: `${reason}${attemptUsed > 1 ? ` (attempt ${attemptUsed}/${maxAttempts})` : ''}`,
      },
      latency_ms: Date.now() - foundryStartedAt,
      delegation_id: claims.kaif.delegation_id,
      token_jti: claims.jti,
    }
  }

  await appendAudit(redis, {
    action: 'BOUNDARY_RECEIPT',
    detail: `request_id=${request.route_context.request_id} decision_id=${decisionId} status=${receipt.result.status} provider_code=${receipt.result.provider_code}`,
    agent_id: request.kaif_subject.agent_spiffe_id,
    human_id: request.kaif_subject.human_sub,
  })

  const delivery = await deliverReceiptToDNS({
    request,
    response: buildPermitResponse(context, receipt),
  })

  if (delivery.enabled) {
    if (delivery.context_write.status === 'ok') {
      await appendAudit(redis, {
        action: 'BOUNDARY_DELIVERY_WRITTEN',
        detail: `request_id=${request.route_context.request_id} decision_id=${decisionId} context_key=${delivery.context_key ?? 'unknown'} status_code=${delivery.context_write.status_code ?? 0} attempts=${delivery.context_write.attempts ?? 1}`,
        agent_id: request.kaif_subject.agent_spiffe_id,
        human_id: request.kaif_subject.human_sub,
      })
    } else if (delivery.context_write.status === 'error') {
      await appendAudit(redis, {
        action: 'BOUNDARY_DELIVERY_FAILED',
        detail: `request_id=${request.route_context.request_id} decision_id=${decisionId} stage=${delivery.context_write.operation ?? 'context_write'} attempts=${delivery.context_write.attempts ?? 0} reason=${delivery.context_write.error ?? 'unknown'}`,
        agent_id: request.kaif_subject.agent_spiffe_id,
        human_id: request.kaif_subject.human_sub,
      })
    }

    if (delivery.resume.status === 'ok') {
      await appendAudit(redis, {
        action: 'BOUNDARY_RESUME_SENT',
        detail: `request_id=${request.route_context.request_id} decision_id=${decisionId} run_id=${request.adaptive_envelope.run_id} status_code=${delivery.resume.status_code ?? 0} attempts=${delivery.resume.attempts ?? 1}`,
        agent_id: request.kaif_subject.agent_spiffe_id,
        human_id: request.kaif_subject.human_sub,
      })
    } else if (delivery.resume.status === 'error') {
      await appendAudit(redis, {
        action: 'BOUNDARY_RESUME_FAILED',
        detail: `request_id=${request.route_context.request_id} decision_id=${decisionId} run_id=${request.adaptive_envelope.run_id} stage=${delivery.resume.operation ?? 'resume'} attempts=${delivery.resume.attempts ?? 0} reason=${delivery.resume.error ?? 'unknown'}`,
        agent_id: request.kaif_subject.agent_spiffe_id,
        human_id: request.kaif_subject.human_sub,
      })
    }
  }
}

export async function authorizeBoundary(params: {
  redis: Redis
  rawRequest: unknown
  foundry?: FoundryRequestOptions
}): Promise<BoundaryPermitResponse> {
  const request = parseBoundaryRequest(params.rawRequest)
  const decisionId = randomUUID()

  const exchange = await executeTokenExchange({
    redis: params.redis,
    request: {
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: request.subject_token,
      subject_token_type: request.subject_token_type,
      actor_token: request.actor_token,
      actor_token_type: request.actor_token_type,
      scope: request.action.scope,
      audience: request.action.audience,
      ...(request.action.resource ? { resource: request.action.resource } : {}),
    },
  })

  const claims = decodeKAIFClaims(exchange.access_token)
  const auditEntry = await appendAudit(params.redis, {
    action: 'BOUNDARY_PERMIT',
    detail: `request_id=${request.route_context.request_id} decision_id=${decisionId} workflow_id=${request.route_context.workflow_id} node_id=${request.route_context.node_id} audience=${request.action.audience} scope=${request.action.scope}`,
    agent_id: request.kaif_subject.agent_spiffe_id,
    human_id: request.kaif_subject.human_sub,
  })

  const context: BoundaryPermitContext = {
    request,
    decisionId,
    claims,
    exchange,
    auditEntry,
  }
  const foundryBody = buildFoundryBody(params.rawRequest, request)

  setImmediate(() => {
    void runPermitContinuation({
      redis: params.redis,
      context,
      foundryBody,
      ...(params.foundry ? { foundry: params.foundry } : {}),
    }).catch(async (err) => {
      await appendAudit(params.redis, {
        action: 'BOUNDARY_DELIVERY_FAILED',
        detail: `request_id=${request.route_context.request_id} decision_id=${decisionId} stage=async_pipeline attempts=1 reason=${err instanceof Error ? err.message : 'unknown async continuation error'}`,
        agent_id: request.kaif_subject.agent_spiffe_id,
        human_id: request.kaif_subject.human_sub,
      })
    })
  })

  const pendingReceipt: BoundaryPermitResponse['receipt'] = {
    receipt_version: 'v1',
    receipt_id: randomUUID(),
    decision_id: decisionId,
    request_id: request.route_context.request_id,
    run_id: request.adaptive_envelope.run_id,
    target_system: 'foundry',
    occurred_at_ms: Date.now(),
    result: {
      status: 'paused',
      provider_code: 'pending',
      provider_message: 'Accepted for asynchronous continuation',
    },
  }

  const response = buildPermitResponse(context, pendingReceipt, {
    enabled: true,
    context_write: { status: 'skipped' },
    resume: { status: 'skipped' },
  })
  response.status = 'accepted'
  response.async = true

  return response
}

export async function denyBoundary(params: {
  redis: Redis
  rawRequest: unknown
  error: KAIFError
}): Promise<BoundaryDenyResponse> {
  const decisionId = randomUUID()
  const boundary = boundaryContextFromUnknown(params.rawRequest, decisionId)
  const intent = intentFromUnknown(params.rawRequest)
  const requestRecord = isRecord(params.rawRequest) ? params.rawRequest : {}
  const kaifSubject = isRecord(requestRecord['kaif_subject']) ? requestRecord['kaif_subject'] : {}

  const denyAudit: {
    action: 'BOUNDARY_DENY'
    detail: string
    agent_id?: string
    human_id?: string
  } = {
    action: 'BOUNDARY_DENY',
    detail: `request_id=${boundary.request_id ?? 'missing'} decision_id=${decisionId} code=${params.error.code} reason=${params.error.description}`,
  }
  const denyAgentId = asOptionalString(kaifSubject['agent_spiffe_id'])
  const denyHumanId = asOptionalString(kaifSubject['human_sub'])
  if (denyAgentId !== undefined) denyAudit.agent_id = denyAgentId
  if (denyHumanId !== undefined) denyAudit.human_id = denyHumanId

  const auditEntry = await appendAudit(params.redis, denyAudit)

  return {
    decision: 'deny',
    boundary,
    intent,
    error: {
      code: params.error.code,
      reason: params.error.description,
    },
    evidence: buildEvidence(auditEntry),
  }
}
