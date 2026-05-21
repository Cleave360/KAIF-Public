# KAIF Project Index — Master Navigation

**KAIF** (Kindred Agent Identity Framework) is a composable protocol stack that gives autonomous AI agents scoped, auditable, revocable authority traceable to a human principal.

**Status:** Implementation Complete (All 8 Phases), Release Gates Pending
**Last Updated:** 2026-05-21

---

## Quick Navigation

- **📋 Project Overview** — [KAIF Specification](#kaif-specification) | [Build Instructions](#build-instructions) | [Repository Layout](#repository-layout)
- **🔐 Core Concepts** — [Trust Model](#trust-model-and-tiers) | [Token Exchange](#token-exchange-rfc-8693) | [Audit Chain](#audit-chain-and-compliance)
- **🧪 Testing & Conformance** — [Verification Snapshot](#latest-verification-snapshot) | [Test Surface Map](#test-surface-map) | [Conformance Fixtures](#conformance-fixtures-kaif-001-kaif-007)
- **📁 Source Code** — [Server](#kaif-server-implementation) | [SDK](#kaif-agent-sdk) | [Examples](#example-implementations)
- **📚 Documentation** — [Architecture Decisions](#architecture-and-decisions) | [Security](#security) | [Contributing](#contributing-and-governance)
- **🎯 Reference** — [Wiki (Naming Conventions)](#wiki--reference) | [Phase Checklist](#implementation-phases-checklist)

---

## 📋 Project Overview

### KAIF Specification

**File:** [SPEC.md](SPEC.md)  
**Purpose:** RFC 8693 (Token Exchange) + SPIFFE/SPIRE + OAuth 2.1 + SHA-256 audit chain  
**Audience:** Protocol designers, security auditors, integrators

**Key Sections:**
- Protocol layers: PEP (Policy Enforcement Point), PDP (Policy Decision Point), Audit
- Trust tier model (PROVISIONAL, STANDARD, VERIFIED, TRUSTED)
- Token exchange flow diagrams
- Security properties and threat model

### Build Instructions

**File:** [CLAUDE.md](CLAUDE.md) ← **Authoritative build specification**  
**Purpose:** Step-by-step implementation guide with hard phase dependencies  
**Audience:** Developers building KAIF reference implementation

**Phases (in order):**
1. **Phase 0** — Project Scaffold (package.json, tsconfig, .env.example)
2. **Phase 1** — Crypto Foundation (RSA keys, JWT signing/verification)
3. **Phase 2** — Services (audit log, trust score, ACL, token exchange)
4. **Phase 3–4** — Routes & Server (Fastify app, error handling, request validation)
5. **Phase 5** — SDK (KAIFClient for agents, token cache)
6. **Phase 6** — Infrastructure (Docker Compose, SPIRE configs, agents.yaml)
7. **Phase 7** — Documentation (README, SECURITY.md, GOVERNANCE.md, CONTRIBUTING.md)

### Repository Layout

```
KAIF/
├── README.md                          ← User-facing intro & quick start
├── SPEC.md                            ← Protocol specification
├── SECURITY.md                        ← Vulnerability policy, SLO
├── GOVERNANCE.md                      ← Project roles & decision-making
├── CONTRIBUTING.md                    ← Developer guide
├── LICENSE                            ← Apache 2.0
├── CLAUDE.md                          ← THIS FILE: Build spec (authoritative)
├── wiki.md                            ← THIS PROJECT: Naming conventions & definitions
├── index.md                           ← THIS FILE: Master navigation
│
├── package.json                       ← Root workspace (pnpm)
├── pnpm-workspace.yaml                ← Monorepo config
├── tsconfig.base.json                 ← Base TypeScript config
├── pnpm-lock.yaml                     ← Dependency lock file
│
├── .env.example                       ← Environment variable template
├── .gitignore                         ← Git exclusions
├── docker-compose.yml                 ← Full stack: SPIRE + Redis + KAIF + mock agent
│
├── packages/
│   ├── server/                        ← KAIF Token Exchange Server (Fastify)
│   │   ├── src/                       ← [See Server Structure](#kaif-server-structure) below
│   │   ├── config/agents.yaml         ← Agent ACL definitions (runtime loaded)
│   │   ├── tests/                     ← Unit & integration tests
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── sdk/                           ← KAIF Agent SDK (what agents import)
│       ├── src/client.ts              ← KAIFClient class (main export)
│       ├── src/token-cache.ts         ← TTL-aware token cache
│       ├── src/types.ts               ← Re-exports of server types
│       ├── tests/
│       ├── package.json
│       └── tsconfig.json
│
├── conformance/                       ← KAIF conformance kit (fixtures + CLI + CI workflow)
│   ├── fixtures/                      ← KAIF-001..KAIF-007
│   ├── runner/                        ← Harness and reporters
│   ├── tests/                         ← Conformance package tests
│   ├── ci/conformance.yml             ← GitHub Actions workflow
│   └── README.md
│
├── spire/
│   ├── server.conf                    ← SPIRE server configuration
│   ├── agent.conf                     ← SPIRE agent configuration
│   └── entries/bootstrap-entries.json ← Sample workload identity entries
│
├── examples/
│   ├── mock-agent/                    ← Demonstrates full auth flow (KAIF client)
│   │   ├── index.ts
│   │   └── package.json
│   │
│   └── mock-service/                  ← Demonstrates JWT validation (without KAIF SDK)
│       ├── index.ts
│       └── package.json
│
└── scripts/
    ├── generate-keys.sh               ← Generate RSA keypair for dev
    ├── setup-spire.sh                 ← Bootstrap SPIRE entries
    └── demo.sh                        ← End-to-end demo script
```

---

## 🔐 Core Concepts

### Trust Model and Tiers

**Trust Tier** — Classification of agent security posture  
**Components:**
- **Trust Score** (0.0–1.0 numeric): Agent behavior, credential freshness, audit integrity, peer reputation
- **Trust Tier Label**: PROVISIONAL, STANDARD, VERIFIED, TRUSTED
- **Privileges**: TTL, max delegation depth, minimum required for operations

| Tier | Score Range | Token TTL | Max Depth | Use Case |
|------|-------------|-----------|-----------|----------|
| PROVISIONAL | 0.00–0.49 | 5 min | 0 | Untrusted agents, sandbox environment |
| STANDARD | 0.50–0.69 | 10 min | 1 | General-purpose agents, limited trust |
| VERIFIED | 0.70–0.89 | 15 min | 2 | Proven agents, can sub-delegate once |
| TRUSTED | 0.90–1.00 | 15 min | 3 | Highest tier, full privileges |

**See:** [wiki.md — Trust Model Concepts](wiki.md#core-concepts)

### Agent Identity (SPIFFE/SPIRE)

**SPIFFE ID** — Workload identifier format: `spiffe://<trust-domain>/ns/<namespace>/agent/<name>`  
**Example:** `spiffe://kindred.systems/ns/adaptive-layer/agent/lyra`

**SVID** (SPIFFE Verifiable Identity Document) — JWT issued by SPIRE, contains:
- SPIFFE ID claim
- Certificate thumbprint (for RFC 8705 mTLS binding)
- Expiry (typically 1 hour)

**ACL (agents.yaml)** — Defines per-agent capabilities:
- `trust_tier_minimum`: Minimum tier to operate
- `permitted_scopes`: Allowed permissions (glob supported, e.g., `vault:read:*`)
- `may_sub_delegate`: Can delegate to other agents?
- `max_delegation_depth`: How deep can sub-delegation go?

**See:** [CLAUDE.md — Phase 6: agents.yaml](CLAUDE.md#phase-6--infrastructure-files)

### Token Exchange (RFC 8693)

**Request Flow:**
1. Agent → Server: JWT-SVID (proof of identity) + Delegation grant (human authority)
2. Server: Validate SVID → Lookup ACL → Check trust tier → Issue KAIF JWT
3. Agent ← Server: Bearer token (RSA-2048 signed)
4. Agent → External Service: Authorization header with token
5. Service: Validate signature against JWKS at `/.well-known/jwks.json`

**KAIF JWT Claims:**
- `iss`: Issuer (KAIF server)
- `sub`: Human principal (email)
- `actor.sub`: Agent SPIFFE ID
- `kaif.trust_score`: Current trust score
- `kaif.delegation_depth`: Depth in chain
- `kaif.principal_chain`: Human emails (audit trail)
- `jti`: Unique ID (for revocation)
- `exp`: Expiration (TTL based on tier)

**See:** [wiki.md — Token Exchange Flow](wiki.md#token-exchange-flow-rfc-8693)

### Audit Chain and Compliance

**SHA-256 Hash-Linked Log:**
- Every authorization event: `DELEGATION_PROVISIONED`, `TOKEN_ISSUED`, `TOKEN_REVOKED`, `AUTH_FAILED`, etc.
- Each entry: `hash = SHA-256(prev_hash | timestamp | action | detail)`
- Genesis entry: `prev_hash = "0".repeat(64)`
- Tamper detection: Any deletion/modification breaks chain

**Stored in Redis:**
- Global: `kaif:audit:global` (all events)
- Per-agent: `kaif:audit:<spiffe_id>` (agent-specific events)
- Broadcast: Pub/Sub channel `kaif:audit` (real-time feed)

**See:** [wiki.md — Audit Log Types](wiki.md#audit-log-types)

### Revocation Model

**Two Mechanisms:**

1. **User-Initiated** — `POST /revoke` with token → JTI added to denylist immediately
2. **Automatic** — Entry expires from Redis when TTL reached (matches token expiry)

**Enforcement:**
- **Strict mode** (`KAIF_STRICT_REVOCATION=true`): Every token use calls `/introspect` (real-time check)
- **Eventual consistency mode** (default): Revocation is advisory (fast, eventual)

**See:** [wiki.md — Revocation Section](wiki.md#revocation)

---

## 📁 Source Code

### KAIF Server Structure

**Core Services** — Located in `packages/server/src/services/`

| Service | File | Purpose | Key Functions |
|---------|------|---------|---|
| **Crypto** | `crypto/keys.ts` | RSA-2048 keypair & JWKS | `getSigningKey()`, `getJWKS()` |
| **JWT** | `crypto/jwt.ts` | Sign & verify KAIF JWTs | `signKAIFToken()`, `verifyJWT()` |
| **SVID** | `services/svid.ts` | SPIFFE SVID validation | `validateSVID()`, `validateSpiffeID()` |
| **Audit** | `services/audit.ts` | Hash-chained audit log | `appendAudit()`, `verifyChain()` |
| **Trust Score** | `services/trust-score.ts` | Score computation & tier resolution | `getTrustScore()`, `resolveTier()` |
| **ACL** | `services/acl.ts` | Agent access control | `validateScopes()`, `assertAuthorised()` |
| **Revocation** | `services/revocation.ts` | JTI denylist via Redis | `revokeToken()`, `isRevoked()` |
| **Token Exchange** | `services/token-exchange.ts` | **RFC 8693 core logic** | `executeTokenExchange()` |

**Routes** — Located in `packages/server/src/routes/`

| Endpoint | Route | Purpose | Compliance |
|----------|-------|---------|-----------|
| Token Exchange | `POST /oauth/token` | Issue KAIF JWT | RFC 8693 |
| Introspection | `POST /introspect` | Check token validity | RFC 7662 |
| Provision | `POST /provision` | Create human delegation grant | KAIF-specific |
| Revoke | `POST /revoke` | Revoke a token | RFC 9110 |
| JWKS | `GET /.well-known/jwks.json` | Public key material | IETF standard |
| Health | `GET /health` | Liveness & readiness | Kubernetes |

**See:** [CLAUDE.md — Phase 3–4](CLAUDE.md#phase-3--routes)

### KAIF Agent SDK

**File:** `packages/sdk/src/client.ts`

**Main Class:** `KAIFClient`

```typescript
new KAIFClient({
  server_url: 'http://kaif-server:8080',
  spiffe_id: 'spiffe://kindred.systems/ns/adaptive-layer/agent/lyra',
  svid_path: '/tmp/svid.jwt',                  // path to JWT file SPIRE writes (not the gRPC socket)
  delegation_token: '<signed-grant-jwt>'       // signed KAIF JWT returned by POST /provision
})

// Core methods:
await client.getToken(scope, audience)           // returns access_token string
await client.authHeader(scope, audience)         // returns "Bearer <token>"
await client.refreshToken(scope, audience)       // force refresh
await client.revoke()                            // revoke all held tokens
```

**Token Cache:**
- Automatic TTL tracking (evict when `now > exp - 60s`)
- Per `(scope, audience)` key
- In-memory only (ephemeral)

**See:** [CLAUDE.md — Phase 5: SDK](CLAUDE.md#phase-5--sdk)

### Example Implementations

**`examples/mock-agent/`** — Demonstrates KAIF client usage
- Loads SVID from SPIRE socket
- Provisions delegation grant via human OIDC token
- Exchanges for KAIF JWT
- Uses token in Authorization header

**`examples/mock-service/`** — Demonstrates JWT validation
- Fetches JWKS from KAIF server
- Validates incoming KAIF JWT
- Extracts claims and makes authorization decision
- Does NOT use SDK; uses `jose` library directly

**See:** [CLAUDE.md — Phase 6: Examples](CLAUDE.md#phase-6--infrastructure-files)

---

## 🧪 Testing & Conformance

### Latest Verification Snapshot

Latest verification status recorded in project review artifacts:

- `pnpm test` passed (server + SDK + conformance packages)
- `pnpm build` passed (`@kaif/server`, `@kaif/sdk`, `@kaif/conformance`)
- `docker compose config` renders successfully

Reference: [review.md](review.md)

### Test Surface Map

| Area | Location | Focus |
|------|----------|-------|
| Server unit tests | `packages/server/tests/` | Crypto, routes, services, auth flow guards |
| Server integration | `packages/server/tests/integration.test.ts` | End-to-end token lifecycle with mock Redis and injected SPIRE/IdP keys |
| SDK tests | `packages/sdk/tests/client.test.ts` | Token cache behavior, refresh/revoke flows |
| Conformance tests | `conformance/fixtures/` + `conformance/tests/` | KAIF Core Profile fixture-based interoperability checks |

### Conformance Fixtures (KAIF-001..KAIF-007)

Conformance suite location: [conformance/README.md](conformance/README.md)

| Fixture | Requirement | Validates |
|---------|-------------|-----------|
| KAIF-001 | MUST | Happy-path token exchange and claims shape |
| KAIF-002 | MUST | Expired `subject_token` returns `invalid_grant` |
| KAIF-003 | MUST | Audience restriction enforcement |
| KAIF-004 | MUST | Revoked JTI is rejected |
| KAIF-005 | SHOULD | CNF thumbprint mismatch handling (advisory) |
| KAIF-006 | MUST | Scope overreach rejected with `invalid_scope` |
| KAIF-007 | MUST | Delegation depth / sub-delegation constraints |

Conformance result semantics:
- `PASS`: fixture behavior matches the Core Profile requirement
- `FAIL`: required behavior not met (MUST failures should fail CI)
- `WARN`: advisory requirement not enforced (SHOULD-level)

---

## 📚 Documentation

### Architecture and Decisions

**File:** [SPEC.md](SPEC.md)  
**Contents:**
- Protocol layers and trust model
- Token exchange flows (happy path + error cases)
- Compliance properties (auditability, revocability, immutability)
- Threat model and security assumptions
- RFC 8693, RFC 8705, RFC 7662 compliance notes

### Security

- **File:** [SECURITY.md](SECURITY.md)
- **Production hardening:** [security/PRODUCTION_ATTESTATION_PROTOCOL_PLAN.md](security/PRODUCTION_ATTESTATION_PROTOCOL_PLAN.md)
- **Governance Redis integration:** [security/GOVERNANCE_REDIS_INTEGRATION.md](security/GOVERNANCE_REDIS_INTEGRATION.md)
- **Gap register:** [security/gaps.md](security/gaps.md)
**Contents:**
- Supported versions
- How to report vulnerabilities
- Response SLA (acknowledge 48h, patch 14 days for critical)
- In-scope / out-of-scope security concerns
- PGP key fingerprint

**Security Rules (Non-Negotiable):**
- Never log token values (log JTI only)
- Never return stack traces in error responses
- All crypto via Node.js built-in or `jose`
- JWT private key never persisted to disk
- Clock skew tolerance exactly 10 seconds
- Scope validation uses exact match or glob, never substring
- Delegation depth must be integer ≥ 0

**See:** [CLAUDE.md — Security Rules](CLAUDE.md#security-rules--non-negotiable)

### Governance and Contributions

**File:** [GOVERNANCE.md](GOVERNANCE.md)  
**Contents:**
- Project roles: Maintainer, Contributor, Adopter
- Decision-making process (consensus for protocol changes)
- RFC process (KAIF-RFC documents in `/rfcs`)
- Versioning scheme (semver + independent protocol version)
- CNCF intent

**File:** [CONTRIBUTING.md](CONTRIBUTING.md)  
**Contents:**
- Development setup (clone, install, test)
- Commit format: Conventional Commits
- PR requirements & security review
- Code style: ESLint + Prettier
- Security-sensitive areas (crypto/, services/)

---

## 🎯 Reference & Checklists

### Wiki — Reference

**File:** [wiki.md](wiki.md)  
**Audience:** Developers, security auditors, integrators

**Sections:**
- [Acronyms & Standards](wiki.md#acronyms--standards) — RFC numbers, SPIFFE, JWT, etc.
- [Core Concepts](wiki.md#core-concepts) — Principal, Actor, Scope, Trust Tier, Audit
- [Data Types & Interfaces](wiki.md#data-types--interfaces) — All TypeScript types
- [Authentication & Authorization](wiki.md#authentication--authorization) — Token flows, revocation
- [File & Directory Conventions](wiki.md#file--directory-conventions) — Source layout
- [Code Style Conventions](wiki.md#code-style-conventions) — Naming, comments, imports
- [Redis Key Prefixes](wiki.md#redis-key-prefixes) — All Redis operations
- [Error Codes](wiki.md#error-codes) — RFC 6749 compliance
- [Conformance & Test Vocabulary](wiki.md#conformance--test-vocabulary) — Fixture IDs, MUST/SHOULD levels, PASS/FAIL/WARN semantics

### Implementation Phases Checklist

Completion status: all phases complete (Phase 0 through Phase 7).

**Phase 0 — Project Scaffold**
- [x] Root `package.json` (pnpm workspaces)
- [x] `tsconfig.base.json`
- [x] `packages/server/package.json` & `packages/sdk/package.json`
- [x] `.env.example` (all required env vars documented)
- [x] `.gitignore`
- [x] `LICENSE` (Apache 2.0)

**Phase 1 — Crypto Foundation** ← _All phases depend on this_
- [x] `packages/server/src/crypto/keys.ts` — `getSigningKey()`, `getJWKS()`
- [x] `packages/server/src/crypto/jwt.ts` — `signKAIFToken()`, `verifyJWT()`
- [x] RFC 8705 thumbprint computation: `sha256:<hex>`
- [x] Tests pass: `100%` coverage on crypto

**Phase 2 — Services**
- [x] `services/audit.ts` — SHA-256 hash chain
- [x] `services/revocation.ts` — JTI denylist
- [x] `services/trust-score.ts` — Score → tier resolution
- [x] `services/svid.ts` — SPIFFE validation
- [x] `services/acl.ts` — Agent permissions
- [x] `services/token-exchange.ts` — **RFC 8693 core**
- [x] Unit tests: 90%+ coverage

**Phase 3–4 — Routes & Server**
- [x] 6 routes: `/oauth/token`, `/introspect`, `/provision`, `/revoke`, `/.well-known/jwks.json`, `/health`
- [x] `server.ts` (Fastify app factory)
- [x] `config.ts` (env + agents.yaml loader)
- [x] Fastify plugins: rate-limit, helmet, request ID
- [x] Graceful shutdown
- [x] All tests pass

**Phase 5 — SDK**
- [x] `KAIFClient` class
- [x] `getToken()`, `authHeader()`, `refreshToken()`, `revoke()`
- [x] Token cache with TTL
- [x] Tests pass

**Phase 6 — Infrastructure**
- [x] `docker-compose.yml` — Redis, SPIRE server, SPIRE agent, KAIF, mock agent
- [x] `spire/server.conf` & `spire/agent.conf`
- [x] `packages/server/config/agents.yaml` (sample agents)
- [x] Stack brings up healthy: `docker compose up`

**Phase 7 — Documentation**
- [x] `README.md` (quick start in 5 min)
- [x] `SPEC.md` (protocol design)
- [x] `SECURITY.md` (vulnerability policy)
- [x] `GOVERNANCE.md` (project roles, RFC process)
- [x] `CONTRIBUTING.md` (dev setup, PR requirements)

**Full Done Criteria:**
- [x] Integration test passes against Docker Compose stack
- [x] `scripts/demo.sh` runs end-to-end
- [x] No TypeScript errors in strict mode
- [x] No ESLint errors
- [x] All documentation files complete

**See:** [CLAUDE.md — Definition of Done](CLAUDE.md#definition-of-done)

### Core Profile Release Gates (Honest Status)

Based on current project notes and [KAIF-Core-Profile-v1.0-Checklist.md](KAIF-Core-Profile-v1.0-Checklist.md):

| Section | Status |
|---|---|
| §1 Protocol Core | Complete |
| §2 Verification Contract | Complete |
| §3 Revocation + SLOs | Partial (formal SLO document alignment pending) |
| §4 Attestation + Identity | Complete |
| §5 Security + Threat Hardening | Complete |
| §6 Open Source Readiness | Complete |
| §7 Conformance + Test Kit | Complete |
| §8 Enterprise Adoption Pack | SHOULD (not blocking v1.0) |
| §9 Acceptance Matrix | Partial (2 of 4 gates remain) |

Open v1.0 external gates:
- [ ] Security review sign-off (structured adversarial review across routes/services)
- [ ] Two independent conforming implementations passing the conformance kit

---

## 📞 How to Use This Index

### I want to...

**...understand the project**
→ Start with [Project Overview](#project-overview)

**...build KAIF**
→ Follow [Build Instructions](CLAUDE.md) (Phase 0–7, in order)

**...integrate KAIF with my agent**
→ See [KAIF Agent SDK](#kaif-agent-sdk) + [examples/mock-agent/](examples/mock-agent)

**...validate incoming KAIF tokens**
→ See [examples/mock-service/](examples/mock-service) + [wiki.md — JWT Claims](wiki.md#jwt-claims)

**...understand naming conventions**
→ Read [wiki.md](wiki.md)

**...review security properties**
→ Read [SPEC.md](SPEC.md) + [SECURITY.md](SECURITY.md)

**...contribute to KAIF**
→ Read [GOVERNANCE.md](GOVERNANCE.md) + [CONTRIBUTING.md](CONTRIBUTING.md)

**...debug a token exchange failure**
→ Check [Error Codes](wiki.md#error-codes) in wiki.md, then [services/token-exchange.ts](packages/server/src/services/token-exchange.ts)

**...run or interpret conformance tests**
→ Start at [conformance/README.md](conformance/README.md), then review [wiki.md — Conformance & Test Vocabulary](wiki.md#conformance--test-vocabulary)

---

## 🗂️ Related Project Checklists

For reference, see also:
- [KAIF-Core-Profile-v1.0-Checklist.md](KAIF-Core-Profile-v1.0-Checklist.md) — Feature completeness
- [KAIF-Key-Compromise-Runbook-v1.md](KAIF-Key-Compromise-Runbook-v1.md) — Incident response
- [KAIF-SLO-Revocation-Introspection-v1.md](KAIF-SLO-Revocation-Introspection-v1.md) — Revocation SLO specs

---

## 📝 Quick Facts

| Aspect | Value |
|--------|-------|
| **Language** | TypeScript 5.x (strict mode) |
| **Runtime** | Node.js 20 LTS |
| **HTTP Server** | Fastify 4.x |
| **Package Manager** | pnpm (workspaces) |
| **Testing** | Vitest |
| **Conformance** | `@kaif/conformance` (KAIF-001..KAIF-007 fixtures) |
| **Protocol Base** | RFC 8693 (Token Exchange) |
| **Workload ID** | SPIFFE/SPIRE |
| **Audit Log** | SHA-256 hash-chained |
| **Persistence** | Redis only |
| **Deployment** | Docker Compose (v1), Kubernetes (future) |
| **License** | Apache 2.0 |

---

## 📅 Document Metadata

| Field | Value |
|-------|-------|
| Last Updated | 2026-05-21 |
| Created For | KAIF Reference Implementation v1.0 |
| Maintainer | KAIF Core Team |
| Status | Implementation Complete; External Release Gates Pending |

---

**For detailed build instructions, see:** [CLAUDE.md](CLAUDE.md)  
**For naming conventions & definitions, see:** [wiki.md](wiki.md)  
**For protocol specification, see:** [SPEC.md](SPEC.md)
