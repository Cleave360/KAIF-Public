import type { FastifyInstance, FastifyPluginOptions } from 'fastify'
import type { Redis } from 'ioredis'
import { fetchSpireBundle } from '../crypto/spire-bundle.js'

interface HealthOpts extends FastifyPluginOptions {
  redis: Redis
  spireEndpoint: string
  version: string
  fetchBundle?: (endpoint: string) => Promise<unknown>
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
      await (opts.fetchBundle ?? fetchSpireBundle)(opts.spireEndpoint)
      spireStatus = 'reachable'
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
