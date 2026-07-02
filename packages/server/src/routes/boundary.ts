import type { FastifyInstance, FastifyPluginOptions } from 'fastify'
import type { Redis } from 'ioredis'
import { KAIFError } from '../errors.js'
import { authorizeBoundary, denyBoundary } from '../services/boundary.js'

interface BoundaryRouteOpts extends FastifyPluginOptions {
  redis: Redis
}

export async function boundaryRoute(app: FastifyInstance, opts: BoundaryRouteOpts): Promise<void> {
  app.post(
    '/v1/boundary/authorize',
    async (request, reply) => {
      try {
        const response = await authorizeBoundary({
          redis: opts.redis,
          rawRequest: request.body,
        })
        return reply.status(200).send(response)
      } catch (err) {
        if (err instanceof KAIFError) {
          const denyResponse = await denyBoundary({
            redis: opts.redis,
            rawRequest: request.body,
            error: err,
          })
          return reply.status(err.httpStatus).send(denyResponse)
        }

        request.log.error({ err }, 'boundary_authorize_error')
        return reply.status(500).send({
          error: 'server_error',
          error_description: 'Internal server error',
        })
      }
    }
  )
}
