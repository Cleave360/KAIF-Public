import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'

const originalEnv = { ...process.env }

function setBaseEnv(): void {
  process.env['KAIF_ISSUER'] = 'https://auth.test'
  process.env['KAIF_REDIS_URL'] = 'redis://localhost:6379'
  process.env['KAIF_SPIRE_BUNDLE_ENDPOINT'] = 'http://spire.test/bundles/jwt'
  process.env['KAIF_SPIRE_TRUST_DOMAIN'] = 'kindred.systems'
  process.env['KAIF_IDP_JWKS_URL'] = 'https://idp.test/jwks'
  process.env['KAIF_IDP_ISSUER'] = 'https://idp.test'
  process.env['KAIF_AGENTS_CONFIG_PATH'] = new URL('../config/agents.yaml', import.meta.url).pathname
}

describe('loadConfig production guardrails', () => {
  beforeEach(() => {
    process.env = { ...originalEnv }
    setBaseEnv()
    delete process.env['NODE_ENV']
    delete process.env['KAIF_DEV_MODE']
    delete process.env['KAIF_PRIVATE_KEY_PATH']
    delete process.env['KAIF_ALLOW_INSECURE_REDIS']
    delete process.env['KAIF_TENANT_ADDRESS']
    delete process.env['KAIF_GOVERNANCE_AUDIT_APPEND_URL']
    delete process.env['KAIF_GOVERNANCE_WORKSPACE_ID']
    delete process.env['KAIF_GOVERNANCE_PROJECT_ID']
    delete process.env['KAIF_GOVERNANCE_UI_INSTANCE_ID']
    delete process.env['KAIF_CLASS_C_DEGRADED_OPEN']
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it('allows dev mode outside production', () => {
    process.env['KAIF_DEV_MODE'] = 'true'
    const config = loadConfig()
    expect(config.dev_mode).toBe(true)
  })

  it('rejects dev mode in production', () => {
    process.env['NODE_ENV'] = 'production'
    process.env['KAIF_DEV_MODE'] = 'true'
    process.env['KAIF_PRIVATE_KEY_PATH'] = '/run/secrets/kaif.pem'
    process.env['KAIF_REDIS_URL'] = 'rediss://kaif.redis:6380'

    expect(() => loadConfig()).toThrow(/KAIF_DEV_MODE=true/)
  })

  it('requires persistent signing key in production', () => {
    process.env['NODE_ENV'] = 'production'
    process.env['KAIF_REDIS_URL'] = 'rediss://kaif.redis:6380'

    expect(() => loadConfig()).toThrow(/KAIF_PRIVATE_KEY_PATH is required/)
  })

  it('requires TLS Redis URL in production by default', () => {
    process.env['NODE_ENV'] = 'production'
    process.env['KAIF_PRIVATE_KEY_PATH'] = '/run/secrets/kaif.pem'

    expect(() => loadConfig()).toThrow(/KAIF_REDIS_URL must use rediss/)
  })

  it('allows explicit insecure Redis override for controlled production tests', () => {
    process.env['NODE_ENV'] = 'production'
    process.env['KAIF_PRIVATE_KEY_PATH'] = '/run/secrets/kaif.pem'
    process.env['KAIF_ALLOW_INSECURE_REDIS'] = 'true'

    const config = loadConfig()
    expect(config.redis_url).toBe('redis://localhost:6379')
  })

  it('captures KAIF tenant address when provided', () => {
    process.env['KAIF_TENANT_ADDRESS'] = 'kaif://tenant/test'
    const config = loadConfig()
    expect(config.tenant_address).toBe('kaif://tenant/test')
  })

  it('captures governance audit append settings when provided', () => {
    process.env['KAIF_GOVERNANCE_AUDIT_APPEND_URL'] = 'http://adaptive.test/v1/audit/append'
    process.env['KAIF_GOVERNANCE_WORKSPACE_ID'] = 'ws-test'
    process.env['KAIF_GOVERNANCE_PROJECT_ID'] = 'kaif-test'
    process.env['KAIF_GOVERNANCE_UI_INSTANCE_ID'] = 'ui-test'
    process.env['KAIF_CLASS_C_DEGRADED_OPEN'] = 'true'

    const config = loadConfig()
    expect(config.governance_audit_append_url).toBe('http://adaptive.test/v1/audit/append')
    expect(config.governance_workspace_id).toBe('ws-test')
    expect(config.governance_project_id).toBe('kaif-test')
    expect(config.governance_ui_instance_id).toBe('ui-test')
    expect(config.class_c_degraded_open).toBe(true)
  })
})
