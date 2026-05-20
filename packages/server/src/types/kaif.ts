// ── Trust Model ───────────────────────────────────────────────────

export type TrustTier = 'PROVISIONAL' | 'STANDARD' | 'VERIFIED' | 'TRUSTED'

export interface TrustTierConfig {
  tier:        TrustTier
  minScore:    number
  maxScore:    number
  tokenTTL:    number   // seconds
  maxDepth:    number   // max delegation depth
}

export const TRUST_TIERS: TrustTierConfig[] = [
  { tier: 'PROVISIONAL', minScore: 0.00, maxScore: 0.49, tokenTTL: 300,  maxDepth: 0 },
  { tier: 'STANDARD',    minScore: 0.50, maxScore: 0.69, tokenTTL: 600,  maxDepth: 1 },
  { tier: 'VERIFIED',    minScore: 0.70, maxScore: 0.89, tokenTTL: 900,  maxDepth: 2 },
  { tier: 'TRUSTED',     minScore: 0.90, maxScore: 1.00, tokenTTL: 900,  maxDepth: 3 },
]

// ── KAIF JWT Claims ───────────────────────────────────────────────

export interface KAIFExtensionClaims {
  trust_score:      number
  trust_tier:       TrustTier
  delegation_depth: number
  delegation_id:    string
  rollback_window:  string   // ISO 8601 duration e.g. "PT10M"
  principal_chain:  string[] // human email addresses, oldest first
}

export interface KAIFActorClaim {
  sub:             string  // SPIFFE ID
  svid_thumbprint: string  // sha256:<hex> of signing JWK thumbprint
}

export interface KAIFTokenClaims {
  iss:     string
  sub:     string           // human principal
  aud:     string | string[]
  iat:     number
  exp:     number
  jti:     string           // UUID v4
  scope:   string           // space-separated
  actor:   KAIFActorClaim
  may_act: { sub: string }
  kaif:    KAIFExtensionClaims
}

// ── Agent ACL (from agents.yaml) ──────────────────────────────────

export interface AgentACL {
  spiffe_id:              string
  trust_tier_minimum:     TrustTier
  permitted_scopes:       string[]  // glob supported e.g. "vault:read:*"
  may_sub_delegate:       boolean
  max_delegation_depth:   number
  delegation_ttl_seconds: number
  human_principal_required: boolean
}

export interface AgentACLConfig {
  agents: Record<string, AgentACL>
}

// ── RFC 8693 Token Exchange Request ──────────────────────────────

export interface TokenExchangeRequest {
  grant_type:           'urn:ietf:params:oauth:grant-type:token-exchange'
  subject_token:        string
  subject_token_type:   'urn:ietf:params:oauth:token-type:access_token'
  actor_token:          string
  actor_token_type:     'urn:ietf:params:oauth:token-type:jwt'
  scope?:               string
  audience?:            string
  resource?:            string
}

export interface TokenExchangeResponse {
  access_token:       string
  issued_token_type:  'urn:ietf:params:oauth:token-type:access_token'
  token_type:         'Bearer'
  expires_in:         number
  scope:              string
}

// ── Audit Log ─────────────────────────────────────────────────────

export type AuditAction =
  | 'VAULT_UNLOCKED'
  | 'VAULT_LOCKED'
  | 'DELEGATION_PROVISIONED'
  | 'TOKEN_ISSUED'
  | 'TOKEN_INTROSPECTED'
  | 'TOKEN_REVOKED'
  | 'AUTH_FAILED'
  | 'SCOPE_DENIED'
  | 'TRUST_SCORE_UPDATED'
  | 'SUB_DELEGATION_ISSUED'
  | 'REVOCATION_PROPAGATED'

export interface AuditEntry {
  id:          string   // UUID v4
  ts:          string   // ISO 8601
  action:      AuditAction
  agent_id?:   string   // SPIFFE ID
  human_id?:   string   // email
  detail:      string
  hash:        string   // SHA-256 hex of (prevHash|ts|action|detail)
  prev_hash:   string   // previous entry hash — genesis = "0".repeat(64)
}

// ── SVID ──────────────────────────────────────────────────────────

export interface ParsedSVID {
  spiffe_id:    string
  thumbprint:   string  // sha256:<jwk-thumbprint> of signing key
  expiry:       number  // unix seconds
  raw_cert:     Buffer  // empty for JWT-SVIDs
}

// ── Delegation ────────────────────────────────────────────────────

export interface DelegationGrant {
  delegation_id:    string   // UUID v4
  human_principal:  string   // email
  agent_spiffe_id:  string
  granted_scopes:   string[]
  expires_at:       number   // unix seconds
  created_at:       number
  audit_hash:       string   // hash from provisioning audit entry
}

// ── Trust Score Signal ────────────────────────────────────────────

export interface TrustScoreSignal {
  agent_spiffe_id:   string
  score:             number  // 0.0–1.0
  updated_at:        number
  signal_breakdown?: {
    behavioural:  number  // 0.0–1.0
    audit_chain:  number
    credential:   number
    peer:         number
  }
}

// ── Revocation ────────────────────────────────────────────────────

export interface RevocationEvent {
  jti:        string
  agent_id:   string
  reason:     string
  revoked_at: number
}
