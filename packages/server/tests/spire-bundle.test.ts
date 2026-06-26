import https from 'node:https'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getSpireJwksOptions } from '../src/crypto/spire-bundle.js'

const originalEnv = { ...process.env }
const caPath = new URL('../config/agents.yaml', import.meta.url).pathname

type OptionsWithAgent = ReturnType<typeof getSpireJwksOptions> & {
  agent?: unknown
}

describe('SPIRE bundle JWKS transport options', () => {
  beforeEach(() => {
    process.env = { ...originalEnv }
    delete process.env['KAIF_SPIRE_BUNDLE_CA_PATH']
    delete process.env['KAIF_SPIRE_BUNDLE_CA_PEM']
    delete process.env['KAIF_SPIRE_BUNDLE_TLS_INSECURE']
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it('uses default TLS verification for HTTPS bundle endpoints', () => {
    const options = getSpireJwksOptions('https://spire.test/bundle') as OptionsWithAgent

    expect(options.agent).toBeUndefined()
  })

  it('uses the configured CA file for private HTTPS bundle endpoints', () => {
    process.env['KAIF_SPIRE_BUNDLE_CA_PATH'] = caPath

    const options = getSpireJwksOptions('https://spire.test/bundle') as OptionsWithAgent

    expect(options.agent).toBeInstanceOf(https.Agent)
  })

  it('uses the configured CA PEM for private HTTPS bundle endpoints', () => {
    process.env['KAIF_SPIRE_BUNDLE_CA_PEM'] = '-----BEGIN CERTIFICATE-----\nmock\n-----END CERTIFICATE-----'

    const options = getSpireJwksOptions('https://spire.test/bundle') as OptionsWithAgent

    expect(options.agent).toBeInstanceOf(https.Agent)
  })

  it('keeps insecure TLS override explicit and HTTPS-only for local development', () => {
    process.env['KAIF_SPIRE_BUNDLE_TLS_INSECURE'] = 'true'

    const httpsOptions = getSpireJwksOptions('https://localhost:8081/bundle') as OptionsWithAgent
    const httpOptions = getSpireJwksOptions('http://localhost:8081/bundle') as OptionsWithAgent

    expect(httpsOptions.agent).toBeInstanceOf(https.Agent)
    expect(httpOptions.agent).toBeUndefined()
  })
})
