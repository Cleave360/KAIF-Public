import type { Redis } from 'ioredis'
import { TRUST_TIERS } from '../types/kaif.js'
import type { TrustTierConfig, TrustTier, TrustScoreSignal } from '../types/kaif.js'
import { KAIFError } from '../errors.js'

const CHANNEL = 'kaif:trust-score'

function trustKey(spiffe_id: string): string {
  return `kaif:trust:${spiffe_id}`
}

function clamp(score: number): number {
  return Math.min(1.0, Math.max(0.0, score))
}

export function resolveTier(score: number): TrustTierConfig {
  const clamped = clamp(score)
  // TRUST_TIERS is ordered PROVISIONAL → TRUSTED; find the last tier whose minScore fits
  const tier = [...TRUST_TIERS].reverse().find(t => clamped >= t.minScore)
  // Genesis tier always matches (minScore 0.0), so this cannot be undefined
  return tier!
}

export function assertTierMinimum(score: number, required: TrustTier): void {
  const actual = resolveTier(score)
  const requiredConfig = TRUST_TIERS.find(t => t.tier === required)!
  if (actual.minScore < requiredConfig.minScore) {
    throw new KAIFError(
      'insufficient_trust',
      `Agent trust score ${score.toFixed(2)} is below the required tier ${required}`
    )
  }
}

export async function getTrustScore(
  redis: Redis,
  spiffe_id: string
): Promise<TrustScoreSignal> {
  const raw = await redis.get(trustKey(spiffe_id))

  if (!raw) {
    return {
      agent_spiffe_id: spiffe_id,
      score:           0.5,
      updated_at:      Math.floor(Date.now() / 1000),
    }
  }

  return JSON.parse(raw) as TrustScoreSignal
}

export async function updateTrustScore(
  redis: Redis,
  spiffe_id: string,
  score: number,
  breakdown?: TrustScoreSignal['signal_breakdown']
): Promise<void> {
  const clamped = clamp(score)

  const signal: TrustScoreSignal = {
    agent_spiffe_id: spiffe_id,
    score:           clamped,
    updated_at:      Math.floor(Date.now() / 1000),
    ...(breakdown !== undefined ? { signal_breakdown: breakdown } : {}),
  }

  await redis.set(trustKey(spiffe_id), JSON.stringify(signal))
  await redis.publish(CHANNEL, JSON.stringify(signal))
}
