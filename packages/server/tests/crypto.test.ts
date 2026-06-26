import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  getSigningKey,
  getPublicJWK,
  getJWKS,
  getKid,
  _resetKeyCache,
} from '../src/crypto/keys.js'
import {
  signKAIFToken,
  verifyJWT,
  computeThumbprint,
  verifySVIDJWT,
  _resetSpireJWKSCache,
  _setSpireJWKS,
  _setRawSpireKeys,
} from '../src/crypto/jwt.js'
import {
  _resetSpireBundleFetcher,
  _setSpireBundleFetcher,
} from '../src/crypto/spire-bundle.js'
import type { KAIFTokenClaims } from '../src/types/kaif.js'
import {
  exportJWK,
  generateKeyPair,
  SignJWT,
  calculateJwkThumbprint,
  createLocalJWKSet,
  exportPKCS8,
} from 'jose'
import type { KeyLike, JWK } from 'jose'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPublicKey } from 'node:crypto'
import { _setAzureSecretResolver } from '../src/crypto/key-source.js'

// ── keys.ts ───────────────────────────────────────────────────────

describe('keys', () => {
  beforeEach(() => {
    _resetKeyCache()
    delete process.env['KAIF_PRIVATE_KEY_PATH']
    delete process.env['KAIF_PRIVATE_KEY_PEM']
    delete process.env['KAIF_RETAINED_KEY_PATHS']
    delete process.env['KAIF_RETAINED_KEY_PEMS']
    delete process.env['KAIF_AZURE_KEY_VAULT_URL']
    delete process.env['KAIF_AZURE_PRIVATE_KEY_SECRET_NAME']
    delete process.env['KAIF_AZURE_PRIVATE_KEY_SECRET_VERSION']
    delete process.env['KAIF_AZURE_RETAINED_KEY_SECRETS']
    _setAzureSecretResolver(null)
  })

  it('generates an ephemeral RSA keypair on first call', async () => {
    const key = await getSigningKey()
    expect(key).toBeDefined()
  })

  it('returns a consistent signing key on repeated calls', async () => {
    const a = await getSigningKey()
    const b = await getSigningKey()
    expect(a).toBe(b)
  })

  it('getPublicJWK returns a valid RSA JWK with required fields', async () => {
    const jwk = await getPublicJWK()
    expect(jwk.kty).toBe('RSA')
    expect(jwk.alg).toBe('RS256')
    expect(jwk.use).toBe('sig')
    expect(typeof jwk.n).toBe('string')
    expect(typeof jwk.e).toBe('string')
    expect(typeof jwk.kid).toBe('string')
    // Public JWK must not contain private components
    expect(jwk).not.toHaveProperty('d')
    expect(jwk).not.toHaveProperty('p')
    expect(jwk).not.toHaveProperty('q')
  })

  it('getJWKS wraps the public key in a keys array', async () => {
    const jwks = await getJWKS()
    expect(Array.isArray(jwks.keys)).toBe(true)
    expect(jwks.keys).toHaveLength(1)
    expect(jwks.keys[0]?.kty).toBe('RSA')
  })

  it('ephemeral kid is a UUID string', async () => {
    const kid = await getKid()
    expect(kid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  })

  it('publishes retained verification keys in JWKS', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kaif-retained-'))
    try {
      const { privateKey: activePrivateKey } = await generateKeyPair('RS256', { modulusLength: 2048 })
      const { publicKey: retainedPublicKey } = await generateKeyPair('RS256', { modulusLength: 2048 })

      const activePath = join(dir, 'active.pem')
      const retainedPath = join(dir, 'retained.pem')
      await writeFile(activePath, await exportPKCS8(activePrivateKey, 'RS256'))
      await writeFile(retainedPath, createPublicKeyPem(await exportJWK(retainedPublicKey)))

      process.env['KAIF_PRIVATE_KEY_PATH'] = activePath
      process.env['KAIF_RETAINED_KEY_PATHS'] = retainedPath
      _resetKeyCache()

      const jwks = await getJWKS()
      expect(jwks.keys).toHaveLength(2)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('loads active key and retained keys from inline PEM env vars', async () => {
    const { privateKey: activePrivateKey } = await generateKeyPair('RS256', { modulusLength: 2048 })
    const { publicKey: retainedPublicKey } = await generateKeyPair('RS256', { modulusLength: 2048 })

    process.env['KAIF_PRIVATE_KEY_PEM'] = await exportPKCS8(activePrivateKey, 'RS256')
    process.env['KAIF_RETAINED_KEY_PEMS'] = createPublicKeyPem(await exportJWK(retainedPublicKey))
    _resetKeyCache()

    const jwks = await getJWKS()
    expect(jwks.keys).toHaveLength(2)
  })

  it('loads active key and retained keys from Azure Key Vault secrets', async () => {
    const { privateKey: activePrivateKey } = await generateKeyPair('RS256', { modulusLength: 2048 })
    const { publicKey: retainedPublicKey } = await generateKeyPair('RS256', { modulusLength: 2048 })

    process.env['KAIF_AZURE_KEY_VAULT_URL'] = 'https://kaif-kv.vault.azure.net'
    process.env['KAIF_AZURE_PRIVATE_KEY_SECRET_NAME'] = 'kaif-signing-key'
    process.env['KAIF_AZURE_RETAINED_KEY_SECRETS'] = 'kaif-signing-key-v1-public@v1'

    const activePem = await exportPKCS8(activePrivateKey, 'RS256')
    const retainedPem = createPublicKeyPem(await exportJWK(retainedPublicKey))

    _setAzureSecretResolver(async ({ name, version }) => {
      if (name === 'kaif-signing-key') return activePem
      if (name === 'kaif-signing-key-v1-public' && version === 'v1') return retainedPem
      throw new Error(`unexpected Azure secret lookup: ${name}@${version ?? 'latest'}`)
    })

    _resetKeyCache()
    const jwks = await getJWKS()
    expect(jwks.keys).toHaveLength(2)
  })
})

// ── jwt.ts ────────────────────────────────────────────────────────

function makeTestClaims(overrides?: Partial<KAIFTokenClaims>): KAIFTokenClaims {
  const now = Math.floor(Date.now() / 1000)
  return {
    iss: 'https://auth.kindred.systems',
    sub: 'alice@example.com',
    aud: 'https://api.kindred.systems',
    iat: now,
    exp: now + 600,
    jti: 'test-jti-' + Math.random().toString(36).slice(2),
    scope: 'invoke:completion',
    actor: {
      sub: 'spiffe://kindred.systems/ns/examples/agent/mock',
      svid_thumbprint: 'sha256:abc123',
    },
    may_act: { sub: 'spiffe://kindred.systems/ns/examples/agent/mock' },
    kaif: {
      trust_score:      0.75,
      trust_tier:       'VERIFIED',
      delegation_depth: 1,
      delegation_id:    'test-delegation-id',
      rollback_window:  'PT10M',
      principal_chain:  ['alice@example.com'],
    },
    ...overrides,
  }
}

describe('signKAIFToken + verifyJWT', () => {
  beforeEach(() => {
    _resetKeyCache()
    delete process.env['KAIF_PRIVATE_KEY_PATH']
    delete process.env['KAIF_PRIVATE_KEY_PEM']
    delete process.env['KAIF_RETAINED_KEY_PATHS']
    delete process.env['KAIF_RETAINED_KEY_PEMS']
    delete process.env['KAIF_AZURE_KEY_VAULT_URL']
    delete process.env['KAIF_AZURE_PRIVATE_KEY_SECRET_NAME']
    delete process.env['KAIF_AZURE_PRIVATE_KEY_SECRET_VERSION']
    delete process.env['KAIF_AZURE_RETAINED_KEY_SECRETS']
    _setAzureSecretResolver(null)
  })

  afterEach(() => {
    delete process.env['KAIF_PRIVATE_KEY_PATH']
    delete process.env['KAIF_PRIVATE_KEY_PEM']
    delete process.env['KAIF_RETAINED_KEY_PATHS']
    delete process.env['KAIF_RETAINED_KEY_PEMS']
    delete process.env['KAIF_AZURE_KEY_VAULT_URL']
    delete process.env['KAIF_AZURE_PRIVATE_KEY_SECRET_NAME']
    delete process.env['KAIF_AZURE_PRIVATE_KEY_SECRET_VERSION']
    delete process.env['KAIF_AZURE_RETAINED_KEY_SECRETS']
    _setAzureSecretResolver(null)
  })

  it('produces a compact JWT string', async () => {
    const token = await signKAIFToken(makeTestClaims())
    const parts = token.split('.')
    expect(parts).toHaveLength(3)
  })

  it('round-trips claims through sign → verify', async () => {
    const claims = makeTestClaims()
    const token = await signKAIFToken(claims)
    const payload = await verifyJWT(token)

    expect(payload['sub']).toBe(claims.sub)
    expect(payload['iss']).toBe(claims.iss)
    expect(payload['jti']).toBe(claims.jti)
    expect(payload['scope']).toBe(claims.scope)
  })

  it('verifyJWT throws on a token signed by a different key', async () => {
    const { privateKey: otherKey } = await generateKeyPair('RS256', { modulusLength: 2048 })
    const forgedToken = await new SignJWT({ sub: 'attacker@example.com' } as Record<string, unknown>)
      .setProtectedHeader({ alg: 'RS256', kid: 'other-kid' })
      .sign(otherKey)

    await expect(verifyJWT(forgedToken)).rejects.toThrow()
  })

  it('verifyJWT throws on an expired token', async () => {
    const pastExp = Math.floor(Date.now() / 1000) - 3600
    const token = await signKAIFToken(
      makeTestClaims({ exp: pastExp, iat: pastExp - 600 })
    )
    await expect(verifyJWT(token)).rejects.toThrow()
  })

  it('verifyJWT throws on a malformed token', async () => {
    await expect(verifyJWT('not.a.token')).rejects.toThrow()
  })

  it('KAIF extension claims survive round-trip', async () => {
    const claims = makeTestClaims()
    const token = await signKAIFToken(claims)
    const payload = await verifyJWT(token)

    const kaif = payload['kaif'] as KAIFTokenClaims['kaif']
    expect(kaif.trust_score).toBe(0.75)
    expect(kaif.trust_tier).toBe('VERIFIED')
    expect(kaif.delegation_depth).toBe(1)
    expect(kaif.principal_chain).toEqual(['alice@example.com'])
  })

  it('verifyJWT accepts a token signed by a retained key', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kaif-rotation-'))
    try {
      const { privateKey: previousPrivateKey, publicKey: previousPublicKey } = await generateKeyPair('RS256', { modulusLength: 2048 })
      const { privateKey: activePrivateKey } = await generateKeyPair('RS256', { modulusLength: 2048 })

      const previousPath = join(dir, 'previous-public.pem')
      const activePath = join(dir, 'active.pem')
      await writeFile(previousPath, createPublicKeyPem(await exportJWK(previousPublicKey)))
      await writeFile(activePath, await exportPKCS8(activePrivateKey, 'RS256'))

      process.env['KAIF_PRIVATE_KEY_PATH'] = activePath
      process.env['KAIF_RETAINED_KEY_PATHS'] = previousPath
      _resetKeyCache()

      const previousJwk = await exportJWK(previousPublicKey)
      const previousKid = await calculateJwkThumbprint(previousJwk, 'sha256')
      const token = await new SignJWT(makeTestClaims() as Record<string, unknown>)
        .setProtectedHeader({ alg: 'RS256', kid: previousKid })
        .sign(previousPrivateKey)

      const payload = await verifyJWT(token)
      expect(payload['sub']).toBe('alice@example.com')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

function createPublicKeyPem(jwk: JWK): string {
  const entries = Object.entries(jwk).filter(([key]) => ['kty', 'n', 'e'].includes(key))
  const obj = Object.fromEntries(entries) as JWK
  const keyObject = createPublicKey({ key: obj, format: 'jwk' })
  return keyObject.export({ format: 'pem', type: 'spki' }).toString()
}

// ── computeThumbprint ─────────────────────────────────────────────

describe('computeThumbprint', () => {
  it('returns a sha256: prefixed string', async () => {
    const { publicKey } = await generateKeyPair('RS256', { modulusLength: 2048 })
    const jwk = await exportJWK(publicKey)
    const thumb = await computeThumbprint(jwk)
    expect(thumb).toMatch(/^sha256:[A-Za-z0-9_-]+$/)
  })

  it('is deterministic for the same JWK', async () => {
    const { publicKey } = await generateKeyPair('RS256', { modulusLength: 2048 })
    const jwk = await exportJWK(publicKey)
    const a = await computeThumbprint(jwk)
    const b = await computeThumbprint(jwk)
    expect(a).toBe(b)
  })

  it('differs for different keys', async () => {
    const { publicKey: k1 } = await generateKeyPair('RS256', { modulusLength: 2048 })
    const { publicKey: k2 } = await generateKeyPair('RS256', { modulusLength: 2048 })
    const t1 = await computeThumbprint(await exportJWK(k1))
    const t2 = await computeThumbprint(await exportJWK(k2))
    expect(t1).not.toBe(t2)
  })

  it('matches jose calculateJwkThumbprint output', async () => {
    const { publicKey } = await generateKeyPair('RS256', { modulusLength: 2048 })
    const jwk = await exportJWK(publicKey)
    const expected = `sha256:${await calculateJwkThumbprint(jwk, 'sha256')}`
    expect(await computeThumbprint(jwk)).toBe(expected)
  })
})

// ── verifySVIDJWT ─────────────────────────────────────────────────

describe('verifySVIDJWT', () => {
  let spirePrivateKey: KeyLike
  let spirePublicJWK: JWK
  let spireKid: string

  beforeEach(async () => {
    _resetKeyCache()
    _resetSpireJWKSCache()

    const { privateKey, publicKey } = await generateKeyPair('RS256', { modulusLength: 2048 })
    spirePrivateKey = privateKey
    spirePublicJWK = await exportJWK(publicKey)
    spireKid = await calculateJwkThumbprint(spirePublicJWK, 'sha256')
    spirePublicJWK = { ...spirePublicJWK, kid: spireKid }

    process.env['KAIF_SPIRE_TRUST_DOMAIN'] = 'kindred.systems'
    process.env['KAIF_SPIRE_BUNDLE_ENDPOINT'] = 'https://spire.test/'

    // Inject SPIRE JWKS directly — avoids HTTP fetch mocking problems with jose's
    // createRemoteJWKSet which captures the fetch reference at module load time.
    _setSpireJWKS(createLocalJWKSet({ keys: [spirePublicJWK] }))
    _setRawSpireKeys([spirePublicJWK])
  })

  it('accepts a valid JWT-SVID from the configured trust domain', async () => {
    const now = Math.floor(Date.now() / 1000)
    const svid = await new SignJWT({ sub: 'spiffe://kindred.systems/ns/examples/agent/mock' } as Record<string, unknown>)
      .setProtectedHeader({ alg: 'RS256', kid: spireKid })
      .setIssuedAt(now)
      .setExpirationTime(now + 600)
      .sign(spirePrivateKey)

    const result = await verifySVIDJWT(svid)

    expect(result.spiffe_id).toBe('spiffe://kindred.systems/ns/examples/agent/mock')
    expect(result.thumbprint).toMatch(/^sha256:/)
    expect(result.expiry).toBe(now + 600)
    expect(result.raw_cert).toEqual(Buffer.alloc(0))
  })

  it('rejects an SVID with wrong trust domain', async () => {
    const now = Math.floor(Date.now() / 1000)
    const svid = await new SignJWT({ sub: 'spiffe://evil.example.com/agent/bad' } as Record<string, unknown>)
      .setProtectedHeader({ alg: 'RS256', kid: spireKid })
      .setIssuedAt(now)
      .setExpirationTime(now + 600)
      .sign(spirePrivateKey)

    await expect(verifySVIDJWT(svid)).rejects.toThrow()
  })

  it('rejects an expired SVID', async () => {
    const past = Math.floor(Date.now() / 1000) - 3600
    const svid = await new SignJWT({ sub: 'spiffe://kindred.systems/ns/examples/agent/mock' } as Record<string, unknown>)
      .setProtectedHeader({ alg: 'RS256', kid: spireKid })
      .setIssuedAt(past - 600)
      .setExpirationTime(past)
      .sign(spirePrivateKey)

    await expect(verifySVIDJWT(svid)).rejects.toThrow()
  })

  it('rejects an SVID signed by an untrusted key', async () => {
    const { privateKey: foreignKey } = await generateKeyPair('RS256', { modulusLength: 2048 })
    const now = Math.floor(Date.now() / 1000)
    const svid = await new SignJWT({ sub: 'spiffe://kindred.systems/ns/examples/agent/mock' } as Record<string, unknown>)
      .setProtectedHeader({ alg: 'RS256', kid: 'foreign-kid' })
      .setIssuedAt(now)
      .setExpirationTime(now + 600)
      .sign(foreignKey)

    await expect(verifySVIDJWT(svid)).rejects.toThrow()
  })

  it('computes the correct JWK thumbprint for the signing key', async () => {
    const now = Math.floor(Date.now() / 1000)
    const svid = await new SignJWT({ sub: 'spiffe://kindred.systems/ns/test/agent/x' } as Record<string, unknown>)
      .setProtectedHeader({ alg: 'RS256', kid: spireKid })
      .setIssuedAt(now)
      .setExpirationTime(now + 600)
      .sign(spirePrivateKey)

    const result = await verifySVIDJWT(svid)
    const expected = `sha256:${await calculateJwkThumbprint(spirePublicJWK, 'sha256')}`
    expect(result.thumbprint).toBe(expected)
  })

  it('accepts SPIRE JWT-SVID bundle keys marked with use jwt-svid', async () => {
    _resetSpireJWKSCache()
    _setSpireBundleFetcher(async () => ({
      keys: [{ ...spirePublicJWK, use: 'jwt-svid' }],
    }))

    try {
      const now = Math.floor(Date.now() / 1000)
      const svid = await new SignJWT({ sub: 'spiffe://kindred.systems/ns/conformance/agent/test' } as Record<string, unknown>)
        .setProtectedHeader({ alg: 'RS256', kid: spireKid })
        .setIssuedAt(now)
        .setExpirationTime(now + 600)
        .sign(spirePrivateKey)

      const result = await verifySVIDJWT(svid)
      expect(result.spiffe_id).toBe('spiffe://kindred.systems/ns/conformance/agent/test')
    } finally {
      _resetSpireBundleFetcher()
    }
  })
})
