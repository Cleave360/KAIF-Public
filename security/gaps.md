# KAIF Security Gaps Register
> This file tracks known security gaps, risks, and issues.
> Each entry is assigned a GAP-NNN ID. Resolved entries are marked CLOSED.
> Cross-reference with handoff.md for context.

---

## GAP-001 — Key cache race condition in `keys.ts`
**Status:** CLOSED (fixed 2026-05-20)  
**Severity:** High  
**File:** `packages/server/src/crypto/keys.ts`

**Description:**  
`signKAIFToken` called `Promise.all([getSigningKey(), getKid()])`. Both code paths invoked `getCache()` concurrently while the module-level `_cache` variable was `null`. Two separate `buildEphemeral()` calls executed in parallel, each generating a different RSA-2048 keypair. The signing key and the kid stored in the cache came from different keypairs. Any token signed in this state could not be verified — and the failure was non-deterministic (depended on microtask scheduling).

**Impact in production:**  
Intermittent signature verification failures for the first token exchange after server startup or key cache reset. Extremely hard to reproduce; catastrophic to debug under load.

**Fix:**  
Changed `_cache: KeyCache | null` to `_cachePromise: Promise<KeyCache> | null`. All concurrent `getCache()` callers await the same promise. The promise is nulled on error to allow retry. This is the standard "promise-cache" pattern for async singletons.

**Action required for future contributors:**  
Do not revert to a simple `let _cache` without understanding this race. Any modification to `keys.ts` must be reviewed with this pattern in mind. See `SECURITY.md` key management section.

---

## GAP-002 — `appendAudit` is not atomic under concurrent writes
**Status:** CLOSED for global audit chain (fixed 2026-05-21)  
**Severity:** Medium  
**File:** `packages/server/src/services/audit.ts`

**Description:**  
`appendAudit` reads the previous hash with `LRANGE`, computes the new hash, then `RPUSH`es the entry. If two callers execute concurrently, both may read the same "last entry" as their predecessor, breaking the hash chain.

**Impact:**  
Two concurrent audit events could produce an invalid chain where both entries have the same `prev_hash`. `verifyChain` would detect this.

**Fix applied:**  
`appendAudit` now serializes the read-compute-write sequence with a Redis `SET NX PX` lock and releases the lock after appending and publishing. A concurrent append regression test performs 50 parallel writes and verifies the global chain remains valid.

**Remaining production note:**  
The global chain append is serialized, but GAP-003 still tracks independent per-agent chain verification.

---

## GAP-003 — Per-agent audit chain is not independently verifiable
**Status:** OPEN  
**Severity:** Low  
**File:** `packages/server/src/services/audit.ts`

**Description:**  
The global audit list maintains a proper hash chain. Per-agent lists are filtered views of the global chain — each entry's `prev_hash` references the global predecessor (which may be an entry from a different agent). `verifyChain(redis, agent_id)` verifies each entry's individual hash but cannot verify consecutive `prev_hash` linkage within the agent's filtered list.

**Impact:**  
Deletion of an entry from a per-agent list is not detected by `verifyChain(redis, agent_id)`. Only the global chain detects deletion from middle.

**Mitigation:**  
Always verify the global chain for tamper detection. Per-agent lists are for query convenience, not security.

**Required fix for production:**  
Maintain a separate, independent hash chain per agent (separate Redis list with its own prev_hash). Each `appendAudit` call maintains two chains: one global, one per-agent.

---

## GAP-004 — SPIRE bundle and IdP JWKS fetched over plain HTTP in dev config
**Status:** OPEN  
**Severity:** High (in production deployment)  
**File:** `packages/server/src/crypto/jwt.ts`, `.env.example`

**Description:**  
`.env.example` shows `KAIF_SPIRE_BUNDLE_ENDPOINT=http://localhost:8081/bundles/jwt` with HTTP (not HTTPS). A MITM attacker on the network path between the KAIF server and SPIRE could substitute their own JWKS, allowing arbitrary JWT-SVIDs to be accepted.

**Impact:**  
Full authentication bypass for the actor_token (SVID) validation path.

**Mitigation for v0.1:**  
Docker Compose network is internal (`kaif-server` and `spire-server` share a bridge network). This is acceptable for development. Production deployments MUST use HTTPS or mTLS between KAIF server and SPIRE.

**Required fix for production:**  
1. Configure SPIRE's bundle endpoint with TLS.
2. Add `KAIF_SPIRE_BUNDLE_ENDPOINT_CA` env var pointing to the SPIRE CA cert.
3. Use Node.js `https.Agent` with the CA cert when fetching the SPIRE bundle.
4. Document this requirement prominently in the deployment guide.

---

## GAP-005 — No rate limiting on `/introspect` and `/revoke` in current implementation
**Status:** CLOSED (fixed Phase 3, 2026-05-20)  
**Severity:** Medium  
**File:** `packages/server/src/routes/token.ts`, `src/server.ts`

Rate limiting now implemented:
- `/oauth/token`: 100 req/min (per-route config via `@fastify/rate-limit`)
- All other routes: 1000 req/min global
- Retry-After header added automatically on 429

---

## GAP-006 — Scope glob matching uses micromatch which treats strings as Unix paths
**Status:** CLOSED (fixed 2026-05-21)  
**Severity:** Low  
**File:** `packages/server/src/services/acl.ts`

**Description:**  
`micromatch` treats the first argument as a Unix path. Glob patterns like `vault:*` work correctly because `:` is not a path separator. However, if scope strings ever include `/` characters, `*` would not match across path segments. A pattern like `vault/read/*` would match `vault/read/key` but NOT `vault/read/sub/key` (two levels deep).

**Fix applied:**  
`loadACL` now validates `agents.yaml` at startup. Scope patterns must be non-empty colon-delimited strings and are rejected if they contain `/` or recursive `**` wildcards. The validator also rejects malformed SPIFFE IDs, duplicate SPIFFE IDs, unknown trust tiers, missing booleans, invalid TTLs, and negative delegation depths.

---

## GAP-007 — Missing SECURITY.md required by CLAUDE.md
**Status:** CLOSED (fixed Phase 7, 2026-05-20)  
**Severity:** Low  
**File:** `SECURITY.md`

`SECURITY.md` created with supported versions, vulnerability SLA, scope, architecture note, and explicit `_cachePromise` key management warning. GAP-001 cross-referenced.

---

## GAP-008 — `/provision` returns delegation UUID; `executeTokenExchange` requires a signed JWT
**Status:** CLOSED (fixed 2026-05-20)  
**Severity:** High  
**Files:** `packages/server/src/routes/provision.ts`, `packages/server/src/services/token-exchange.ts`, `packages/sdk/src/client.ts`

**Description:**  
`executeTokenExchange` step 1 calls `verifyJWT(subject_token)`, which expects a compact JWS signed by the KAIF server. However, `POST /provision` returns `{ delegation_id: string }` — a UUID v4, not a signed JWT. There is no route or service function that converts a delegation grant UUID into a signed KAIF JWT for use as `subject_token`.

The `KAIFClientConfig.delegation_grant_id` field comment says "The delegation grant JWT — the subject_token for RFC 8693 token exchange", which is the correct design intent — but the value obtained from `/provision` is a UUID, not a JWT.

**Impact:**  
The end-to-end flow is broken. A real agent calling `/provision` and passing the returned `delegation_id` directly to `/oauth/token` as `subject_token` will receive `invalid_grant` — JWT parse failure.

The integration test works because it bypasses `/provision` entirely and calls `signKAIFToken()` directly to construct the subject_token.

**Required fix:**  
One of the following:

**Option A (preferred):** Have `/provision` sign and return a KAIF JWT as the delegation grant. The JWT's claims would include the delegation scope, expiry, and human principal. This JWT becomes the `subject_token`. The `delegation_id` UUID remains the Redis key but is embedded as `kaif.delegation_id` in the JWT.

```typescript
// /provision returns:
{
  delegation_grant: "<signed KAIF JWT>",   // ← subject_token for /oauth/token
  expires_at: number
}
```

**Option B:** Modify `executeTokenExchange` step 1 to also accept a delegation_id UUID by looking it up in Redis, then synthesising the effective claims. This is looser but avoids changing the provision response.

**Mitigation for v0.1:**  
The conformance kit and integration test both bypass `/provision` and construct the subject_token directly. The end-to-end demo script is not currently functional at the token exchange step because of this gap.

**Fix applied:**  
`/provision` now signs a KAIF JWT (via `signKAIFToken`) after writing the `DelegationGrant` to Redis and returns it as `delegation_token` alongside the `delegation_id` UUID. The SDK `KAIFClientConfig` field renamed from `delegation_grant_id` to `delegation_token`. Integration test now uses the real `/provision` → `/oauth/token` path — no manual `signKAIFToken` call for the main flow. `svid_thumbprint: 'pending'` is intentional and documented inline.

---

## GAP-009 — `insecure_bootstrap = true` in SPIRE agent config
**Status:** DOCUMENTED (2026-05-20)  
**Severity:** Medium (High in production)  
**File:** `spire/agent.conf`

**Description:**  
`spire/agent.conf` sets `insecure_bootstrap = true`. This tells the SPIRE agent to accept the server's bundle without verifying its identity on first contact. A network attacker able to intercept the first connection could present a rogue SPIRE server, causing the agent to trust a malicious bundle — meaning arbitrary JWT-SVIDs from an attacker-controlled SPIRE could be accepted by the KAIF server.

**Impact:**  
Full actor_token authentication bypass if the network path between agent and server is compromised at agent startup.

**Mitigation for v0.1:**  
Acceptable in Docker Compose development where agent and server share an internal bridge network. The flag is standard for dev SPIRE setups.

**Required fix for production:**  
1. Remove `insecure_bootstrap = true`.
2. Provide a bootstrap bundle (the SPIRE server's trust bundle in PEM format) to the agent at startup.
3. Configure `trust_bundle_path` in `spire/agent.conf` pointing to the pre-distributed bundle.
4. Document this in the deployment guide as a mandatory production step.

**Documentation applied:**  
`docker-compose.yml` spire-agent service now has a prominent `⚠️ DEVELOPMENT ONLY` comment. `README.md` Quick Start section now includes the warning about `insecure_bootstrap`. Pending formal deployment guide section.

---

## GAP-010 — Delegation grants were not bound to the presenting SVID
**Status:** CLOSED (fixed 2026-05-21)  
**Severity:** High  
**Files:** `packages/server/src/services/token-exchange.ts`, `packages/server/tests/token-exchange.test.ts`

**Description:**  
`/provision` embedded the intended agent in `actor.sub` and `may_act.sub`, but token exchange accepted any registered actor SVID whose ACL allowed the requested scope. A leaked delegation token could therefore be redeemed by the wrong registered workload.

**Fix applied:**  
`executeTokenExchange` now requires the subject token's `may_act.sub` or `actor.sub` to match the validated SVID SPIFFE ID. Regression coverage verifies actor mismatch rejection.

---

## GAP-011 — Sub-delegation ACL fields were defined but not enforced
**Status:** CLOSED for current token-exchange semantics (fixed 2026-05-21)  
**Severity:** High  
**Files:** `packages/server/src/services/token-exchange.ts`, `packages/server/tests/token-exchange.test.ts`

**Description:**  
`may_sub_delegate` and `human_principal_required` existed in the ACL schema, but token exchange only enforced scope, trust tier, TTL, and maximum depth.

**Fix applied:**  
Using an issued access token as a new `subject_token` is treated as sub-delegation. The parent actor must be registered and must set `may_sub_delegate: true`; required human principal chains are enforced for parent actors that require them. Direct `/provision` grants remain non-sub-delegation grants.

**Remaining production work:**  
Design and implement an explicit sub-delegation issuance flow if cross-agent delegation is required.

---

## GAP-012 — Protected routes accepted any valid unrevoked scope
**Status:** CLOSED (fixed 2026-05-21)  
**Severity:** High  
**Files:** `packages/server/src/routes/_auth.ts`, `packages/server/src/routes/introspect.ts`, `packages/server/src/routes/revoke.ts`

**Description:**  
`/introspect` and `/revoke` used a bearer pre-handler that verified JWT signature and expiry only. It did not reject revoked bearer tokens and did not enforce route-specific authorization.

**Fix applied:**  
The shared auth pre-handler now rejects revoked bearer JTIs. `/introspect` allows self-introspection or requires `audit:read`; `/revoke` allows self-revocation or requires `admin:revoke`.

---

## GAP-013 — Local quick start did not match the implemented token flow
**Status:** CLOSED for local reference workflow (fixed 2026-05-21)  
**Severity:** Medium  
**Files:** `QUICKSTART.md`, `README.md`, `docker-compose.yml`, `scripts/demo.sh`, `conformance/fixtures/*.ts`

**Description:**  
The docs described using a delegation UUID as `subject_token`, referenced a non-existent SVID HTTP endpoint, and started `mock-agent` without the required delegation token.

**Fix applied:**  
Docs now use `delegation_token`, the SPIRE agent CLI SVID flow, and the local demo script. `mock-agent` is behind an explicit Compose profile. Conformance protected-endpoint fixtures authenticate with a KAIF bearer token.

---

## GAP-014 — Production startup allowed ephemeral keys and non-TLS Redis
**Status:** CLOSED for startup guardrails (fixed 2026-05-21)  
**Severity:** High  
**Files:** `packages/server/src/config.ts`, `packages/server/tests/config.test.ts`, `.env.example`, `README.md`

**Description:**  
Before this guardrail, a deployment could set `NODE_ENV=production` while still using generated ephemeral signing keys or a plain `redis://` endpoint. That creates restart-induced token invalidation risk and makes Redis traffic unsuitable for production networks.

**Fix applied:**  
`loadConfig()` now rejects `NODE_ENV=production` when `KAIF_DEV_MODE=true`, when `KAIF_PRIVATE_KEY_PATH` is unset, or when `KAIF_REDIS_URL` is not `rediss://` unless `KAIF_ALLOW_INSECURE_REDIS=true` is explicitly set for controlled production-like tests. Config tests cover each case.

**Remaining production work:**  
KMS/HSM key storage, JWKS rotation, Redis infrastructure provisioning, and Redis ACL policy are tracked in `security/PRODUCTION_ATTESTATION_PROTOCOL_PLAN.md`.

---

## GAP-015 — Governance Redis and KAIF tenant boundary was undefined
**Status:** DOCUMENTED, implementation contract pending (2026-05-21)  
**Severity:** Medium  
**Files:** `security/GOVERNANCE_REDIS_INTEGRATION.md`, `scripts/day7b_kaif_handshake_conformance.sh`, `packages/server/src/config.ts`

**Description:**  
KAIF is intended to run as the external receiver for an agentic handshake while a separate governance engine runs on Redis. Without an explicit boundary, production deployments could accidentally couple KAIF to the governance engine's Redis, mix retention/security policies, or make the two systems non-independently restartable.

**Fix applied:**  
The governance integration plan now states that production/staging KAIF uses dedicated Redis with TLS, ACLs, and dedicated credentials. `KAIF_TENANT_ADDRESS` is accepted by configuration and included in Day 7b evidence when set. The Day 7b wrapper records Redis guidance in its summary artifacts.

**Required fix for production:**  
Finalize the external governance repo path, exact `KAIF_TENANT_ADDRESS`, trust signal schema, failure policy, and whether KAIF consumes governance state through API pull, stream subscribe, or a one-way bridge.

---

## Production Tracking

The remaining open production work is tracked in `security/PRODUCTION_ATTESTATION_PROTOCOL_PLAN.md`, including GAP-003, GAP-004, GAP-009, GAP-014 remaining lifecycle work, and GAP-015 integration contract work.

---

*Last updated: 2026-05-21 by Codex — GAP-014 CLOSED for startup guardrails; GAP-015 documented; Day 7b evidence plan expanded*
