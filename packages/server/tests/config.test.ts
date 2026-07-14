import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'

const originalEnv = { ...process.env }

function setBaseEnv(): void {
  process.env['KAIF_ISSUER'] = 'https://auth.test'
  process.env['KAIF_REDIS_URL'] = 'redis://localhost:6379'
  process.env['KAIF_SPIRE_BUNDLE_ENDPOINT'] = 'https://spire.test/'
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
    delete process.env['KAIF_PRIVATE_KEY_PEM']
    delete process.env['KAIF_AZURE_KEY_VAULT_URL']
    delete process.env['KAIF_AZURE_PRIVATE_KEY_SECRET_NAME']
    delete process.env['KAIF_AZURE_PRIVATE_KEY_SECRET_VERSION']
    delete process.env['KAIF_AZURE_RETAINED_KEY_SECRETS']
    delete process.env['KAIF_ALLOW_INSECURE_REDIS']
    delete process.env['KAIF_ALLOWED_AUDIENCES']
    delete process.env['KAIF_SPIRE_BUNDLE_CA_PATH']
    delete process.env['KAIF_SPIRE_BUNDLE_CA_PEM']
    delete process.env['KAIF_SPIRE_BUNDLE_TLS_INSECURE']
    delete process.env['KAIF_TENANT_ADDRESS']
    delete process.env['KAIF_GOVERNANCE_AUDIT_APPEND_URL']
    delete process.env['KAIF_GOVERNANCE_WORKSPACE_ID']
    delete process.env['KAIF_GOVERNANCE_PROJECT_ID']
    delete process.env['KAIF_GOVERNANCE_UI_INSTANCE_ID']
    delete process.env['KAIF_CLASS_C_DEGRADED_OPEN']
    delete process.env['KAIF_FOUNDRY_PROJECT_ENDPOINT']
    delete process.env['KAIF_FOUNDRY_API_VERSION']
    delete process.env['KAIF_FOUNDRY_MODE']
    delete process.env['KAIF_FOUNDRY_AUTH_MODE']
    delete process.env['KAIF_FOUNDRY_API_KEY']
    delete process.env['KAIF_FOUNDRY_INVOKE_PATH']
    delete process.env['KAIF_FOUNDRY_AAD_SCOPE']
    delete process.env['KAIF_FOUNDRY_MODEL']
    delete process.env['KAIF_FOUNDRY_AGENT_NAME']
    delete process.env['KAIF_FOUNDRY_AGENT_VERSION']
    delete process.env['KAIF_DNS_DELIVERY_ENABLED']
    delete process.env['KAIF_DNS_BASE_URL']
    delete process.env['KAIF_DNS_AUTH_MODE']
    delete process.env['KAIF_DNS_AUTH_TOKEN']
    delete process.env['KAIF_DNS_WRITE_TIMEOUT_MS']
    delete process.env['KAIF_DNS_RESUME_TIMEOUT_MS']
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

    expect(() => loadConfig()).toThrow(/KAIF_PRIVATE_KEY_PATH, KAIF_PRIVATE_KEY_PEM, or Azure Key Vault key source is required/)
  })

  it('accepts inline private key material in production', () => {
    process.env['NODE_ENV'] = 'production'
    process.env['KAIF_PRIVATE_KEY_PEM'] = '-----BEGIN PRIVATE KEY-----\nmock\n-----END PRIVATE KEY-----'
    process.env['KAIF_REDIS_URL'] = 'rediss://kaif.redis:6380'

    const config = loadConfig()
    expect(config.private_key_pem).toContain('BEGIN PRIVATE KEY')
  })

  it('rejects conflicting private key path and inline key material', () => {
    process.env['KAIF_PRIVATE_KEY_PATH'] = '/run/secrets/kaif.pem'
    process.env['KAIF_PRIVATE_KEY_PEM'] = '-----BEGIN PRIVATE KEY-----\nmock\n-----END PRIVATE KEY-----'

    expect(() => loadConfig()).toThrow(/cannot both be set/)
  })

  it('accepts Azure Key Vault key source in production', () => {
    process.env['NODE_ENV'] = 'production'
    process.env['KAIF_AZURE_KEY_VAULT_URL'] = 'https://kaif-kv.vault.azure.net'
    process.env['KAIF_AZURE_PRIVATE_KEY_SECRET_NAME'] = 'kaif-signing-key'
    process.env['KAIF_AZURE_RETAINED_KEY_SECRETS'] = 'kaif-signing-key-v1-public,kaif-signing-key-v2-public@abcd1234'
    process.env['KAIF_REDIS_URL'] = 'rediss://kaif.redis:6380'

    const config = loadConfig()

    expect(config.azure_key_vault_url).toBe('https://kaif-kv.vault.azure.net')
    expect(config.azure_private_key_secret_name).toBe('kaif-signing-key')
    expect(config.azure_retained_key_secrets).toEqual([
      'kaif-signing-key-v1-public',
      'kaif-signing-key-v2-public@abcd1234',
    ])
  })

  it('rejects conflicting local and Azure key sources', () => {
    process.env['KAIF_PRIVATE_KEY_PATH'] = '/run/secrets/kaif.pem'
    process.env['KAIF_AZURE_KEY_VAULT_URL'] = 'https://kaif-kv.vault.azure.net'
    process.env['KAIF_AZURE_PRIVATE_KEY_SECRET_NAME'] = 'kaif-signing-key'

    expect(() => loadConfig()).toThrow(/Local key material and Azure Key Vault key sources cannot both be set/)
  })

  it('rejects partial Azure key source configuration', () => {
    process.env['KAIF_AZURE_PRIVATE_KEY_SECRET_NAME'] = 'kaif-signing-key'

    expect(() => loadConfig()).toThrow(/KAIF_AZURE_KEY_VAULT_URL is required/)
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

  it('rejects insecure SPIRE bundle TLS in production', () => {
    process.env['NODE_ENV'] = 'production'
    process.env['KAIF_PRIVATE_KEY_PATH'] = '/run/secrets/kaif.pem'
    process.env['KAIF_REDIS_URL'] = 'rediss://kaif.redis:6380'
    process.env['KAIF_SPIRE_BUNDLE_TLS_INSECURE'] = 'true'

    expect(() => loadConfig()).toThrow(/KAIF_SPIRE_BUNDLE_TLS_INSECURE=true/)
  })

  it('requires a valid SPIRE bundle URL', () => {
    process.env['KAIF_SPIRE_BUNDLE_ENDPOINT'] = 'not-a-url'

    expect(() => loadConfig()).toThrow(/KAIF_SPIRE_BUNDLE_ENDPOINT must be a valid URL/)
  })

  it('requires https SPIRE bundle endpoint in production', () => {
    process.env['NODE_ENV'] = 'production'
    process.env['KAIF_PRIVATE_KEY_PATH'] = '/run/secrets/kaif.pem'
    process.env['KAIF_REDIS_URL'] = 'rediss://kaif.redis:6380'
    process.env['KAIF_SPIRE_BUNDLE_ENDPOINT'] = 'http://spire.test:8081/'

    expect(() => loadConfig()).toThrow(/KAIF_SPIRE_BUNDLE_ENDPOINT must use https:\/\//)
  })

  it('captures insecure SPIRE bundle TLS for local development', () => {
    process.env['KAIF_SPIRE_BUNDLE_TLS_INSECURE'] = 'true'

    const config = loadConfig()
    expect(config.spire_bundle_tls_insecure).toBe(true)
  })

  it('captures SPIRE bundle CA path when provided', () => {
    const caPath = new URL('../config/agents.yaml', import.meta.url).pathname
    process.env['KAIF_SPIRE_BUNDLE_CA_PATH'] = caPath

    const config = loadConfig()
    expect(config.spire_bundle_ca_path).toBe(caPath)
  })

  it('captures SPIRE bundle CA PEM when provided', () => {
    process.env['KAIF_SPIRE_BUNDLE_CA_PEM'] = '-----BEGIN CERTIFICATE-----\nmock\n-----END CERTIFICATE-----'

    const config = loadConfig()
    expect(config.spire_bundle_ca_pem).toContain('BEGIN CERTIFICATE')
  })

  it('rejects missing SPIRE bundle CA path', () => {
    process.env['KAIF_SPIRE_BUNDLE_CA_PATH'] = '/definitely/missing/spire-ca.pem'

    expect(() => loadConfig()).toThrow(/KAIF_SPIRE_BUNDLE_CA_PATH does not exist/)
  })

  it('rejects conflicting SPIRE bundle CA and insecure TLS settings', () => {
    process.env['KAIF_SPIRE_BUNDLE_CA_PATH'] = new URL('../config/agents.yaml', import.meta.url).pathname
    process.env['KAIF_SPIRE_BUNDLE_TLS_INSECURE'] = 'true'

    expect(() => loadConfig()).toThrow(/cannot both be set/)
  })

  it('rejects conflicting SPIRE bundle CA path and inline PEM', () => {
    process.env['KAIF_SPIRE_BUNDLE_CA_PATH'] = new URL('../config/agents.yaml', import.meta.url).pathname
    process.env['KAIF_SPIRE_BUNDLE_CA_PEM'] = '-----BEGIN CERTIFICATE-----\nmock\n-----END CERTIFICATE-----'

    expect(() => loadConfig()).toThrow(/KAIF_SPIRE_BUNDLE_CA_PATH and KAIF_SPIRE_BUNDLE_CA_PEM cannot both be set/)
  })

  it('captures KAIF tenant address when provided', () => {
    process.env['KAIF_TENANT_ADDRESS'] = 'kaif://tenant/test'
    const config = loadConfig()
    expect(config.tenant_address).toBe('kaif://tenant/test')
  })

  it('defaults allowed audiences to issuer', () => {
    const config = loadConfig()
    expect(config.allowed_audiences).toEqual(['https://auth.test'])
  })

  it('captures configured allowed audiences', () => {
    process.env['KAIF_ALLOWED_AUDIENCES'] = 'urn:service:a, https://service-b.test '

    const config = loadConfig()
    expect(config.allowed_audiences).toEqual(['urn:service:a', 'https://service-b.test'])
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

  it('captures Foundry Azure AD settings when provided', () => {
    process.env['KAIF_FOUNDRY_PROJECT_ENDPOINT'] = 'https://example-resource.services.ai.azure.com/api/projects/example-project'
    process.env['KAIF_FOUNDRY_API_VERSION'] = '2025-05-15-preview'
    process.env['KAIF_FOUNDRY_AUTH_MODE'] = 'azure_ad'
    process.env['KAIF_FOUNDRY_AAD_SCOPE'] = 'https://ai.azure.com/.default'
    process.env['KAIF_FOUNDRY_INVOKE_PATH'] = '/agents/mock/runs'

    const config = loadConfig()
    expect(config.foundry_project_endpoint).toBe('https://example-resource.services.ai.azure.com/api/projects/example-project')
    expect(config.foundry_api_version).toBe('2025-05-15-preview')
    expect(config.foundry_auth_mode).toBe('azure_ad')
    expect(config.foundry_aad_scope).toBe('https://ai.azure.com/.default')
    expect(config.foundry_invoke_path).toBe('/agents/mock/runs')
  })

  it('captures Foundry project agent settings when provided', () => {
    process.env['KAIF_FOUNDRY_PROJECT_ENDPOINT'] = 'https://example-resource.services.ai.azure.com/api/projects/example-project'
    process.env['KAIF_FOUNDRY_API_VERSION'] = '2025-05-15-preview'
    process.env['KAIF_FOUNDRY_MODE'] = 'project_agent'
    process.env['KAIF_FOUNDRY_AUTH_MODE'] = 'azure_ad'
    process.env['KAIF_FOUNDRY_AAD_SCOPE'] = 'https://ai.azure.com/.default'
    process.env['KAIF_FOUNDRY_MODEL'] = 'gpt-5-mini'
    process.env['KAIF_FOUNDRY_AGENT_NAME'] = 'BoundaryAgent'
    process.env['KAIF_FOUNDRY_AGENT_VERSION'] = '2'

    const config = loadConfig()
    expect(config.foundry_mode).toBe('project_agent')
    expect(config.foundry_model).toBe('gpt-5-mini')
    expect(config.foundry_agent_name).toBe('BoundaryAgent')
    expect(config.foundry_agent_version).toBe('2')
  })

  it('requires project endpoint when Foundry integration is configured', () => {
    process.env['KAIF_FOUNDRY_AUTH_MODE'] = 'none'
    expect(() => loadConfig()).toThrow(/KAIF_FOUNDRY_PROJECT_ENDPOINT is required/)
  })

  it('requires api key when Foundry auth mode is api_key', () => {
    process.env['KAIF_FOUNDRY_PROJECT_ENDPOINT'] = 'https://example-resource.services.ai.azure.com/api/projects/example-project'
    process.env['KAIF_FOUNDRY_AUTH_MODE'] = 'api_key'
    expect(() => loadConfig()).toThrow(/KAIF_FOUNDRY_API_KEY is required/)
  })

  it('requires Azure AD scope when Foundry auth mode is azure_ad', () => {
    process.env['KAIF_FOUNDRY_PROJECT_ENDPOINT'] = 'https://example-resource.services.ai.azure.com/api/projects/example-project'
    process.env['KAIF_FOUNDRY_AUTH_MODE'] = 'azure_ad'
    expect(() => loadConfig()).toThrow(/KAIF_FOUNDRY_AAD_SCOPE is required/)
  })

  it('rejects Foundry invoke path without a leading slash', () => {
    process.env['KAIF_FOUNDRY_PROJECT_ENDPOINT'] = 'https://example-resource.services.ai.azure.com/api/projects/example-project'
    process.env['KAIF_FOUNDRY_AUTH_MODE'] = 'none'
    process.env['KAIF_FOUNDRY_INVOKE_PATH'] = 'agents/mock/runs'
    expect(() => loadConfig()).toThrow(/KAIF_FOUNDRY_INVOKE_PATH must start with "\/"/)
  })

  it('requires model and agent reference when Foundry mode is project_agent', () => {
    process.env['KAIF_FOUNDRY_PROJECT_ENDPOINT'] = 'https://example-resource.services.ai.azure.com/api/projects/example-project'
    process.env['KAIF_FOUNDRY_MODE'] = 'project_agent'
    process.env['KAIF_FOUNDRY_AUTH_MODE'] = 'azure_ad'
    process.env['KAIF_FOUNDRY_AAD_SCOPE'] = 'https://ai.azure.com/.default'
    expect(() => loadConfig()).toThrow(/KAIF_FOUNDRY_MODEL is required/)

    process.env['KAIF_FOUNDRY_MODEL'] = 'gpt-5-mini'
    expect(() => loadConfig()).toThrow(/KAIF_FOUNDRY_AGENT_NAME is required/)

    process.env['KAIF_FOUNDRY_AGENT_NAME'] = 'BoundaryAgent'
    expect(() => loadConfig()).toThrow(/KAIF_FOUNDRY_AGENT_VERSION is required/)
  })

  it('captures DNS delivery settings when provided', () => {
    process.env['KAIF_DNS_DELIVERY_ENABLED'] = 'true'
    process.env['KAIF_DNS_BASE_URL'] = 'http://127.0.0.1:19082'
    process.env['KAIF_DNS_AUTH_MODE'] = 'both'
    process.env['KAIF_DNS_AUTH_TOKEN'] = 'dev-example-token'
    process.env['KAIF_DNS_WRITE_TIMEOUT_MS'] = '3000'
    process.env['KAIF_DNS_RESUME_TIMEOUT_MS'] = '4000'

    const config = loadConfig()
    expect(config.dns_delivery_enabled).toBe(true)
    expect(config.dns_base_url).toBe('http://127.0.0.1:19082')
    expect(config.dns_auth_mode).toBe('both')
    expect(config.dns_auth_token).toBe('dev-example-token')
    expect(config.dns_write_timeout_ms).toBe(3000)
    expect(config.dns_resume_timeout_ms).toBe(4000)
  })

  it('requires DNS base URL and token when delivery is enabled', () => {
    process.env['KAIF_DNS_DELIVERY_ENABLED'] = 'true'
    expect(() => loadConfig()).toThrow(/KAIF_DNS_BASE_URL is required/)

    process.env['KAIF_DNS_BASE_URL'] = 'http://127.0.0.1:19082'
    expect(() => loadConfig()).toThrow(/KAIF_DNS_AUTH_TOKEN is required/)
  })

  it('rejects invalid DNS auth mode', () => {
    process.env['KAIF_DNS_AUTH_MODE'] = 'token'
    expect(() => loadConfig()).toThrow(/KAIF_DNS_AUTH_MODE must be one of bearer, header, or both/)
  })
})
