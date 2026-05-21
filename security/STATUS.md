# KAIF Security Status
> Current security posture of the KAIF reference implementation.
> Updated each session. See `gaps.md` for open issues.

---

## Overall status: 🟡 IMPLEMENTATION COMPLETE — NOT PRODUCTION READY

All 8 phases of the reference implementation are built and tested (128 tests, 0 failures, TypeScript strict clean). Two known gaps block a real end-to-end flow (GAP-008) and production deployment (GAP-009). Two external release gates remain open (security review sign-off, second independent conforming implementation).

---

## Security review by component

### Crypto foundation (`src/crypto/`) — 🟢 REVIEWED
- RSA-2048 with RS256 for JWT signing — compliant
- `kid` derived from JWK thumbprint for file-based keys (stable, deterministic) — compliant
- Ephemeral keys use random UUID for kid — acceptable for dev/test
- `_cachePromise` pattern prevents key-generation race — **fixed GAP-001**
- SPIRE JWKS cached at 5-minute TTL via `jose`'s `createRemoteJWKSet` — compliant
- `actor.svid_thumbprint` uses JWK thumbprint (sha256) — correct per Clarification 2
- Private key never leaves process memory — compliant with Security Rule 4
- No third-party crypto primitives — compliant with Security Rule 3

**Open:** GAP-004 (HTTP vs HTTPS for SPIRE bundle in dev)

---

### Audit log (`src/services/audit.ts`) — 🟡 PARTIAL
- SHA-256 hash chain correctly implemented per spec
- Genesis entry uses `"0".repeat(64)` — compliant
- Writes to both per-agent and global Redis lists — compliant
- Publishes to `kaif:audit` channel — compliant
- All required test cases pass (100% of spec-mandated cases)
- Redis key prefix `kaif:audit:` — compliant with Security Rule 5

**Open:** GAP-002 (non-atomic append), GAP-003 (per-agent chain not independently verifiable)

---

### Revocation (`src/services/revocation.ts`) — 🟢 REVIEWED
- JTI denylist via Redis SET with TTL matching token expiry — compliant with Security Rule 6
- `isRevoked` is O(1) Redis GET — compliant
- TTL computed as `token_exp - now_unix` — correct
- Revocation events published to `kaif:revocation` channel — compliant
- All required test cases pass

---

### Trust scoring (`src/services/trust-score.ts`) — 🟢 REVIEWED
- Score clamped to [0.0, 1.0] — compliant
- Default score 0.5 (STANDARD) for unknown agents — compliant
- Tier resolution covers all boundary values — tested
- `assertTierMinimum` throws `KAIFError('insufficient_trust')` — compliant
- All required test cases pass

---

### ACL enforcement (`src/services/acl.ts`) — 🟡 PARTIAL
- Glob matching via `micromatch` — correct for `:` separator scopes
- `validateScopes` returns denied scope list — compliant
- `loadACL` caches with SIGHUP reload — compliant
- `assertAuthorised` throws `KAIFError` on any failure — compliant
- SPIFFE ID format validation mandatory before ACL lookup — compliant

**Open:** GAP-006 (micromatch path separator edge case with `/` scopes)

---

### Token exchange (`src/services/token-exchange.ts`) — 🟡 PARTIAL
- Full RFC 8693 flow implemented in spec-mandated order (steps 1–10)
- Subject token: KAIF JWTs accepted; OIDC/IdP path stubbed for Phase 3
- Delegation depth checked against ACL `max_delegation_depth`
- Principal chain correctly maintained (deduplication of human principal)
- TTL resolved from trust tier (min of tier TTL and ACL delegation_ttl_seconds)
- All required test cases pass (9/9 specified cases)
- `secondsToDuration` converts TTL to ISO 8601 rollback_window

**Open:** IdP JWKS subject_token path not yet implemented (see Phase 3 comment in token-exchange.ts)
**Pending (Phase 3):** Route-level rate limiting, `X-Request-ID` propagation, Fastify schema validation, token value redaction in logs

---

### Routes (Phase 3) — 🟢 REVIEWED
- `GET /health` — Redis ping + SPIRE HEAD, always 200, never 5xx
- `GET /.well-known/jwks.json` — public keys, Cache-Control: max-age=3600, private fields absent
- `POST /introspect` — verifies sig + exp + JTI denylist; allows self-introspection or `audit:read`
- `POST /oauth/token` — urlencoded body, calls `executeTokenExchange`, logs JTI only (Security Rule 1)
- `POST /provision` — IdP token verification via injected JWKS, writes DelegationGrant with TTL
- `POST /revoke` — decodes target without sig verify; allows self-revocation or `admin:revoke`
- Rate limiting: 100/min on `/oauth/token`, 1000/min global (via `@fastify/rate-limit`)
- `@fastify/helmet` — security headers on all routes
- `requireKAIFAuth` — shared preHandler rejects invalid, expired, or revoked bearer tokens
- Pino redaction: `body.subject_token`, `body.actor_token`, `headers.authorization`, `body.token`, `body.id_token`
- 42 route tests passing (health:4, jwks:5, introspect:9, token:9, provision:7, revoke:8)

**Resolved:** GAP-005 (rate limiting now implemented)

---

### Documentation (Phase 7) — 🟢 REVIEWED
- `README.md` — Quick Start, architecture diagram, token format, 6-step verification, full config tables, SDK snippet
- `SPEC.md` — RFC 2119 language throughout; normative sections 3–9; cnf/jkt statement verbatim in §7
- `SECURITY.md` — vulnerability reporting, SLA, `_cachePromise` key management note (GAP-001 reference)
- `GOVERNANCE.md` — roles, RFC process, versioning, CNCF intent
- `CONTRIBUTING.md` — dev setup, commit format, PR requirements, security-sensitive files

**Resolved:** GAP-007 (SECURITY.md now complete)

---

### Server assembly (Phase 4) — 🟢 REVIEWED
- `buildServer(fastifyOpts, deps)` factory — injectable Redis + rate limits
- Helmet security headers registered globally
- Rate limiting: 100/min token endpoint, 1000/min global (`@fastify/rate-limit`)
- Pino logger with redaction: `body.subject_token`, `body.actor_token`, `headers.authorization`, `body.token`, `body.id_token`
- X-Request-ID: generated from header or random UUID, echoed in response
- SIGTERM/SIGINT graceful shutdown: drains requests, closes Redis, logs SHUTDOWN_COMPLETE
- Integration test (10 steps) exercises full flow: provision → exchange → introspect → revoke → trust-drop → chain tamper
- `scripts/smoke.ts` verifies startup against real Redis

---

### SDK (Phase 5) — 🟢 REVIEWED
- `KAIFClient` with `getToken`, `refreshToken`, `authHeader`, `revoke`
- `TokenCache` — evicts at `exp - 60s`, in-memory only, per `(scope, audience)` key
- `readSVID()` re-reads from disk per exchange — correct for SPIRE rotation
- `revoke()` uses `Promise.allSettled` — one failure does not block cache clear
- `delegation_token` field holds the signed JWT subject_token
- 21 tests passing

**Resolved:** GAP-008 — `/provision` returns a signed `delegation_token`.

---

### Infrastructure (Phase 6) — 🟢 REVIEWED
- `docker-compose.yml` — full stack with proper `service_healthy` dependency chain
- `packages/server/Dockerfile` — multi-stage builder/runtime, alpine base
- `spire/server.conf` — bundle endpoint on 8081, Unix socket API
- `spire/agent.conf` — Unix workload attestor, `insecure_bootstrap = true` (dev only)
- `scripts/setup-spire.sh` — join token generation + 4 workload entry registrations
- `scripts/demo.sh` — end-to-end demo with `KAIF_DEV_MODE=true`, signed `delegation_token`, and SPIRE CLI SVID fetch
- `examples/mock-agent/` — SDK usage demonstration
- `examples/mock-service/` — relying party JWT validation via jose

**Open:** GAP-009 — `insecure_bootstrap = true` in agent.conf (dev only; production requires trust bundle)
**Tracked:** Production hardening plan lives in `security/PRODUCTION_ATTESTATION_PROTOCOL_PLAN.md`.

---

## Security rules compliance (from CLAUDE.md)

| Rule | Status | Notes |
|------|--------|-------|
| 1. Never log token values — log JTI only | 🟢 Done | Pino redacts `body.subject_token`, `body.actor_token`, `headers.authorization`, `body.token`, `body.id_token` |
| 2. Never return stack traces | 🟢 Done | `KAIFError` returns only `error`/`error_description`; routes return RFC 6749 JSON |
| 3. All crypto via Node.js built-in or `jose` | 🟢 Done | No third-party crypto primitives |
| 4. JWT private key never leaves process memory | 🟢 Done | Not written to logs/responses/Redis |
| 5. All Redis keys use `kaif:` prefixes | 🟢 Done | Enforced in all service files |
| 6. Redis denylist TTL must match token exp | 🟢 Done | `max(token_exp - now, 1)` seconds |
| 7. SPIFFE ID format validation mandatory | 🟢 Done | `validateSpiffeID` in `svid.ts` before any ACL lookup |
| 8. Clock skew tolerance exactly 10 seconds | 🟢 Done | `CLOCK_SKEW_SECONDS = 10` constant in `svid.ts`; not configurable |
| 9. Scope validation exact match or glob | 🟢 Done | `micromatch.isMatch`; `:` separator; substring match structurally impossible |
| 10. `delegation_depth` must be integer ≥ 0 | 🟢 Done | `Math.floor` + `>= 0` check in `token-exchange.ts` |

---

### SVID validation (`src/services/svid.ts`) — 🟢 REVIEWED
- SPIFFE ID format validated: `spiffe://<domain>/<path>` regex
- `isSVIDValid` enforces 10-second clock skew tolerance (Security Rule 8)
- `validateSVID` calls `verifySVIDJWT` then validates format and expiry

### ACL enforcement (`src/services/acl.ts`) — 🟡 PARTIAL (updated)
- Glob matching via `micromatch` — correct for `:` separator scopes
- `validateScopes` returns denied scope list — compliant
- `loadACL` caches with SIGHUP reload — compliant
- `assertAuthorised` throws `KAIFError` on any failure — compliant
- SPIFFE ID format validation mandatory before ACL lookup — compliant

**Open:** GAP-006 (micromatch path separator edge case with `/` scopes)

---

## Open gaps summary

| GAP | Severity | Affects | Status |
|-----|----------|---------|--------|
| GAP-002 | Medium | `audit.ts` — non-atomic append | Open — v0.2 |
| GAP-003 | Low | `audit.ts` — per-agent chain not independently verifiable | Open — v0.2 |
| GAP-004 | High (prod) | SPIRE bundle over HTTP in dev config | Open — deployment guide |
| GAP-006 | Low | `acl.ts` — micromatch with `/` separator scopes | Open — monitoring |
| GAP-008 | High | `/provision` → `/oauth/token` flow broken (UUID vs JWT) | **CLOSED 2026-05-20** |
| GAP-009 | High (prod) | `insecure_bootstrap` in SPIRE agent config | Documented (compose + README) |

*Last updated: 2026-05-20 by Claude Code (claude-sonnet-4-6) — All phases complete*
