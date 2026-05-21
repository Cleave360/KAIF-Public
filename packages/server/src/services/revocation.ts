import type { Redis } from 'ioredis'
import type { RevocationEvent } from '../types/kaif.js'

const CHANNEL = 'kaif:revocation'

function jtiKey(jti: string): string {
  return `kaif:revoke:${jti}`
}

export async function revokeToken(
  redis: Redis,
  jti: string,
  agent_id: string,
  reason: string,
  token_exp: number
): Promise<void> {
  const ttl = Math.max(token_exp - Math.floor(Date.now() / 1000), 1)

  await redis.set(jtiKey(jti), '1', 'EX', ttl)

  const event: RevocationEvent = {
    jti,
    agent_id,
    reason,
    revoked_at: Math.floor(Date.now() / 1000),
  }

  await redis.publish(CHANNEL, JSON.stringify(event))
}

export async function isRevoked(redis: Redis, jti: string): Promise<boolean> {
  const val = await redis.get(jtiKey(jti))
  return val !== null
}

export function subscribeRevocation(
  redis: Redis,
  onEvent: (event: RevocationEvent) => void
): void {
  // ioredis subscribe takes a callback (channel, message)
  ;(redis as any).subscribe(CHANNEL, (_channel: string, message: string) => {
    try {
      onEvent(JSON.parse(message) as RevocationEvent)
    } catch {
      // malformed message — ignore
    }
  })
}
