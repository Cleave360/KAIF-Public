export interface KAIFConfig {
  port:                  number
  host:                  string
  issuer:                string
  redis_url:             string
  spire_bundle_endpoint: string
  spire_trust_domain:    string
  idp_jwks_url:          string
  idp_issuer:            string
  private_key_path?:     string
  agents_config_path:    string
  log_level:             string
  strict_revocation:     boolean
}

function requireEnv(name: string): string {
  const val = process.env[name]
  if (!val) throw new Error(`Required environment variable ${name} is not set`)
  return val
}

export function loadConfig(): KAIFConfig {
  const keyPath = process.env['KAIF_PRIVATE_KEY_PATH'] || undefined

  return {
    port:                  parseInt(process.env['KAIF_PORT'] ?? '8080', 10),
    host:                  process.env['KAIF_HOST'] ?? '0.0.0.0',
    issuer:                requireEnv('KAIF_ISSUER'),
    redis_url:             requireEnv('KAIF_REDIS_URL'),
    spire_bundle_endpoint: requireEnv('KAIF_SPIRE_BUNDLE_ENDPOINT'),
    spire_trust_domain:    requireEnv('KAIF_SPIRE_TRUST_DOMAIN'),
    idp_jwks_url:          requireEnv('KAIF_IDP_JWKS_URL'),
    idp_issuer:            requireEnv('KAIF_IDP_ISSUER'),
    // exactOptionalPropertyTypes: omit the key entirely when absent
    ...(keyPath !== undefined ? { private_key_path: keyPath } : {}),
    agents_config_path:    requireEnv('KAIF_AGENTS_CONFIG_PATH'),
    log_level:             process.env['KAIF_LOG_LEVEL'] ?? 'info',
    strict_revocation:     process.env['KAIF_STRICT_REVOCATION'] === 'true',
  }
}
