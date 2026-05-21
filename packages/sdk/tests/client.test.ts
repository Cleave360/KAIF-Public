import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { KAIFClient } from '../src/client.js'
import { TokenCache } from '../src/token-cache.js'

// ── Helpers ───────────────────────────────────────────────────────

const SERVER_URL          = 'http://kaif-server:8080'
const SPIFFE_ID           = 'spiffe://kindred.systems/ns/test/agent/mock'
const DELEGATION_TOKEN    = 'grant.jwt.stub'
const SVID_PATH           = '/tmp/test-svid.jwt'
const MOCK_SVID          = 'svid.jwt.stub'
const MOCK_ACCESS_TOKEN  = 'access.token.stub'
const SCOPE              = 'invoke:completion'
const AUDIENCE           = 'urn:kaif:mock-service'

function makeTokenResponse(expiresIn = 600, token = MOCK_ACCESS_TOKEN) {
  return {
    access_token:      token,
    issued_token_type: 'urn:ietf:params:oauth:token-type:access_token',
    token_type:        'Bearer',
    expires_in:        expiresIn,
    scope:             SCOPE,
  }
}

function mockFetchOk(body: object): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok:   true,
    json: () => Promise.resolve(body),
  } as Response)
}

function mockFetchErr(status: number, error: string): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok:     false,
    status,
    json:   () => Promise.resolve({ error, error_description: 'test error' }),
    statusText: 'Error',
  } as Response)
}

// ── Client factory ────────────────────────────────────────────────

function makeClient(): KAIFClient {
  return new KAIFClient({
    server_url:       SERVER_URL,
    spiffe_id:        SPIFFE_ID,
    svid_path:        SVID_PATH,
    delegation_token: DELEGATION_TOKEN,
  })
}

// ── SVID file stub ────────────────────────────────────────────────
// vi.mock is hoisted before constants — use a literal here.
vi.mock('fs', () => ({
  readFileSync: vi.fn().mockReturnValue('svid.jwt.stub\n'),
}))

// ── Tests ─────────────────────────────────────────────────────────

describe('KAIFClient', () => {
  let fetchSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  describe('getToken', () => {
    it('exchanges tokens and returns access_token', async () => {
      fetchSpy.mockResolvedValue({
        ok:   true,
        json: () => Promise.resolve(makeTokenResponse()),
      })

      const client = makeClient()
      const token = await client.getToken(SCOPE, AUDIENCE)

      expect(token).toBe(MOCK_ACCESS_TOKEN)
      expect(fetchSpy).toHaveBeenCalledOnce()

      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
      expect(url).toBe(`${SERVER_URL}/oauth/token`)
      expect(init.method).toBe('POST')
      expect((init.headers as Record<string, string>)['content-type']).toBe(
        'application/x-www-form-urlencoded'
      )
      const body = new URLSearchParams(init.body as string)
      expect(body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:token-exchange')
      expect(body.get('subject_token')).toBe(DELEGATION_TOKEN)
      expect(body.get('actor_token')).toBe(MOCK_SVID)
      expect(body.get('scope')).toBe(SCOPE)
      expect(body.get('audience')).toBe(AUDIENCE)
    })

    it('returns cached token on second call', async () => {
      fetchSpy.mockResolvedValue({
        ok:   true,
        json: () => Promise.resolve(makeTokenResponse(600)),
      })

      const client = makeClient()
      const first  = await client.getToken(SCOPE, AUDIENCE)
      const second = await client.getToken(SCOPE, AUDIENCE)

      expect(first).toBe(second)
      expect(fetchSpy).toHaveBeenCalledOnce()
    })

    it('uses separate cache entries for different scope:audience pairs', async () => {
      const token1 = 'token.for.scope1'
      const token2 = 'token.for.scope2'

      fetchSpy
        .mockResolvedValueOnce({
          ok:   true,
          json: () => Promise.resolve({ ...makeTokenResponse(), access_token: token1 }),
        })
        .mockResolvedValueOnce({
          ok:   true,
          json: () => Promise.resolve({ ...makeTokenResponse(), access_token: token2 }),
        })

      const client = makeClient()
      const t1 = await client.getToken('invoke:completion', AUDIENCE)
      const t2 = await client.getToken('audit:read', AUDIENCE)

      expect(t1).toBe(token1)
      expect(t2).toBe(token2)
      expect(fetchSpy).toHaveBeenCalledTimes(2)
    })

    it('evicts cached token when within 60 seconds of expiry', async () => {
      vi.useFakeTimers()

      fetchSpy.mockResolvedValue({
        ok:   true,
        json: () => Promise.resolve(makeTokenResponse(120)),
      })

      const client = makeClient()
      await client.getToken(SCOPE, AUDIENCE)
      expect(fetchSpy).toHaveBeenCalledOnce()

      // Advance time so token has only 59 seconds remaining (120 - 61 = 59)
      vi.advanceTimersByTime(61_000)

      await client.getToken(SCOPE, AUDIENCE)
      expect(fetchSpy).toHaveBeenCalledTimes(2)

      vi.useRealTimers()
    })

    it('does not evict cached token with more than 60 seconds remaining', async () => {
      vi.useFakeTimers()

      fetchSpy.mockResolvedValue({
        ok:   true,
        json: () => Promise.resolve(makeTokenResponse(120)),
      })

      const client = makeClient()
      await client.getToken(SCOPE, AUDIENCE)
      expect(fetchSpy).toHaveBeenCalledOnce()

      // Advance time so token has 61 seconds remaining (120 - 59 = 61)
      vi.advanceTimersByTime(59_000)

      await client.getToken(SCOPE, AUDIENCE)
      expect(fetchSpy).toHaveBeenCalledOnce()

      vi.useRealTimers()
    })

    it('throws on HTTP error response', async () => {
      fetchSpy.mockResolvedValue({
        ok:     false,
        status: 401,
        json:   () => Promise.resolve({ error: 'invalid_client', error_description: 'bad svid' }),
        statusText: 'Unauthorized',
      })

      const client = makeClient()
      await expect(client.getToken(SCOPE, AUDIENCE)).rejects.toThrow(
        'KAIF token exchange failed [HTTP 401]'
      )
    })

    it('throws with server_error when response body is not JSON', async () => {
      fetchSpy.mockResolvedValue({
        ok:     false,
        status: 500,
        statusText: 'Internal Server Error',
        json:   () => Promise.reject(new Error('not json')),
      })

      const client = makeClient()
      await expect(client.getToken(SCOPE, AUDIENCE)).rejects.toThrow(
        'KAIF token exchange failed [HTTP 500]'
      )
    })
  })

  describe('refreshToken', () => {
    it('bypasses cache and fetches a fresh token', async () => {
      const first  = 'first.token'
      const second = 'second.token'

      fetchSpy
        .mockResolvedValueOnce({
          ok:   true,
          json: () => Promise.resolve({ ...makeTokenResponse(), access_token: first }),
        })
        .mockResolvedValueOnce({
          ok:   true,
          json: () => Promise.resolve({ ...makeTokenResponse(), access_token: second }),
        })

      const client = makeClient()
      const t1 = await client.getToken(SCOPE, AUDIENCE)
      const t2 = await client.refreshToken(SCOPE, AUDIENCE)

      expect(t1).toBe(first)
      expect(t2).toBe(second)
      expect(fetchSpy).toHaveBeenCalledTimes(2)
    })

    it('updates the cache after refresh', async () => {
      const refreshed = 'refreshed.token'

      fetchSpy
        .mockResolvedValueOnce({
          ok:   true,
          json: () => Promise.resolve(makeTokenResponse()),
        })
        .mockResolvedValueOnce({
          ok:   true,
          json: () => Promise.resolve({ ...makeTokenResponse(), access_token: refreshed }),
        })

      const client = makeClient()
      await client.getToken(SCOPE, AUDIENCE)
      await client.refreshToken(SCOPE, AUDIENCE)

      // Next getToken should return refreshed token without another fetch
      const cached = await client.getToken(SCOPE, AUDIENCE)
      expect(cached).toBe(refreshed)
      expect(fetchSpy).toHaveBeenCalledTimes(2)
    })
  })

  describe('authHeader', () => {
    it('returns Bearer prefix with token', async () => {
      fetchSpy.mockResolvedValue({
        ok:   true,
        json: () => Promise.resolve(makeTokenResponse()),
      })

      const client = makeClient()
      const header = await client.authHeader(SCOPE, AUDIENCE)
      expect(header).toBe(`Bearer ${MOCK_ACCESS_TOKEN}`)
    })
  })

  describe('revoke', () => {
    it('calls /revoke for each cached token and clears the cache', async () => {
      const revokeUrl = `${SERVER_URL}/revoke`

      // First two calls: token exchanges for two scopes
      fetchSpy
        .mockResolvedValueOnce({
          ok:   true,
          json: () => Promise.resolve({ ...makeTokenResponse(), access_token: 'token-a' }),
        })
        .mockResolvedValueOnce({
          ok:   true,
          json: () => Promise.resolve({ ...makeTokenResponse(), access_token: 'token-b' }),
        })
        // Revocation calls
        .mockResolvedValue({ ok: true, json: () => Promise.resolve({}) })

      const client = makeClient()
      await client.getToken('invoke:completion', AUDIENCE)
      await client.getToken('audit:read', AUDIENCE)

      expect(fetchSpy).toHaveBeenCalledTimes(2)

      await client.revoke()

      // Two revocation calls
      const revokeCalls = fetchSpy.mock.calls.slice(2) as [string, RequestInit][]
      expect(revokeCalls).toHaveLength(2)
      for (const [url, init] of revokeCalls) {
        expect(url).toBe(revokeUrl)
        expect(init.method).toBe('POST')
        const body = JSON.parse(init.body as string) as { token: string; reason: string }
        expect(body.reason).toBe('client_shutdown')
        expect(['token-a', 'token-b']).toContain(body.token)
      }

      // Cache is cleared — next getToken re-fetches
      fetchSpy.mockResolvedValue({
        ok:   true,
        json: () => Promise.resolve(makeTokenResponse()),
      })
      await client.getToken('invoke:completion', AUDIENCE)
      expect(fetchSpy).toHaveBeenCalledTimes(5)
    })

    it('clears cache even when revocation requests fail', async () => {
      fetchSpy
        .mockResolvedValueOnce({
          ok:   true,
          json: () => Promise.resolve(makeTokenResponse()),
        })
        // Revocation fails with network error
        .mockRejectedValueOnce(new Error('network error'))

      const client = makeClient()
      await client.getToken(SCOPE, AUDIENCE)

      await expect(client.revoke()).resolves.toBeUndefined()

      // Cache cleared — next getToken re-fetches
      fetchSpy.mockResolvedValue({
        ok:   true,
        json: () => Promise.resolve(makeTokenResponse()),
      })
      await client.getToken(SCOPE, AUDIENCE)
      expect(fetchSpy).toHaveBeenCalledTimes(3)
    })

    it('does nothing when cache is empty', async () => {
      const client = makeClient()
      await expect(client.revoke()).resolves.toBeUndefined()
      expect(fetchSpy).not.toHaveBeenCalled()
    })
  })

  describe('svid_path', () => {
    it('throws when svid_path is not configured', async () => {
      fetchSpy.mockResolvedValue({
        ok:   true,
        json: () => Promise.resolve(makeTokenResponse()),
      })

      const client = new KAIFClient({
        server_url:       SERVER_URL,
        spiffe_id:        SPIFFE_ID,
        delegation_token: DELEGATION_TOKEN,
        // svid_path intentionally omitted
      })

      await expect(client.getToken(SCOPE, AUDIENCE)).rejects.toThrow('svid_path is required')
    })
  })
})

describe('TokenCache', () => {
  it('returns null for unknown key', () => {
    const cache = new TokenCache()
    expect(cache.get('missing:key')).toBeNull()
  })

  it('returns token when valid', () => {
    const cache = new TokenCache()
    const exp   = Math.floor(Date.now() / 1000) + 300
    cache.set('s:a', 'tok', exp, 'scope')
    expect(cache.get('s:a')).toBe('tok')
  })

  it('evicts token when within 60 seconds of expiry', () => {
    vi.useFakeTimers()
    const cache = new TokenCache()
    const exp   = Math.floor(Date.now() / 1000) + 65
    cache.set('s:a', 'tok', exp, 'scope')

    vi.advanceTimersByTime(6_000)   // now exp - 59 < 60 → evict
    expect(cache.get('s:a')).toBeNull()
    vi.useRealTimers()
  })

  it('returns token when more than 60 seconds remain', () => {
    vi.useFakeTimers()
    const cache = new TokenCache()
    const exp   = Math.floor(Date.now() / 1000) + 120
    cache.set('s:a', 'tok', exp, 'scope')

    vi.advanceTimersByTime(59_000)  // now exp - 61 > 60 → keep
    expect(cache.get('s:a')).toBe('tok')
    vi.useRealTimers()
  })

  it('size returns count of stored entries', () => {
    const cache = new TokenCache()
    const exp   = Math.floor(Date.now() / 1000) + 300
    cache.set('s:a', 'tok1', exp, 'scope')
    cache.set('s:b', 'tok2', exp, 'scope')
    expect(cache.size()).toBe(2)
  })

  it('clear removes all entries', () => {
    const cache = new TokenCache()
    const exp   = Math.floor(Date.now() / 1000) + 300
    cache.set('s:a', 'tok', exp, 'scope')
    cache.clear()
    expect(cache.size()).toBe(0)
    expect(cache.get('s:a')).toBeNull()
  })

  it('entries returns map for iteration', () => {
    const cache = new TokenCache()
    const exp   = Math.floor(Date.now() / 1000) + 300
    cache.set('s:a', 'tok', exp, 'scope')
    const entries = cache.entries()
    expect(entries.size).toBe(1)
    expect(entries.get('s:a')?.access_token).toBe('tok')
  })
})
