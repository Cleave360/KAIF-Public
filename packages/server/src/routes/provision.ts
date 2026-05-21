import { randomUUID } from 'crypto'
import type { FastifyInstance, FastifyPluginOptions } from 'fastify'
import type { Redis } from 'ioredis'
import { signKAIFToken, verifyIdpToken } from '../crypto/jwt.js'
import { getAgentACLByName, validateScopes } from '../services/acl.js'
import { appendAudit } from '../services/audit.js'
import type { DelegationGrant } from '../types/kaif.js'

const DEV_MOCK_TOKEN     = 'dev-mock-token'
const DEV_MOCK_PRINCIPAL = 'dev@local'

interface ProvisionOpts extends FastifyPluginOptions {
  redis:    Redis
  issuer:   string
  devMode?: boolean
}

interface ProvisionBody {
  id_token:     string
  agent_id:     string
  scope:        string
  ttl_seconds?: number
}

const bodySchema = {
  type: 'object',
  required: ['id_token', 'agent_id', 'scope'],
  properties: {
    id_token:    { type: 'string', minLength: 1 },
    agent_id:    { type: 'string', minLength: 1 },
    scope:       { type: 'string', minLength: 1 },
    ttl_seconds: { type: 'number' },
  },
  additionalProperties: false,
}

const MIN_TTL = 60
const MAX_TTL = 86400
const DEFAULT_TTL = 900

export async function provisionRoute(app: FastifyInstance, opts: ProvisionOpts): Promise<void> {
  app.post<{ Body: ProvisionBody }>(
    '/provision',
    { schema: { body: bodySchema } },
    async (request, reply) => {
      const { id_token, agent_id, scope, ttl_seconds } = request.body

      // Step 1: Verify id_token against configured IdP.
      // In dev_mode, accept a hardcoded mock token so local demos run without a real IdP.
      let humanPrincipal: string
      if (opts.devMode && id_token === DEV_MOCK_TOKEN) {
        humanPrincipal = DEV_MOCK_PRINCIPAL
      } else {
        let idPayload: Record<string, unknown>
        try {
          idPayload = await verifyIdpToken(id_token) as Record<string, unknown>
        } catch {
          return reply.status(401).send({
            error: 'invalid_client',
            error_description: 'id_token is invalid or from an untrusted issuer',
          })
        }

        // Step 2: Extract human principal
        const principal =
          (typeof idPayload['email'] === 'string' ? idPayload['email'] : null) ??
          (typeof idPayload['sub'] === 'string' ? idPayload['sub'] : null)

        if (!principal) {
          return reply.status(400).send({
            error: 'invalid_request',
            error_description: 'id_token missing email or sub claim',
          })
        }
        humanPrincipal = principal
      }

      // Step 3: Look up agent in ACL (agent_id is the yaml name key, not SPIFFE ID)
      const agentACL = getAgentACLByName(agent_id)
      if (!agentACL) {
        return reply.status(400).send({
          error: 'invalid_request',
          error_description: `Unknown agent_id: ${agent_id}`,
        })
      }

      // Step 4: Validate requested scopes
      const requestedScopes = scope.split(' ').filter(Boolean)
      const { valid, denied } = validateScopes(requestedScopes, agentACL.permitted_scopes)
      if (!valid) {
        return reply.status(400).send({
          error: 'invalid_scope',
          error_description: `Scopes not permitted for agent ${agent_id}: ${denied.join(', ')}`,
        })
      }

      // Step 5: Clamp TTL
      const ttl = Math.min(MAX_TTL, Math.max(MIN_TTL, ttl_seconds ?? DEFAULT_TTL))
      const now = Math.floor(Date.now() / 1000)
      const expiresAt = now + ttl

      // Step 6: Write DelegationGrant to Redis
      const delegationId = randomUUID()
      const grant: DelegationGrant = {
        delegation_id:   delegationId,
        human_principal: humanPrincipal,
        agent_spiffe_id: agentACL.spiffe_id,
        granted_scopes:  requestedScopes,
        expires_at:      expiresAt,
        created_at:      now,
        audit_hash:      '',  // filled after audit write below
      }

      // Step 7: Write audit entry
      const auditEntry = await appendAudit(opts.redis, {
        action:   'DELEGATION_PROVISIONED',
        detail:   `agent=${agent_id} scope=${scope} ttl=${ttl}`,
        human_id: humanPrincipal,
      })

      grant.audit_hash = auditEntry.hash

      await opts.redis.set(
        `kaif:delegation:${delegationId}`,
        JSON.stringify(grant),
        'EX',
        ttl
      )

      // Step 8: Sign and return the delegation JWT.
      // This JWT becomes the subject_token for POST /oauth/token.
      //
      // svid_thumbprint is 'pending' because the executing agent's SVID is not
      // known at provision time — it is presented and bound at token exchange.
      // /provision establishes HUMAN authority; /oauth/token binds it to a
      // specific SPIRE-attested workload. These are intentionally separate steps.
      const delegationToken = await signKAIFToken({
        iss:   opts.issuer,
        sub:   humanPrincipal,
        aud:   opts.issuer,       // audience is the KAIF server (self-issued grant)
        iat:   now,
        exp:   expiresAt,
        jti:   delegationId,     // UUID v4 — same value as the Redis key suffix
        scope: requestedScopes.join(' '),
        actor: {
          sub:             agentACL.spiffe_id,
          svid_thumbprint: 'pending',
        },
        may_act: { sub: agentACL.spiffe_id },
        kaif: {
          trust_score:      0,
          trust_tier:       'PROVISIONAL',
          delegation_depth: 0,
          delegation_id:    delegationId,
          rollback_window:  'PT0S',
          principal_chain:  [humanPrincipal],
        },
      })

      return reply.status(200).send({
        delegation_id:    delegationId,     // UUID — for audit lookup
        delegation_token: delegationToken,  // signed JWT — use as subject_token
        expires_at:       expiresAt,
        agent_id,
        scope:            requestedScopes.join(' '),
      })
    }
  )
}
