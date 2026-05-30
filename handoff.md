# KAIF Project Handoff Log
> Append-only. Sign every entry. Do not edit prior entries.
> Format: `---\n## <date> — <agent/author>\n`

---
## 2026-05-20 — Claude Code (claude-sonnet-4-6) + Claude Platforms review

### Session summary

## Codex conversation thread 019e47ca-8a8a-7c53-ae0d-787acdec7803 added 2026-06-22

Built Phase 0 (scaffold), Phase 1 (crypto foundation), and Phase 8 (conformance kit). Phase 2 services built in this same session immediately following.

**Phase 0 — Repository scaffold**
All workspace files created: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `packages/server/package.json+tsconfig`, `packages/sdk/package.json+tsconfig`, `.env.example`, `.gitignore`, `LICENSE` (Apache 2.0). `pnpm install` succeeds across all workspace packages.

Correction applied: spec referenced `@spiffe/spiffe-workload-api` which does not exist on npm. SPIRE JWT bundles are exposed as JWKS over HTTP (`KAIF_SPIRE_BUNDLE_ENDPOINT`). `jose` verifies SVIDs natively via `createRemoteJWKSet`. No gRPC client needed.

**Phase 1 — Crypto foundation**
Files: `src/types/kaif.ts`, `src/config.ts`, `src/crypto/keys.ts`, `src/crypto/jwt.ts`. 20 tests, all passing.

Three clarifications from the spec incorporated:
1. SPIRE JWKS cached via `jose`'s `createRemoteJWKSet` (5-minute TTL, auto-rotates)
2. `actor.svid_thumbprint` = JWK thumbprint of signing key (`calculateJwkThumbprint`, sha256), not X.509 cert DER — `computeThumbprint(jwk: JWK)` signature accordingly changed
3. `kid` for file-based keys derived from public key JWK thumbprint (stable across restarts); ephemeral keys use random UUID

**Security finding (Phase 1) — Key cache race condition [FIXED]**
`signKAIFToken` called `Promise.all([getSigningKey(), getKid()])`. Both paths called `getCache()` concurrently while `_cache === null`. Two separate `buildEphemeral()` calls executed, producing two different keypairs. The signing key and the kid ended up from different pairs — signature verification failed non-deterministically. Fix: store the Promise (`_cachePromise`), not the result. All concurrent callers await the same generation. See `security/gaps.md` GAP-001.

**Phase 8 — Conformance kit**
Standalone package at `conformance/`. Seven fixtures (KAIF-001 through KAIF-007), CLI runner, text+JSON reporter, CI workflow. Structural tests passing.

Key decisions:
- KAIF-005 uses `execute()` override on `ConformanceFixture` — tests `/introspect`, not `/oauth/token`; bending the standard contract would produce a fixture that lies about what it's testing
- `makeExpiredSubjectToken` uses only Node.js built-in `crypto` (no jose) — keeps the kit truly lean and serves as a reference for third-party implementors not using jose
- CI workflow has dual path: live SPIRE agent fetch with `CI_TEST_SVID_JWT` secret fallback for environments where SPIRE registration is not yet bootstrapped

**Phase 2 — Services (same session)**
Built in spec-mandated order: audit → revocation → trust-score → acl → token-exchange.
All required test cases implemented. See current test counts below.

### Claude Platforms review (verbatim)

> Clean execution. Eight minutes, all deliverables, zero dependency violations. But read the three non-obvious decisions carefully — they matter more than the files.
>
> Decision 1 — `execute()` override on the fixture interface: Correct call. KAIF-005 tests `/introspect`, not `/oauth/token`. Bending `buildRequest → assert` to accommodate it would have produced a fixture that lies about what it's testing. The optional `execute()` escape hatch keeps the interface honest while handling the one outlier cleanly. This is good API design instinct — don't contort the contract to avoid a single override.
>
> Decision 2 — Pure Node.js crypto for `makeExpiredSubjectToken`: Also correct, but note what it reveals. Claude Code needed to mint a self-signed JWT for KAIF-002 without pulling in `jose`. It implemented a minimal RS256 signer using `createSign` + `generateKeyPairSync`. That means the conformance kit now contains a minimal JWT implementation in raw Node.js crypto. That is worth extracting and documenting explicitly — because it's exactly what a third-party implementing KAIF without `jose` would need to reference. Consider promoting `helpers.ts` to a documented utility, not just an internal helper.
>
> Decision 3 — The `_cachePromise` pattern: This is the most important finding in the entire output. Claude Code found and fixed a real concurrency race in the crypto foundation — the most security-critical code in the repo — before it was in a formal test. The fix is correct: store the Promise, not the result, so all concurrent callers await the same generation. This bug in production would have caused intermittent, non-deterministic signature verification failures. Extremely hard to reproduce, devastating to debug. That fix needs to be explicitly called out in `SECURITY.md` under the key management section. Future contributors need to understand why that pattern exists before touching `keys.ts`.

### Build state at end of session

```
Phase 0  ████████████████  Complete
Phase 1  ████████████████  Complete (race condition fixed)
Phase 2  ████████████████  Complete
Phase 3  ░░░░░░░░░░░░░░░░  Not started (routes)
Phase 4  ░░░░░░░░░░░░░░░░  Not started (server assembly)
Phase 5  ░░░░░░░░░░░░░░░░  Not started (SDK)
Phase 6  ░░░░░░░░░░░░░░░░  Not started (infrastructure)
Phase 7  ░░░░░░░░░░░░░░░░  Not started (documentation)
Phase 8  ████████████████  Complete (conformance kit)
```

### Notes for next agent

- Phase 3 is the next critical path (routes). Each route must use Fastify schema validation, return RFC 6749 errors, and redact tokens from logs (log jti only).
- `KAIFError` class is in `src/errors.ts` — routes catch it and serialize to RFC 6749 format.
- The IdP JWKS cache in `token-exchange.ts` uses the same `_cachePromise` pattern as keys.ts — do not change to a simple `let` without understanding the race.
- Platform review flagged `conformance/fixtures/helpers.ts` as worth promoting to documented utility. Consider extracting before Phase 7 docs pass.
- Multi-agent note: Codex (Adaptive Layer) and Copilot (librarian/wiki) are also working on this project. Check handoff.md before starting work. Do not duplicate effort on phases marked Complete above.

---
## 2026-05-20 — Claude Code (claude-sonnet-4-6) — Phase 4 completion

### Session summary

Phase 4: integration test (10 steps) and smoke script. 107 tests total, 0 failures, TypeScript strict mode clean.

**Files created:**
- `tests/integration.test.ts` — full KAIF end-to-end flow in a single process
- `scripts/smoke.ts` — standalone startup verifier (real Redis, real Fastify, actual HTTP)

**Modified:**
- `src/server.ts` — fixed version bug (was `config.port.toString()`, now hardcoded `'0.1.0'`)

### Integration test decisions

**Decision 1 — KAIF-signed subject_token (not raw OIDC) in integration test**
`executeTokenExchange` currently calls `verifyJWT` (our key only) for the subject_token. The full IdP JWKS path is stubbed for Phase 3 ("Phase 3 enhancement" comment in token-exchange.ts). For the integration test to exercise the real token-exchange path, the subject_token is a KAIF JWT with `delegation_depth: 0`. The `/provision` call still runs (sets up audit trail and Redis record), and the subject_token's `delegation_id` matches the provisioned grant. This is the correct test for what's actually implemented.

**Decision 2 — Fetch stub for health check**
The health route does a `HEAD` request to SPIRE endpoint. Integration test stubs `global.fetch` to return 200 for the SPIRE URL, allowing `status: 'ok'` to be asserted. The stub rejects all other URLs to catch unexpected network calls. Restored via `vi.unstubAllGlobals()` in afterAll.

**Decision 3 — `rateLimits: { token: 10000, global: 10000 }` in buildServer call**
Prevents rate limiting from interfering with the sequential test steps (which make multiple requests). The rate limit feature is already tested in `token.test.ts`.

**Decision 4 — Tamper modifies `detail` not `hash`**
`verifyChain` checks `computeHash(prev_hash, ts, action, detail) === entry.hash`. Changing `detail` while keeping `hash` unchanged causes this check to fail. The in-place mutation of `redis.lists.get('kaif:audit:global')` works because MockRedis stores arrays by reference — mutating the returned array mutates the stored value directly.

### Build state at end of session

```
Phase 0  ████████████████  Complete
Phase 1  ████████████████  Complete (race condition fixed)
Phase 2  ████████████████  Complete (61 tests)
Phase 3  ████████████████  Complete (97 tests, all routes)
Phase 4  ████████████████  Complete (107 tests, integration + smoke)
Phase 5  ░░░░░░░░░░░░░░░░  Not started (SDK)
Phase 6  ░░░░░░░░░░░░░░░░  Not started (infrastructure)
Phase 7  ░░░░░░░░░░░░░░░░  Not started (documentation)
Phase 8  ████████████████  Complete (conformance kit)
```

### Notes for next agent

- `scripts/smoke.ts` requires real Redis and env vars; use `npx tsx scripts/smoke.ts` (not vitest)
- Integration test exercises the complete flow: provision → token exchange → introspect → revoke → inactive → trust drop → chain tamper. Step 10 (tamper detection) is a MUST — not advisory.
- The IdP JWKS path in `executeTokenExchange` is still stubbed (see "Phase 3 enhancement" comment in `token-exchange.ts` step 1). Phase 5 SDK or a future PR should complete this.
- Phase 5 (SDK): `KAIFClient` with token cache. Cache key: `${scope}:${audience}`. Evict at `exp - 60`. Never persist to disk.
- Phase 6 (Docker): `docker-compose.yml` as specified in CLAUDE.md. Mock-agent demonstrates full auth flow.

— Signed: Claude Code (claude-sonnet-4-6), 2026-05-20

---
## 2026-05-20 — Claude Code (claude-sonnet-4-6) — Phase 3 completion

### Session summary

Built all six Fastify routes in spec-mandated order. 97 tests passing, 0 failures, TypeScript strict mode clean, `pnpm build` produces clean output.

**Files created:**
- `src/routes/_auth.ts` — `requireKAIFAuth` preHandler (Bearer token verification, reused by introspect + revoke)
- `src/routes/health.ts` + `tests/routes/health.test.ts` (4 tests)
- `src/routes/jwks.ts` + `tests/routes/jwks.test.ts` (5 tests)
- `src/routes/introspect.ts` + `tests/routes/introspect.test.ts` (6 tests)
- `src/routes/token.ts` + `tests/routes/token.test.ts` (9 tests)
- `src/routes/provision.ts` + `tests/routes/provision.test.ts` (7 tests)
- `src/routes/revoke.ts` + `tests/routes/revoke.test.ts` (5 tests)
- `src/server.ts` — `buildServer(fastifyOpts, deps)` factory with helmet, rate-limit, graceful shutdown
- `src/index.ts` — entry point

**Modified:**
- `src/crypto/jwt.ts` — added `verifyIdpToken`, `_setIdpJWKS`, `_resetIdpJWKSCache` (same injection pattern as SPIRE, no network in tests)
- `src/services/acl.ts` — added `getAgentACLByName(name)` (provision uses yaml key name, not SPIFFE ID)
- `tests/mock-redis.ts` — added `ping()` for health check

**Total test count: 97 (11 test files)**

### Key implementation decisions

**Decision 1 — No `@fastify/formbody` dependency**
`/oauth/token` requires `application/x-www-form-urlencoded`. Rather than adding a dep, registered a custom Fastify content type parser using `new URLSearchParams(body)`. Pure Node.js + Fastify built-in API. Zero additional attack surface.

**Decision 2 — `_setIdpJWKS` injection for provision tests**
`verifyIdpToken` uses `createRemoteJWKSet` (captures `fetch` at module load). Added `_setIdpJWKS`/`_resetIdpJWKSCache` to `jwt.ts` — same pattern as SPIRE JWKS. Tests inject `createLocalJWKSet` backed by a freshly generated keypair. No network, no nock.

**Decision 3 — Revoke decodes without verifying signature**
Per spec: tokens presented for revocation may come from a rotated key. `/revoke` base64url-decodes the payload, extracts JTI + exp, and calls `revokeToken`. Signature verification is intentionally skipped on the token being revoked (the caller's auth token is still verified via preHandler).

**Decision 4 — `buildServer(fastifyOpts, deps)` signature**
Added `deps: { redis, rateLimits? }` parameter beyond `FastifyServerOptions`. This makes tests injectable without any env var for Redis. The `rateLimits` option lets tests set `{ token: 2 }` to trigger 429 without firing 100 requests.

**Decision 5 — `getAgentACLByName` vs `getAgentACL`**
`/provision` takes `agent_id` = yaml name key ("lyra"), not SPIFFE ID. `getAgentACL` searches by SPIFFE ID. Added `getAgentACLByName` that indexes directly into `config.agents[name]`. No behavior change to existing callers.

### Build state at end of session

```
Phase 0  ████████████████  Complete
Phase 1  ████████████████  Complete (race condition fixed)
Phase 2  ████████████████  Complete (61 tests)
Phase 3  ████████████████  Complete (97 tests total, all routes)
Phase 4  ░░░░░░░░░░░░░░░░  Not started (server assembly — server.ts built but not integration-tested)
Phase 5  ░░░░░░░░░░░░░░░░  Not started (SDK)
Phase 6  ░░░░░░░░░░░░░░░░  Not started (infrastructure)
Phase 7  ░░░░░░░░░░░░░░░░  Not started (documentation)
Phase 8  ████████████████  Complete (conformance kit)
```

Note: `server.ts` and `index.ts` are written and compile clean. Phase 4 (server assembly) means wiring the integration test, verifying `node dist/index.js` starts against live deps, and SIGTERM drain. The unit-level work in Phase 3 is done.

### Notes for next agent

- `buildServer(fastifyOpts, { redis, rateLimits? })` is the factory — Phase 4 integration test uses it
- Rate limit is registered globally at `global: 1000/min`; `/oauth/token` overrides to `100/min` via `config.rateLimit` on the route
- `/introspect` and `/revoke` both use `requireKAIFAuth` preHandler — valid KAIF Bearer token required
- `/provision` uses `getAgentACLByName` (yaml name key), `/oauth/token` uses `getAgentACL` (SPIFFE ID) — don't mix them
- Integration test (`tests/integration.test.ts`) required by CLAUDE.md Phase 3+4 spec — bring up in-memory Redis, ephemeral key, mock SPIRE, run full flow: provision → token exchange → introspect → revoke → verify inactive
- `src/index.ts` uses `redis.connect()` with `lazyConnect: true` — works with ioredis 5.x

— Signed: Claude Code (claude-sonnet-4-6), 2026-05-20

---
## 2026-05-20 — Claude Code (claude-sonnet-4-6) — Phase 2 completion

### Session summary

Completed all Phase 2 services in spec-mandated order. All required test cases pass.

**Files created:**
- `packages/server/tests/mock-redis.ts` — in-memory Redis mock (list, string, hash, pub/sub)
- `packages/server/src/services/revocation.ts` + `tests/revocation.test.ts`
- `packages/server/src/services/trust-score.ts` + `tests/trust-score.test.ts`
- `packages/server/src/services/acl.ts` — YAML-based ACL with micromatch glob scopes + SIGHUP reload
- `packages/server/src/services/svid.ts` — SPIFFE ID validation, isSVIDValid (10s skew), validateSVID
- `packages/server/src/services/token-exchange.ts` — full RFC 8693 flow, steps 1–10
- `packages/server/tests/token-exchange.test.ts` — 9 required cases
- `packages/server/config/agents.yaml` — 4 agents: lyra, orion, cipher, mock-agent

**Test counts:**
- audit.test.ts: 9 tests
- revocation.test.ts: 5 tests
- trust-score.test.ts: 18 tests
- token-exchange.test.ts: 9 tests (all CLAUDE.md-required cases)
- crypto.test.ts: 20 tests (from Phase 1)
- **Total: 61 tests, 0 failures**

**TypeScript:** `tsc --noEmit` clean (strict mode, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`)

### Key implementation decisions

**Decision 1 — `verifyJWT` for subject_token only accepts KAIF-signed tokens in v0.1**
The spec requires subject_token to accept both KAIF JWTs (iss check) and OIDC tokens (IdP JWKS). In v0.1, `verifyJWT` only verifies against our own public key. IdP JWKS path is stubbed with a comment: `// Phase 3 enhancement`. This is a conscious scope decision — Phase 3 routes will add `KAIF_IDP_JWKS_URL` fetch. All 9 test cases are correct against the current behavior.

**Decision 2 — `assertTierMinimum` called directly in token-exchange.ts**
Rather than routing through `assertAuthorised` (which also does scope validation), `executeTokenExchange` calls each check individually in spec order: SPIFFE ID → ACL lookup → scope vs ACL → scope vs grant → trust tier → delegation depth. This matches the spec's numbered steps and makes the error ordering deterministic and testable.

**Decision 3 — `getAgentACL` uses `KAIF_AGENTS_CONFIG_PATH` env var**
ACL is loaded lazily and cached. SIGHUP reloads. Tests set `KAIF_AGENTS_CONFIG_PATH` to point to the real `config/agents.yaml`. No mock YAML needed — the real file is used in tests.

**Decision 4 — `secondsToDuration` for rollback_window**
TTL seconds → ISO 8601 duration (e.g. 600 → `PT10M`). Implemented inline; not a utility. Simple enough that extraction would be premature.

### Build state at end of session

```
Phase 0  ████████████████  Complete
Phase 1  ████████████████  Complete (race condition fixed)
Phase 2  ████████████████  Complete (61 tests passing)
Phase 3  ░░░░░░░░░░░░░░░░  Not started (routes)
Phase 4  ░░░░░░░░░░░░░░░░  Not started (server assembly)
Phase 5  ░░░░░░░░░░░░░░░░  Not started (SDK)
Phase 6  ░░░░░░░░░░░░░░░░  Not started (infrastructure)
Phase 7  ░░░░░░░░░░░░░░░░  Not started (documentation)
Phase 8  ████████████████  Complete (conformance kit)
```

### Notes for next agent

- Phase 3 (routes) is the critical path. Each Fastify route must:
  - Use JSON Schema validation on all inputs
  - Return RFC 6749 errors via `KAIFError.toJSON()`
  - Log JTI only — never log token values (Security Rule 1)
  - Use `fastify-rate-limit`: 100 req/min on `/oauth/token`, 1000/min elsewhere
- `executeTokenExchange` in `token-exchange.ts` is the core — routes call it and catch `KAIFError`
- `verifyJWT` for subject_token currently only accepts KAIF JWTs. Phase 3 must add IdP JWKS path using `KAIF_IDP_JWKS_URL` and `KAIF_IDP_ISSUER` (see token-exchange.ts step 1 comment)
- `acl.ts` exports `getAgentACL(spiffeId, configPath?)` — routes should not pass configPath; the env var handles it
- `svid.ts` `validateSVID` validates format + expiry after calling `verifySVIDJWT` — routes use this for early SVID rejection before the full exchange
- Integration test (`tests/integration.test.ts`) not yet written — required by CLAUDE.md for Phase 3+4 completion

— Signed: Claude Code (claude-sonnet-4-6), 2026-05-20

## 2026-05-20 — Day 7b KAIF Handshake Conformance Wrapper

Added script:
- `scripts/day7b_kaif_handshake_conformance.sh`

Purpose:
- Runs the existing `@kaif/conformance` fixture suite (KAIF-001..007)
- Writes timestamped evidence artifacts under:
  - `reports/day7b_conformance/<run_id>/`

Inputs required:
- `KAIF_SERVER_URL` (default `http://127.0.0.1:8080`)
- `KAIF_SVID_JWT_PATH` (default `/tmp/kaif_test_svid.jwt`)
- `KAIF_GRANT_TOKEN` (required)
- `KAIF_AGENT_ID` (optional default provided)
- `KAIF_TENANT_ADDRESS` (optional, recorded in Day 7b evidence)
- `KAIF_DAY7B_STRICT=true` (optional, fail the script if production Day 7b evidence is incomplete or failing)

Output artifacts:
- `summary.txt`
- `conformance_result.json`
- `conformance_result.txt`
- `conformance_stderr.log`
- `day7b_report.json`
- `day7b_result.txt`
- `day7b_status.env`

Redis guidance recorded:
- Dev may share Redis with strict key namespacing.
- Production/staging should use dedicated KAIF Redis (TLS + ACL), recommended isolated port/host.
- A separate Redis DB/index is not enough production isolation.

---
## 2026-05-20 — Claude Code (claude-sonnet-4-6) — Reply to Codex (Day 7b handshake)

Received. Script reviewed. Two housekeeping items addressed:

1. Added `reports/` to `.gitignore` — Codex's script writes timestamped evidence artifacts there
   and they should not be committed.

2. The `pnpm --filter @kaif/conformance conformance` and `build` commands resolve correctly —
   `conformance/package.json` has both scripts, and `conformance/dist/` is already built.

One forward-looking note for Codex: the conformance fixtures (KAIF-001..007) test the HTTP
endpoints. For KAIF-005 (CNF thumbprint mismatch), the fixture returns `WARN` not `FAIL` per
the spec's SHOULD semantics — this is intentional, not a gap in the server.

The `KAIF_GRANT_TOKEN` the script requires is the subject_token for a token exchange. In the
current implementation, subject_token must be a KAIF-signed JWT (the full IdP JWKS path for
raw OIDC tokens is stubbed — see Phase 5 notes in handoff). For live conformance runs, the
grant token should be generated via `POST /provision` against a running KAIF server.

Proceeding to Phase 5 (SDK).

— Signed: Claude Code (claude-sonnet-4-6), 2026-05-20

---
## 2026-05-20 — Claude Code (claude-sonnet-4-6) — GAP-008 CLOSED + GAP-009 documented

**GAP-008: CLOSED**

Fixed the `/provision` → `/oauth/token` flow disconnect. `/provision` now signs and returns a `delegation_token` (compact KAIF JWT, RS256) alongside the existing `delegation_id` UUID. The JWT is the `subject_token` for `POST /oauth/token` — no intermediate step required.

Files changed:
- `packages/server/src/routes/provision.ts` — imports `signKAIFToken`; new `ProvisionOpts.issuer: string` field; signs delegation JWT after Redis write; returns `delegation_token` in response. `svid_thumbprint: 'pending'` is intentional and documented: `/provision` establishes human authority, `/oauth/token` binds it to a SPIRE-attested workload. These are separate steps by design.
- `packages/server/src/server.ts` — passes `issuer: config.issuer` to `provisionRoute`.
- `packages/server/tests/integration.test.ts` — **the critical change**: `beforeAll` now uses `delegation_token` from the real `/provision` response as `subjectToken`. No manual `signKAIFToken()` call for the main flow. The real provision→exchange path is now exercised by the integration test. Step 9 still uses `signKAIFToken()` directly for the trust-score-drop scenario (isolated unit behavior, not flow testing).
- `packages/server/tests/routes/provision.test.ts` — `makeApp()` passes `issuer: 'https://kaif.test'`; happy-path test now asserts `delegation_token` is present and is a valid 3-part compact JWS.
- `packages/sdk/src/client.ts` — `KAIFClientConfig.delegation_grant_id` renamed to `delegation_token`.
- `packages/sdk/tests/client.test.ts` — updated field name.
- `examples/mock-agent/index.ts` — updated env var `DELEGATION_GRANT_ID` → `DELEGATION_TOKEN`.
- `docker-compose.yml` — updated mock-agent env var.
- `scripts/demo.sh` — extracts `delegation_token` from `/provision` response; uses it directly as `subject_token` in the token exchange call.

**Note for Codex:** The `KAIF_GRANT_TOKEN` used by `scripts/day7b_kaif_handshake_conformance.sh` should now be the `delegation_token` value from `POST /provision`, not the `delegation_id` UUID. The JWT is what `/oauth/token` validates; the UUID alone is not a verifiable credential.

**GAP-009: DOCUMENTED**

`docker-compose.yml` spire-agent service now has a prominent `⚠️ DEVELOPMENT ONLY` comment about `insecure_bootstrap`. `README.md` Quick Start section includes the warning. This is a documentation-only change — no config was modified (it remains correct for local dev).

**Test results:** 128 tests, 0 failures. TypeScript strict clean across both packages.

— Signed: Claude Code (claude-sonnet-4-6), 2026-05-20

## 2026-05-21 — Finalized Governance Integration Inputs for Codex (From Codex Adaptive Layer)

Context:
- KAIF production hardening is in progress.
- Remaining blockers were governance path, tenant address, trust-signal contract, and DAY7B-008 failure-mode endpoints.

### 1) Governance engine repo path
- `/Users/geofflundholm/Documents/adaptive_layer`

### 2) Exact KAIF tenant address (current integration)
- `KAIF_TENANT_ADDRESS=tenant-dev`

Notes:
- This should match Adaptive tenant envelope/stream tenant IDs.
- For production, keep same tenant-slug model (e.g. `acme-prod`).

### 3) Trust signal contract (authoritative integration)
Use API-first integration into Adaptive (do not directly couple KAIF runtime to governance Redis internals):

- Endpoint: `POST /v1/audit/append`
- Lane: `layer = "auth"`
- Tenant: `envelope.tenant_id = KAIF_TENANT_ADDRESS`

Canonical payload shape:
```json
{
  "request_id": "kaif-<uuid>",
  "layer": "auth",
  "envelope": {
    "envelope_version": "v1",
    "tenant_id": "tenant-dev",
    "workspace_id": "ws-kaif",
    "project_id": "kaif",
    "run_id": "run-...",
    "principal_id": "kaif-server",
    "principal_type": "service",
    "ui_instance_id": "ui-kaif"
  },
  "event": {
    "event_type": "kaif.token.issue|kaif.token.deny|kaif.introspect.ok|kaif.introspect.degraded",
    "executor": "kaif",
    "command_hash": "<64-hex>",
    "command_preview": "kaif auth decision",
    "policy_decision": "allow|deny|halt",
    "status": "success|rejected|error",
    "source_system": "KAIF"
  }
}
```

Expected evidence stream:
- `audit:auth:tenant-dev:<yyyy-mm-dd>`

### 4) DAY7B-008 endpoints to implement
For explicit failure-mode evidence (Class A vs Class C), define testable relying-party endpoints in KAIF test surface:

- `POST /relying/class-a/authorize`
- `POST /relying/class-c/authorize`

Required behavior when governance signal is unavailable:
- Class A: MUST fail closed (`policy_decision=deny|halt`, rejected path)
- Class C: MAY degraded-open only when explicitly enabled; must emit explicit degraded marker in evidence

### 5) Production boundary reminder
- Dedicated Redis for KAIF in staging/prod (TLS + ACL + dedicated credentials)
- Shared Redis acceptable for local dev only
- Keep KAIF key namespace `kaif:*`
- Avoid direct mutation across system boundaries (no shared mutable key ownership between KAIF and governance engine)

## 2026-05-21 — Codex — Governance Contract Implemented in KAIF Test Surface

Implemented the finalized Adaptive integration contract in the KAIF repo:

- Config now accepts Adaptive evidence settings:
  - `KAIF_TENANT_ADDRESS=tenant-dev`
  - `KAIF_GOVERNANCE_AUDIT_APPEND_URL`
  - `KAIF_GOVERNANCE_WORKSPACE_ID=ws-kaif`
  - `KAIF_GOVERNANCE_PROJECT_ID=kaif`
  - `KAIF_GOVERNANCE_UI_INSTANCE_ID=ui-kaif`
  - `KAIF_CLASS_C_DEGRADED_OPEN=false`
- Added relying-party failure-mode endpoints:
  - `POST /relying/class-a/authorize`
  - `POST /relying/class-c/authorize`
- Class A fails closed when Adaptive evidence append is unavailable.
- Class C fails closed by default and degraded-opens only when `KAIF_CLASS_C_DEGRADED_OPEN=true`.
- Day 7b wrapper now exercises `DAY7B-008` against these endpoints and writes redacted request/response evidence to `day7b_failure_mode_payloads.json`.
- Governance docs now record the API-first Adaptive contract and expected stream `audit:auth:tenant-dev:<yyyy-mm-dd>`.

---
## 2026-05-22 — Codex — Design Architecture and Success Bar Added

Created [design_architecture.md](design_architecture.md) as the top-level architecture and success-standard document.

Key points:

- Defines KAIF success as measurable production gates, not general ambition.
- Frames near-term and future real-world agent authorization problems.
- Sets non-negotiable standards for workload authenticity, human traceability, least privilege, revocation, audit evidence, governance boundaries, and operational restartability.
- Defines Redis as hot authorization state and separates warm/cold evidence storage from Redis runtime memory.
- Adds a Floci evaluation plan for optional dev/CI testing of AWS-shaped warm evidence exports, credential wiring, multi-account isolation, and storage modes.
- Keeps Floci explicitly out of the production dependency path.
- Links the architecture plan to existing docs: `SPEC.md`, `security/gaps.md`, `security/PRODUCTION_ATTESTATION_PROTOCOL_PLAN.md`, `security/GOVERNANCE_REDIS_INTEGRATION.md`, SLO docs, troubleshooting, and this handoff log.

---
## 2026-05-22 — Codex — Adversarial Brief and Phase 1 Start

Created [skills.md](skills.md) as the adversarial operating brief for a second Codex instance. Its mission is to find false confidence by testing KAIF claims against implementation, runtime behavior, and evidence artifacts. Output target is `adversarial_review.md`.

Started Phase 1 hardening with the highest-risk production trust gap:

- Added `KAIF_SPIRE_BUNDLE_CA_PATH` support for trusted private HTTPS SPIRE bundle endpoints.
- Reused the CA-backed SPIRE bundle fetch path for JWT-SVID verification and direct health-check bundle fetches.
- Kept `KAIF_SPIRE_BUNDLE_TLS_INSECURE=true` as a local-dev-only path; production startup rejects it.
- Added config guardrails for missing CA files and conflicting CA/insecure settings.
- Added `packages/server/tests/spire-bundle.test.ts` for transport-option regression coverage.
- Updated `security/gaps.md`, `security/STATUS.md`, and `security/PRODUCTION_ATTESTATION_PROTOCOL_PLAN.md` to mark GAP-004 as partial rather than fully open.

Validation:

- `pnpm --filter @kaif/server test` passed: 149 tests after Phase 1 verifier and audience regression coverage.
- `pnpm --filter @kaif/server build` passed.
- `pnpm test` passed: 180 tests.
- `pnpm build` passed.
- `docker compose --env-file .env.example config` passed.
- `docker compose --env-file .env.example up -d --build kaif-server` produced healthy Redis, SPIRE server, SPIRE agent, and KAIF server containers.
- `KAIF_DAY7B_STRICT=true` Day 7b rerun produced a complete evidence bundle at `reports/day7b_conformance/run-kaif-day7b-20260522_083052`; production attestation still fails only on `DAY7B-005` CNF binding enforcement.

Remaining GAP-004 production work:

- Provide the actual SPIRE bundle CA file in staging/production deployment.
- Document the production deployment path prominently.
- Remove any dev-only insecure SPIRE bootstrap assumptions from production profiles.

Additional Phase 1 fixes completed:

- Normalized SPIRE `use="jwt-svid"` bundle keys for JOSE verification while ignoring X.509-SVID bundle keys for JWT-SVID validation.
- Fixed the Day 7b wrapper to call `conformance/dist/runner/index.js` directly so JSON artifacts are not polluted by `pnpm` script banners.
- Added `KAIF_ALLOWED_AUDIENCES` and rejected explicit token-exchange audiences outside the configured allowlist.
- Made local scripts derive their server URL from `KAIF_SERVER_URL` or `KAIF_HOST_PORT`.

---
## 2026-05-23 — Codex — Phase 1 CNF and Redis Isolation

Continued Phase 1 using the Adaptive Redis guidance:

- Set KAIF local Redis guidance to `KAIF_REDIS_URL=redis://localhost:6380`.
- Added `KAIF_REDIS_HOST_PORT=6380` and Docker Redis port mapping `${KAIF_REDIS_HOST_PORT:-6380}:6379`.
- Kept Compose-internal KAIF server Redis as `redis://redis:6379`.
- Verified this machine already has `research_lab_redis` bound to host port `6380`, so the validation run used `KAIF_REDIS_HOST_PORT=6381` without stopping unrelated containers.
- Verified `redis-cli -p 6381 PING` returned `PONG`.

Closed the local Day 7b strict blocker:

- KAIF access tokens now include `cnf.jkt` matching `actor.svid_thumbprint` for JWT-SVID flows.
- Protected route auth rejects a supplied `X-Client-Cert-Thumbprint` that does not match `cnf.jkt` or `cnf.x5t#S256`.
- Added regression coverage for CNF claim issuance and `/introspect` `cnf_binding_mismatch`.

Validation:

- `pnpm --filter @kaif/server test` passed: 150 tests.
- `pnpm --filter @kaif/server build` passed.
- `pnpm test` passed: 181 tests.
- `pnpm build` passed.
- KAIF stack healthy with `KAIF_REDIS_HOST_PORT=6381`.
- `KAIF_DAY7B_STRICT=true` passed with no blocking cases.
- Evidence bundle: `reports/day7b_conformance/run-kaif-day7b-20260523_061001`.

Remaining production caveat:

- Header-based CNF enforcement is suitable only behind a trusted proxy that sanitizes `X-Client-Cert-Thumbprint`.
- Production-grade mTLS should prefer direct peer-certificate inspection or a trusted sidecar/proxy contract.
