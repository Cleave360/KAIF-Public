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
  trust_score:      number  // operator-assigned authorization gate value; not behavioral scoring
  trust_tier:       TrustTier  // resolved tier used for TTL and delegation-depth limits
  delegation_depth: number
  delegation_id:    string
  rollback_window:  string   // ISO 8601 duration e.g. "PT10M"
  principal_chain:  string[] // human email addresses, oldest first
}

export interface KAIFActorClaim {
  sub:             string  // SPIFFE ID
  svid_thumbprint: string  // sha256:<hex> of signing JWK thumbprint
}

export interface KAIFConfirmationClaim {
  jkt?: string
  'x5t#S256'?: string
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
  cnf?:    KAIFConfirmationClaim
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
  | 'RELYING_CLASS_A_AUTHORIZE'
  | 'RELYING_CLASS_C_AUTHORIZE'
  | 'BOUNDARY_PERMIT'
  | 'BOUNDARY_DENY'
  | 'BOUNDARY_RECEIPT'

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
  score:             number  // operator-assigned authorization gate value, 0.0–1.0
  updated_at:        number
  signal_breakdown?: {
    behavioural:  number  // deferred future work; excluded from conformance scope
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

// ── Boundary authorization contract ───────────────────────────────

export interface BoundaryAdaptiveEnvelope {
  envelope_version: string
  tenant_id: string
  workspace_id: string
  project_id: string
  run_id: string
  principal_id: string
  principal_type: string
  ui_instance_id: string
  blueprint_id?: string
  blueprint_version?: string
  agent_global_id?: string | null
  purchase_id?: string | null
  agent_instance_id?: string | null
  agent_key_id?: string | null
  policy_hash?: string | null
  lease_id?: string | null
}

export interface BoundaryRouteContext {
  workflow_id: string
  workflow_version?: string
  node_id: string
  runtime_node_id?: string
  node_number?: number
  request_id: string
}

export interface BoundaryHumanIntent {
  intent_mode: 'bound' | 'abstracted'
  intent_id?: string
  intent_type?: string
  intent_summary?: string
  intent_scope?: string[]
  intent_hash?: string
  intent_absence_reason?: string
}

export interface BoundarySubject {
  human_sub: string
  agent_id: string
  agent_spiffe_id: string
}

export interface BoundaryAction {
  operation: string
  scope: string
  audience: string
  resource?: string
}

export interface BoundaryGovernance {
  policy_version?: string
  minted_agent_ref?: string
  minted_skill_refs?: string[]
}

export interface BoundaryAuthorizationRequest {
  adaptive_envelope: BoundaryAdaptiveEnvelope
  route_context: BoundaryRouteContext
  human_intent: BoundaryHumanIntent
  kaif_subject: BoundarySubject
  action: BoundaryAction
  governance?: BoundaryGovernance
  subject_token: string
  actor_token: string
  subject_token_type: 'urn:ietf:params:oauth:token-type:access_token'
  actor_token_type: 'urn:ietf:params:oauth:token-type:jwt'
}

export interface BoundaryDecisionContext {
  request_id: string | null
  decision_id: string
  tenant_id: string | null
  run_id: string | null
  workflow_id: string | null
  node_id: string | null
}

export interface BoundaryEvidence {
  audit_event_id: string
  audit_hash: string
  prev_hash: string
  recorded_at: string
}

export interface BoundaryPermitResponse {
  decision: 'permit'
  boundary: BoundaryDecisionContext
  authority: {
    human_sub: string
    agent_id: string
    agent_spiffe_id: string
    delegation_id: string
    token_jti: string
    scope: string
    audience: string
  }
  intent: {
    intent_mode: 'bound' | 'abstracted'
    intent_id?: string
    intent_type?: string
    intent_hash?: string
  }
  attestation: {
    trust_tier: TrustTier
    trust_score: number
    delegation_depth: number
    cnf?: KAIFConfirmationClaim
  }
  evidence: BoundaryEvidence
  token: {
    access_token: string
    token_type: 'Bearer'
    expires_in: number
    issued_token_type: 'urn:ietf:params:oauth:token-type:access_token'
    scope: string
  }
  receipt: {
    receipt_version: 'v1'
    receipt_id: string
    decision_id: string
    request_id: string
    run_id: string
    target_system: 'foundry'
    occurred_at_ms: number
    result: {
      status: 'success' | 'rejected' | 'error' | 'paused'
      provider_code: string
      provider_message: string
    }
    provider_request_id?: string
    provider_session_id?: string
    output_hash?: string
    output_preview?: string
    latency_ms?: number
    receipt_payload?: unknown
    delegation_id?: string
    token_jti?: string
  }
}

export interface BoundaryDenyResponse {
  decision: 'deny'
  boundary: BoundaryDecisionContext
  intent: {
    intent_mode: 'bound' | 'abstracted' | null
    intent_id?: string
    intent_type?: string
    intent_hash?: string
  }
  error: {
    code: string
    reason: string
  }
  evidence: BoundaryEvidence
}
