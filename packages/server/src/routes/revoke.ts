import type { FastifyInstance, FastifyPluginOptions } from 'fastify'
import type { Redis } from 'ioredis'
import { revokeToken } from '../services/revocation.js'
import { appendAudit } from '../services/audit.js'
import {
  hasRequiredScopes,
  requireKAIFAuth,
  type KAIFAuthenticatedRequest,
} from './_auth.js'

interface RevokeOpts extends FastifyPluginOptions {
  redis: Redis
}

interface RevokeBody {
  token:    string
  reason?:  string
}

const bodySchema = {
  type: 'object',
  required: ['token'],
  properties: {
    token:  { type: 'string', minLength: 1 },
    reason: { type: 'string' },
  },
  additionalProperties: false,
}

export async function revokeRoute(app: FastifyInstance, opts: RevokeOpts): Promise<void> {
  app.post<{ Body: RevokeBody }>(
    '/revoke',
    {
      schema: { body: bodySchema },
      preHandler: requireKAIFAuth({ redis: opts.redis }),
    },
    async (request, reply) => {
      const { token, reason = 'requested' } = request.body
      const authPayload = (request as KAIFAuthenticatedRequest).kaifAuth ?? {}

      // Decode without verifying signature — tokens presented for revocation
      // may be from a rotated key (Security note: intentional)
      const parts = token.split('.')
      if (parts.length !== 3) {
        return reply.status(400).send({
          error: 'invalid_request',
          error_description: 'token does not appear to be a JWT',
        })
      }

      let payload: Record<string, unknown>
      try {
        payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString())
      } catch {
        return reply.status(400).send({
          error: 'invalid_request',
          error_description: 'token payload is not valid JSON',
        })
      }

      const jti = typeof payload['jti'] === 'string' ? payload['jti'] : null
      if (!jti) {
        return reply.status(400).send({
          error: 'invalid_request',
          error_description: 'token missing jti claim',
        })
      }

      const callerJti = typeof authPayload['jti'] === 'string' ? authPayload['jti'] : null
      const isSelfRevocation = callerJti !== null && callerJti === jti
      if (!isSelfRevocation && !hasRequiredScopes(authPayload, ['admin:revoke'])) {
        return reply.status(403).send({
          error: 'insufficient_scope',
          error_description: 'Bearer token requires admin:revoke to revoke another token',
        })
      }

      const exp    = typeof payload['exp'] === 'number' ? payload['exp'] : Math.floor(Date.now() / 1000) + 3600
      const sub    = typeof payload['sub'] === 'string' ? payload['sub'] : 'unknown'
      const actorSub = (payload['actor'] as Record<string, unknown> | undefined)?.['sub']
      const agentId = typeof actorSub === 'string' ? actorSub : 'unknown'

      await revokeToken(opts.redis, jti, agentId, reason, exp)

      await appendAudit(opts.redis, {
        action:  'TOKEN_REVOKED',
        detail:  `jti=${jti} reason=${reason}`,
        ...(sub !== 'unknown'    ? { human_id: sub }     : {}),
        ...(agentId !== 'unknown' ? { agent_id: agentId } : {}),
      })

      // Log JTI only — Security Rule 1
      request.log.info({ jti, reason }, 'TOKEN_REVOKED')

      return reply.status(200).send({ revoked: true, jti })
    }
  )
}
