import {
  generateKeyPair as joseGenerateKeyPair,
  exportJWK,
  importPKCS8,
  calculateJwkThumbprint,
} from 'jose'
import { createPrivateKey, createPublicKey } from 'node:crypto'
import { randomUUID } from 'crypto'
import type { JWK, KeyLike } from 'jose'
import { loadConfiguredKeyMaterial } from './key-source.js'

type PublicJWK = JWK & { kid: string; alg: string; use: string }

interface KeyCache {
  privateKey: KeyLike
  publicJWK:  PublicJWK
  jwks:       { keys: PublicJWK[] }
  kid:        string
}

// Promise-cache: concurrent callers share one buildEphemeral/buildFromFile call.
let _cachePromise: Promise<KeyCache> | null = null

async function buildEphemeral(): Promise<KeyCache> {
  const { privateKey, publicKey } = await joseGenerateKeyPair('RS256', { modulusLength: 2048 })
  const publicJWK = await exportJWK(publicKey)
  // kid is random for ephemeral keys — only valid for this process lifetime
  const kid = randomUUID()

  return {
    privateKey,
    publicJWK: { ...publicJWK, kid, alg: 'RS256', use: 'sig' },
    jwks: { keys: [{ ...publicJWK, kid, alg: 'RS256', use: 'sig' }] },
    kid,
  }
}

async function toPublicJWK(pem: string): Promise<PublicJWK> {
  const keyObject = pem.includes('BEGIN PUBLIC KEY')
    ? createPublicKey(pem)
    : createPublicKey(createPrivateKey(pem))
  const publicJWK = await exportJWK(keyObject)
  const kid = await calculateJwkThumbprint(publicJWK, 'sha256')
  return { ...publicJWK, kid, alg: 'RS256', use: 'sig' }
}

function getCache(): Promise<KeyCache> {
  if (_cachePromise) return _cachePromise

  _cachePromise = loadConfiguredKeyMaterial()
    .then((material) => material.privatePem
      ? buildFromPem(material.privatePem, material.retainedPublicPems)
      : buildEphemeral())
    .catch(err => {
    _cachePromise = null  // allow retry after error
    throw err
  })
  return _cachePromise
}

async function buildFromPem(pem: string, retainedPublicPems: string[] = []): Promise<KeyCache> {
  const privateKey = await importPKCS8(pem, 'RS256')
  const publicJWK = await toPublicJWK(pem)
  const kid = publicJWK.kid
  const retainedPublicJWKs = await Promise.all(retainedPublicPems.map((retainedPem) => toPublicJWK(retainedPem)))

  return {
    privateKey,
    publicJWK,
    jwks: { keys: [publicJWK, ...retainedPublicJWKs.filter(key => key.kid !== kid)] },
    kid,
  }
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
  return (await getCache()).jwks
}

export async function getKid(): Promise<string> {
  return (await getCache()).kid
}
