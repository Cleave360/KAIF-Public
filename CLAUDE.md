# KAIF — Kindred Agent Identity Framework
## Claude Code Build Specification

> This document is the authoritative build instruction for Claude Code.
> Read it entirely before writing a single line of code.
> Follow implementation order exactly — each phase has hard dependencies on the previous.

---

## Project Mission

Build the reference implementation of KAIF: a composable protocol stack that gives
autonomous AI agents scoped, auditable, revocable authority traceable to a human principal.

**Protocol basis:** RFC 8693 (Token Exchange) + SPIFFE/SPIRE + OAuth 2.1 + SHA-256 audit chain.
**NOT a framework.** A minimal, dependency-lean reference implementation that is readable
first, clever never.

---

## Repository Structure

```
kaif/
├── CLAUDE.md                          ← this file
├── README.md
├── SPEC.md                            ← protocol specification (copy from KAIF-Specification)
├── SECURITY.md
├── GOVERNANCE.md
├── CONTRIBUTING.md
├── LICENSE                            ← Apache 2.0
├── .env.example
├── .gitignore
├── docker-compose.yml                 ← full stack: SPIRE + Redis + KAIF server + mock agent
├── package.json                       ← workspace root
├── tsconfig.base.json
│
├── packages/
│   ├── server/                        ← KAIF Token Exchange Server (Fastify)
│   │   ├── src/
│   │   │   ├── index.ts               ← entry point
│   │   │   ├── server.ts              ← Fastify app factory
│   │   │   ├── config.ts              ← env + agent ACL loader
│   │   │   ├── types/
│   │   │   │   └── kaif.ts            ← ALL shared types (single source of truth)
│   │   │   ├── crypto/
│   │   │   │   ├── keys.ts            ← RSA key generation + JWKS
│   │   │   │   └── jwt.ts             ← sign + verify KAIF JWTs
│   │   │   ├── services/
│   │   │   │   ├── svid.ts            ← SPIFFE SVID validation
│   │   │   │   ├── trust-score.ts     ← score computation + tier resolution
│   │   │   │   ├── audit.ts           ← SHA-256 hash-chained audit log
│   │   │   │   ├── acl.ts             ← agent ACL enforcement
│   │   │   │   ├── revocation.ts      ← JTI denylist via Redis
│   │   │   │   └── token-exchange.ts  ← RFC 8693 core logic
│   │   │   └── routes/
│   │   │       ├── token.ts           ← POST /oauth/token
│   │   │       ├── introspect.ts      ← POST /introspect
│   │   │       ├── provision.ts       ← POST /provision
│   │   │       ├── revoke.ts          ← POST /revoke
│   │   │       ├── jwks.ts            ← GET /.well-known/jwks.json
│   │   │       └── health.ts          ← GET /health
│   │   ├── config/
│   │   │   └── agents.yaml            ← agent ACL definitions
│   │   ├── tests/
│   │   │   ├── token-exchange.test.ts
│   │   │   ├── trust-score.test.ts
│   │   │   ├── audit.test.ts
│   │   │   ├── revocation.test.ts
│   │   │   └── integration.test.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── sdk/                           ← KAIF Agent SDK (what agents import)
│       ├── src/
│       │   ├── index.ts               ← public exports
│       │   ├── client.ts              ← KAIFClient class
│       │   ├── token-cache.ts         ← TTL-aware in-memory token cache
│       │   └── types.ts               ← re-exports from server types
│       ├── tests/
│       │   └── client.test.ts
│       ├── package.json
│       └── tsconfig.json
│
├── spire/
│   ├── server.conf                    ← SPIRE server config
│   ├── agent.conf                     ← SPIRE agent config
│   └── entries/
│       └── bootstrap-entries.json     ← sample workload entries
│
├── examples/
│   ├── mock-agent/                    ← demonstrates full auth flow
│   │   ├── index.ts
│   │   └── package.json
│   └── mock-service/                  ← demonstrates KAIF JWT validation
│       ├── index.ts
│       └── package.json
│
└── scripts/
    ├── generate-keys.sh               ← generate RSA keypair for dev
    ├── setup-spire.sh                 ← bootstrap SPIRE entries
    └── demo.sh                        ← end-to-end demo script
```

---

## Technology Stack

| Concern | Choice | Reason |
|---|---|---|
| Runtime | Node.js 20 LTS | SPIFFE workload API gRPC support, crypto built-in |
| Language | TypeScript 5.x strict | Type safety for security primitives is non-negotiable |
| HTTP server | Fastify 4.x | Schema validation built-in, low overhead |
| JWT | `jose` 5.x | IETF-compliant, handles RS256, JWK, JWKS |
| Redis client | `ioredis` 5.x | Pub/sub support, battle-tested |
| SPIFFE | `@spiffe/spiffe-workload-api` | Official gRPC client |
| YAML config | `js-yaml` | Agent ACL file parsing |
| Testing | Vitest | Fast, native ESM, no config overhead |
| Schema validation | Zod | Runtime type safety on all inputs |
| Package management | pnpm workspaces | Monorepo with shared types |

**Dependency rule:** If a dependency is not in this table, ask before adding it.
This is a security project. Every dependency is an attack surface.

---

## Types — Define These First

File: `packages/server/src/types/kaif.ts`

```typescript
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
  svid_thumbprint: string  // sha256:<hex> of SVID leaf cert DER
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
  thumbprint:   string  // sha256:<hex> of leaf cert DER
  expiry:       number  // unix seconds
  raw_cert:     Buffer
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
```

---

## Implementation Order

Build in this exact sequence. Do not skip ahead.

### Phase 0 — Project Scaffold

1. `package.json` (root workspace)
2. `tsconfig.base.json`
3. `packages/server/package.json`
4. `packages/sdk/package.json`
5. `.env.example` (see Environment Variables section)
6. `.gitignore`
7. `LICENSE` (Apache 2.0 — full text)

### Phase 1 — Crypto Foundation

Build `packages/server/src/crypto/` first. Everything else depends on this.

**`keys.ts`** — must implement:
```typescript
// Generate RSA-2048 keypair for JWT signing (RS256)
// Store private key PEM to process env or file (configurable)
// Export public key as JWK and JWKS (array)
// Cache keypair in memory after first load
export async function getSigningKey(): Promise<KeyLike>
export async function getPublicJWK(): Promise<JWK>
export async function getJWKS(): Promise<{ keys: JWK[] }>
```

**`jwt.ts`** — must implement:
```typescript
// Sign a KAIF token — returns compact JWT string
export async function signKAIFToken(claims: KAIFTokenClaims): Promise<string>

// Verify any JWT using our JWKS — throws on invalid
export async function verifyJWT(token: string): Promise<JWTPayload>

// Verify a JWT-SVID from SPIRE — throws on invalid
// SPIRE bundles are fetched from SPIRE_BUNDLE_ENDPOINT env var
export async function verifySVIDJWT(svid: string): Promise<ParsedSVID>

// Compute RFC 8705 certificate thumbprint from DER bytes
export function computeThumbprint(certDER: Buffer): string
// Returns "sha256:<lowercase hex>"
```

### Phase 2 — Services

**`services/audit.ts`** — SHA-256 hash-chained log:
```typescript
// Append an audit entry — computes hash from previous entry
// Writes to Redis list: kaif:audit:<agent_id> AND kaif:audit:global
// Publishes to Redis channel: kaif:audit
export async function appendAudit(
  redis: Redis,
  params: Omit<AuditEntry, 'id' | 'ts' | 'hash' | 'prev_hash'>
): Promise<AuditEntry>

// Get last N entries for an agent (or global)
export async function getAuditLog(
  redis: Redis,
  agent_id?: string,
  limit?: number
): Promise<AuditEntry[]>

// Verify the full chain integrity — returns false if any link is broken
export async function verifyChain(
  redis: Redis,
  agent_id?: string
): Promise<boolean>
```

Hash computation MUST be:
```typescript
const raw = `${prev_hash}|${ts}|${action}|${detail}`
const hash = crypto.createHash('sha256').update(raw).digest('hex')
```

**`services/revocation.ts`** — JTI denylist:
```typescript
// Add JTI to Redis denylist — SET with TTL matching token expiry
// Publishes RevocationEvent to kaif:revocation channel
export async function revokeToken(
  redis: Redis,
  jti: string,
  agent_id: string,
  reason: string,
  token_exp: number
): Promise<void>

// Check if JTI is revoked — O(1) Redis GET
export async function isRevoked(redis: Redis, jti: string): Promise<boolean>

// Subscribe to revocation events from other instances
export function subscribeRevocation(
  redis: Redis,
  onEvent: (event: RevocationEvent) => void
): void
```

**`services/trust-score.ts`**:
```typescript
// Get current trust score for an agent
// Source: Redis key kaif:trust:<spiffe_id>
// Default: 0.5 (STANDARD) for unknown agents
export async function getTrustScore(
  redis: Redis,
  spiffe_id: string
): Promise<TrustScoreSignal>

// Update trust score — validates 0.0–1.0 range
// Publishes to kaif:trust-score channel
export async function updateTrustScore(
  redis: Redis,
  spiffe_id: string,
  score: number,
  breakdown?: TrustScoreSignal['signal_breakdown']
): Promise<void>

// Resolve score to tier config
export function resolveTier(score: number): TrustTierConfig
// Uses TRUST_TIERS constant — clamp score to 0.0–1.0 before lookup

// Validate an agent meets the minimum tier for an operation
export function assertTierMinimum(
  score: number,
  required: TrustTier
): void  // throws KAIFError if below minimum
```

**`services/svid.ts`** — SPIFFE SVID validation:
```typescript
// Validate a JWT-SVID string
// Fetches SPIRE bundle from SPIRE_BUNDLE_ENDPOINT
// Verifies signature, expiry, and SPIFFE ID format
export async function validateSVID(svid_jwt: string): Promise<ParsedSVID>

// Validate SPIFFE ID format: spiffe://<trust-domain>/path
export function validateSpiffeID(id: string): boolean

// Check SVID is not expired (with 10s clock skew tolerance)
export function isSVIDValid(svid: ParsedSVID): boolean
```

**`services/acl.ts`** — Agent authorisation:
```typescript
// Load ACL from agents.yaml — cached, reloads on SIGHUP
export function loadACL(): AgentACLConfig

// Get ACL entry for a SPIFFE ID — null if not registered
export function getAgentACL(spiffe_id: string): AgentACL | null

// Validate requested scopes against agent's permitted scopes
// Supports glob: "vault:read:*" matches "vault:read:anthropic_key"
export function validateScopes(
  requested: string[],
  permitted: string[]
): { valid: boolean; denied: string[] }

// Full ACL check — throws KAIFError with specific code on any failure
export async function assertAuthorised(params: {
  redis:            Redis
  agent_acl:        AgentACL
  requested_scopes: string[]
  trust_score:      number
  delegation_depth: number
}): Promise<void>
```

**`services/token-exchange.ts`** — RFC 8693 core:
```typescript
// Execute a complete RFC 8693 token exchange
// This is the core KAIF operation — all validation flows through here
export async function executeTokenExchange(params: {
  redis:          Redis
  request:        TokenExchangeRequest
  client_cert?:   Buffer   // TLS client cert for RFC 8705 binding
}): Promise<TokenExchangeResponse>
```

Internal flow — implement in this exact order:

```
1. Validate subject_token (human delegation grant)
   - Must be a valid JWT signed by us OR a valid OIDC token from configured IdP
   - Must not be expired
   - Must not be revoked (JTI check)

2. Validate actor_token (agent JWT-SVID from SPIRE)
   - Must be a valid JWT-SVID from our SPIRE trust domain
   - Must not be expired
   - SPIFFE ID must be registered in ACL

3. Parse requested scope
   - Split by space
   - Must be subset of agent's permitted_scopes (ACL check)
   - Must be subset of human grant's scope

4. Fetch trust score for agent
   - If score < ACL minimum tier → reject with 403 INSUFFICIENT_TRUST

5. Compute delegation depth
   - If subject_token is a direct `/provision` grant: depth = 0
   - If subject_token is an issued access token: depth = subject.kaif.delegation_depth + 1
   - If depth > ACL max_delegation_depth → reject with 403 DEPTH_EXCEEDED

6. Compute RFC 8705 thumbprint if client_cert provided
   - cnf.x5t#S256 = sha256(client_cert_DER)

7. Resolve TTL from trust tier

8. Mint KAIF JWT:
   - sub: human principal from subject_token
   - actor.sub: SPIFFE ID from SVID
   - actor.svid_thumbprint: computed in step 6
   - kaif.trust_score: from step 4
   - kaif.trust_tier: resolved from score
   - kaif.delegation_depth: from step 5
   - kaif.delegation_id: UUID v4
   - kaif.rollback_window: ISO 8601 from TTL
   - kaif.principal_chain: append human principal to parent chain

9. Write audit entry: TOKEN_ISSUED

10. Return TokenExchangeResponse
```

### Phase 3 — Routes

Each route must:
- Use Fastify schema validation (JSON Schema) on all inputs
- Return RFC 6749 / RFC 7591 compliant error responses
- Log all requests via Fastify logger (pino)
- Never log token values — log jti only

**`POST /oauth/token`** — Token Exchange endpoint
```
Content-Type: application/x-www-form-urlencoded
Body: TokenExchangeRequest fields

Success: 200 TokenExchangeResponse
Errors:
  400 invalid_request        — missing required fields
  400 invalid_grant          — subject_token invalid/expired
  400 invalid_scope          — scope not permitted
  401 invalid_client         — actor_token (SVID) invalid
  403 insufficient_trust     — trust score below tier minimum
  403 delegation_depth_exceeded
  429 too_many_requests      — rate limit hit
```

**`POST /introspect`** — RFC 7662 Token Introspection
```
Body: { token: string }
Returns: { active: boolean, ...claims if active }
MUST check JTI denylist — this is the real-time revocation check
External services call this on every request when strict mode enabled
```

**`POST /provision`** — Human principal delegation provisioning
```
Body: {
  id_token:        string   // human OIDC token from IdP
  agent_id:        string   // name key from agents.yaml
  scope:           string   // requested scopes
  ttl_seconds?:    number   // optional override, capped at 86400
}
Returns: { delegation_id: string, expires_at: number }
Writes DelegationGrant to Redis: kaif:delegation:<delegation_id>
Writes audit: DELEGATION_PROVISIONED
```

**`POST /revoke`** — Revocation
```
Body: { token: string, reason?: string }
Adds JTI to denylist
Publishes to kaif:revocation channel
Writes audit: TOKEN_REVOKED
Returns: 200 { revoked: true }
```

**`GET /.well-known/jwks.json`** — Public key material
```
Returns JWKS for external service validation
Cache-Control: max-age=3600
No auth required — public endpoint
```

**`GET /health`** — Health check
```
Returns:
{
  status: 'ok' | 'degraded',
  redis: 'connected' | 'disconnected',
  spire: 'reachable' | 'unreachable',
  uptime: number,
  version: string
}
```

### Phase 4 — Server Assembly

**`server.ts`** — Fastify app factory:
```typescript
export async function buildServer(opts?: FastifyServerOptions): Promise<FastifyInstance>
```

Must register:
- `fastify-rate-limit` — 100 req/min on /oauth/token, 1000/min elsewhere
- `@fastify/helmet` — security headers
- Request ID header: `X-Request-ID`
- Pino logger with redaction: `['body.subject_token', 'body.actor_token', 'headers.authorization']`
- Graceful shutdown: drain connections on SIGTERM, flush Redis, close SPIRE connection

**`config.ts`** — configuration loader:
```typescript
export interface KAIFConfig {
  port:                number           // default 8080
  host:                string           // default 0.0.0.0
  issuer:              string           // e.g. https://auth.kindred.systems
  redis_url:           string
  spire_bundle_endpoint: string         // e.g. http://spire-server:8081/bundles/jwt
  spire_trust_domain:  string           // e.g. kindred.systems
  idp_jwks_url:        string           // human IdP JWKS for subject_token validation
  idp_issuer:          string           // human IdP issuer claim
  private_key_path?:   string           // path to PEM, or generate ephemeral if absent
  agents_config_path:  string           // path to agents.yaml
  log_level:           string           // default 'info'
  strict_revocation:   boolean          // if true, every token use hits /introspect
}

export function loadConfig(): KAIFConfig
// Reads from environment variables
// Throws with clear message if required var missing
```

### Phase 5 — SDK

**`packages/sdk/src/client.ts`**:
```typescript
export interface KAIFClientConfig {
  server_url:     string   // e.g. http://kaif-server:8080
  spiffe_id:      string   // this agent's SPIFFE ID
  svid_path?:     string   // path to JWT-SVID file (SPIRE writes this)
  delegation_token: string
}

export class KAIFClient {
  constructor(config: KAIFClientConfig)

  // Exchange tokens — returns access token string
  // Caches token until 60s before expiry
  async getToken(scope: string, audience: string): Promise<string>

  // Force token refresh
  async refreshToken(scope: string, audience: string): Promise<string>

  // Returns Authorization header value: "Bearer <token>"
  async authHeader(scope: string, audience: string): Promise<string>

  // Revoke all held tokens
  async revoke(): Promise<void>
}
```

Token cache rules:
- Cache key: `${scope}:${audience}`
- Evict when: `now > token.exp - 60`
- Never cache expired tokens
- Cache is in-memory only — never persisted

### Phase 6 — Infrastructure Files

**`docker-compose.yml`** — must bring up full stack with `docker compose up`:

Services:
```yaml
services:
  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]
    volumes: ["redis-data:/data"]
    command: redis-server --appendonly yes

  spire-server:
    image: ghcr.io/spiffe/spire-server:1.9.0
    volumes:
      - ./spire/server.conf:/etc/spire/server/server.conf
      - spire-data:/run/spire/data
    ports: ["8081:8081"]  # bundle endpoint
    healthcheck:
      test: ["/opt/spire/bin/spire-server", "healthcheck"]
      interval: 10s

  spire-agent:
    image: ghcr.io/spiffe/spire-agent:1.9.0
    volumes:
      - ./spire/agent.conf:/etc/spire/agent/agent.conf
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - spire-agent-socket:/run/spire/sockets
    depends_on:
      spire-server: { condition: service_healthy }

  kaif-server:
    build: ./packages/server
    ports: ["8080:8080"]
    env_file: .env
    volumes:
      - ./packages/server/config:/app/config
      - spire-agent-socket:/run/spire/sockets:ro
    depends_on:
      - redis
      - spire-agent
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8080/health"]

  mock-agent:
    build: ./examples/mock-agent
    depends_on:
      kaif-server: { condition: service_healthy }
    environment:
      KAIF_SERVER_URL: http://kaif-server:8080
```

**`spire/server.conf`**:
```hcl
server {
  bind_address = "0.0.0.0"
  bind_port = "8443"
  trust_domain = "kindred.systems"
  data_dir = "/run/spire/data"
  log_level = "INFO"
  jwt_issuer = "spire-server"

  federation {
    bundle_endpoint {
      address = "0.0.0.0"
      port = 8081
    }
  }
}

plugins {
  DataStore "sql" {
    plugin_data {
      database_type = "sqlite3"
      connection_string = "/run/spire/data/datastore.sqlite3"
    }
  }
  KeyManager "memory" { plugin_data {} }
  NodeAttestor "join_token" { plugin_data {} }
}
```

**`spire/agent.conf`**:
```hcl
agent {
  data_dir = "/run/spire/data"
  log_level = "INFO"
  server_address = "spire-server"
  server_port = "8443"
  socket_path = "/run/spire/sockets/agent.sock"
  trust_domain = "kindred.systems"
}

plugins {
  NodeAttestor "join_token" { plugin_data {} }
  KeyManager "memory" { plugin_data {} }
  WorkloadAttestor "docker" { plugin_data {} }
  SVIDStore "memory" { plugin_data {} }
}
```

**`packages/server/config/agents.yaml`**:
```yaml
agents:
  lyra:
    spiffe_id: "spiffe://example.org/ns/adaptive-layer/agent/lyra"
    trust_tier_minimum: STANDARD
    permitted_scopes:
      - "vault:read:anthropic_key"
      - "invoke:completion"
      - "audit:read"
    may_sub_delegate: false
    max_delegation_depth: 1
    delegation_ttl_seconds: 900
    human_principal_required: true

  orion:
    spiffe_id: "spiffe://kindred.systems/ns/adaptive-layer/agent/orion"
    trust_tier_minimum: VERIFIED
    permitted_scopes:
      - "vault:read:*"
      - "invoke:*"
      - "agent:delegate"
    may_sub_delegate: true
    max_delegation_depth: 2
    delegation_ttl_seconds: 900
    human_principal_required: true

  cipher:
    spiffe_id: "spiffe://kindred.systems/ns/adaptive-layer/agent/cipher"
    trust_tier_minimum: TRUSTED
    permitted_scopes:
      - "vault:*"
      - "invoke:*"
      - "agent:delegate"
      - "admin:revoke"
    may_sub_delegate: true
    max_delegation_depth: 3
    delegation_ttl_seconds: 900
    human_principal_required: true

  mock-agent:
    spiffe_id: "spiffe://kindred.systems/ns/examples/agent/mock"
    trust_tier_minimum: PROVISIONAL
    permitted_scopes:
      - "invoke:completion"
    may_sub_delegate: false
    max_delegation_depth: 0
    delegation_ttl_seconds: 300
    human_principal_required: false
```

### Phase 7 — Documentation Files

**`README.md`** — structure:
```
1. What is KAIF (3 sentences max — problem, solution, status)
2. Quick Start (docker compose up → working demo in 5 minutes)
3. How It Works (the four-layer diagram from SPEC.md)
4. Installation (server + SDK)
5. Configuration (env vars table)
6. Agent ACL (agents.yaml format)
7. Protocol Flows (link to SPEC.md for detail)
8. Contributing
9. Licence
```

Do not mention Kindred Systems OS in the README beyond the author credit.
This is the protocol's README, not Kindred's marketing page.

**`SECURITY.md`** must contain:
- Supported versions table
- How to report a vulnerability (security@kindred.systems)
- Response SLA: acknowledge within 48h, patch within 14 days for critical
- What is in scope / out of scope
- PGP key fingerprint placeholder

**`GOVERNANCE.md`** must contain:
- Project roles: Maintainer, Contributor, Adopter
- Decision-making: maintainer consensus for protocol changes, PR approval for code
- RFC process: protocol changes require a KAIF-RFC document in /rfcs
- Versioning: semver, protocol version in /SPEC.md independently versioned
- CNCF intent stated clearly

**`CONTRIBUTING.md`** must contain:
- Development setup (prerequisites, clone, install, test)
- Commit format: Conventional Commits
- PR requirements: tests pass, no new deps without discussion, security review for crypto changes
- Code style: ESLint + Prettier, config in repo
- Security-sensitive areas flagged: crypto/, services/token-exchange.ts, services/audit.ts

---

## Environment Variables

`.env.example` — every variable documented:

```bash
# Server
KAIF_PORT=8080
KAIF_HOST=0.0.0.0
KAIF_ISSUER=https://auth.kindred.systems
KAIF_LOG_LEVEL=info

# Redis
KAIF_REDIS_URL=redis://localhost:6379

# SPIRE
KAIF_SPIRE_BUNDLE_ENDPOINT=http://localhost:8081/bundles/jwt
KAIF_SPIRE_TRUST_DOMAIN=kindred.systems

# Human IdP (Azure Entra / any OIDC)
KAIF_IDP_JWKS_URL=https://login.microsoftonline.com/{tenant}/discovery/v2.0/keys
KAIF_IDP_ISSUER=https://login.microsoftonline.com/{tenant}/v2.0

# Keys
KAIF_PRIVATE_KEY_PATH=./keys/private.pem  # leave blank to generate ephemeral

# Config
KAIF_AGENTS_CONFIG_PATH=./config/agents.yaml
KAIF_STRICT_REVOCATION=false  # true = every token use hits introspect
```

---

## Error Format

All errors must conform to RFC 6749:
```typescript
interface KAIFError {
  error:             string   // snake_case code
  error_description: string   // human readable, no sensitive data
  error_uri?:        string   // link to docs
}

// Error codes used by KAIF:
// invalid_request          — malformed request
// invalid_grant            — subject_token invalid/expired/revoked
// invalid_client           — actor_token (SVID) invalid
// invalid_scope            — scope not permitted
// insufficient_trust       — trust score below tier minimum
// delegation_depth_exceeded — depth > max for agent
// access_denied            — general authorisation failure
// server_error             — internal error (never expose stack trace)
```

---

## Test Requirements

Every service must have unit tests. Integration test must cover the happy path end-to-end.

**Minimum test coverage targets:**
- `services/audit.ts` — 100% (hash chain integrity is critical)
- `services/revocation.ts` — 100%
- `services/token-exchange.ts` — 90%
- `services/trust-score.ts` — 90%
- `services/acl.ts` — 90%
- `crypto/jwt.ts` — 100%

**Required test cases (non-negotiable):**

```typescript
// audit.ts
✓ appendAudit creates correct hash linking previous entry
✓ genesis entry uses "0".repeat(64) as prev_hash
✓ verifyChain returns true for unmodified chain
✓ verifyChain returns false if any entry is tampered
✓ verifyChain returns false if entry is deleted from middle

// token-exchange.ts
✓ valid request returns well-formed KAIF JWT
✓ expired subject_token returns invalid_grant
✓ expired SVID returns invalid_client
✓ unknown SPIFFE ID returns access_denied
✓ score below tier minimum returns insufficient_trust
✓ depth > max returns delegation_depth_exceeded
✓ requested scope not in ACL returns invalid_scope
✓ requested scope not in subject grant returns invalid_scope
✓ revoked subject_token returns invalid_grant

// revocation.ts
✓ revoked JTI fails isRevoked check
✓ unknown JTI passes isRevoked check
✓ revocation event published to Redis channel
✓ revocation TTL matches token expiry

// trust-score.ts
✓ score 0.0 resolves to PROVISIONAL
✓ score 0.49 resolves to PROVISIONAL
✓ score 0.5 resolves to STANDARD
✓ score 0.9 resolves to TRUSTED
✓ score 1.0 resolves to TRUSTED
✓ score > 1.0 is clamped to 1.0
✓ score < 0.0 is clamped to 0.0
```

**Integration test** (`tests/integration.test.ts`):
```
1. Bring up in-memory Redis
2. Generate ephemeral RSA keypair
3. Mock SPIRE bundle endpoint (return test JWK)
4. Create a test delegation grant for mock agent
5. Execute token exchange with valid mock SVID
6. Verify returned JWT: correct claims, valid signature, correct TTL
7. Verify audit log has TOKEN_ISSUED entry with correct hash
8. Revoke the token
9. Verify introspect returns { active: false }
10. Verify second token exchange with same grant still works
```

---

## Security Rules — Non-Negotiable

1. **Never log token values.** Log JTI only. Redact in Fastify config.
2. **Never return stack traces** in error responses. Log internally, return generic message.
3. **All crypto via Node.js built-in `crypto` or `jose`.** No third-party crypto primitives.
4. **JWT private key never leaves process memory.** Never write to logs, responses, or Redis.
5. **All Redis keys use prefixes:** `kaif:audit:`, `kaif:trust:`, `kaif:delegation:`, `kaif:revoke:`
6. **Redis denylist TTL must match token exp.** Do not set infinite TTL.
7. **SPIFFE ID format validation is mandatory** before any ACL lookup. Reject malformed IDs.
8. **Clock skew tolerance is exactly 10 seconds.** Not configurable. Not more.
9. **scope validation uses exact match or glob, never substring match.**
   `vault:read:anthropic` must NOT match `vault:read:anthropic_key`.
10. **delegation_depth must be an integer >= 0.** Reject floats, negatives, NaN.

---

## What NOT to Build

- No user interface (that is the Adaptive Layer's job)
- No database (Redis is the only persistence layer)
- No agent runtime or agent behaviour (KAIF is the auth layer only)
- No secret storage (that is the Key Vault's job)
- No OIDC server (KAIF validates OIDC tokens, it does not issue them)
- No OpenTelemetry tracing (v0.1 — add in a future PR)
- No Kubernetes operator (v0.1 — add in a future PR)
- No web UI for the audit log (v0.1 — add in a future PR)

---

## Definition of Done

Phase 0 complete:
- [ ] Repo structure exists, all package.json files valid, pnpm install succeeds

Phase 1 complete:
- [ ] `crypto/keys.ts` and `crypto/jwt.ts` tests pass
- [ ] Can sign and verify a KAIF JWT
- [ ] Can compute RFC 8705 thumbprint

Phase 2 complete:
- [ ] All service unit tests pass
- [ ] Audit chain tamper detection works

Phase 3 + 4 complete:
- [ ] `pnpm test` passes with no failures
- [ ] `pnpm build` produces clean TypeScript output
- [ ] Server starts with `node dist/index.js`

Phase 5 complete:
- [ ] SDK `KAIFClient` can exchange tokens against the running server
- [ ] Token cache evicts correctly at exp - 60s

Phase 6 complete:
- [ ] `docker compose up` brings full stack to healthy
- [ ] Mock agent successfully exchanges a token and logs the flow

Phase 7 complete:
- [ ] README quick start works from a clean clone
- [ ] All documentation files present and complete

**Full done:**
- [ ] Integration test passes against Docker Compose stack
- [ ] `scripts/demo.sh` runs end-to-end and prints a decoded KAIF JWT
- [ ] No TypeScript errors in strict mode
- [ ] No ESLint errors
- [ ] SECURITY.md, GOVERNANCE.md, CONTRIBUTING.md present and complete
