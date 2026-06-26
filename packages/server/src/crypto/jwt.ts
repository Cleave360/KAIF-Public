import {
  SignJWT,
  jwtVerify,
  createRemoteJWKSet,
  createLocalJWKSet,
  decodeProtectedHeader,
  calculateJwkThumbprint,
} from 'jose'
import type { JWTPayload, JWK } from 'jose'
import { getSigningKey, getJWKS, getKid } from './keys.js'
import { fetchSpireBundle } from './spire-bundle.js'
import type { KAIFTokenClaims, ParsedSVID } from '../types/kaif.js'

// ── SPIRE bundle JWKS (cached via raw bundle fetch at 5-minute TTL) ─
// The type is kept broad so tests can inject createLocalJWKSet output.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _spireJWKS: any = null

function normalizeSpireJwtKeys(keys: JWK[]): JWK[] {
  return keys
    .filter((key) => key.use === undefined || key.use === 'jwt-svid' || key.use === 'sig')
    .map((key) => key.use === 'jwt-svid' ? { ...key, use: 'sig' } : key)
}

function getSpireJWKS(): ReturnType<typeof createLocalJWKSet> {
  if (_spireJWKS) return _spireJWKS as ReturnType<typeof createLocalJWKSet>
  _spireJWKS = async (protectedHeader: unknown, token: unknown) => {
    const keys = normalizeSpireJwtKeys(await getRawSpireJWKS())
    return createLocalJWKSet({ keys })(
      protectedHeader as Parameters<ReturnType<typeof createLocalJWKSet>>[0],
      token as Parameters<ReturnType<typeof createLocalJWKSet>>[1]
    )
  }
  return _spireJWKS
}

// Test injection: replace SPIRE key resolution with a createLocalJWKSet-backed getter.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function _setSpireJWKS(fn: any): void {
  _spireJWKS = fn
}

// Test injection: pre-populate the raw SPIRE keys cache (bypasses fetch)
export function _setRawSpireKeys(keys: JWK[]): void {
  _rawSpireCache = { keys, fetchedAt: Date.now() }
}

export function _resetSpireJWKSCache(): void {
  _spireJWKS = null
  _rawSpireCache = null
}

// ── Raw SPIRE JWKS cache for verification and thumbprint computation ─

interface RawJWKSCache {
  keys:      JWK[]
  fetchedAt: number
}

let _rawSpireCache: RawJWKSCache | null = null

async function getRawSpireJWKS(): Promise<JWK[]> {
  const now = Date.now()
  if (_rawSpireCache && now - _rawSpireCache.fetchedAt < 5 * 60 * 1000) {
    return _rawSpireCache.keys
  }

  const endpoint = process.env['KAIF_SPIRE_BUNDLE_ENDPOINT']
  if (!endpoint) throw new Error('KAIF_SPIRE_BUNDLE_ENDPOINT is not set')

  const body = await fetchSpireBundle(endpoint)
  _rawSpireCache = { keys: body.keys, fetchedAt: now }
  return body.keys
}

// ── IdP JWKS (for /provision id_token verification) ──────────────
// Same injection pattern as SPIRE JWKS so tests never hit the network.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _idpJWKS: any = null

function getIdpJWKS(): ReturnType<typeof createRemoteJWKSet> {
  if (_idpJWKS) return _idpJWKS as ReturnType<typeof createRemoteJWKSet>
  const url = process.env['KAIF_IDP_JWKS_URL']
  if (!url) throw new Error('KAIF_IDP_JWKS_URL is not set')
  _idpJWKS = createRemoteJWKSet(new URL(url), { cacheMaxAge: 5 * 60 * 1000 })
  return _idpJWKS
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function _setIdpJWKS(fn: any): void { _idpJWKS = fn }
export function _resetIdpJWKSCache(): void { _idpJWKS = null }

export async function verifyIdpToken(token: string): Promise<JWTPayload> {
  const issuer = process.env['KAIF_IDP_ISSUER']
  const { payload } = await jwtVerify(token, getIdpJWKS(), {
    algorithms: ['RS256'],
    ...(issuer ? { issuer } : {}),
  })
  return payload
}

// ── Public API ────────────────────────────────────────────────────

export async function signKAIFToken(claims: KAIFTokenClaims): Promise<string> {
  const [privateKey, kid] = await Promise.all([getSigningKey(), getKid()])

  return new SignJWT(claims as unknown as JWTPayload)
    .setProtectedHeader({ alg: 'RS256', kid })
    .sign(privateKey)
}

export async function verifyJWT(token: string): Promise<JWTPayload> {
  const jwks = await getJWKS()
  const { payload } = await jwtVerify(token, createLocalJWKSet(jwks), { algorithms: ['RS256'] })
  return payload
}

export async function verifySVIDJWT(svid: string): Promise<ParsedSVID> {
  const trustDomain = process.env['KAIF_SPIRE_TRUST_DOMAIN']

  const { payload } = await jwtVerify(svid, getSpireJWKS(), {
    algorithms: ['RS256', 'ES256'],
  })

  const spiffeId = payload.sub
  if (!spiffeId) throw new Error('SVID missing sub claim')

  if (trustDomain && !spiffeId.startsWith(`spiffe://${trustDomain}/`)) {
    throw new Error(`SVID sub does not match trust domain — got: ${spiffeId}`)
  }

  const expiry = payload.exp ?? 0

  // Compute JWK thumbprint of the key that signed this SVID (Clarification 2)
  const header = decodeProtectedHeader(svid)
  const spireKeys = await getRawSpireJWKS()
  const signingJWK = spireKeys.find(k => k.kid === header.kid)

  let thumbprint: string
  if (signingJWK) {
    const tp = await calculateJwkThumbprint(signingJWK, 'sha256')
    thumbprint = `sha256:${tp}`
  } else {
    // Key rotated between verification and thumbprint lookup — use kid as fallback
    thumbprint = `sha256:${header.kid ?? 'unknown'}`
  }

  return {
    spiffe_id: spiffeId,
    thumbprint,
    expiry,
    raw_cert: Buffer.alloc(0),
  }
}

// Compute JWK thumbprint — returns "sha256:<thumbprint>"
// Clarification 2: replaces RFC 8705 cert-DER thumbprint for JWT-SVID flows
export async function computeThumbprint(jwk: JWK): Promise<string> {
  const tp = await calculateJwkThumbprint(jwk, 'sha256')
  return `sha256:${tp}`
}
