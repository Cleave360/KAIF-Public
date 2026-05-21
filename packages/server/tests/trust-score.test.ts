import { describe, it, expect, beforeEach } from 'vitest'
import { MockRedis } from './mock-redis.js'
import {
  resolveTier,
  assertTierMinimum,
  getTrustScore,
  updateTrustScore,
} from '../src/services/trust-score.js'
import { KAIFError } from '../src/errors.js'

describe('resolveTier', () => {
  it('score 0.0 resolves to PROVISIONAL', () => {
    expect(resolveTier(0.0).tier).toBe('PROVISIONAL')
  })

  it('score 0.49 resolves to PROVISIONAL', () => {
    expect(resolveTier(0.49).tier).toBe('PROVISIONAL')
  })

  it('score 0.5 resolves to STANDARD', () => {
    expect(resolveTier(0.5).tier).toBe('STANDARD')
  })

  it('score 0.69 resolves to STANDARD', () => {
    expect(resolveTier(0.69).tier).toBe('STANDARD')
  })

  it('score 0.7 resolves to VERIFIED', () => {
    expect(resolveTier(0.7).tier).toBe('VERIFIED')
  })

  it('score 0.9 resolves to TRUSTED', () => {
    expect(resolveTier(0.9).tier).toBe('TRUSTED')
  })

  it('score 1.0 resolves to TRUSTED', () => {
    expect(resolveTier(1.0).tier).toBe('TRUSTED')
  })

  it('score > 1.0 is clamped to 1.0 (TRUSTED)', () => {
    expect(resolveTier(1.5).tier).toBe('TRUSTED')
  })

  it('score < 0.0 is clamped to 0.0 (PROVISIONAL)', () => {
    expect(resolveTier(-0.5).tier).toBe('PROVISIONAL')
  })
})

describe('assertTierMinimum', () => {
  it('passes when score meets required tier', () => {
    expect(() => assertTierMinimum(0.75, 'VERIFIED')).not.toThrow()
  })

  it('throws KAIFError insufficient_trust when score below required tier', () => {
    let err: unknown
    try { assertTierMinimum(0.4, 'STANDARD') } catch (e) { err = e }
    expect(err).toBeInstanceOf(KAIFError)
    expect((err as KAIFError).code).toBe('insufficient_trust')
  })

  it('passes exactly at boundary', () => {
    expect(() => assertTierMinimum(0.5, 'STANDARD')).not.toThrow()
    expect(() => assertTierMinimum(0.9, 'TRUSTED')).not.toThrow()
  })

  it('throws for PROVISIONAL score against TRUSTED requirement', () => {
    let err: unknown
    try {
      assertTierMinimum(0.3, 'TRUSTED')
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(KAIFError)
    expect((err as KAIFError).code).toBe('insufficient_trust')
    expect((err as KAIFError).httpStatus).toBe(403)
  })
})

describe('getTrustScore / updateTrustScore', () => {
  let redis: MockRedis

  beforeEach(() => {
    redis = new MockRedis()
  })

  it('returns default score 0.5 for unknown agents', async () => {
    const signal = await getTrustScore(redis as any, 'spiffe://kindred.systems/unknown')
    expect(signal.score).toBe(0.5)
  })

  it('returns stored score after update', async () => {
    const id = 'spiffe://kindred.systems/ns/adaptive-layer/agent/lyra'
    await updateTrustScore(redis as any, id, 0.85)
    const signal = await getTrustScore(redis as any, id)
    expect(signal.score).toBe(0.85)
    expect(signal.agent_spiffe_id).toBe(id)
  })

  it('clamps scores to [0.0, 1.0] on update', async () => {
    const id = 'spiffe://test'
    await updateTrustScore(redis as any, id, 1.5)
    const high = await getTrustScore(redis as any, id)
    expect(high.score).toBe(1.0)

    await updateTrustScore(redis as any, id, -0.3)
    const low = await getTrustScore(redis as any, id)
    expect(low.score).toBe(0.0)
  })

  it('publishes to kaif:trust-score channel on update', async () => {
    await updateTrustScore(redis as any, 'spiffe://test', 0.7)
    expect(redis.published).toHaveLength(1)
    expect(redis.published[0]!.channel).toBe('kaif:trust-score')
  })

  it('stores optional signal_breakdown', async () => {
    const id = 'spiffe://test'
    const breakdown = { behavioural: 0.8, audit_chain: 0.9, credential: 1.0, peer: 0.7 }
    await updateTrustScore(redis as any, id, 0.85, breakdown)
    const signal = await getTrustScore(redis as any, id)
    expect(signal.signal_breakdown).toEqual(breakdown)
  })
})
