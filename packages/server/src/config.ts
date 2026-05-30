import { existsSync } from 'node:fs'

export interface KAIFConfig {
  port:                  number
  host:                  string
  issuer:                string
  allowed_audiences:     string[]
  redis_url:             string
  spire_bundle_endpoint: string
  spire_bundle_ca_path?: string
  spire_bundle_tls_insecure: boolean
  spire_trust_domain:    string
  idp_jwks_url:          string
  idp_issuer:            string
  private_key_path?:     string
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

export function loadConfig(): KAIFConfig {
  const keyPath = process.env['KAIF_PRIVATE_KEY_PATH'] || undefined
  const devMode = process.env['KAIF_DEV_MODE'] === 'true'
  const production = process.env['NODE_ENV'] === 'production'
  const issuer = requireEnv('KAIF_ISSUER')
  const redisUrl = requireEnv('KAIF_REDIS_URL')
  const spireBundleCaPath = process.env['KAIF_SPIRE_BUNDLE_CA_PATH'] || undefined
  const allowedAudiences = parseList(process.env['KAIF_ALLOWED_AUDIENCES'] ?? issuer)

  if (production && devMode) {
    throw new Error('KAIF_DEV_MODE=true is not permitted when NODE_ENV=production')
  }

  if (production && !keyPath) {
    throw new Error('KAIF_PRIVATE_KEY_PATH is required when NODE_ENV=production')
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

  if (spireBundleCaPath && process.env['KAIF_SPIRE_BUNDLE_TLS_INSECURE'] === 'true') {
    throw new Error('KAIF_SPIRE_BUNDLE_CA_PATH and KAIF_SPIRE_BUNDLE_TLS_INSECURE cannot both be set')
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
    spire_bundle_endpoint: requireEnv('KAIF_SPIRE_BUNDLE_ENDPOINT'),
    ...(spireBundleCaPath !== undefined ? { spire_bundle_ca_path: spireBundleCaPath } : {}),
    spire_bundle_tls_insecure: process.env['KAIF_SPIRE_BUNDLE_TLS_INSECURE'] === 'true',
    spire_trust_domain:    requireEnv('KAIF_SPIRE_TRUST_DOMAIN'),
    // IdP settings are required in production; optional in dev_mode
    idp_jwks_url:          devMode ? (process.env['KAIF_IDP_JWKS_URL'] ?? '') : requireEnv('KAIF_IDP_JWKS_URL'),
    idp_issuer:            devMode ? (process.env['KAIF_IDP_ISSUER'] ?? '')   : requireEnv('KAIF_IDP_ISSUER'),
    // exactOptionalPropertyTypes: omit the key entirely when absent
    ...(keyPath !== undefined ? { private_key_path: keyPath } : {}),
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
