import { Redis } from 'ioredis'
import { loadConfig } from './config.js'
import { buildServer } from './server.js'

async function main(): Promise<void> {
  const config = loadConfig()

  if (config.dev_mode) {
    console.warn('WARNING: KAIF_DEV_MODE is enabled — dev mock token accepted. Do NOT use in production.')
  }

  const redis = new Redis(config.redis_url, { lazyConnect: true })
  await redis.connect()

  const app = await buildServer({}, { redis })
  await app.listen({ port: config.port, host: config.host })
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
