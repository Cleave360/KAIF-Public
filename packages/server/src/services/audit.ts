import { createHash, randomUUID } from 'crypto'
import type { Redis } from 'ioredis'
import type { AuditEntry } from '../types/kaif.js'

const GLOBAL_KEY  = 'kaif:audit:global'
const CHANNEL     = 'kaif:audit'
const LOCK_KEY    = 'kaif:audit:global:lock'
const LOCK_TTL_MS = 5000
const LOCK_TRIES  = 50

function agentKey(agent_id: string): string {
  return `kaif:audit:${agent_id}`
}

// Hash computation as specified: SHA-256(prev_hash|ts|action|detail)
function computeHash(prev_hash: string, ts: string, action: string, detail: string): string {
  return createHash('sha256')
    .update(`${prev_hash}|${ts}|${action}|${detail}`)
    .digest('hex')
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function acquireAuditLock(redis: Redis): Promise<string> {
  const token = randomUUID()

  for (let i = 0; i < LOCK_TRIES; i++) {
    const acquired = await (redis as any).set(LOCK_KEY, token, 'NX', 'PX', LOCK_TTL_MS)
    if (acquired === 'OK') return token
    await sleep(10)
  }

  throw new Error('Timed out acquiring audit append lock')
}

async function releaseAuditLock(redis: Redis, token: string): Promise<void> {
  try {
    if (await redis.get(LOCK_KEY) === token) {
      await redis.del(LOCK_KEY)
    }
  } catch {
    // Lock expiry provides the fallback if cleanup fails.
  }
}

export async function appendAudit(
  redis: Redis,
  params: Omit<AuditEntry, 'id' | 'ts' | 'hash' | 'prev_hash'>
): Promise<AuditEntry> {
  const lockToken = await acquireAuditLock(redis)
  try {
    const lastRaw = await redis.lrange(GLOBAL_KEY, -1, -1)

    const prev_hash = lastRaw.length > 0 && lastRaw[0]
      ? (JSON.parse(lastRaw[0]) as AuditEntry).hash
      : '0'.repeat(64)

    const id  = randomUUID()
    const ts  = new Date().toISOString()
    const hash = computeHash(prev_hash, ts, params.action, params.detail)

    const entry: AuditEntry = {
      id,
      ts,
      action:   params.action,
      detail:   params.detail,
      hash,
      prev_hash,
      ...(params.agent_id !== undefined ? { agent_id: params.agent_id } : {}),
      ...(params.human_id !== undefined ? { human_id: params.human_id } : {}),
    }

    const serialized = JSON.stringify(entry)

    await redis.rpush(GLOBAL_KEY, serialized)

    if (params.agent_id) {
      await redis.rpush(agentKey(params.agent_id), serialized)
    }

    await redis.publish(CHANNEL, serialized)

    return entry
  } finally {
    await releaseAuditLock(redis, lockToken)
  }
}

export async function getAuditLog(
  redis: Redis,
  agent_id?: string,
  limit = 100
): Promise<AuditEntry[]> {
  const key = agent_id ? agentKey(agent_id) : GLOBAL_KEY
  const raw = await redis.lrange(key, -limit, -1)
  return raw.map(r => JSON.parse(r) as AuditEntry)
}

// Verifies the global chain (consecutive prev_hash linkage).
// For per-agent lists: verifies each entry's individual hash integrity.
// See security/gaps.md GAP-003 for the limitation of per-agent chain verification.
export async function verifyChain(redis: Redis, agent_id?: string): Promise<boolean> {
  const key = agent_id ? agentKey(agent_id) : GLOBAL_KEY
  const raw = await redis.lrange(key, 0, -1)

  if (raw.length === 0) return true

  if (agent_id) {
    // Per-agent: verify each entry's hash is self-consistent
    for (const r of raw) {
      const entry = JSON.parse(r) as AuditEntry
      const expected = computeHash(entry.prev_hash, entry.ts, entry.action, entry.detail)
      if (entry.hash !== expected) return false
    }
    return true
  }

  // Global chain: verify consecutive prev_hash linkage from genesis
  let expectedPrevHash = '0'.repeat(64)

  for (const r of raw) {
    const entry = JSON.parse(r) as AuditEntry

    if (entry.prev_hash !== expectedPrevHash) return false

    const expected = computeHash(entry.prev_hash, entry.ts, entry.action, entry.detail)
    if (entry.hash !== expected) return false

    expectedPrevHash = entry.hash
  }

  return true
}
