import {
  generateKeyPair as joseGenerateKeyPair,
  exportJWK,
  importPKCS8,
  calculateJwkThumbprint,
} from 'jose'
import { randomUUID } from 'crypto'
import { readFile } from 'fs/promises'
import type { JWK, KeyLike } from 'jose'

interface KeyCache {
  privateKey: KeyLike
  publicJWK:  JWK & { kid: string; alg: string; use: string }
  kid:        string
}

// Promise-cache: concurrent callers share one buildEphemeral/buildFromFile call.
let _cachePromise: Promise<KeyCache> | null = null

async function buildFromFile(keyPath: string): Promise<KeyCache> {
  const pem = await readFile(keyPath, 'utf8')
  const privateKey = await importPKCS8(pem, 'RS256')

  // Derive public JWK by stripping private components from the exported JWK
  const fullJWK = await exportJWK(privateKey)
  const { d: _d, p: _p, q: _q, dp: _dp, dq: _dq, qi: _qi, ...publicFields } = fullJWK
  const publicJWK = publicFields as JWK

  // kid derived from public key thumbprint — stable across restarts
  const kid = await calculateJwkThumbprint(publicJWK, 'sha256')

  return {
    privateKey,
    publicJWK: { ...publicJWK, kid, alg: 'RS256', use: 'sig' },
    kid,
  }
}

async function buildEphemeral(): Promise<KeyCache> {
  const { privateKey, publicKey } = await joseGenerateKeyPair('RS256', { modulusLength: 2048 })
  const publicJWK = await exportJWK(publicKey)
  // kid is random for ephemeral keys — only valid for this process lifetime
  const kid = randomUUID()

  return {
    privateKey,
    publicJWK: { ...publicJWK, kid, alg: 'RS256', use: 'sig' },
    kid,
  }
}

function getCache(): Promise<KeyCache> {
  if (_cachePromise) return _cachePromise

  const keyPath = process.env['KAIF_PRIVATE_KEY_PATH'] || undefined
  _cachePromise = (keyPath ? buildFromFile(keyPath) : buildEphemeral()).catch(err => {
    _cachePromise = null  // allow retry after error
    throw err
  })
  return _cachePromise
}

// Exposed for testing — allows resetting the in-process key cache
export function _resetKeyCache(): void {
  _cachePromise = null
}

export async function getSigningKey(): Promise<KeyLike> {
  return (await getCache()).privateKey
}

export async function getPublicJWK(): Promise<JWK> {
  return (await getCache()).publicJWK
}

export async function getJWKS(): Promise<{ keys: JWK[] }> {
  return { keys: [await getPublicJWK()] }
}

export async function getKid(): Promise<string> {
  return (await getCache()).kid
}
