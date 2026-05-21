import type { FastifyInstance, FastifyPluginOptions } from 'fastify'
import type { Redis } from 'ioredis'
import { verifyJWT } from '../crypto/jwt.js'
import { isRevoked } from '../services/revocation.js'
import {
  hasRequiredScopes,
  requireKAIFAuth,
  type KAIFAuthenticatedRequest,
} from './_auth.js'

interface IntrospectOpts extends FastifyPluginOptions {
  redis: Redis
}

interface IntrospectBody {
  token: string
}

const bodySchema = {
  type: 'object',
  required: ['token'],
  properties: {
    token: { type: 'string', minLength: 1 },
  },
  additionalProperties: false,
}

export async function introspectRoute(app: FastifyInstance, opts: IntrospectOpts): Promise<void> {
  app.post<{ Body: IntrospectBody }>(
    '/introspect',
    {
      schema: { body: bodySchema },
      preHandler: requireKAIFAuth({ redis: opts.redis }),
    },
    async (request, reply) => {
      const { token } = request.body
      const authPayload = (request as KAIFAuthenticatedRequest).kaifAuth ?? {}

      let payload: Record<string, unknown>
      try {
        payload = await verifyJWT(token) as Record<string, unknown>
      } catch {
        return reply.status(200).send({ active: false })
      }

      const jti = typeof payload['jti'] === 'string' ? payload['jti'] : null
      const callerJti = typeof authPayload['jti'] === 'string' ? authPayload['jti'] : null
      const isSelfIntrospection = callerJti !== null && callerJti === jti
      if (!isSelfIntrospection && !hasRequiredScopes(authPayload, ['audit:read'])) {
        return reply.status(403).send({
          error: 'insufficient_scope',
          error_description: 'Bearer token requires audit:read to introspect another token',
        })
      }

      if (jti && await isRevoked(opts.redis, jti)) {
        return reply.status(200).send({ active: false })
      }

      return reply.status(200).send({ active: true, ...payload })
    }
  )
}
