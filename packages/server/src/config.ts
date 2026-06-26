import { existsSync } from 'node:fs'

export interface KAIFConfig {
  port:                  number
  host:                  string
  issuer:                string
  allowed_audiences:     string[]
  redis_url:             string
  spire_bundle_endpoint: string
  spire_bundle_ca_path?: string
  spire_bundle_ca_pem?:  string
  spire_bundle_tls_insecure: boolean
  spire_trust_domain:    string
  idp_jwks_url:          string
  idp_issuer:            string
  private_key_path?:     string
  private_key_pem?:      string
  azure_key_vault_url?:  string
  azure_private_key_secret_name?: string
  azure_private_key_secret_version?: string
  azure_retained_key_secrets?: string[]
  agents_config_path:    string
  log_level:             string
  strict_revocation:     boolean
  dev_mode:              boolean
  tenant_address?:       string
  governance_audit_append_url?: string
  governance_workspace_id: string
  governance_project_id:   string
  governance_ui_instance_id: string
  class_c_degraded_open: boolean
}

function requireEnv(name: string): string {
  const val = process.env[name]
  if (!val) throw new Error(`Required environment variable ${name} is not set`)
  return val
}

function parseList(value: string): string[] {
  return value.split(',').map((item) => item.trim()).filter(Boolean)
}

function requireURL(name: string): URL {
  const value = requireEnv(name)
  try {
    return new URL(value)
  } catch {
    throw new Error(`${name} must be a valid URL`)
  }
}

export function loadConfig(): KAIFConfig {
  const keyPath = process.env['KAIF_PRIVATE_KEY_PATH'] || undefined
  const keyPem = process.env['KAIF_PRIVATE_KEY_PEM'] || undefined
  const azureKeyVaultUrl = process.env['KAIF_AZURE_KEY_VAULT_URL'] || undefined
  const azurePrivateKeySecretName = process.env['KAIF_AZURE_PRIVATE_KEY_SECRET_NAME'] || undefined
  const azurePrivateKeySecretVersion = process.env['KAIF_AZURE_PRIVATE_KEY_SECRET_VERSION'] || undefined
  const azureRetainedKeySecrets = parseList(process.env['KAIF_AZURE_RETAINED_KEY_SECRETS'] ?? '')
  const azureConfigured = Boolean(
    azureKeyVaultUrl
    || azurePrivateKeySecretName
    || azurePrivateKeySecretVersion
    || azureRetainedKeySecrets.length > 0
  )
  const devMode = process.env['KAIF_DEV_MODE'] === 'true'
  const production = process.env['NODE_ENV'] === 'production'
  const issuer = requireEnv('KAIF_ISSUER')
  const redisUrl = requireEnv('KAIF_REDIS_URL')
  const spireBundleEndpoint = requireURL('KAIF_SPIRE_BUNDLE_ENDPOINT')
  const spireBundleCaPath = process.env['KAIF_SPIRE_BUNDLE_CA_PATH'] || undefined
  const spireBundleCaPem = process.env['KAIF_SPIRE_BUNDLE_CA_PEM'] || undefined
  const allowedAudiences = parseList(process.env['KAIF_ALLOWED_AUDIENCES'] ?? issuer)

  if (production && devMode) {
    throw new Error('KAIF_DEV_MODE=true is not permitted when NODE_ENV=production')
  }

  if (keyPath && keyPem) {
    throw new Error('KAIF_PRIVATE_KEY_PATH and KAIF_PRIVATE_KEY_PEM cannot both be set')
  }

  if ((keyPath || keyPem) && azureConfigured) {
    throw new Error('Local key material and Azure Key Vault key sources cannot both be set')
  }

  if (azureConfigured && !azureKeyVaultUrl) {
    throw new Error('KAIF_AZURE_KEY_VAULT_URL is required when using Azure Key Vault key sources')
  }

  if (azureConfigured && !azurePrivateKeySecretName) {
    throw new Error('KAIF_AZURE_PRIVATE_KEY_SECRET_NAME is required when using Azure Key Vault key sources')
  }

  if (azureKeyVaultUrl) {
    try {
      new URL(azureKeyVaultUrl)
    } catch {
      throw new Error('KAIF_AZURE_KEY_VAULT_URL must be a valid URL')
    }
  }

  if (production && !keyPath && !keyPem && !azureConfigured) {
    throw new Error('KAIF_PRIVATE_KEY_PATH, KAIF_PRIVATE_KEY_PEM, or Azure Key Vault key source is required when NODE_ENV=production')
  }

  if (
    production
    && !redisUrl.startsWith('rediss://')
    && process.env['KAIF_ALLOW_INSECURE_REDIS'] !== 'true'
  ) {
    throw new Error('KAIF_REDIS_URL must use rediss:// when NODE_ENV=production')
  }

  if (production && process.env['KAIF_SPIRE_BUNDLE_TLS_INSECURE'] === 'true') {
    throw new Error('KAIF_SPIRE_BUNDLE_TLS_INSECURE=true is not permitted when NODE_ENV=production')
  }

  if (production && spireBundleEndpoint.protocol !== 'https:') {
    throw new Error('KAIF_SPIRE_BUNDLE_ENDPOINT must use https:// when NODE_ENV=production')
  }

  if (spireBundleCaPath && spireBundleCaPem) {
    throw new Error('KAIF_SPIRE_BUNDLE_CA_PATH and KAIF_SPIRE_BUNDLE_CA_PEM cannot both be set')
  }

  if ((spireBundleCaPath || spireBundleCaPem) && process.env['KAIF_SPIRE_BUNDLE_TLS_INSECURE'] === 'true') {
    throw new Error('SPIRE bundle CA material and KAIF_SPIRE_BUNDLE_TLS_INSECURE cannot both be set')
  }

  if (spireBundleCaPath && !existsSync(spireBundleCaPath)) {
    throw new Error(`KAIF_SPIRE_BUNDLE_CA_PATH does not exist: ${spireBundleCaPath}`)
  }

  if (allowedAudiences.length === 0) {
    throw new Error('KAIF_ALLOWED_AUDIENCES must contain at least one audience')
  }

  return {
    port:                  parseInt(process.env['KAIF_PORT'] ?? '8080', 10),
    host:                  process.env['KAIF_HOST'] ?? '0.0.0.0',
    issuer,
    allowed_audiences:     allowedAudiences,
    redis_url:             redisUrl,
    spire_bundle_endpoint: spireBundleEndpoint.toString(),
    ...(spireBundleCaPath !== undefined ? { spire_bundle_ca_path: spireBundleCaPath } : {}),
    ...(spireBundleCaPem !== undefined ? { spire_bundle_ca_pem: spireBundleCaPem } : {}),
    spire_bundle_tls_insecure: process.env['KAIF_SPIRE_BUNDLE_TLS_INSECURE'] === 'true',
    spire_trust_domain:    requireEnv('KAIF_SPIRE_TRUST_DOMAIN'),
    // IdP settings are required in production; optional in dev_mode
    idp_jwks_url:          devMode ? (process.env['KAIF_IDP_JWKS_URL'] ?? '') : requireEnv('KAIF_IDP_JWKS_URL'),
    idp_issuer:            devMode ? (process.env['KAIF_IDP_ISSUER'] ?? '')   : requireEnv('KAIF_IDP_ISSUER'),
    // exactOptionalPropertyTypes: omit the key entirely when absent
    ...(keyPath !== undefined ? { private_key_path: keyPath } : {}),
    ...(keyPem !== undefined ? { private_key_pem: keyPem } : {}),
    ...(azureKeyVaultUrl !== undefined ? { azure_key_vault_url: azureKeyVaultUrl } : {}),
    ...(azurePrivateKeySecretName !== undefined ? { azure_private_key_secret_name: azurePrivateKeySecretName } : {}),
    ...(azurePrivateKeySecretVersion !== undefined ? { azure_private_key_secret_version: azurePrivateKeySecretVersion } : {}),
    ...(azureRetainedKeySecrets.length > 0 ? { azure_retained_key_secrets: azureRetainedKeySecrets } : {}),
    agents_config_path:    requireEnv('KAIF_AGENTS_CONFIG_PATH'),
    log_level:             process.env['KAIF_LOG_LEVEL'] ?? 'info',
    strict_revocation:     process.env['KAIF_STRICT_REVOCATION'] === 'true',
    dev_mode:              devMode,
    ...(process.env['KAIF_TENANT_ADDRESS'] ? { tenant_address: process.env['KAIF_TENANT_ADDRESS'] } : {}),
    ...(process.env['KAIF_GOVERNANCE_AUDIT_APPEND_URL']
      ? { governance_audit_append_url: process.env['KAIF_GOVERNANCE_AUDIT_APPEND_URL'] }
      : {}),
    governance_workspace_id:    process.env['KAIF_GOVERNANCE_WORKSPACE_ID'] ?? 'ws-kaif',
    governance_project_id:      process.env['KAIF_GOVERNANCE_PROJECT_ID'] ?? 'kaif',
    governance_ui_instance_id:  process.env['KAIF_GOVERNANCE_UI_INSTANCE_ID'] ?? 'ui-kaif',
    class_c_degraded_open:      process.env['KAIF_CLASS_C_DEGRADED_OPEN'] === 'true',
  }
}
