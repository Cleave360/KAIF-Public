import { describe, it, expect, beforeEach } from 'vitest'
import { MockRedis } from './mock-redis.js'
import { revokeToken, isRevoked, subscribeRevocation } from '../src/services/revocation.js'
import type { RevocationEvent } from '../src/types/kaif.js'

describe('revocation service', () => {
  let redis: MockRedis

  beforeEach(() => {
    redis = new MockRedis()
  })

  it('revoked JTI fails isRevoked check', async () => {
    const jti = 'test-jti-1'
    const exp = Math.floor(Date.now() / 1000) + 600

    await revokeToken(redis as any, jti, 'spiffe://kindred.systems/agent/lyra', 'test', exp)

    expect(await isRevoked(redis as any, jti)).toBe(true)
  })

  it('unknown JTI passes isRevoked check', async () => {
    expect(await isRevoked(redis as any, 'never-revoked-jti')).toBe(false)
  })

  it('revocation event published to Redis channel', async () => {
    const jti = 'test-jti-2'
    const agentId = 'spiffe://kindred.systems/ns/adaptive-layer/agent/lyra'
    const reason = 'user requested'
    const exp = Math.floor(Date.now() / 1000) + 300

    await revokeToken(redis as any, jti, agentId, reason, exp)

    expect(redis.published).toHaveLength(1)
    expect(redis.published[0]!.channel).toBe('kaif:revocation')

    const event = JSON.parse(redis.published[0]!.message) as RevocationEvent
    expect(event.jti).toBe(jti)
    expect(event.agent_id).toBe(agentId)
    expect(event.reason).toBe(reason)
    expect(event.revoked_at).toBeGreaterThan(0)
  })

  it('revocation TTL matches token expiry', async () => {
    const jti = 'test-jti-3'
    const nowSeconds = Math.floor(Date.now() / 1000)
    const ttlSeconds = 600
    const exp = nowSeconds + ttlSeconds

    await revokeToken(redis as any, jti, 'spiffe://test', 'ttl-test', exp)

    // Check the stored entry has an expireAt close to exp
    const entry = (redis as any).strings.get(`kaif:revoke:${jti}`)
    expect(entry).toBeDefined()
    // expireAt should be within 2 seconds of now + ttlSeconds
    const expectedExpireAt = Date.now() + ttlSeconds * 1000
    expect(Math.abs(entry.expireAt - expectedExpireAt)).toBeLessThan(2000)
  })

  it('subscribeRevocation delivers events to callback', async () => {
    const events: RevocationEvent[] = []
    subscribeRevocation(redis as any, ev => events.push(ev))

    const jti = 'test-jti-4'
    const exp = Math.floor(Date.now() / 1000) + 300
    await revokeToken(redis as any, jti, 'spiffe://test', 'sub-test', exp)

    expect(events).toHaveLength(1)
    expect(events[0]!.jti).toBe(jti)
  })
})
