import type { FastifyInstance, FastifyPluginOptions } from 'fastify'
import type { Redis } from 'ioredis'
import { KAIFError } from '../errors.js'
import { executeTokenExchange } from '../services/token-exchange.js'
import type { TokenExchangeRequest } from '../types/kaif.js'

interface TokenRouteOpts extends FastifyPluginOptions {
  redis: Redis
  rateLimit?: number   // max req/min (default 100)
}

const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:token-exchange'
const SUBJECT_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token'
const ACTOR_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:jwt'

function httpStatusForKAIFError(err: KAIFError): number {
  return err.httpStatus
}

export async function tokenRoute(app: FastifyInstance, opts: TokenRouteOpts): Promise<void> {
  // Register urlencoded body parser for this plugin scope
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_req, body, done) => {
      try {
        const params = new URLSearchParams(body as string)
        const result: Record<string, string> = {}
        for (const [k, v] of params) result[k] = v
        done(null, result)
      } catch (e) {
        done(e as Error)
      }
    }
  )

  const routeConfig: Record<string, unknown> = {}
  if (opts.rateLimit !== undefined) {
    routeConfig['rateLimit'] = {
      max: opts.rateLimit,
      timeWindow: '1 minute',
      addHeaders: { 'retry-after': true },
    }
  }

  app.post(
    '/oauth/token',
    { config: routeConfig },
    async (request, reply) => {
      const body = request.body as Record<string, string | undefined>

      // Validate grant_type
      if (body['grant_type'] !== GRANT_TYPE) {
        return reply.status(400).send({
          error: 'invalid_request',
          error_description: 'grant_type must be urn:ietf:params:oauth:grant-type:token-exchange',
        })
      }

      // Validate required fields
      if (!body['subject_token']) {
        return reply.status(400).send({
          error: 'invalid_request',
          error_description: 'subject_token is required',
        })
      }
      if (!body['actor_token']) {
        return reply.status(400).send({
          error: 'invalid_request',
          error_description: 'actor_token is required',
        })
      }

      if (body['subject_token_type'] && body['subject_token_type'] !== SUBJECT_TOKEN_TYPE) {
        return reply.status(400).send({
          error: 'invalid_request',
          error_description: `subject_token_type must be ${SUBJECT_TOKEN_TYPE}`,
        })
      }
      if (body['actor_token_type'] && body['actor_token_type'] !== ACTOR_TOKEN_TYPE) {
        return reply.status(400).send({
          error: 'invalid_request',
          error_description: `actor_token_type must be ${ACTOR_TOKEN_TYPE}`,
        })
      }

      const exchangeRequest: TokenExchangeRequest = {
        grant_type:         GRANT_TYPE,
        subject_token:      body['subject_token']!,
        subject_token_type: SUBJECT_TOKEN_TYPE,
        actor_token:        body['actor_token']!,
        actor_token_type:   ACTOR_TOKEN_TYPE,
        ...(body['scope']    ? { scope:    body['scope'] }    : {}),
        ...(body['audience'] ? { audience: body['audience'] } : {}),
        ...(body['resource'] ? { resource: body['resource'] } : {}),
      }

      const start = Date.now()

      try {
        const response = await executeTokenExchange({ redis: opts.redis, request: exchangeRequest })

        // Log JTI only — never log token values (Security Rule 1)
        const jti = (() => {
          try {
            return JSON.parse(Buffer.from(response.access_token.split('.')[1]!, 'base64url').toString()).jti
          } catch { return 'unknown' }
        })()
        request.log.info({ jti, scope: response.scope, latency_ms: Date.now() - start }, 'TOKEN_ISSUED')

        return reply.status(200).send(response)
      } catch (err) {
        if (err instanceof KAIFError) {
          return reply.status(httpStatusForKAIFError(err)).send(err.toJSON())
        }
        request.log.error({ err }, 'token_exchange_error')
        return reply.status(500).send({ error: 'server_error', error_description: 'Internal server error' })
      }
    }
  )
}
