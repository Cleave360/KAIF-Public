# KAIF Design Architecture and Success Bar

Status: design architecture plan  
Date: 2026-05-22  
Audience: maintainers, security reviewers, protocol implementers, operators

This document sets the bar for KAIF as a real identity and authorization protocol for agentic systems. It is intentionally stricter than the current alpha implementation. The goal is not to make the repo look complete; the goal is to make every claim testable, falsifiable, and operationally meaningful.

Related documents:

- [SPEC.md](SPEC.md) - normative core profile
- [security/gaps.md](security/gaps.md) - security gap register
- [security/PRODUCTION_ATTESTATION_PROTOCOL_PLAN.md](security/PRODUCTION_ATTESTATION_PROTOCOL_PLAN.md) - production hardening workstreams
- [security/GOVERNANCE_REDIS_INTEGRATION.md](security/GOVERNANCE_REDIS_INTEGRATION.md) - Adaptive governance boundary
- [KAIF-SLO-Revocation-Introspection-v1.md](KAIF-SLO-Revocation-Introspection-v1.md) - revocation and introspection SLOs
- [skills.md](skills.md) - adversarial second-reviewer operating brief
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) - operational diagnostics
- [handoff.md](handoff.md) - implementation handoff log

---

## 1. Executive Standard

KAIF succeeds only if it can answer this production question:

> Can a relying service decide, quickly and defensibly, whether a specific agent workload is allowed to perform a specific action for a specific human principal, with revocation, audit evidence, and governance context that survive incidents?

That means KAIF must prove all of the following:

| Property | Success Standard |
|---|---|
| Workload authenticity | Every issued agent token is bound to a current SPIRE-attested workload identity. |
| Human traceability | Every grant and access token preserves the human authority chain. |
| Least privilege | Scope, audience, actor, trust tier, and delegation depth are enforced before issuance and again at relying parties. |
| Fast revocation | A token can be denied by JTI without rotating long-lived secrets. |
| Tamper evidence | Audit records are hash chained, atomically appended, and exported to durable evidence storage. |
| Governance boundary | KAIF and the governance engine integrate through a versioned API contract, not shared mutable Redis internals. |
| Operational restartability | Redis, SPIRE, KAIF, and governance components can restart independently without corrupting trust state. |
| Interoperability | A second implementation can pass the conformance kit without private knowledge of this codebase. |

Anything less is useful research, but not production protocol success.

---

## 2. Real-World Problems KAIF Must Solve

### Near-Term Problems

KAIF should solve problems already visible in current agent deployments:

| Problem | KAIF Answer |
|---|---|
| Static API keys used by agents | Replace long-lived secrets with short-lived, scoped, SPIRE-attested access tokens. |
| Unclear human accountability | Embed human `sub` and principal chain in every delegated credential. |
| Tool overreach | Enforce explicit scopes and trust-tier gates before tool access. |
| Weak revocation | Deny by JTI with Redis TTL and optional strict introspection. |
| Audit gaps | Emit hash-linked local audit and governance evidence for every auth decision. |
| Shared infrastructure coupling | Require dedicated KAIF Redis in staging and production. |
| Demo-only identity | Remove or hard-fail all development shortcuts under `NODE_ENV=production`. |

### Future Problems

KAIF should also be ready for higher-order agent systems:

| Future Pressure | Required Architecture Response |
|---|---|
| Agent-to-agent delegation chains | Explicit sub-delegation model with depth, actor transition, and principal-chain checks. |
| Cross-tenant agent execution | Tenant address becomes a first-class evidence and isolation dimension. |
| Regulated workflow replay | Durable audit exports and replay tooling must reconstruct auth decisions. |
| Multi-cloud agent platforms | Protocol must rely on standards, not one provider control plane. |
| Memory/tool authorization | Tokens must distinguish memory read/write, tool invocation, policy update, and administrative revoke scopes. |
| Dynamic trust scoring | Trust scores must be versioned, explainable, and bounded by fail-closed policy. |
| Independent verifiers | Relying parties must verify KAIF tokens without importing this server implementation. |

---

## 3. Design Principles

1. Standards first. Compose SPIFFE/SPIRE, OAuth 2.0 Token Exchange, JWT, JWKS, mTLS/CNF, and OIDC instead of inventing new primitives.
2. Proof over assertion. Agent identity must be attested, not claimed by a string in a request.
3. Fail closed by default. Class A and administrative paths must halt when identity, policy, revocation, or governance evidence is unavailable.
4. Development shortcuts are radioactive in production. Dev mock tokens, insecure SPIRE bootstrap, insecure bundle TLS, and non-TLS Redis must be startup failures in production.
5. Redis is hot state, not the whole evidence system. Redis is appropriate for revocation, active delegation, trust score, locks, and pub/sub. Durable audit belongs in exported warm/cold evidence stores.
6. Governance is API-first. KAIF sends auth-layer evidence to the governance engine; it does not mutate governance Redis directly.
7. Every claim gets a test. If a README sentence says "revoked tokens are rejected," there must be a test and evidence artifact showing that behavior.
8. The conformance kit must be hostile. Negative cases matter more than happy paths for an auth protocol.
9. Relying parties are part of the protocol. Issuing a token is not enough; independent services must know how to verify and enforce it.
10. Operations must be boring. Restart, rotation, backup, restore, audit export, and incident response must have runbooks and automated checks.

---

## 4. System Architecture

KAIF is a trust boundary between human authorization, workload attestation, runtime trust state, and relying-party enforcement.

```text
Human / IdP
  |
  | OIDC id_token
  v
KAIF /provision
  |
  | signed delegation_token
  v
Agent workload
  |
  | SPIRE JWT-SVID + delegation_token
  v
KAIF /oauth/token
  |
  | KAIF access token
  v
Relying service
  |
  | verify JWKS, aud, scope, jti, trust tier, actor
  v
Protected action

Side channels:
  - Redis hot state: delegation, revocation, trust score, locks, pub/sub
  - SPIRE: workload identity and trust bundle
  - Governance API: auth evidence append
  - Warm/cold evidence: immutable audit exports and verification reports
```

### Architecture Layers

| Layer | Responsibility | Must Not Do |
|---|---|---|
| Identity layer | SPIRE issues JWT-SVIDs for workloads. | Trust unauthenticated workload strings. |
| Human authority layer | `/provision` validates IdP tokens and signs delegation grants. | Issue grants without human traceability. |
| Token exchange layer | `/oauth/token` binds delegation to SVID and emits scoped KAIF tokens. | Redeem a grant for the wrong actor. |
| Runtime state layer | Redis stores hot authorization state with TTLs and pub/sub. | Become the only durable audit archive. |
| Evidence layer | Local audit and governance append record auth decisions. | Share mutable Redis ownership with governance engine. |
| Relying-party layer | Services enforce signature, issuer, audience, scope, revocation, and trust. | Treat KAIF JWT possession as sufficient by itself. |

---

## 5. Trust Boundaries

### Boundary A: Human IdP to KAIF

KAIF trusts the human IdP only through configured issuer, JWKS, audience, expiry, and signature validation. Dev mode may accept `dev-mock-token`; production must reject dev mode at startup.

Success gate:

- Invalid issuer, invalid audience, expired token, malformed token, and unknown principal are rejected with explicit tests.

### Boundary B: SPIRE to KAIF

KAIF trusts actor SVIDs only through the configured SPIRE bundle. Production must use trusted HTTPS or mTLS bundle retrieval. `KAIF_SPIRE_BUNDLE_TLS_INSECURE=true` must remain dev-only.

Success gate:

- Wrong trust domain, expired SVID, wrong audience, wrong signing key, and grant/SVID actor mismatch are rejected.

### Boundary C: KAIF to Redis

Redis is a hot state dependency. Production Redis must be dedicated to KAIF, use TLS, ACLs, backups, and distinct credentials.

Success gate:

- `NODE_ENV=production` refuses `redis://` unless an explicit controlled-test override is set.
- KAIF never depends on governance-engine Redis keys for token issuance or revocation.

### Boundary D: KAIF to Governance Engine

The governance engine receives auth-layer evidence through `POST /v1/audit/append`. It may influence policy, but the contract must be versioned and observable.

Success gate:

- Class A fails closed when governance evidence append is required and unavailable.
- Class C degraded-open is possible only when explicitly enabled and marked in evidence.

### Boundary E: KAIF to Relying Services

Relying parties must verify tokens independently. They must not trust the token just because it was received over an internal network.

Success gate:

- Example relying services and conformance fixtures reject wrong audience, insufficient scope, revoked JTI, expired token, and missing binding material.

---

## 6. Redis Memory Architecture

KAIF should treat Redis as a hot authorization memory layer and deliberately export evidence to warm and cold stores.

### Hot State

Hot state is active, low-latency, and TTL-driven.

| Data | Redis Key | Retention | Production Requirement |
|---|---|---|---|
| Delegation grants | `kaif:delegation:<delegation_id>` | Grant TTL | Dedicated TLS Redis, ACL write limited to KAIF. |
| Revoked JTI | `kaif:revoke:<jti>` | Token remaining TTL | O(1) lookup; no infinite TTL. |
| Trust scores | `kaif:trust:<spiffe_id>` | Short TTL | Versioned signal source and fallback policy. |
| Audit append lock | `kaif:lock:audit:*` | Milliseconds | Eventually replaced by Lua or equivalent atomic append. |
| Pub/sub | `kaif:revocation`, `kaif:audit` | No storage | Multi-instance propagation only. |

Hot-state success gate:

- Redis restart, KAIF restart, and SPIRE restart are each tested independently.
- Revocation remains enforceable after KAIF instance restart while Redis is preserved.

### Warm Evidence

Warm evidence is queryable and durable enough for replay, support, and short-term incident response.

Required warm exports:

- Hash-linked audit entries exported in batches.
- Day 7b run reports and redacted payload artifacts.
- Revocation propagation metrics with p95 and p99 samples.
- Governance evidence append receipts or failure markers.

Warm storage candidates:

- S3-compatible object storage for append batches.
- DynamoDB-compatible tables for evidence indexes.
- SIEM or log analytics sink for operational search.

Warm-state success gate:

- A verifier can reconstruct the global audit chain from exported batches and prove no missing middle entry.

### Cold Evidence

Cold evidence is immutable, lower-cost, and retained for regulatory or post-incident review.

Required cold exports:

- Periodic signed audit checkpoints.
- Release evidence bundles for production attestation.
- Key rotation and key compromise event summaries.
- Governance decision summaries by tenant.

Cold-state success gate:

- A cold evidence bundle can answer: who authorized what, which workload executed it, what token was issued, whether it was revoked, and which policy/gov evidence was available.

---

## 7. Floci Evaluation Plan

[floci-io/floci](https://github.com/floci-io/floci) is a candidate local and CI emulator for AWS-shaped services. It is not a production dependency for KAIF.

Use Floci only where it raises confidence without weakening the production story:

| Use Case | Why It Helps | Limit |
|---|---|---|
| Warm evidence export tests | Emulate S3/DynamoDB-shaped storage locally for audit batch export and indexing. | Does not replace production object storage controls. |
| Credential path tests | Run AWS SDK calls against `http://localhost:4566` with explicit credentials and endpoint config. | Floci allows local credentials; this proves wiring, not cloud-grade IAM assurance. |
| Multi-account isolation tests | Use 12-digit `AWS_ACCESS_KEY_ID` values to model tenant/account isolation in CI. | Must still test real cloud IAM separately before production. |
| Storage mode experiments | Compare `memory`, `persistent`, `hybrid`, and `wal` modes for local evidence durability workflows. | KAIF production Redis durability is still handled by managed Redis and external evidence stores. |
| ElastiCache-shaped tests | Exercise Redis/Valkey protocol and credential-shaped flows in local AWS-style tests. | Dedicated KAIF Redis remains the production requirement. |

### Proposed `floci-lab` Profile

Do not add Floci to the default KAIF stack. Add it later behind an explicit Compose profile:

```yaml
profiles:
  - floci-lab
```

The lab should test:

1. Export audit batches from Redis hot state to an S3-compatible bucket.
2. Write an evidence index keyed by `tenant_id`, `run_id`, and `jti`.
3. Verify exported audit chain continuity from warm storage.
4. Run credential wiring tests with two local account IDs:
   - `AWS_ACCESS_KEY_ID=111111111111`
   - `AWS_ACCESS_KEY_ID=222222222222`
5. Prove account A cannot read account B's evidence objects in the local emulator if the chosen Floci service supports that isolation.
6. Run all tests with `FLOCI_STORAGE_MODE=memory` for fast CI and `FLOCI_STORAGE_MODE=wal` for durability simulation.

Floci adoption gate:

- Floci can be introduced only if it stays optional, adds no production code path, and has tests proving KAIF still runs without it.

---

## 8. Success Gates

### Security Gates

| Gate | Required Evidence |
|---|---|
| No known high auth bypass remains open | `security/gaps.md` has no OPEN High items for release candidate. |
| Production startup guardrails | Tests prove dev mode, insecure SPIRE bundle TLS, ephemeral signing keys, and non-TLS Redis fail in production. |
| Actor binding | Grant `may_act.sub` and presented SVID `sub` mismatch is rejected. |
| CNF or equivalent binding | Replay without expected binding material is rejected by a relying-party test. |
| Route authorization | Protected routes enforce revocation and route-specific scopes. |
| Threat model complete | Abuse cases include stolen delegation token, stolen access token, rogue SPIRE, stale Redis, and governance outage. |

### Conformance Gates

| Gate | Required Evidence |
|---|---|
| MUST fixture pass | KAIF-001 through KAIF-007 pass without weakening assertions. |
| Day 7b pass | Valid exchange, wrong audience, expired token, revoked JTI, binding mismatch, scope overreach, depth limit, and failure modes pass. |
| Negative tests are specific | Fixtures distinguish unauthenticated failure from the intended policy failure. |
| Independent implementation | At least one implementation outside this repo passes the MUST fixtures. |
| Artifact retention | JSON reports, redacted request/response payloads, logs, and timing metrics are retained. |

### Operational Gates

| Gate | Target |
|---|---|
| Token endpoint reliability | 99.9% success over a 30-day pilot, excluding invalid client requests. |
| Token exchange latency | p99 within the published SLO for the deployment profile. |
| Introspection latency | p99 within the published SLO for the deployment profile. |
| Revoke-to-deny latency | p99 under 5 seconds in strict mode; bounded and documented in eventual mode. |
| Restart safety | KAIF, Redis, SPIRE server, SPIRE agent, and governance endpoint restart tests pass independently. |
| Key rotation | Rolling rotation does not invalidate unexpired tokens unexpectedly. |
| Audit verification | Global and per-agent chains verify continuously or on a scheduled interval. |

### Documentation Gates

| Gate | Required Evidence |
|---|---|
| Quick start is real | A fresh checkout can run one documented command path to a valid token. |
| Dev/prod split is explicit | Every insecure local setting is labeled as local-only. |
| Operator runbooks exist | SPIRE, Redis, key compromise, revocation, and governance outage runbooks are linked. |
| Status labels are honest | Docs distinguish implemented, planned, dev-only, and production-required behavior. |

---

## 9. Release Profiles

### Local Development Profile

Purpose: fast iteration.

Allowed:

- Shared local Redis.
- `KAIF_DEV_MODE=true`.
- SPIRE `insecure_bootstrap=true`.
- `KAIF_SPIRE_BUNDLE_TLS_INSECURE=true`.
- Floci optional lab profile.

Not allowed:

- Claims of production readiness.
- Long-lived real secrets.
- Shared test credentials outside the local machine.

### Staging Profile

Purpose: production rehearsal.

Required:

- Dedicated KAIF Redis with TLS and ACLs.
- Real IdP JWKS and issuer validation.
- Production-like SPIRE bootstrap without insecure first trust.
- Governance evidence endpoint configured.
- Day 7b strict evidence run.
- Warm audit export enabled.

Not allowed:

- Dev mock token.
- Insecure SPIRE bundle TLS.
- Shared governance Redis.

### Production Profile

Purpose: real relying-party authorization.

Required:

- Dedicated Redis or managed Redis with TLS, ACLs, backups, and monitoring.
- KMS/HSM or equivalent signing-key protection.
- JWKS rotation with previous keys retained until all issued tokens expire.
- SPIRE production bootstrap and trusted bundle retrieval.
- Relying-party verification contract published.
- Immutable audit export.
- Incident runbooks tested.
- Security review sign-off.

Not allowed:

- Dev-only flags.
- Direct mutable Redis coupling to governance.
- Unauthenticated bundle retrieval.
- Untested conformance exceptions.

---

## 10. Implementation Roadmap

### Phase 1: Alpha Hardening

Goal: make the current reference implementation honest and repeatable.

Deliverables:

- Close remaining high and medium auth gaps.
- Keep Docker Compose healthy after cold restart.
- Fix docs so local and demo paths match implementation.
- Add failing regression tests before each security fix.
- Keep `pnpm test`, `pnpm build`, and `docker compose config` green.

Exit criteria:

- No known high auth bypass remains open.
- Local Day 7b produces a complete evidence bundle.

### Phase 2: Production Candidate

Goal: remove dev-only trust assumptions from the production path.

Deliverables:

- Production SPIRE bootstrap plan implemented.
- Trusted SPIRE bundle CA path implemented.
- Signing key rotation implemented.
- Per-agent audit chain implemented.
- Atomic audit append upgraded to Redis Lua or equivalent.
- Relying-party CNF enforcement implemented.

Exit criteria:

- Staging profile can run Day 7b strict mode without skipped production-required cases.

### Phase 3: Pilot

Goal: prove real operational behavior under controlled production-like traffic.

Deliverables:

- 30-day pilot SLO dashboard.
- Revocation drill.
- Key compromise drill.
- Governance outage drill.
- Redis failover drill.
- Warm/cold evidence reconstruction test.

Exit criteria:

- No unresolved high-severity auth defects.
- Revoke-to-deny and token exchange latency meet published SLOs.

### Phase 4: Protocol Release

Goal: make KAIF credible beyond this implementation.

Deliverables:

- Core profile frozen for v1.0.
- Independent implementation passes conformance.
- Security review sign-off.
- Public interoperability report.
- Maintainer governance for protocol changes.

Exit criteria:

- Protocol claims are supported by multiple implementations and retained evidence.

---

## 11. Architecture Decision Records To Add

The following ADRs should be created before production candidate status:

| ADR | Decision |
|---|---|
| ADR-001 | Redis is hot state; audit exports are durable evidence. |
| ADR-002 | KAIF integrates with governance through API evidence append, not shared Redis. |
| ADR-003 | Production SPIRE trust bootstrap and bundle CA model. |
| ADR-004 | CNF binding mode for JWT-SVID and mTLS deployments. |
| ADR-005 | Signing key lifecycle and JWKS rotation model. |
| ADR-006 | Floci lab profile is optional dev/CI infrastructure only. |

---

## 12. Definition Of Success

KAIF is successful when a skeptical external reviewer can run the repo, inspect the docs, read the evidence artifacts, and conclude:

1. The protocol solves a real authorization gap for agents.
2. The implementation enforces the protocol's security claims.
3. The operational model survives restarts, outages, revocation, and key rotation.
4. Relying parties can verify tokens independently.
5. Governance integration is observable and decoupled.
6. The project is honest about what is implemented, what is dev-only, and what is required for production.

That is the bar.

---

## 13. References

- [KAIF Core Profile](SPEC.md)
- [Production Attestation Protocol Plan](security/PRODUCTION_ATTESTATION_PROTOCOL_PLAN.md)
- [Governance Redis Integration Plan](security/GOVERNANCE_REDIS_INTEGRATION.md)
- [Security Gaps Register](security/gaps.md)
- [Floci local AWS emulator](https://github.com/floci-io/floci)
- [SPIFFE/SPIRE](https://spiffe.io/)
- [RFC 8693 OAuth 2.0 Token Exchange](https://www.rfc-editor.org/rfc/rfc8693)
- [RFC 9068 JWT Profile for OAuth 2.0 Access Tokens](https://www.rfc-editor.org/rfc/rfc9068)
