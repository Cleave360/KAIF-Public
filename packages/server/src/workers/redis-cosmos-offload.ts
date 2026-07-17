import { randomUUID } from 'crypto'
import { CosmosClient } from '@azure/cosmos'
import { DefaultAzureCredential } from '@azure/identity'
import { Redis } from 'ioredis'

type UnknownMap = Record<string, unknown>

interface OffloadEvent {
  id: string
  channel: string
  event_type: string
  event_ts: string
  ingested_at: string
  source: 'kaif-redis-pubsub'
  agent_id?: string
  human_id?: string
  run_id?: string
  request_id?: string
  jti?: string
  score?: number
  summary: string
  attributes: UnknownMap
  ttl?: number
  raw_payload?: string
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value || value.trim().length === 0) {
    throw new Error(`${name} is required`)
  }
  return value
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback
  const normalized = value.trim().toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on'
}

function parseChannels(value: string | undefined): string[] {
  const fallback = ['kaif:audit', 'kaif:revocation', 'kaif:authorization-tier']
  if (!value) return fallback

  const channels = value
    .split(',')
    .map(v => v.trim())
    .filter(Boolean)

  return channels.length > 0 ? channels : fallback
}

function isoFromUnixSeconds(seconds: unknown): string | undefined {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return undefined
  return new Date(seconds * 1000).toISOString()
}

function asObject(value: unknown): UnknownMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as UnknownMap
}

function summarizeAudit(payload: UnknownMap): { eventType: string; summary: string; eventTs: string; eventId: string; attrs: UnknownMap } {
  const action = typeof payload['action'] === 'string' ? payload['action'] : 'AUDIT_EVENT'
  const detail = typeof payload['detail'] === 'string' ? payload['detail'] : ''
  const ts = typeof payload['ts'] === 'string' ? payload['ts'] : new Date().toISOString()
  const id = typeof payload['id'] === 'string' ? payload['id'] : randomUUID()

  return {
    eventType: action,
    summary: detail.length > 0 ? detail : action,
    eventTs: ts,
    eventId: id,
    attrs: {
      hash: payload['hash'],
      prev_hash: payload['prev_hash'],
    },
  }
}

function summarizeRevocation(payload: UnknownMap): { eventType: string; summary: string; eventTs: string; eventId: string; attrs: UnknownMap } {
  const jti = typeof payload['jti'] === 'string' ? payload['jti'] : undefined
  const reason = typeof payload['reason'] === 'string' ? payload['reason'] : 'token_revoked'
  const ts = isoFromUnixSeconds(payload['revoked_at']) ?? new Date().toISOString()

  return {
    eventType: 'TOKEN_REVOKED',
    summary: jti ? `revoked ${jti}: ${reason}` : reason,
    eventTs: ts,
    eventId: jti ? `revoke:${jti}` : randomUUID(),
    attrs: {},
  }
}

function summarizeTier(payload: UnknownMap): { eventType: string; summary: string; eventTs: string; eventId: string; attrs: UnknownMap } {
  const score = typeof payload['score'] === 'number' ? payload['score'] : undefined
  const spiffe = typeof payload['agent_spiffe_id'] === 'string' ? payload['agent_spiffe_id'] : undefined
  const ts = isoFromUnixSeconds(payload['updated_at']) ?? new Date().toISOString()

  return {
    eventType: 'AUTHORIZATION_TIER_UPDATED',
    summary: spiffe && score !== undefined
      ? `${spiffe} => ${score.toFixed(2)}`
      : 'authorization tier updated',
    eventTs: ts,
    eventId: spiffe ? `tier:${spiffe}:${payload['updated_at'] ?? Date.now()}` : randomUUID(),
    attrs: {
      signal_breakdown: payload['signal_breakdown'],
    },
  }
}

function toOffloadEvent(
  channel: string,
  rawMessage: string,
  ttlSeconds: number,
  includeRaw: boolean
): OffloadEvent {
  const nowIso = new Date().toISOString()
  const payload = asObject(JSON.parse(rawMessage))

  let derived: { eventType: string; summary: string; eventTs: string; eventId: string; attrs: UnknownMap }

  if (channel === 'kaif:audit') {
    derived = summarizeAudit(payload)
  } else if (channel === 'kaif:revocation') {
    derived = summarizeRevocation(payload)
  } else if (channel === 'kaif:authorization-tier') {
    derived = summarizeTier(payload)
  } else {
    derived = {
      eventType: 'CHANNEL_EVENT',
      summary: `event from ${channel}`,
      eventTs: nowIso,
      eventId: randomUUID(),
      attrs: {},
    }
  }

  const event: OffloadEvent = {
    id: `${channel}:${derived.eventId}`,
    channel,
    event_type: derived.eventType,
    event_ts: derived.eventTs,
    ingested_at: nowIso,
    source: 'kaif-redis-pubsub',
    summary: derived.summary,
    attributes: {
      ...derived.attrs,
      channel: payload['channel'],
      action: payload['action'],
      reason: payload['reason'],
      // Keep both names while public docs and downstream consumers converge.
      authorization_tier_value: payload['score'],
      trust_score: payload['score'],
    },
    ...(typeof payload['agent_id'] === 'string' ? { agent_id: payload['agent_id'] } : {}),
    ...(typeof payload['human_id'] === 'string' ? { human_id: payload['human_id'] } : {}),
    ...(typeof payload['run_id'] === 'string' ? { run_id: payload['run_id'] } : {}),
    ...(typeof payload['request_id'] === 'string' ? { request_id: payload['request_id'] } : {}),
    ...(typeof payload['jti'] === 'string' ? { jti: payload['jti'] } : {}),
    ...(typeof payload['score'] === 'number' ? { score: payload['score'] } : {}),
    ...(ttlSeconds > 0 ? { ttl: ttlSeconds } : {}),
    ...(includeRaw ? { raw_payload: rawMessage } : {}),
  }

  return event
}

async function main(): Promise<void> {
  const redisUrl = requireEnv('KAIF_REDIS_URL')
  const cosmosEndpoint = requireEnv('KAIF_COSMOS_ENDPOINT')
  const cosmosKey = process.env['KAIF_COSMOS_KEY']
  const cosmosDatabase = process.env['KAIF_COSMOS_DATABASE'] ?? 'kaif-warm'
  const cosmosContainer = process.env['KAIF_COSMOS_CONTAINER'] ?? 'channel-events'
  const cosmosPartitionKey = process.env['KAIF_COSMOS_CONTAINER_PARTITION_KEY'] ?? '/channel'
  const defaultTtlSeconds = Number(process.env['KAIF_COSMOS_DEFAULT_TTL_SECONDS'] ?? '2592000')
  const channels = parseChannels(process.env['KAIF_REDIS_CHANNELS'])
  const includeRaw = parseBool(process.env['KAIF_OFFLOAD_INCLUDE_RAW'], false)

  const cosmosClient = cosmosKey
    ? new CosmosClient({ endpoint: cosmosEndpoint, key: cosmosKey })
    : new CosmosClient({ endpoint: cosmosEndpoint, aadCredentials: new DefaultAzureCredential() })

  const redis = new Redis(redisUrl, { lazyConnect: true })
  await redis.connect()

  const { database } = await cosmosClient.databases.createIfNotExists({ id: cosmosDatabase })
  const containerDefinition = {
    id: cosmosContainer,
    partitionKey: { paths: [cosmosPartitionKey] },
    ...(defaultTtlSeconds > 0 ? { defaultTtl: defaultTtlSeconds } : {}),
  }
  const { container } = await database.containers.createIfNotExists(containerDefinition)

  await redis.subscribe(...channels)

  console.log('[offload] redis connected')
  console.log(`[offload] subscribed channels: ${channels.join(', ')}`)
  console.log(`[offload] cosmos target: ${cosmosDatabase}/${cosmosContainer}`)
  console.log(`[offload] include raw payload: ${includeRaw}`)

  let written = 0
  let failed = 0

  redis.on('message', (channel: string, message: string) => {
    void (async () => {
      try {
        const event = toOffloadEvent(channel, message, defaultTtlSeconds, includeRaw)
        await container.items.upsert(event)
        written += 1
        if (written % 25 === 0) {
          console.log(`[offload] written=${written} failed=${failed}`)
        }
      } catch (err) {
        failed += 1
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[offload] failed channel=${channel} error=${msg}`)
      }
    })()
  })

  const shutdown = async () => {
    console.log('[offload] shutting down')
    try { await redis.unsubscribe(...channels) } catch { /* noop */ }
    try { await redis.quit() } catch { /* noop */ }
    process.exit(0)
  }

  process.on('SIGINT', () => { void shutdown() })
  process.on('SIGTERM', () => { void shutdown() })
}

void main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.stack ?? err.message : String(err)
  console.error(`[offload] startup failure: ${msg}`)
  process.exit(1)
})
