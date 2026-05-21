import type { FastifyInstance, FastifyPluginOptions } from 'fastify'
import type { Redis } from 'ioredis'

interface HealthOpts extends FastifyPluginOptions {
  redis: Redis
  spireEndpoint: string
  version: string
}

export async function healthRoute(app: FastifyInstance, opts: HealthOpts): Promise<void> {
  app.get('/health', async (_request, reply) => {
    let redisStatus: 'connected' | 'disconnected' = 'disconnected'
    let spireStatus: 'reachable' | 'unreachable' = 'unreachable'

    try {
      await (opts.redis as any).ping()
      redisStatus = 'connected'
    } catch {
      redisStatus = 'disconnected'
    }

    try {
      const resp = await fetch(opts.spireEndpoint, {
        method: 'HEAD',
        signal: AbortSignal.timeout(1000),
      })
      spireStatus = resp.ok ? 'reachable' : 'unreachable'
    } catch {
      spireStatus = 'unreachable'
    }

    const status = redisStatus === 'connected' && spireStatus === 'reachable'
      ? 'ok'
      : 'degraded'

    return reply.status(200).send({
      status,
      redis: redisStatus,
      spire: spireStatus,
      uptime: process.uptime(),
      version: opts.version,
    })
  })
}
