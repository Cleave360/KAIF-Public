import { randomUUID } from 'crypto'
import Fastify from 'fastify'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import type { FastifyInstance, FastifyServerOptions } from 'fastify'
import type { Redis } from 'ioredis'
import { loadConfig } from './config.js'
import { healthRoute } from './routes/health.js'
import { jwksRoute }   from './routes/jwks.js'
import { introspectRoute } from './routes/introspect.js'
import { tokenRoute }  from './routes/token.js'
import { provisionRoute } from './routes/provision.js'
import { revokeRoute } from './routes/revoke.js'

export interface BuildServerDeps {
  redis: Redis
  rateLimits?: {
    token?:     number   // max req/min on /oauth/token  (default 100)
    introspect?: number  // max req/min on /introspect   (default 500)
    global?:    number   // max req/min everywhere else  (default 1000)
  }
}

const PINO_REDACT = [
  'body.subject_token',
  'body.actor_token',
  'headers.authorization',
  'body.token',
  'body.id_token',
]

export async function buildServer(
  fastifyOpts: FastifyServerOptions = {},
  deps: BuildServerDeps
): Promise<FastifyInstance> {
  const config = loadConfig()

  const app = Fastify({
    genReqId: (req) => (req.headers['x-request-id'] as string | undefined) ?? randomUUID(),
    logger: {
      level:    config.log_level,
      redact:   PINO_REDACT,
      serializers: {
        req(req) {
          return { method: req.method, url: req.url, reqId: req.id }
        },
      },
    },
    ...fastifyOpts,
  })

  // ── Security headers ───────────────────────────────────────────
  await app.register(helmet, { global: true })

  // ── Rate limiting ──────────────────────────────────────────────
  const limits = deps.rateLimits ?? {}
  await app.register(rateLimit, {
    global: true,
    max:    limits.global ?? 1000,
    timeWindow: '1 minute',
    addHeaders: { 'retry-after': true },
  })

  // ── Echo X-Request-ID in responses ────────────────────────────
  app.addHook('onSend', async (request, reply) => {
    reply.header('X-Request-ID', request.id)
  })

  // ── Routes ────────────────────────────────────────────────────
  const { redis } = deps

  await app.register(healthRoute, {
    redis,
    spireEndpoint: config.spire_bundle_endpoint,
    version:       '0.1.0',
  })

  await app.register(jwksRoute)

  await app.register(introspectRoute, { redis })

  await app.register(tokenRoute, {
    redis,
    rateLimit: limits.token ?? 100,
  })

  await app.register(provisionRoute, { redis, issuer: config.issuer, devMode: config.dev_mode })

  await app.register(revokeRoute, { redis })

  // ── Graceful shutdown ──────────────────────────────────────────
  let requestCount = 0
  app.addHook('onRequest', async () => { requestCount++ })
  app.addHook('onResponse', async () => { requestCount-- })

  const shutdown = async (): Promise<void> => {
    app.log.info('SHUTDOWN_INITIATED')
    await app.close()
    try { await (redis as any).quit() } catch { /* already closed */ }
    app.log.info({ final_request_count: requestCount }, 'SHUTDOWN_COMPLETE')
    process.exit(0)
  }

  process.once('SIGTERM', shutdown)
  process.once('SIGINT', shutdown)

  return app
}
