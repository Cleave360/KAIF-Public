import { randomUUID } from 'crypto'
import type { Redis } from 'ioredis'
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

const SUBJECT_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token'
const ACTOR_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:jwt'

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

export async function authorizeBoundary(params: {
  redis: Redis
  rawRequest: unknown
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

  return {
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
  }
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
