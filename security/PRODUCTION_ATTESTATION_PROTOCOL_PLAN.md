# Production Attestation Protocol Plan

Status: draft production hardening plan  
Date: 2026-05-21

This plan turns the KAIF reference implementation into a production-quality attestation protocol. It addresses the open items in `security/gaps.md` and the repository review findings in `review.md`.

## Security Objectives

KAIF production deployments must provide:

1. Workload authenticity: every token issued to an agent is backed by a currently valid SPIFFE/SPIRE SVID.
2. Human traceability: every delegated authority chain preserves the human principal that authorized it.
3. Actor binding: a delegation grant can only be redeemed by the SPIFFE ID named by the grant.
4. Least privilege: scopes, trust tier, delegation depth, and route-level administrative permissions are enforced fail-closed.
5. Fast revocation: any issued credential can be denied in O(1) time and revocation propagates to relying parties.
6. Tamper evidence: audit records are hash chained and written through an atomic append path.
7. Operational trust: production SPIRE bootstrap, JWKS retrieval, key storage, and token verification do not depend on insecure development defaults.

## Protocol Baseline

### 1. Human Provisioning

- `/provision` accepts a human OIDC ID token.
- The server validates issuer, signature, expiry, and expected audience.
- The server maps the human to a stable principal from `email` or `sub`.
- The requested agent name resolves to one configured SPIFFE ID.
- The requested scopes must be a subset of the agent ACL.
- The server creates a signed delegation JWT with:
  - `sub` = human principal.
  - `actor.sub` = intended agent SPIFFE ID.
  - `may_act.sub` = intended agent SPIFFE ID.
  - `kaif.delegation_depth` = `0` for direct human grants.
  - `jti` = delegation grant ID.
- The delegation grant is stored in Redis with TTL and an audit hash.

### 2. Workload Attestation

- Agents fetch JWT-SVIDs from the SPIRE Workload API or an explicitly configured SVIDStore.
- KAIF validates SVID signatures against a trusted SPIRE bundle.
- Production deployments must not fetch SPIRE bundles over unauthenticated HTTP.
- Production SPIRE agents must not use `insecure_bootstrap = true`.
- KAIF validates SVID `sub`, `exp`, trust domain, and audience.

### 3. Token Exchange

- `/oauth/token` accepts RFC 8693 token exchange requests.
- `subject_token` must be a valid KAIF-signed delegation or sub-delegation token.
- `actor_token` must be a valid SPIRE JWT-SVID.
- Requested `scope` must be non-empty.
- The grant's `may_act.sub` must equal the SVID `sub`.
- Direct human grants remain `delegation_depth = 0`.
- Using an issued access token as a new subject token is sub-delegation and requires the parent actor ACL to set `may_sub_delegate: true`.
- Effective delegation depth cannot exceed the smaller of the actor ACL maximum and trust-tier maximum.
- Issued access tokens must include human `sub`, actor SPIFFE ID, JTI, scope, trust score, trust tier, delegation depth, and rollback window.

### 4. Protected KAIF Endpoints

- Protected KAIF routes must reject missing, invalid, expired, or revoked bearer tokens.
- `/introspect` allows self-introspection. Introspecting another token requires `audit:read`.
- `/revoke` allows self-revocation. Revoking another token requires `admin:revoke`.
- Route authorization errors must use OAuth-style error bodies with `error` and `error_description`.

### 5. Relying Party Verification

Every relying party must verify:

1. JWT signature against KAIF JWKS.
2. `iss` equals the configured KAIF issuer.
3. `aud` matches the relying party.
4. `exp` and `nbf` with at most 10 seconds clock skew.
5. `jti` is not locally revoked or is active via `/introspect`.
6. Required scope is present.
7. `kaif.trust_tier` meets the service policy.
8. `actor.sub` is an allowed workload identity for the service.

## Production Hardening Workstreams

### Workstream A: SPIRE Trust and SVID Retrieval

Addresses: GAP-004, GAP-009, quick-start/runtime mismatch.

- Replace unauthenticated SPIRE bundle fetches with HTTPS or mTLS.
- Add `KAIF_SPIRE_BUNDLE_CA_PATH` or equivalent trust bundle configuration.
- Remove `insecure_bootstrap = true` from production agent configs.
- Require `trust_bundle_path` or upstream authority bootstrap for production SPIRE agents.
- Decide one production SVID retrieval path:
  - Workload API socket integration in SDK, or
  - SVIDStore file path with documented rotation behavior.
- Add an integration test that exercises the selected SVID path.

Release gate: no production deployment guide may reference `insecure_bootstrap` or HTTP SPIRE bundle URLs except as explicit local-development warnings.

### Workstream B: Atomic Audit and Durable Evidence

Addresses: GAP-002, GAP-003.

- Replace `appendAudit` read-compute-write with a Redis Lua script.
- Maintain independent hash chains for:
  - global audit log,
  - per-agent audit logs,
  - optionally per-human audit logs.
- Add concurrent append tests that issue many requests in parallel and verify the chain.
- Export audit entries to an immutable sink such as append-only object storage, SIEM, or WORM log storage.
- Add audit verification tooling for operators.

Release gate: concurrent token issuance must not break global or per-agent audit chain verification.

### Workstream C: Signing Key Management and JWKS Lifecycle

Addresses: key-management production requirements and compromise runbooks.

- Require persistent signing keys in production. Startup guard implemented: `NODE_ENV=production` requires `KAIF_PRIVATE_KEY_PATH`.
- Store private keys in KMS/HSM or a secret store with strict access policy.
- Add key rotation support:
  - active signing key,
  - previous verification keys retained until all tokens expire,
  - JWKS exposes active and retained public keys.
- Add `kid` selection in `verifyJWT`.
- Keep ephemeral keys dev-only and fail startup in production if no production key source is configured.

Release gate: a rolling restart or key rotation cannot invalidate unexpired tokens unexpectedly.

### Workstream C2: Redis Isolation and Tenant Boundary

Addresses: governance-engine coupling, noisy-neighbor risk, mixed retention/security policy.

- Production/staging KAIF must use dedicated Redis with TLS, ACLs, and dedicated credentials.
- `NODE_ENV=production` now requires `KAIF_REDIS_URL` to use `rediss://` unless `KAIF_ALLOW_INSECURE_REDIS=true` is explicitly set for controlled production-like tests.
- `KAIF_TENANT_ADDRESS` is accepted in configuration and included in Day 7b evidence reports.
- Governance engine Redis must remain independently restartable and observable.
- Direct shared Redis access between KAIF and the governance engine is not a production integration contract.
- Preferred integration is a narrow API/stream bridge with explicit signal schema and failure policy.

Release gate: a production deployment must document the dedicated KAIF Redis endpoint, ACL policy, tenant address, and governance signal contract.

### Workstream D: CNF Binding and Transport Security

Addresses: conformance advisory KAIF-005 and production bearer-token replay resistance.

- Define the production binding mode:
  - mTLS `cnf.x5t#S256`, or
  - JWT-SVID signing-key thumbprint for SPIFFE-only flows.
- Enforce CNF binding on relying-party examples and conformance tests.
- Add route support for `X-Client-Cert-Thumbprint` only behind trusted proxies that sanitize the header.
- Prefer direct mTLS peer certificate inspection where possible.

Release gate: a token replayed without the expected binding material is rejected by at least one production relying-party integration test.

### Workstream E: Scope Grammar and Policy Validation

Addresses: GAP-006.

- Document the scope grammar as colon-delimited strings.
- Reject scopes containing `/` unless the glob matcher is replaced or configured for that grammar.
- Validate `agents.yaml` on startup with explicit schema checks.
- Add startup failures for unknown trust tiers, negative depth, empty scope lists, and unsafe wildcard patterns.

Release gate: invalid ACL files fail startup with actionable errors.

### Workstream F: Conformance and CI Gates

Addresses: review findings around false confidence.

- Conformance fixtures must authenticate to protected endpoints.
- Happy-path fixtures must assert exact `actor.sub`.
- CNF fixtures must distinguish authentication failure from actual CNF enforcement.
- Day 7b evidence runner must map protocol cases to conformance artifacts and identify incomplete production evidence.
- Production CI should set `KAIF_DAY7B_STRICT=true` so incomplete or failing Day 7b production evidence fails the job.
- CI must run:
  - unit tests,
  - type checks,
  - conformance against local compose,
  - smoke demo,
  - audit-chain concurrency test.

Release gate: a release candidate cannot pass CI if conformance relies on unauthenticated protected endpoint calls.

## Production Release Checklist

| Area | Gate | Current status |
|---|---|---|
| Actor binding | Grant `may_act.sub` must match SVID `sub` | Implemented |
| Sub-delegation | Parent actor must allow `may_sub_delegate` | Implemented for access-token subjects |
| Protected routes | Bearer token revocation and route authorization enforced | Implemented |
| Direct grant depth | Direct human grants issue depth `0` | Implemented |
| SPIRE bundle security | No unauthenticated HTTP bundle fetch in production | Open |
| SPIRE bootstrap | No `insecure_bootstrap = true` in production | Open |
| Audit atomicity | Redis Lua or equivalent atomic append | Implemented for global chain with Redis lock |
| Per-agent audit chain | Independently verifiable per-agent chain | Open |
| Signing key guard | Production cannot boot with ephemeral signing key | Implemented |
| Signing key lifecycle | KMS/HSM-backed keys and JWKS rotation | Open |
| Redis isolation | Dedicated TLS Redis for production/staging | Startup TLS guard implemented; infrastructure pending |
| Governance tenant | Tenant address and governance signal contract | Config field implemented; contract pending |
| CNF enforcement | Replay-resistant token binding enforced | Open |
| ACL validation | Startup schema validation and safe scope grammar | Implemented |
| Day 7b evidence | Handshake cases mapped to report artifacts | Implemented except external failure-mode endpoints |
| CI gates | Full conformance, Day 7b, and smoke demo in CI | Open |

## Immediate Implementation Order

1. Replace production SPIRE bootstrap and bundle retrieval defaults.
2. Implement JWKS key rotation on top of the production signing-key guard.
3. Implement SDK Workload API SVID retrieval or document SVIDStore as the only supported production path.
4. Add CNF enforcement to relying-party examples and conformance.
5. Add independent per-agent audit chains.
6. Finalize governance signal schema and wire Day 7b failure-mode endpoints.
