# KAIF Project Wiki — Naming Conventions & Definitions

## Quick Reference

This wiki documents the naming conventions, acronyms, data types, and core concepts used throughout the KAIF codebase.

---

## Table of Contents

- [Acronyms & Standards](#acronyms--standards)
- [Core Concepts](#core-concepts)
- [Data Types & Interfaces](#data-types--interfaces)
- [Authentication & Authorization](#authentication--authorization)
- [File & Directory Conventions](#file--directory-conventions)
- [Code Style Conventions](#code-style-conventions)
- [Redis Key Prefixes](#redis-key-prefixes)
- [Error Codes](#error-codes)

---

## Acronyms & Standards

| Acronym | Expansion | Reference | Purpose |
|---------|-----------|-----------|---------|
| KAIF | Kindred Agent Identity Framework | — | Core protocol/project name |
| RFC 8693 | Token Exchange | OAuth 2.0 | Defines token exchange mechanism for workload identity |
| RFC 8705 | OAuth 2.0 Mutual TLS | mTLS binding | Certificate thumbprint binding for tokens |
| RFC 7662 | Token Introspection | Real-time checks | Validates token status at request time |
| RFC 7591 | OAuth 2.0 Dynamic Registration | Not used in v1 | Reserved for future credential provisioning |
| RFC 6749 | OAuth 2.0 Authorization | Error formats | Standard error response structure |
| SPIFFE | Secure Production Identity Framework for Everyone | Workload identity | Standard for workload certificates & SPIRE integration |
| SPIRE | SPIFFE Runtime Environment | gRPC API | Workload identity issuer; provides JWT-SVIDs |
| SVID | SPIFFE Verifiable Identity Document | JWT | Workload certificate issued by SPIRE (JWT format in KAIF) |
| JWT | JSON Web Token | — | Encoded claims with signature |
| JTI | JWT ID | RFC 7519 | Unique token identifier; used for revocation denylist |
| JWK | JSON Web Key | RFC 7517 | Public key material in JSON format |
| JWKS | JSON Web Key Set | RFC 7517 | Array of JWK; served at `/.well-known/jwks.json` |
| mTLS | Mutual TLS | — | Client and server both verify certificates |
| ACL | Access Control List | — | Agent permissions matrix (`agents.yaml`) |
| DER | Distinguished Encoding Rules | X.509 | Binary format for certificates |
| PEM | Privacy Enhanced Mail | — | Base64-encoded DER (standard cert format) |
| TTL | Time To Live | — | Expiration duration in seconds |
| UTC | Coordinated Universal Time | — | Timezone for all timestamps (ISO 8601) |
| UUID | Universally Unique Identifier | RFC 4122 | 128-bit identifier; v4 (random) used throughout KAIF |
| KQL | Kusto Query Language | — | Query language for audit logs (future) |
| MCP | Model Context Protocol | — | Agent tooling protocol (agents use KAIF for authz) |

---

## Core Concepts

### Identity Model

**Principal**
- A human or machine entity that can request authority
- Humans identified by: email address (from IdP)
- Machines identified by: SPIFFE ID (from SPIRE)

**Actor** (`KAIFActorClaim`)
- The agent fulfilling a request on behalf of a principal
- Always holds a SPIFFE ID and JWT-SVID from SPIRE
- Can be sub-delegated to other agents (if permitted)

**Subject** (in OAuth context)
- The entity for which the token is issued (usually a human principal)
- In KAIF: the human email from the delegation grant

### Authorization

**Scope**
- Requested permission granule (space-separated string in token)
- Format: `resource:action:target` (e.g., `vault:read:anthropic_key`)
- Supports glob matching: `vault:read:*` matches `vault:read:any_key`
- Validated against agent's ACL and human grant

**Trust Tier**
- Classification of agent security posture (ranges from `PROVISIONAL` to `TRUSTED`)
- Determined by trust score: `0.0–0.49` → PROVISIONAL, `0.5–0.69` → STANDARD, etc.
- Limits token TTL, delegation depth, and minimum required tier for operations

**Trust Score**
- Numeric value `0.0–1.0` representing agent reliability
- Components: behavioural, audit chain integrity, credential freshness, peer reputation
- Updated dynamically; sourced from Redis: `kaif:trust:<spiffe_id>`

**Delegation**
- Granting authority from a human principal to an agent
- Stored in Redis: `kaif:delegation:<delegation_id>`
- Bounded by expiry, scopes, and delegation depth

### Audit & Compliance

**Audit Chain**
- Hash-linked log of all authorization events
- Each entry: `hash = SHA-256(prev_hash|ts|action|detail)`
- Genesis entry uses `"0".repeat(64)` as `prev_hash`
- Tamper-detect: any deletion/modification breaks chain integrity

**Audit Action**
- Enumeration of logged events (e.g., `TOKEN_ISSUED`, `TOKEN_REVOKED`, `AUTH_FAILED`)
- Every action requires human/agent context and immutable detail field

**JTI Denylist** (Revocation)
- Redis set of revoked token IDs
- TTL matches token expiry (auto-cleanup)
- Checked on every token use if `KAIF_STRICT_REVOCATION=true`

### Token Lifecycle

**Delegation Grant**
- Provision: Human provides OIDC `id_token` to `/provision` endpoint
- Storage: Stored in Redis with expiry
- Use: Exchanged at `/oauth/token` for KAIF JWT

**KAIF JWT**
- Issued: KAIF signs token with RSA-2048 private key (RS256)
- Claims: Include `act` (actor/agent), `sub` (human), `kaif.*` (extensions)
- Validation: External services check against `/.well-known/jwks.json`
- Revocation: Optional JTI check via `/introspect` endpoint

---

## Data Types & Interfaces

### Trust Model Types

**TrustTier** (Enum)
```typescript
'PROVISIONAL' | 'STANDARD' | 'VERIFIED' | 'TRUSTED'
```
- Mapped to score ranges and token privileges

**TrustTierConfig**
- `tier`: TrustTier label
- `minScore`, `maxScore`: Score range (0.0–1.0)
- `tokenTTL`: Expiration in seconds
- `maxDepth`: Max delegation depth allowed

**TrustScoreSignal**
- `agent_spiffe_id`: Which agent
- `score`: 0.0–1.0 current score
- `updated_at`: Unix timestamp
- `signal_breakdown?`: Components (behavioural, audit_chain, credential, peer)

### JWT Claims

**KAIFTokenClaims**
- `iss`: Issuer (KAIF server URL)
- `sub`: Subject (human principal email)
- `aud`: Audience(s)
- `iat`, `exp`: Issued at, expires at (Unix seconds)
- `jti`: JWT ID (UUID v4 for revocation)
- `scope`: Space-separated permissions
- `actor`: KAIFActorClaim (agent identity)
- `may_act`: RFC 8693 allow this token to act on behalf of (JSON)
- `kaif`: KAIFExtensionClaims (KAIF-specific fields)

**KAIFExtensionClaims** (in `kaif` field)
- `trust_score`: Agent's trust score (0.0–1.0)
- `trust_tier`: Resolved tier label
- `delegation_depth`: Depth in delegation chain (0 = direct from human)
- `delegation_id`: UUID of the delegation grant
- `rollback_window`: ISO 8601 duration string (e.g., "PT10M")
- `principal_chain`: Array of human emails (oldest first)

**KAIFActorClaim** (in `actor` field)
- `sub`: Actor's SPIFFE ID
- `svid_thumbprint`: RFC 8705 certificate thumbprint (`sha256:<hex>`)

### Request/Response Types

**TokenExchangeRequest**
- `grant_type`: Must be `'urn:ietf:params:oauth:grant-type:token-exchange'`
- `subject_token`: Delegation grant JWT (or OIDC ID token)
- `subject_token_type`: Must be `'urn:ietf:params:oauth:token-type:access_token'`
- `actor_token`: Agent's JWT-SVID from SPIRE
- `actor_token_type`: Must be `'urn:ietf:params:oauth:token-type:jwt'`
- `scope?`: Requested scopes (space-separated)
- `audience?`: Target service identifier
- `resource?`: Optional resource identifier

**TokenExchangeResponse**
- `access_token`: Signed KAIF JWT string
- `issued_token_type`: `'urn:ietf:params:oauth:token-type:access_token'`
- `token_type`: `'Bearer'`
- `expires_in`: TTL in seconds
- `scope`: Granted scopes

### Audit Log Types

**AuditEntry**
- `id`: UUID v4 (unique event identifier)
- `ts`: ISO 8601 timestamp (UTC)
- `action`: AuditAction enum value
- `agent_id?`: SPIFFE ID of agent (if applicable)
- `human_id?`: Email of human principal (if applicable)
- `detail`: Immutable string with context
- `hash`: SHA-256 hex of `prev_hash|ts|action|detail`
- `prev_hash`: Previous entry's hash (genesis = `"0".repeat(64)`)

**AuditAction** (Enum)
```
VAULT_UNLOCKED | VAULT_LOCKED | DELEGATION_PROVISIONED |
TOKEN_ISSUED | TOKEN_INTROSPECTED | TOKEN_REVOKED |
AUTH_FAILED | SCOPE_DENIED | TRUST_SCORE_UPDATED |
SUB_DELEGATION_ISSUED | REVOCATION_PROPAGATED
```

### Agent Configuration

**AgentACL**
- `spiffe_id`: Workload's SPIFFE ID (must match SPIRE-issued SVID)
- `trust_tier_minimum`: Minimum tier required for any operation
- `permitted_scopes`: Array of allowed scopes (glob supported)
- `may_sub_delegate`: Boolean; can this agent delegate to others?
- `max_delegation_depth`: Max depth for delegated tokens (0 = no sub-delegation)
- `delegation_ttl_seconds`: Max TTL for delegated tokens (usually 900 = 15 min)
- `human_principal_required`: If true, actor must have human in principal chain

**AgentACLConfig**
- `agents`: Map of agent name → AgentACL

### SVID Types

**ParsedSVID**
- `spiffe_id`: Full SPIFFE ID string (`spiffe://<trust-domain>/path`)
- `thumbprint`: RFC 8705 thumbprint (`sha256:<lowercase-hex>`)
- `expiry`: Unix timestamp (seconds)
- `raw_cert`: DER-encoded certificate (Buffer)

---

## Authentication & Authorization

### Token Exchange Flow (RFC 8693)

1. **Agent requests token** → POST `/oauth/token`
   - Sends JWT-SVID from SPIRE (`actor_token`)
   - Sends human delegation JWT (`subject_token`)
   - Requests scopes and audience

2. **Server validates**
   - SVID: Fetch bundle, verify signature, check expiry, extract SPIFFE ID
   - Delegation: Verify not expired/revoked, not already used beyond age
   - ACL: Look up agent, check tier, verify requested scopes match
   - Trust score: Fetch current score, ensure meets tier minimum

3. **Server issues KAIF JWT**
   - Compute delegation depth (from subject token chain)
   - Encode all claims including trust score, tier, delegation ID
   - Sign with RS256 (RSA-2048 private key)
   - Return access token

4. **Agent uses token**
   - In `Authorization: Bearer <token>` header
   - External service validates signature against JWKS
   - Optional: Service calls `/introspect` for real-time revocation check

### Revocation

**User-initiated**
- Call POST `/revoke` with token string
- JTI added to denylist immediately

**Automatic**
- Entry expires from Redis when TTL reached (matches token expiry)
- Broadcast via Redis channel: `kaif:revocation`

**Enforcement**
- If `KAIF_STRICT_REVOCATION=true`: Every token use hits `/introspect`
- If false: Revocation is advisory (fast path, eventual consistency)

---

## File & Directory Conventions

### TypeScript Source Paths

```
packages/server/src/
├── index.ts                 # Entry point (starts Fastify)
├── server.ts               # App factory (buildServer)
├── config.ts               # Config loader (loadConfig)
│
├── types/
│   └── kaif.ts             # SINGLE SOURCE OF TRUTH for all types
│
├── crypto/
│   ├── keys.ts             # RSA keypair management
│   └── jwt.ts              # Sign/verify JWTs
│
├── services/
│   ├── audit.ts            # Audit log (hash-chained)
│   ├── svid.ts             # SPIFFE SVID validation
│   ├── acl.ts              # Agent ACL enforcement
│   ├── trust-score.ts      # Trust computation
│   ├── revocation.ts       # JTI denylist
│   └── token-exchange.ts   # RFC 8693 core
│
└── routes/
    ├── token.ts            # POST /oauth/token
    ├── introspect.ts       # POST /introspect
    ├── provision.ts        # POST /provision
    ├── revoke.ts           # POST /revoke
    ├── jwks.ts             # GET /.well-known/jwks.json
    └── health.ts           # GET /health
```

### Test Paths

```
packages/server/tests/
├── crypto.test.ts
├── audit.test.ts
├── trust-score.test.ts
├── revocation.test.ts
├── token-exchange.test.ts
└── integration.test.ts
```

### Configuration Paths

```
packages/server/config/
└── agents.yaml             # Agent ACL definitions (loaded at startup)

spire/
├── server.conf             # SPIRE server config
├── agent.conf              # SPIRE agent config
└── entries/
    └── bootstrap-entries.json
```

### Infrastructure Paths

```
.env.example                # Environment variable template
.gitignore                  # Standard for Node.js
docker-compose.yml          # Full stack: SPIRE, Redis, KAIF, mock agent
```

---

## Code Style Conventions

### Naming

| Context | Convention | Example |
|---------|-----------|---------|
| Type names | PascalCase | `KAIFTokenClaims`, `TrustTier` |
| Enum values | UPPER_SNAKE_CASE | `PROVISIONAL`, `TOKEN_ISSUED` |
| Function names | camelCase | `getSigningKey()`, `appendAudit()` |
| Constants | UPPER_SNAKE_CASE | `TRUST_TIERS`, `CLOCK_SKEW_TOLERANCE` |
| Variable names | camelCase | `agentACL`, `tokenTTL` |
| Async functions | camelCase, prefix with verb | `validateSVID()`, `executeTokenExchange()` |
| Private/internal functions | `_leading underscore` (TypeScript private) | `_validateHash()` |
| Redis keys | snake_case, `kaif:` prefix | `kaif:audit:global`, `kaif:trust:spiffe_id` |
| File names (services) | kebab-case | `token-exchange.ts`, `trust-score.ts` |
| File names (routes) | kebab-case | `oauth-token.ts` (or just `token.ts` for brevity) |

### Comments & Documentation

- **Security-sensitive code**: Explain WHY in plain English
- **Hash/crypto operations**: Document exact algorithm and input format
- **Clock skew**: Always document 10-second tolerance
- **Redis operations**: Include key pattern and TTL
- **Type fields**: Inline comments for units (seconds, hex, email, etc.)

### Error Handling

- Never log token values (log `jti` only, or `<redacted>`)
- Never return stack traces in JSON responses
- Use RFC 6749 error codes (snake_case)
- Always include `error_description` (human-readable, no sensitive data)

### Imports & Exports

```typescript
// ✅ Do: Group by source, most specific first
import crypto from 'node:crypto'
import { z } from 'zod'
import Redis from 'ioredis'
import { KAIFTokenClaims } from '../types/kaif'

// ❌ Don't: Wildcard imports or scattered groups
import * as types from '../types/kaif'
```

---

## Redis Key Prefixes

All KAIF Redis operations use the `kaif:` prefix for isolation.

| Prefix | Purpose | Format | TTL |
|--------|---------|--------|-----|
| `kaif:audit:global` | Global audit log | List of AuditEntry JSON | None (indefinite) |
| `kaif:audit:<spiffe_id>` | Per-agent audit log | List of AuditEntry JSON | None (indefinite) |
| `kaif:trust:<spiffe_id>` | Current trust score | TrustScoreSignal JSON | 3600 (1 hour default) |
| `kaif:delegation:<delegation_id>` | Delegation grant | DelegationGrant JSON | Match grant expiry |
| `kaif:revoke:<jti>` | Revoked token JTI | Empty (SET member) | Match token expiry |
| `kaif:revoke:*` (channel) | Revocation broadcast | RevocationEvent JSON | Pub/Sub (no storage) |
| `kaif:audit` (channel) | Audit broadcast | AuditEntry JSON | Pub/Sub (no storage) |
| `kaif:trust-score` (channel) | Trust score updates | TrustScoreSignal JSON | Pub/Sub (no storage) |

### Channel Names

- `kaif:audit` — Audit entry published
- `kaif:revocation` — Token revocation event
- `kaif:trust-score` — Trust score updated

---

## Error Codes

All errors follow RFC 6749 format:

```json
{
  "error": "error_code_here",
  "error_description": "Human-readable description",
  "error_uri": "https://..."  // optional
}
```

### KAIF Error Codes

| Code | HTTP | Meaning | Action |
|------|------|---------|--------|
| `invalid_request` | 400 | Malformed request (missing required field, bad JSON) | Check request format |
| `invalid_grant` | 400 | Subject token invalid, expired, or revoked | Re-authenticate |
| `invalid_client` | 401 | Actor token (SVID) invalid/expired/unregistered | Check agent registration and SVID |
| `invalid_scope` | 400 | Requested scope not permitted for agent or grant | Request narrower scope |
| `insufficient_trust` | 403 | Agent trust score below ACL minimum | Wait for trust to improve or contact admin |
| `delegation_depth_exceeded` | 403 | Delegation chain too deep (> max for agent) | Cannot sub-delegate further |
| `access_denied` | 403 | General authorization failure | Check ACL and trust tier |
| `server_error` | 500 | Internal server error | Retry; contact ops if persistent |
| `temporarily_unavailable` | 503 | Redis or SPIRE unreachable | Retry with backoff |

---

## Future Considerations (v1.1+)

- **Neo4j delegation graph** (reserved for policy-as-code queries)
- **Observability**: OpenTelemetry tracing for audit compliance
- **Kubernetes operator**: Automate KAIF deployment on AKS/GKE/EKS
- **Web UI**: Audit log explorer and trust score dashboard
- **Rate limiting by principal**: Per-human and per-agent quotas

---

**Last updated:** 2026-05-20  
**Maintainer:** KAIF Core Team  
**Status:** Reference Implementation v1.0
