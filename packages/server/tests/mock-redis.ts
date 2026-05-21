/**
 * Minimal in-memory Redis mock for service unit tests.
 * Implements only the commands used by KAIF services.
 */

type Listener = (channel: string, message: string) => void

export class MockRedis {
  private lists: Map<string, string[]> = new Map()
  private hashes: Map<string, Map<string, string>> = new Map()
  private strings: Map<string, { value: string; expireAt?: number }> = new Map()
  private listeners: Listener[] = []

  published: Array<{ channel: string; message: string }> = []

  // ── List operations ──────────────────────────────────────────────

  async rpush(key: string, ...values: string[]): Promise<number> {
    if (!this.lists.has(key)) this.lists.set(key, [])
    const list = this.lists.get(key)!
    list.push(...values)
    return list.length
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    const list = this.lists.get(key) ?? []
    const len = list.length
    const s = start < 0 ? Math.max(len + start, 0) : start
    const e = stop < 0 ? len + stop : Math.min(stop, len - 1)
    if (s > e) return []
    return list.slice(s, e + 1)
  }

  async lrem(key: string, count: number, value: string): Promise<number> {
    const list = this.lists.get(key)
    if (!list) return 0
    const before = list.length
    const filtered = list.filter(v => v !== value)
    this.lists.set(key, filtered)
    return before - filtered.length
  }

  // ── String/key operations ────────────────────────────────────────

  async set(key: string, value: string, ...args: unknown[]): Promise<'OK' | null> {
    let expireAt: number | undefined
    const upperArgs = args.map(a => String(a).toUpperCase())
    const existing = this.strings.get(key)
    if (existing?.expireAt !== undefined && Date.now() > existing.expireAt) {
      this.strings.delete(key)
    } else if (upperArgs.includes('NX') && existing) {
      return null
    }

    // handle EX <seconds> option
    const exIdx = upperArgs.findIndex(a => a === 'EX')
    if (exIdx !== -1) {
      const secs = Number(args[exIdx + 1])
      expireAt = Date.now() + secs * 1000
    }

    const pxIdx = upperArgs.findIndex(a => a === 'PX')
    if (pxIdx !== -1) {
      const ms = Number(args[pxIdx + 1])
      expireAt = Date.now() + ms
    }

    this.strings.set(key, { value, expireAt })
    return 'OK'
  }

  async get(key: string): Promise<string | null> {
    const entry = this.strings.get(key)
    if (!entry) return null
    if (entry.expireAt !== undefined && Date.now() > entry.expireAt) {
      this.strings.delete(key)
      return null
    }
    return entry.value
  }

  async del(...keys: string[]): Promise<number> {
    let count = 0
    for (const k of keys) {
      if (this.strings.delete(k) || this.lists.delete(k) || this.hashes.delete(k)) count++
    }
    return count
  }

  // ── Hash operations ──────────────────────────────────────────────

  async hset(key: string, field: string, value: string): Promise<number> {
    if (!this.hashes.has(key)) this.hashes.set(key, new Map())
    const map = this.hashes.get(key)!
    const isNew = !map.has(field)
    map.set(field, value)
    return isNew ? 1 : 0
  }

  async hget(key: string, field: string): Promise<string | null> {
    return this.hashes.get(key)?.get(field) ?? null
  }

  async hgetall(key: string): Promise<Record<string, string> | null> {
    const map = this.hashes.get(key)
    if (!map) return null
    const result: Record<string, string> = {}
    for (const [k, v] of map) result[k] = v
    return result
  }

  // ── Pub/Sub ──────────────────────────────────────────────────────

  async publish(channel: string, message: string): Promise<number> {
    this.published.push({ channel, message })
    for (const fn of this.listeners) fn(channel, message)
    return this.listeners.length
  }

  subscribe(_channel: string, listener: Listener): void {
    this.listeners.push(listener)
  }

  // ── Misc ─────────────────────────────────────────────────────────

  async ping(): Promise<'PONG'> { return 'PONG' }

  // ── Test helpers ─────────────────────────────────────────────────

  reset(): void {
    this.lists.clear()
    this.hashes.clear()
    this.strings.clear()
    this.published = []
    this.listeners = []
  }
}
