import { describe, it, expect, beforeEach } from 'vitest'
import { createHash } from 'crypto'
import { MockRedis } from './mock-redis.js'
import { appendAudit, getAuditLog, verifyChain } from '../src/services/audit.js'
import type { AuditEntry } from '../src/types/kaif.js'

function hash(prev: string, ts: string, action: string, detail: string): string {
  return createHash('sha256').update(`${prev}|${ts}|${action}|${detail}`).digest('hex')
}

describe('audit service', () => {
  let redis: MockRedis

  beforeEach(() => {
    redis = new MockRedis()
  })

  it('genesis entry uses "0".repeat(64) as prev_hash', async () => {
    const entry = await appendAudit(redis as any, {
      action: 'TOKEN_ISSUED',
      detail: 'test detail',
    })
    expect(entry.prev_hash).toBe('0'.repeat(64))
  })

  it('appendAudit creates correct hash linking previous entry', async () => {
    const first = await appendAudit(redis as any, {
      action: 'TOKEN_ISSUED',
      detail: 'first',
    })
    const second = await appendAudit(redis as any, {
      action: 'TOKEN_REVOKED',
      detail: 'second',
    })

    // First entry: prev_hash = genesis, hash = H(genesis|ts|action|detail)
    expect(first.prev_hash).toBe('0'.repeat(64))
    expect(first.hash).toBe(hash(first.prev_hash, first.ts, first.action, first.detail))

    // Second entry links to first
    expect(second.prev_hash).toBe(first.hash)
    expect(second.hash).toBe(hash(second.prev_hash, second.ts, second.action, second.detail))
  })

  it('verifyChain returns true for unmodified chain', async () => {
    await appendAudit(redis as any, { action: 'TOKEN_ISSUED', detail: 'a' })
    await appendAudit(redis as any, { action: 'AUTH_FAILED', detail: 'b' })
    await appendAudit(redis as any, { action: 'TOKEN_REVOKED', detail: 'c' })

    expect(await verifyChain(redis as any)).toBe(true)
  })

  it('concurrent appendAudit calls keep the global chain valid', async () => {
    const writes = Array.from({ length: 50 }, (_, i) => appendAudit(redis as any, {
      action: 'TOKEN_ISSUED',
      detail: `concurrent-${i}`,
    }))

    await Promise.all(writes)

    const log = await getAuditLog(redis as any, undefined, 100)
    expect(log).toHaveLength(50)
    expect(await verifyChain(redis as any)).toBe(true)
  })

  it('verifyChain returns false if any entry is tampered', async () => {
    await appendAudit(redis as any, { action: 'TOKEN_ISSUED', detail: 'original' })

    // Tamper with the last entry by replacing its hash
    const raw = await redis.lrange('kaif:audit:global', -1, -1)
    const entry = JSON.parse(raw[0]!) as AuditEntry
    entry.detail = 'tampered'
    await redis.lrem('kaif:audit:global', 1, raw[0]!)
    await redis.rpush('kaif:audit:global', JSON.stringify(entry))

    expect(await verifyChain(redis as any)).toBe(false)
  })

  it('verifyChain returns false if entry is deleted from middle', async () => {
    await appendAudit(redis as any, { action: 'TOKEN_ISSUED', detail: 'first' })
    const second = await appendAudit(redis as any, { action: 'AUTH_FAILED', detail: 'second' })
    await appendAudit(redis as any, { action: 'TOKEN_REVOKED', detail: 'third' })

    // Remove the middle entry (second)
    const raw = await redis.lrange('kaif:audit:global', 0, -1)
    const serialized = raw.find(r => {
      const e = JSON.parse(r) as AuditEntry
      return e.id === second.id
    })!
    await redis.lrem('kaif:audit:global', 1, serialized)

    // Third entry's prev_hash now doesn't match first entry's hash
    expect(await verifyChain(redis as any)).toBe(false)
  })

  it('getAuditLog returns entries in order', async () => {
    const a = await appendAudit(redis as any, { action: 'TOKEN_ISSUED', detail: 'a' })
    const b = await appendAudit(redis as any, { action: 'AUTH_FAILED', detail: 'b' })

    const log = await getAuditLog(redis as any)
    expect(log).toHaveLength(2)
    expect(log[0]!.id).toBe(a.id)
    expect(log[1]!.id).toBe(b.id)
  })

  it('per-agent list is populated when agent_id provided', async () => {
    const agentId = 'spiffe://example.org/ns/adaptive-layer/agent/lyra'
    await appendAudit(redis as any, { action: 'TOKEN_ISSUED', detail: 'agent event', agent_id: agentId })
    await appendAudit(redis as any, { action: 'AUTH_FAILED', detail: 'global only' })

    const agentLog = await getAuditLog(redis as any, agentId)
    expect(agentLog).toHaveLength(1)
    expect(agentLog[0]!.agent_id).toBe(agentId)
  })

  it('verifyChain per-agent validates individual hash integrity', async () => {
    const agentId = 'spiffe://example.org/ns/adaptive-layer/agent/lyra'
    await appendAudit(redis as any, { action: 'TOKEN_ISSUED', detail: 'ok', agent_id: agentId })

    expect(await verifyChain(redis as any, agentId)).toBe(true)
  })

  it('publishes to kaif:audit channel on append', async () => {
    await appendAudit(redis as any, { action: 'TOKEN_ISSUED', detail: 'pub test' })

    expect(redis.published).toHaveLength(1)
    expect(redis.published[0]!.channel).toBe('kaif:audit')
    const msg = JSON.parse(redis.published[0]!.message) as AuditEntry
    expect(msg.action).toBe('TOKEN_ISSUED')
  })
})
