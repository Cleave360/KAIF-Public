/**
 * KAIF smoke test — verifies the server starts and core endpoints respond.
 * Connects to real Redis. Requires KAIF_REDIS_URL and other env vars.
 *
 * Usage:  npx tsx scripts/smoke.ts
 * Exit:   0 = pass, 1 = any failure
 */
import { Redis } from 'ioredis'
import { loadConfig } from '../packages/server/src/config.js'
import { buildServer } from '../packages/server/src/server.js'
import type { FastifyInstance } from 'fastify'

const TIMEOUT_MS = 5000

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`${label} timed out after ${TIMEOUT_MS}ms`)), TIMEOUT_MS)
  )
  return Promise.race([promise, timeout])
}

async function main(): Promise<void> {
  console.log('KAIF smoke test starting...')

  const config = loadConfig()
  let redis: Redis | null = null
  let app: FastifyInstance | null = null

  try {
    // Step 1: Connect to Redis
    console.log(`  [1/4] Connecting to Redis at ${config.redis_url}`)
    redis = new Redis(config.redis_url, { lazyConnect: true })
    await withTimeout(redis.connect(), 'Redis connect')
    console.log('  [1/4] Redis connected ✓')

    // Step 2: Start server
    console.log(`  [2/4] Starting KAIF server on port ${config.port}`)
    app = await withTimeout(buildServer({}, { redis }), 'buildServer')
    await withTimeout(
      app.listen({ port: config.port, host: config.host }),
      'server listen'
    )
    const baseUrl = `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`
    console.log(`  [2/4] Server listening at ${baseUrl} ✓`)

    // Step 3: GET /health
    console.log('  [3/4] Checking /health')
    const healthRes = await withTimeout(fetch(`${baseUrl}/health`), 'GET /health')
    if (!healthRes.ok) throw new Error(`/health returned HTTP ${healthRes.status}`)
    const health = await healthRes.json() as { status: string; redis: string }
    if (health.redis !== 'connected') throw new Error(`Redis reports: ${health.redis}`)
    // SPIRE may be 'unreachable' in local dev — that is acceptable; only Redis must be 'connected'
    if (health.status === 'ok' || health.redis === 'connected') {
      console.log(`  [3/4] /health → status=${health.status} redis=${health.redis} ✓`)
    }

    // Step 4: GET /.well-known/jwks.json
    console.log('  [4/4] Checking /.well-known/jwks.json')
    const jwksRes = await withTimeout(fetch(`${baseUrl}/.well-known/jwks.json`), 'GET /jwks')
    if (!jwksRes.ok) throw new Error(`/jwks returned HTTP ${jwksRes.status}`)
    const jwks = await jwksRes.json() as { keys: unknown[] }
    if (!Array.isArray(jwks.keys) || jwks.keys.length === 0) {
      throw new Error('/jwks returned empty or invalid keys array')
    }
    console.log(`  [4/4] /.well-known/jwks.json → ${jwks.keys.length} key(s) ✓`)

    console.log('\nKAIF smoke test passed — server ready')
    process.exit(0)

  } catch (err) {
    console.error('\nKAIF smoke test FAILED:', (err as Error).message)
    process.exit(1)

  } finally {
    await app?.close().catch(() => { /* ignore close errors */ })
    await redis?.quit().catch(() => { /* ignore quit errors */ })
  }
}

main()
