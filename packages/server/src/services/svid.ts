import { verifySVIDJWT } from '../crypto/jwt.js'
import type { ParsedSVID } from '../types/kaif.js'

// spiffe://<trust-domain>/<path>  — domain must be non-empty, path optional but slash required
const SPIFFE_RE = /^spiffe:\/\/[^/]+\/.+$/

export function validateSpiffeID(id: string): boolean {
  return SPIFFE_RE.test(id)
}

// 10 seconds clock skew tolerance — Security Rule 8 (not configurable)
const CLOCK_SKEW_SECONDS = 10

export function isSVIDValid(svid: ParsedSVID): boolean {
  const nowSeconds = Math.floor(Date.now() / 1000)
  return svid.expiry > nowSeconds - CLOCK_SKEW_SECONDS
}

export async function validateSVID(svid_jwt: string): Promise<ParsedSVID> {
  const parsed = await verifySVIDJWT(svid_jwt)

  if (!validateSpiffeID(parsed.spiffe_id)) {
    throw new Error(`Invalid SPIFFE ID format: ${parsed.spiffe_id}`)
  }

  if (!isSVIDValid(parsed)) {
    throw new Error(`SVID expired for ${parsed.spiffe_id}`)
  }

  return parsed
}
