import { createHash, randomUUID } from 'crypto'
import type { FastifyInstance, FastifyPluginOptions } from 'fastify'
import type { Redis } from 'ioredis'
import { appendAudit } from '../services/audit.js'
import {
  requireKAIFAuth,
  type KAIFAuthenticatedRequest,
} from './_auth.js'

interface RelyingOpts extends FastifyPluginOptions {
  redis: Redis
  tenantAddress?: string
  governanceAuditAppendUrl?: string
  governanceWorkspaceId: string
  governanceProjectId: string
  governanceUiInstanceId: string
  classCDegradedOpen: boolean
}

interface AuthorizeBody {
  run_id?: string
  resource?: string
}

type RelyingClass = 'A' | 'C'
type PolicyDecision = 'allow' | 'deny' | 'halt'
type EventStatus = 'success' | 'rejected' | 'error'

const bodySchema = {
  type: 'object',
  properties: {
    run_id:   { type: 'string', minLength: 1 },
    resource: { type: 'string', minLength: 1 },
  },
  additionalProperties: false,
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function stringClaim(payload: Record<string, unknown>, name: string, fallback: string): string {
  const value = payload[name]
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

function actorSub(payload: Record<string, unknown>): string {
  const actor = payload['actor']
  if (typeof actor === 'object' && actor !== null) {
    const sub = (actor as Record<string, unknown>)['sub']
    if (typeof sub === 'string' && sub.length > 0) return sub
  }
  return 'unknown-agent'
}

function buildGovernancePayload(params: {
  requestId: string
  tenantId: string
  workspaceId: string
  projectId: string
  uiInstanceId: string
  runId: string
  commandHash: string
  eventType: string
  policyDecision: PolicyDecision
  status: EventStatus
}): Record<string, unknown> {
  return {
    request_id: params.requestId,
    layer:      'auth',
    envelope: {
      envelope_version: 'v1',
      tenant_id:        params.tenantId,
      workspace_id:     params.workspaceId,
      project_id:       params.projectId,
      run_id:           params.runId,
      principal_id:     'kaif-server',
      principal_type:   'service',
      ui_instance_id:   params.uiInstanceId,
    },
    event: {
      event_type:      params.eventType,
      executor:        'kaif',
      command_hash:    params.commandHash,
      command_preview: 'kaif auth decision',
      policy_decision: params.policyDecision,
      status:          params.status,
      source_system:   'KAIF',
    },
  }
}

async function appendGovernanceEvidence(
  url: string | undefined,
  payload: Record<string, unknown>
): Promise<{ ok: true; status: number } | { ok: false; status?: number; error: string }> {
  if (!url) {
    return { ok: false, error: 'governance_audit_append_url_unset' }
  }

  try {
    const response = await fetch(url, {
      method:  'POST',
      headers: { 'content-type': 'application/json' },
      body:    JSON.stringify(payload),
      signal:  AbortSignal.timeout(1000),
    })

    if (!response.ok) {
      return { ok: false, status: response.status, error: 'governance_audit_append_failed' }
    }

    return { ok: true, status: response.status }
  } catch (err) {
    return {
      ok:    false,
      error: err instanceof Error ? err.message : 'governance_audit_append_unavailable',
    }
  }
}

export async function relyingRoute(app: FastifyInstance, opts: RelyingOpts): Promise<void> {
  async function authorize(
    relyingClass: RelyingClass,
    request: KAIFAuthenticatedRequest,
    body: AuthorizeBody
  ): Promise<{
    statusCode: number
    response: Record<string, unknown>
  }> {
    const authPayload = request.kaifAuth ?? {}
    const requestId = `kaif-${randomUUID()}`
    const runId = body.run_id ?? request.id
    const humanId = stringClaim(authPayload, 'sub', 'unknown-human')
    const agentId = actorSub(authPayload)
    const jti = stringClaim(authPayload, 'jti', requestId)
    const commandHash = sha256Hex(`${relyingClass}:${jti}:${body.resource ?? 'default'}`)
    const tenantId = opts.tenantAddress ?? 'tenant-example'

    const allowPayload = buildGovernancePayload({
      requestId,
      tenantId,
      workspaceId:   opts.governanceWorkspaceId,
      projectId:     opts.governanceProjectId,
      uiInstanceId:  opts.governanceUiInstanceId,
      runId,
      commandHash,
      eventType:      'kaif.introspect.ok',
      policyDecision: 'allow',
      status:         'success',
    })
    const governance = await appendGovernanceEvidence(opts.governanceAuditAppendUrl, allowPayload)

    if (governance.ok) {
      await appendAudit(opts.redis, {
        action:   `RELYING_CLASS_${relyingClass}_AUTHORIZE`,
        detail:   `request_id=${requestId} class=${relyingClass} policy_decision=allow governance=available`,
        agent_id: agentId,
        human_id: humanId,
      })

      return {
        statusCode: 200,
        response: {
          authorized: true,
          class: relyingClass,
          policy_decision: 'allow',
          status: 'success',
          governance_available: true,
          degraded: false,
          request_id: requestId,
        },
      }
    }

    const degradedOpen = relyingClass === 'C' && opts.classCDegradedOpen
    const policyDecision: PolicyDecision = degradedOpen ? 'allow' : 'halt'
    const status: EventStatus = degradedOpen ? 'success' : 'rejected'
    const eventType = degradedOpen ? 'kaif.introspect.degraded' : 'kaif.token.deny'

    await appendAudit(opts.redis, {
      action:   `RELYING_CLASS_${relyingClass}_AUTHORIZE`,
      detail:   `request_id=${requestId} class=${relyingClass} policy_decision=${policyDecision} governance=unavailable degraded=${degradedOpen} event_type=${eventType}`,
      agent_id: agentId,
      human_id: humanId,
    })

    return {
      statusCode: degradedOpen ? 200 : 503,
      response: {
        authorized: degradedOpen,
        class: relyingClass,
        policy_decision: policyDecision,
        status,
        governance_available: false,
        degraded: degradedOpen,
        evidence_marker: eventType,
        request_id: requestId,
        error: governance.error,
      },
    }
  }

  app.post<{ Body: AuthorizeBody }>(
    '/relying/class-a/authorize',
    {
      schema: { body: bodySchema },
      preHandler: requireKAIFAuth({ redis: opts.redis, requiredScopes: ['invoke:completion'] }),
    },
    async (request, reply) => {
      const result = await authorize('A', request as KAIFAuthenticatedRequest, request.body)
      return reply.status(result.statusCode).send(result.response)
    }
  )

  app.post<{ Body: AuthorizeBody }>(
    '/relying/class-c/authorize',
    {
      schema: { body: bodySchema },
      preHandler: requireKAIFAuth({ redis: opts.redis, requiredScopes: ['invoke:completion'] }),
    },
    async (request, reply) => {
      const result = await authorize('C', request as KAIFAuthenticatedRequest, request.body)
      return reply.status(result.statusCode).send(result.response)
    }
  )
}
