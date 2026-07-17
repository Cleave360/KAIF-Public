# KAIF Codebase Tour

A developer's walkthrough of the KAIF reference implementation. This guide shows you how the system works, where to find things, and how to extend it.

**Audience:** Developers building or integrating KAIF  
**Time:** ~30 minutes to read; ~2 hours for hands-on exploration

---

## Table of Contents

- [High-Level Architecture](#high-level-architecture)
- [Token Exchange Data Flow](#token-exchange-data-flow)
- [Server Directory Structure](#server-directory-structure)
- [Core Services Deep Dive](#core-services-deep-dive)
- [Routes & HTTP API](#routes--http-api)
- [SDK: How Agents Use KAIF](#sdk-how-agents-use-kaif)
- [How to Add a New Route](#how-to-add-a-new-route)
- [How to Add a New Service](#how-to-add-a-new-service)
- [Testing Strategy](#testing-strategy)
- [Key Design Decisions](#key-design-decisions)

---

## High-Level Architecture

```
┌────────────────────────────────────────────────────────────────┐
│                         KAIF Server (Fastify)                  │
│  Port 8080 - Handles RFC 8693 token exchange + introspection   │
└────────────────────────────────────────────────────────────────┘
           ▲                                    ▲
           │                                    │
      ┌────┴─────────────┐              ┌──────┴────────┐
      │   SPIRE Server   │              │      Redis    │
      │  (Port 8081)     │              │   (Port 6379) │
      │ JWT-SVID issuer  │              │ Audit log,    │
      └──────────────────┘              │ trust scores  │
            ▲                            └───────────────┘
            │
            │ Workload attestation
            │
    ┌───────┴────────────────┐
    │    SPIRE Agent          │
    │  (/run/spire/sockets/)  │
    │  Workload API gRPC      │
    └────────────────────────┘
            ▲
            │
    ┌───────┴───────────────────┐
    │   Agent Workload          │
    │  (runs inside container)  │
    │  OR                        │
    │  (your service)           │
    └───────────────────────────┘
```

### Key Actors

1. **Agent** — Your service running under SPIRE (gets JWT-SVID from SPIRE Agent)
2. **KAIF Server** — RFC 8693 token exchange endpoint
3. **SPIRE Server** — Issues workload certificates (JWT-SVID)
4. **SPIRE Agent** — Local daemon that provides SVID to workloads
5. **Redis** — Stores audit log, trust scores, delegation grants
6. **Human IdP** — Azure Entra, Okta, etc. (validates subject tokens)

### Request Flow (Happy Path)

```
1. Agent loads SVID from SPIRE Agent                 → JWT-SVID
2. Human provides OIDC token (from IdP)              → subject_token
3. Agent → POST /oauth/token                         → (SVID + subject_token)
4. KAIF validates both tokens + ACL check            → All valid ✓
5. KAIF computes trust score for agent               → 0.75 = VERIFIED
6. KAIF issues signed JWT with claims                → access_token
7. Agent uses token in "Authorization: Bearer ..."   → External service
8. External service validates signature              → JWT valid ✓
9. KAIF writes audit entry (hash-chained)            → Redis
```

---

## Token Exchange Data Flow

This is the **core KAIF operation**. Understanding this flow is essential.

### Input: TokenExchangeRequest

```typescript
{
  grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
  subject_token: 'eyJhbGc...',  // Human delegation JWT (from IdP)
  subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
  actor_token: 'eyJhbGc...',     // Agent JWT-SVID (from SPIRE)
  actor_token_type: 'urn:ietf:params:oauth:token-type:jwt',
  scope: 'vault:read:key1 invoke:completion',
  audience: 'my-service'
}
```

### Processing Steps (in order)

```
┌─────────────────────────────────────────────────────────────────────────┐
│ 1. Parse and validate request structure (Zod schema)                    │
│    → Returns 400 invalid_request if malformed                            │
└──────────────────────┬──────────────────────────────────────────────────┘
                       ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 2. Verify subject_token (human grant)                                   │
│    • Fetch IdP JWKS from configured URL                                 │
│    • Verify JWT signature using issuer's public key                     │
│    • Check expiry (10s clock skew tolerance)                            │
│    • Check JTI not in Redis denylist                                    │
│    → Returns 400 invalid_grant if invalid/expired/revoked               │
│    → Extracts: sub (human email), scope (permitted scopes)              │
└──────────────────────┬──────────────────────────────────────────────────┘
                       ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 3. Validate actor_token (agent SVID from SPIRE)                         │
│    • Fetch SPIRE bundle (public keys) from SPIRE_BUNDLE_ENDPOINT       │
│    • Verify JWT signature                                               │
│    • Check expiry                                                       │
│    • Extract SPIFFE ID (e.g., spiffe://kindred.systems/ns/.../)        │
│    • Validate SPIFFE ID format                                         │
│    → Returns 401 invalid_client if invalid/not registered               │
│    → Extracts: spiffe_id, thumbprint (RFC 8705)                        │
└──────────────────────┬──────────────────────────────────────────────────┘
                       ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 4. Load ACL for agent                                                   │
│    • Query agents.yaml for SPIFFE ID                                    │
│    • Returns 403 access_denied if not registered                        │
│    → Extracts: permitted_scopes, trust_tier_minimum, max_depth         │
│      (`trust_tier_minimum` is the current ACL field name)              │
└──────────────────────┬──────────────────────────────────────────────────┘
                       ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 5. Validate requested scopes (ACL + delegation intersection)            │
│    • Split scope string by space                                        │
│    • For each scope: check glob match against ACL permitted_scopes      │
│    • For each scope: check in subject_token's scope list                │
│    → Returns 400 invalid_scope if any scope denied                      │
└──────────────────────┬──────────────────────────────────────────────────┘
                       ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 6. Fetch authorization tier value for agent                             │
│    • Query Redis: kaif:trust:<spiffe_id>                                │
│    • Default: 0.5 if not found (STANDARD tier)                          │
│    • Resolve authorization tier from value                              │
│      (PROVISIONAL|STANDARD|VERIFIED|TRUSTED)                            │
│    • Current implementation internals may still label these             │
│      values as trust_score and trust_tier                               │
│    → Returns 403 insufficient_trust if < minimum tier for ACL           │
└──────────────────────┬──────────────────────────────────────────────────┘
                       ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 7. Compute delegation depth                                             │
│    • Parse subject_token claims                                         │
│    • Direct /provision grants keep depth 0                              │
│    • Issued access-token subjects increment parent depth by 1           │
│    → Returns 403 delegation_depth_exceeded if > ACL max_depth           │
│    → Also build principal_chain (human emails from parents)             │
└──────────────────────┬──────────────────────────────────────────────────┘
                       ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 8. Resolve token TTL from authorization tier                            │
│    • PROVISIONAL: 300s (5 min)                                          │
│    • STANDARD: 600s (10 min)                                            │
│    • VERIFIED: 900s (15 min)                                            │
│    • TRUSTED: 900s (15 min)                                             │
│    • exp = now + TTL                                                    │
└──────────────────────┬──────────────────────────────────────────────────┘
                       ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 9. Mint KAIF JWT claims object                                          │
│                                                                          │
│    Standard OAuth claims:                                               │
│    • iss: KAIF_ISSUER                                                   │
│    • sub: human email (from subject_token.sub)                          │
│    • aud: from request.audience                                         │
│    • iat: now (unix seconds)                                            │
│    • exp: iat + TTL                                                     │
│    • jti: uuid v4 (for revocation denylist)                             │
│    • scope: granted scopes (space-separated)                            │
│                                                                          │
│    RFC 8693 actor claim:                                                │
│    • actor.sub: agent SPIFFE ID                                         │
│    • actor.svid_thumbprint: sha256:<hex> of SVID cert                   │
│                                                                          │
│    KAIF extension claims (in .kaif field):                              │
│    • kaif.authorization_tier_value: agent's operator-assigned           │
│      authorization value (0.0-1.0)                                      │
│    • kaif.authorization_tier: tier label (VERIFIED, etc.)               │
│    • kaif.delegation_depth: depth in chain (0 = direct from human)      │
│    • kaif.delegation_id: uuid v4 (unique per issuance)                  │
│    • kaif.rollback_window: ISO 8601 duration (e.g., "PT10M")            │
│    • kaif.principal_chain: [human1@org, human2@org, ...] (audit trail)  │
└──────────────────────┬──────────────────────────────────────────────────┘
                       ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 10. Sign JWT with RS256 (RSA-2048 private key)                          │
│     • Fetch private key from config (file or env)                       │
│     • Use 'jose' library to sign with RS256                             │
│     • Returns compact JWT: header.payload.signature                     │
└──────────────────────┬──────────────────────────────────────────────────┘
                       ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 11. Write audit entry (SHA-256 hash-chained)                            │
│     • Fetch prev hash: last entry in kaif:audit:global                  │
│     • Compute new hash: sha256(prevHash|timestamp|TOKEN_ISSUED|jti)     │
│     • Store entry in Redis lists:                                       │
│       - kaif:audit:global (all events)                                  │
│       - kaif:audit:<spiffe_id> (agent-specific)                         │
│     • Publish to channel: kaif:audit                                    │
└──────────────────────┬──────────────────────────────────────────────────┘
                       ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 12. Return TokenExchangeResponse                                        │
│                                                                          │
│     {                                                                   │
│       "access_token": "eyJhbGc...",                                     │
│       "issued_token_type": "urn:ietf:params:oauth:token-type:...",     │
│       "token_type": "Bearer",                                          │
│       "expires_in": 900,                                               │
│       "scope": "vault:read:key1 invoke:completion"                     │
│     }                                                                   │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Server Directory Structure

### `packages/server/src/`

```
src/
├── index.ts                     ← Entry point (starts Fastify, connects Redis/SPIRE)
├── server.ts                    ← buildServer() factory function
├── config.ts                    ← loadConfig() from environment
│
├── types/
│   └── kaif.ts                  ← SINGLE SOURCE OF TRUTH for all types
│                                  (TrustTier, KAIFTokenClaims, AuditEntry, etc.)
│
├── crypto/
│   ├── keys.ts                  ← RSA-2048 keypair management
│   │                             Functions:
│   │                              • getSigningKey() → KeyLike (cached)
│   │                              • getPublicJWK() → JWK
│   │                              • getJWKS() → { keys: JWK[] }
│   │
│   └── jwt.ts                   ← JWT signing/verification
│                                  Functions:
│                                   • signKAIFToken(claims) → JWT string
│                                   • verifyJWT(token) → JWTPayload
│                                   • verifySVIDJWT(svid) → ParsedSVID
│                                   • computeThumbprint(certDER) → sha256:<hex>
│
├── services/ ← CORE BUSINESS LOGIC
│   ├── audit.ts                 ← Audit log, hash-chained
│   │                             Functions:
│   │                              • appendAudit(redis, params) → AuditEntry
│   │                              • getAuditLog(redis, agent_id?) → AuditEntry[]
│   │                              • verifyChain(redis, agent_id?) → boolean
│   │
│   ├── revocation.ts            ← JTI denylist
│   │                             Functions:
│   │                              • revokeToken(redis, jti, ...) → void
│   │                              • isRevoked(redis, jti) → boolean
│   │                              • subscribeRevocation(redis, onEvent) → void
│   │
│   ├── trust-score.ts           ← Trust computation & tier
│   │                             Functions:
│   │                              • getTrustScore(redis, spiffe_id) → TrustScoreSignal
│   │                              • updateTrustScore(redis, spiffe_id, score) → void
│   │                              • resolveTier(score) → TrustTierConfig
│   │                              • assertTierMinimum(score, required) → void
│   │
│   ├── svid.ts                  ← SPIFFE SVID validation
│   │                             Functions:
│   │                              • validateSVID(svid_jwt) → ParsedSVID
│   │                              • validateSpiffeID(id) → boolean
│   │                              • isSVIDValid(svid) → boolean
│   │
│   ├── acl.ts                   ← Agent access control
│   │                             Functions:
│   │                              • loadACL() → AgentACLConfig
│   │                              • getAgentACL(spiffe_id) → AgentACL | null
│   │                              • validateScopes(requested, permitted) → { valid, denied }
│   │                              • assertAuthorised(params) → void (throws)
│   │
│   └── token-exchange.ts        ← RFC 8693 core (MAIN LOGIC)
│                                  Functions:
│                                   • executeTokenExchange(params) → TokenExchangeResponse
│                                    (This is where the 12-step flow above happens)
│
└── routes/                     ← HTTP API endpoints
    ├── token.ts                ← POST /oauth/token (token exchange)
    ├── introspect.ts           ← POST /introspect (RFC 7662)
    ├── provision.ts            ← POST /provision (delegation creation)
    ├── revoke.ts               ← POST /revoke (token revocation)
    ├── jwks.ts                 ← GET /.well-known/jwks.json
    └── health.ts               ← GET /health (health check)
```

### Key Files to Know

| File | Purpose | Key Export |
|------|---------|------------|
| `config.ts` | Load env vars & agents.yaml | `loadConfig()` |
| `types/kaif.ts` | All types (single source of truth) | `TrustTier`, `KAIFTokenClaims`, etc. |
| `crypto/jwt.ts` | JWT sign/verify | `signKAIFToken()`, `verifyJWT()` |
| `services/token-exchange.ts` | Core RFC 8693 logic | `executeTokenExchange()` |
| `services/audit.ts` | Hash-chained log | `appendAudit()`, `verifyChain()` |
| `routes/token.ts` | POST /oauth/token handler | `tokenRoute` (Fastify route) |

---

## Core Services Deep Dive

### 1. Crypto Services (`crypto/`)

**Purpose:** Handle RSA keys and JWT operations

**`keys.ts`** — Keypair management
```typescript
// Generate or load RSA-2048 key from KAIF_PRIVATE_KEY_PATH env
async function getSigningKey(): Promise<KeyLike>
// Returns cached key (in-memory)

// Return public key as JWK
async function getPublicJWK(): Promise<JWK>

// Return JWKS (array of JWK) for /.well-known/jwks.json
async function getJWKS(): Promise<{ keys: JWK[] }>
```

**`jwt.ts`** — Signing and verification
```typescript
// Sign claims with RS256
async function signKAIFToken(claims: KAIFTokenClaims): Promise<string>

// Verify JWT against our JWKS
async function verifyJWT(token: string): Promise<JWTPayload>

// Verify JWT-SVID from SPIRE
async function verifySVIDJWT(svid: string): Promise<ParsedSVID>

// RFC 8705 thumbprint: sha256(cert_DER) as "sha256:<hex>"
function computeThumbprint(certDER: Buffer): string
```

### 2. Audit Service (`services/audit.ts`)

**Purpose:** Immutable hash-chained audit log

**Key concept:** Every entry is cryptographically linked to the previous one:
```
Entry 1: hash = sha256(genesis | T1 | TOKEN_ISSUED | jti1)
Entry 2: hash = sha256(hash1 | T2 | TOKEN_REVOKED | jti1)
Entry 3: hash = sha256(hash2 | T3 | AUTH_FAILED | detail)
```

**Stored in Redis:**
- `kaif:audit:global` — All events (append-only list)
- `kaif:audit:<spiffe_id>` — Per-agent events

**Key functions:**
```typescript
// Append entry (computes hash from previous)
async function appendAudit(redis, params): Promise<AuditEntry>

// Verify chain integrity (no tampers)
async function verifyChain(redis, agent_id?): Promise<boolean>
// Returns false if any entry hash is corrupted or sequence is broken

// Retrieve audit entries
async function getAuditLog(redis, agent_id?, limit?): Promise<AuditEntry[]>
```

### 3. Trust Score Service (`services/trust-score.ts`)

**Purpose:** Compute agent trust tier from score

**Score ranges (0.0–1.0):**
- `0.00–0.49` → PROVISIONAL (5 min tokens, no sub-delegation)
- `0.50–0.69` → STANDARD (10 min tokens, 1 level deep)
- `0.70–0.89` → VERIFIED (15 min tokens, 2 levels deep)
- `0.90–1.00` → TRUSTED (15 min tokens, 3 levels deep)

**Key functions:**
```typescript
// Fetch current score for agent
async function getTrustScore(redis, spiffe_id): Promise<TrustScoreSignal>

// Update score (publish to Redis channel)
async function updateTrustScore(redis, spiffe_id, score): Promise<void>

// Score → Tier
function resolveTier(score: number): TrustTierConfig

// Validate score meets minimum
function assertTierMinimum(score, required): void  // throws if insufficient
```

### 4. ACL Service (`services/acl.ts`)

**Purpose:** Load agents.yaml and enforce permissions

**Loaded from:** `KAIF_AGENTS_CONFIG_PATH` (default: `./config/agents.yaml`)

**YAML structure:**
```yaml
agents:
  lyra:                                 # agent name (key)
    spiffe_id: "spiffe://example.org/ns/adaptive-layer/agent/lyra"
    trust_tier_minimum: STANDARD        # implementation ACL field name for minimum authorization tier
    permitted_scopes:                   # glob supported
      - "vault:read:*"
      - "invoke:completion"
    may_sub_delegate: false             # can delegate to others?
    max_delegation_depth: 1             # how deep?
    delegation_ttl_seconds: 900         # 15 min
    human_principal_required: true
```

**Key functions:**
```typescript
// Load ACL and cache (reloads on SIGHUP)
function loadACL(): AgentACLConfig

// Get entry for SPIFFE ID
function getAgentACL(spiffe_id): AgentACL | null

// Validate requested scopes against permitted (glob support)
function validateScopes(requested, permitted): { valid, denied }
// Example: requested=["vault:read:key1"], permitted=["vault:read:*"]
// Result: { valid: true, denied: [] }

// Full ACL check (throws KAIFError on failure)
async function assertAuthorised(params): Promise<void>
// Throws if: untrusted, tier too low, scope denied, delegation too deep
```

### 5. Token Exchange Service (`services/token-exchange.ts`)

**Purpose:** RFC 8693 core implementation (THE MAIN OPERATION)

**This is where everything comes together:**

```typescript
async function executeTokenExchange(params: {
  redis: Redis
  request: TokenExchangeRequest
  client_cert?: Buffer  // RFC 8705 mTLS binding
}): Promise<TokenExchangeResponse>
```

**This function:**
1. Validates subject_token (human grant)
2. Validates actor_token (agent SVID)
3. Checks ACL
4. Fetches trust score
5. Computes delegation depth
6. Resolves TTL from tier
7. Mints KAIF JWT
8. Writes audit entry
9. Returns TokenExchangeResponse

**See:** [Token Exchange Data Flow](#token-exchange-data-flow) section above for full details.

---

## Routes & HTTP API

### POST /oauth/token

**RFC 8693 Token Exchange**

```bash
curl -X POST http://localhost:8080/oauth/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=urn:ietf:params:oauth:grant-type:token-exchange&subject_token=...&..."
```

**File:** `routes/token.ts`

**Error handling:**
- 400 `invalid_request` — Malformed
- 400 `invalid_grant` — Subject token invalid
- 401 `invalid_client` — Actor token (SVID) invalid
- 400 `invalid_scope` — Scope not permitted
- 403 `insufficient_trust` — Trust score too low
- 403 `delegation_depth_exceeded` — Chain too deep
- 500 `server_error` — Internal error

### POST /introspect

**RFC 7662 Token Introspection**

```bash
curl -X POST http://localhost:8080/introspect \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "token=eyJhbGc..."
```

**Response (if active):**
```json
{
  "active": true,
  "sub": "user@example.com",
  "aud": "my-service",
  "exp": 1716252000,
  "kaif": { "authorization_tier_value": 0.75, ... }
}
```

**Response (if revoked):**
```json
{ "active": false }
```

**File:** `routes/introspect.ts`

### POST /provision

**Delegation Provisioning (KAIF-specific)**

```bash
curl -X POST http://localhost:8080/provision \
  -H "Content-Type: application/json" \
  -d '{
    "id_token": "eyJhbGc...",  # OIDC token from IdP
    "agent_id": "lyra",         # Agent name (from agents.yaml)
    "scope": "vault:read:*",    # Requested scopes
    "ttl_seconds": 900          # Optional, capped at 86400
  }'
```

**Response:**
```json
{
  "delegation_id": "550e8400-e29b-41d4-a716-446655440000",
  "expires_at": 1716252000
}
```

**File:** `routes/provision.ts`

### POST /revoke

**Token Revocation**

```bash
curl -X POST http://localhost:8080/revoke \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "token=eyJhbGc...&reason=user_logout"
```

**File:** `routes/revoke.ts`

### GET /.well-known/jwks.json

**Public Key Material (no auth required)**

```bash
curl http://localhost:8080/.well-known/jwks.json | jq .
```

**Response:**
```json
{
  "keys": [
    {
      "kty": "RSA",
      "use": "sig",
      "kid": "...",
      "n": "...",
      "e": "AQAB"
    }
  ]
}
```

**File:** `routes/jwks.ts`

### GET /health

**Health Check**

```bash
curl http://localhost:8080/health | jq .
```

**Response:**
```json
{
  "status": "ok",
  "redis": "connected",
  "spire": "reachable",
  "uptime": 42,
  "version": "1.0.0"
}
```

**File:** `routes/health.ts`

---

## SDK: How Agents Use KAIF

### `packages/sdk/src/client.ts` — KAIFClient

**Main entry point for agents:**

```typescript
import { KAIFClient } from '@kindred/kaif-sdk'

const client = new KAIFClient({
  server_url: 'http://kaif-server:8080',
  spiffe_id: 'spiffe://example.org/ns/adaptive-layer/agent/lyra',
  svid_path: '/tmp/svid.jwt',                  // JWT-SVID file from SVIDStore
  delegation_token: 'jwt-from-provision'       // From /provision call
})

// Get a token (auto-caches)
const accessToken = await client.getToken('vault:read:*', 'my-service')

// Use in HTTP request
const response = await fetch('https://my-service/api/data', {
  headers: {
    'Authorization': `Bearer ${accessToken}`
  }
})

// Or use helper:
const authHeader = await client.authHeader('vault:read:*', 'my-service')
// Returns: "Bearer eyJhbGc..."

// Refresh if needed
await client.refreshToken('vault:read:*', 'my-service')

// Revoke all tokens on shutdown
await client.revoke()
```

### Token Cache (`packages/sdk/src/token-cache.ts`)

**Smart TTL eviction:**

```typescript
// Cache key: "${scope}:${audience}"
// Evict when: now > token.exp - 60s
// In-memory only (ephemeral)

// Example:
// Token issued with exp=300s
// Cache until: now + 240s
// Then refresh automatically on next getToken() call
```

### How Agents integrate (step-by-step)

1. **Agent startup** → Load SVID from SPIRE (`/run/spire/sockets/agent.sock`)
2. **Human provision** → Provision delegation grant via `/provision` endpoint
3. **Per-request** → Call `client.getToken(scope, audience)`
4. **Use token** → Include in `Authorization: Bearer <token>` header
5. **On shutdown** → Call `client.revoke()` to revoke all tokens

**See:** `examples/mock-agent/index.ts` for full example

---

## How to Add a New Route

### Step 1: Define the endpoint function

**File:** `packages/server/src/routes/my-route.ts`

```typescript
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { z } from 'zod'

// Define input schema
const MyRouteSchema = z.object({
  param1: z.string(),
  param2: z.number().optional()
})

type MyRouteRequest = z.infer<typeof MyRouteSchema>

// Handler function
async function myRouteHandler(
  request: FastifyRequest<{ Body: MyRouteRequest }>,
  reply: FastifyReply
) {
  try {
    // Validation happens in Fastify schema (see step 2)
    const { param1, param2 } = request.body

    // Your business logic
    const result = await someService(param1)

    // Return success
    reply.status(200).send({
      success: true,
      data: result
    })
  } catch (error) {
    // Handle errors
    request.log.error(error)
    reply.status(500).send({
      error: 'server_error',
      error_description: 'Internal server error'
    })
  }
}

// Export route definition
export default async function myRoute(app: FastifyInstance) {
  app.post('/my-route', {
    schema: {
      body: {
        type: 'object',
        properties: {
          param1: { type: 'string' },
          param2: { type: 'number' }
        },
        required: ['param1']
      }
    }
  }, myRouteHandler)
}
```

### Step 2: Register in `server.ts`

**File:** `packages/server/src/server.ts`

```typescript
import myRoute from './routes/my-route'

export async function buildServer(opts?: FastifyServerOptions): Promise<FastifyInstance> {
  const app = fastify(opts)
  
  // ... existing registrations ...
  
  // Add your route
  await app.register(myRoute)
  
  return app
}
```

### Step 3: Test

**File:** `packages/server/tests/my-route.test.ts`

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { buildServer } from '../src/server'
import { FastifyInstance } from 'fastify'

describe('POST /my-route', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = await buildServer()
  })

  afterAll(async () => {
    await app.close()
  })

  it('should handle valid request', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/my-route',
      payload: { param1: 'test' }
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ success: true, data: expect.any(String) })
  })

  it('should return 400 for invalid request', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/my-route',
      payload: {}  // Missing param1
    })
    expect(response.statusCode).toBe(400)
  })
})
```

---

## How to Add a New Service

### Step 1: Create the service module

**File:** `packages/server/src/services/my-service.ts`

```typescript
import Redis from 'ioredis'
import { KAIFError } from '../types/kaif'

// Define interface for service input
export interface MyServiceParams {
  redis: Redis
  agent_id: string
  data: string
}

// Implement the service
export async function myServiceFunction(params: MyServiceParams): Promise<string> {
  const { redis, agent_id, data } = params

  // Use Redis
  const key = `kaif:myservice:${agent_id}`
  await redis.set(key, data, 'EX', 3600)  // TTL 1 hour

  // Return result
  return `Processed: ${data}`
}

// Error handling
export async function assertMyServiceCondition(condition: boolean): Promise<void> {
  if (!condition) {
    throw new KAIFError('invalid_request', 'Condition not met')
  }
}
```

### Step 2: Use in a route or service

**File:** `packages/server/src/routes/token.ts` (example)

```typescript
import { myServiceFunction } from '../services/my-service'

// Inside route handler:
const result = await myServiceFunction({
  redis: request.server.redis,
  agent_id: 'lyra',
  data: 'test'
})
```

### Step 3: Test

**File:** `packages/server/tests/my-service.test.ts`

```typescript
import Redis from 'ioredis-mock'
import { describe, it, expect } from 'vitest'
import { myServiceFunction } from '../src/services/my-service'

describe('myServiceFunction', () => {
  it('should store and retrieve data', async () => {
    const redis = new Redis()
    const result = await myServiceFunction({
      redis,
      agent_id: 'test-agent',
      data: 'hello'
    })
    expect(result).toBe('Processed: hello')
  })
})
```

---

## Testing Strategy

### Test Coverage Targets

| Module | Target | Reason |
|--------|--------|--------|
| `crypto/jwt.ts` | 100% | Signature verification is critical |
| `crypto/keys.ts` | 100% | Key handling must be correct |
| `services/audit.ts` | 100% | Tamper detection is essential |
| `services/revocation.ts` | 100% | Revocation must be accurate |
| `services/token-exchange.ts` | 90% | Core logic, most complex |
| `services/trust-score.ts` | 90% | Score computation must be tested |
| `services/acl.ts` | 90% | Permission checking is critical |
| Routes | 85% | Happy path + error cases |

### Test Patterns

**Unit tests** (test individual functions):
```typescript
import { describe, it, expect } from 'vitest'
import { signKAIFToken } from '../src/crypto/jwt'

describe('signKAIFToken', () => {
  it('should return valid JWT', async () => {
    const token = await signKAIFToken({...claims})
    expect(token).toMatch(/^eyJ/)  // JWT format
  })
})
```

**Integration tests** (test depen on Redis, SPIRE, etc.):
```typescript
import { describe, it, expect, beforeAll } from 'vitest'
import Redis from 'ioredis-mock'
import { appendAudit, verifyChain } from '../src/services/audit'

describe('Audit chain', () => {
  let redis: Redis

  beforeAll(() => {
    redis = new Redis()
  })

  it('should detect tampered entries', async () => {
    // Append entry, tamper, verify
    await appendAudit(redis, {...})
    const chain_ok = await verifyChain(redis)
    expect(chain_ok).toBe(true)
  })
})
```

**End-to-end tests** (test full request flow):
```typescript
import { describe, it, expect } from 'vitest'
import { buildServer } from '../src/server'

describe('Token exchange flow', () => {
  it('should exchange tokens end-to-end', async () => {
    const app = await buildServer()
    const response = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      payload: {...}
    })
    expect(response.statusCode).toBe(200)
  })
})
```

### Run Tests

```bash
# All tests
pnpm test

# Watch mode
pnpm test --watch

# Coverage
pnpm test --coverage

# Specific file
pnpm test services/audit.test.ts
```

---

## Key Design Decisions

### Design Decision #1: Single Source of Truth for Types

**Decision:** All TypeScript types in `packages/server/src/types/kaif.ts`

**Why:**
- Prevents type duplication across routes, services, SDK
- Easy to update contract when protocol changes
- SDK re-exports from server types

**Related files:**
- `packages/sdk/src/types.ts` — Re-exports server types
- `packages/server/src/**` — All import from `types/kaif.ts`

### Design Decision #2: Redis Instead of Database

**Decision:** Redis only, no PostgreSQL/MySQL

**Why:**
- Audit log is append-only (not queried heavily)
- TTL-based auto-cleanup (delegation grants, revocation lists)
- Pub/Sub for real-time events
- Ephemeral; no backup requirement (audit log is immutable durable in logs)
- Simple operational model

**Tradeoff:** Can't do complex queries (reserved for future KQL language)

### Design Decision #3: Hash-Chained Audit Log

**Decision:** SHA-256 chain instead of traditional mutability logs

**Why:**
- Immutable by design (hash breaking detects tampering)
- No DELETE operations (append-only)
- Human-understandable chain verification
- Regulatory compliance (audit trail cannot be doctored)

**Tradeoff:** Can't bulk delete; must expire entries via TTL

### Design Decision #4: Glob Scope Matching

**Decision:** Scopes use glob patterns (`vault:read:*` matches `vault:read:key1`)

**Why:**
- Flexible ACL without enumeration
- Common in access control
- Reduces YAML config size

**Tradeoff:** Exact matching might be more explicit

### Design Decision #5: Clock Skew Tolerance = 10 Seconds

**Decision:** Fixed, non-configurable 10-second tolerance

**Why:**
- RFC standard for JWT
- Prevents drift exploits
- Simple to understand and test

**Tradeoff:** Cannot be tuned per deployment

### Design Decision #6: Two-Route Trust Score

**Decision:** Trust score is separate from token claims

**Why:**
- Trust score computed at /oauth/token time (snapshot)
- Score captured in JWT (immutable during use)
- Score can update; old tokens still valid with old score
- Enables trust tier transitions without token refresh

**Tradeoff:** Trust score in token is point-in-time, not real-time

---

## Common Tasks

### Debug a failing token exchange

```bash
# 1. Check logs
docker compose logs kaif-server | grep ERROR

# 2. Check Redis state
docker compose exec redis redis-cli keys 'kaif:*'

# 3. Verify SPIRE can issue a JWT-SVID
docker compose exec spire-agent /opt/spire/bin/spire-agent api fetch jwt \
  -spiffeID spiffe://kindred.systems/ns/examples/agent/mock \
  -audience http://localhost:8080 \
  -socketPath /run/spire/sockets/agent.sock

# 4. Test /health
curl http://localhost:8080/health | jq .

# 5. Check ACL
docker compose exec kaif-server cat config/agents.yaml
```

### Add a new agent to ACL

```bash
# 1. Edit agents.yaml
vim packages/server/config/agents.yaml

# 2. Add entry:
my-agent:
  spiffe_id: "spiffe://kindred.systems/ns/my-namespace/agent/my-agent"
  trust_tier_minimum: STANDARD
  permitted_scopes:
    - "my:read:*"
  # ... rest of config

# 3. Reload (SIGHUP)
docker compose restart kaif-server

# Or reload in container (if implemented):
curl -X POST http://localhost:8080/admin/reload-acl
```

### View the audit chain

```bash
# Via Redis CLI
docker exec redis redis-cli LRANGE kaif:audit:global 0 -1 | jq -r '.[] | @json'

# Via HTTP API (if implemented)
curl http://localhost:8080/audit | jq '.entries[] | {ts, action, detail, hash}'
```

---

**Next:** [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for common issues  
**Reference:** [wiki.md](wiki.md) for naming conventions  
**Quick Start:** [QUICKSTART.md](QUICKSTART.md) to run KAIF locally in 5 min
