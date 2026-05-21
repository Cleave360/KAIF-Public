interface CachedToken {
  access_token: string
  exp:          number   // unix seconds
  scope:        string
}

export class TokenCache {
  private store = new Map<string, CachedToken>()

  // Returns the token if it's valid with >60 seconds remaining, otherwise null.
  get(key: string): string | null {
    const entry = this.store.get(key)
    if (!entry) return null
    if (Math.floor(Date.now() / 1000) > entry.exp - 60) {
      this.store.delete(key)
      return null
    }
    return entry.access_token
  }

  set(key: string, token: string, exp: number, scope: string): void {
    this.store.set(key, { access_token: token, exp, scope })
  }

  // Returns all stored tokens by key — used for bulk revocation.
  entries(): Map<string, CachedToken> {
    return this.store
  }

  clear(): void {
    this.store.clear()
  }

  size(): number {
    return this.store.size
  }
}
