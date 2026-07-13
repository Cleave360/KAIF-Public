import type { FastifyInstance, FastifyPluginOptions } from 'fastify'
import type { Redis } from 'ioredis'
import { KAIFError } from '../errors.js'
import type { FoundryRequestOptions } from '../services/foundry.js'
import { authorizeBoundary, denyBoundary } from '../services/boundary.js'

interface BoundaryRouteOpts extends FastifyPluginOptions {
  redis: Redis
  foundry?: FoundryRequestOptions
}

export async function boundaryRoute(app: FastifyInstance, opts: BoundaryRouteOpts): Promise<void> {
  app.post(
    '/v1/boundary/authorize',
    async (request, reply) => {
      const startedAt = Date.now()
      try {
        const response = await authorizeBoundary({
          redis: opts.redis,
          rawRequest: request.body,
          ...(opts.foundry ? { foundry: opts.foundry } : {}),
        })
        const elapsedMs = Date.now() - startedAt
        reply.header('x-kaif-authorize-response-ms', String(elapsedMs))
        request.log.info({
          metric: 'authorize_response_ms',
          authorize_response_ms: elapsedMs,
          request_id: response.boundary.request_id,
          decision_id: response.boundary.decision_id,
        }, 'boundary_authorize_metric')
        return reply.status(202).send(response)
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
