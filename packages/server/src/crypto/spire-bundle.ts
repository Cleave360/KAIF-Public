import http from 'node:http'
import https from 'node:https'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import type { JWK, RemoteJWKSetOptions } from 'jose'

const CACHE_MAX_AGE_MS = 5 * 60 * 1000
const FETCH_TIMEOUT_MS = 5 * 1000

export interface SpireBundle {
  keys: JWK[]
  spiffe_sequence?: number
  spiffe_refresh_hint?: number
}

let _fetchSpireBundleOverride: ((endpoint: string) => Promise<SpireBundle>) | null = null

export function _setSpireBundleFetcher(fn: (endpoint: string) => Promise<SpireBundle>): void {
  _fetchSpireBundleOverride = fn
}

export function _resetSpireBundleFetcher(): void {
  _fetchSpireBundleOverride = null
}

function allowInsecureBundleTls(endpoint: URL): boolean {
  return endpoint.protocol === 'https:'
    && process.env['KAIF_SPIRE_BUNDLE_TLS_INSECURE'] === 'true'
}

function getBundleAgent(endpoint: URL): https.Agent | undefined {
  if (endpoint.protocol !== 'https:') return undefined

  const caPath = process.env['KAIF_SPIRE_BUNDLE_CA_PATH']
  if (caPath) {
    return new https.Agent({ ca: readFileSync(caPath) })
  }

  if (allowInsecureBundleTls(endpoint)) {
    return new https.Agent({ rejectUnauthorized: false })
  }

  return undefined
}

export function getSpireJwksOptions(endpoint: string): RemoteJWKSetOptions {
  const url = new URL(endpoint)
  const options: RemoteJWKSetOptions = { cacheMaxAge: CACHE_MAX_AGE_MS }
  const agent = getBundleAgent(url)

  if (agent) options.agent = agent

  return options
}

export async function fetchSpireBundle(
  endpoint: string,
  timeoutMs = FETCH_TIMEOUT_MS
): Promise<SpireBundle> {
  if (_fetchSpireBundleOverride) return _fetchSpireBundleOverride(endpoint)

  const url = new URL(endpoint)
  const get = url.protocol === 'https:' ? https.get
    : url.protocol === 'http:' ? http.get
      : null

  if (!get) throw new Error(`Unsupported SPIRE bundle URL protocol: ${url.protocol}`)

  const req = get(url, {
    agent: getBundleAgent(url),
    timeout: timeoutMs,
    headers: { accept: 'application/json' },
  })

  const [response] = await Promise.race([
    once(req, 'response'),
    once(req, 'timeout'),
  ]) as [http.IncomingMessage | undefined]

  if (!response) {
    req.destroy()
    throw new Error('SPIRE bundle fetch timed out')
  }

  if ((response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300) {
    throw new Error(`Failed to fetch SPIRE bundle: HTTP ${response.statusCode ?? 'unknown'}`)
  }

  const chunks: Buffer[] = []
  for await (const chunk of response) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }

  const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as SpireBundle
  if (!Array.isArray(body.keys)) {
    throw new Error('SPIRE bundle response is missing keys')
  }

  return body
}
