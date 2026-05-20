# KAIF Core Profile v1.0 Checklist

Status: Draft execution checklist  
Owner: Adaptive Layer / KAIF working group  
Last updated: 2026-05-20

## Purpose
Define the minimum interoperable KAIF profile required for open-source release and enterprise integration.

## Release Gate
A release can be marked `KAIF Core v1.0` only when all `MUST` items are complete and verified.

---

## 1) Protocol Core (MUST)

### 1.1 Token Exchange Contract
- [ ] `RFC 8693` token exchange flow documented with exact request/response examples.
- [ ] `subject_token` (human principal) and `actor_token` (workload identity) semantics are normatively defined.
- [ ] Delegation model explicitly states "act-under" (not impersonation).

### 1.2 Core Claim Set
- [ ] Required claims frozen and versioned.
- [ ] Required claims include: `iss`, `sub`, `aud`, `iat`, `exp`, `jti`, `scope`, `actor.sub`.
- [ ] mTLS confirmation claim is fixed and testable (`cnf.x5t#S256` or equivalent profile decision).
- [ ] Claim namespace split documented:
  - Core required claims
  - KAIF extensions (`kaif.*`) optional unless policy mandates

### 1.3 Token Lifetime and Scope
- [ ] Max token TTL and default TTL documented.
- [ ] Scope narrowing rule defined (`requested_scope ⊆ delegation_scope`).
- [ ] Delegation depth hard limit defined and enforced.

---

## 2) Verification Contract for Relying Parties (MUST)

### 2.1 Verification Steps
- [ ] Public verifier sequence published (deterministic order):
  1. Verify JWT signature and `kid` resolution
  2. Validate `iss` and `aud`
  3. Validate `exp/nbf/iat` with declared clock skew window
  4. Validate `jti` revocation/introspection
  5. Validate mTLS binding (`cnf` thumbprint vs TLS cert)
  6. Validate scope and optional trust policy

### 2.2 Error Taxonomy
- [ ] Standard error codes published (machine-readable):
  - `TOKEN_INVALID_SIGNATURE`
  - `TOKEN_EXPIRED`
  - `AUDIENCE_MISMATCH`
  - `TOKEN_REVOKED`
  - `CNF_BINDING_MISMATCH`
  - `SCOPE_DENIED`
- [ ] Retryability guidance per error code defined.

---

## 3) Revocation and Introspection (MUST)

### 3.1 Revocation Modes
- [ ] Threshold revocation behavior specified.
- [ ] Human-triggered revocation behavior specified.
- [ ] Scope-reduction behavior specified.

### 3.2 SLA/SLO
- [x] Revocation propagation SLOs declared (`P95`, `P99`, max bound).
- [x] Introspection endpoint availability SLO declared.
- [x] Failure mode policy documented (fail-open vs fail-closed by integration class).

---

## 4) Attestation and Identity Binding (MUST)


Section 3.2 deliverable:
- `KAIF-SLO-Revocation-Introspection-v1.md`

### 4.1 Workload Identity
- [ ] Supported attestation formats enumerated (X.509 SVID, JWT-SVID).
- [ ] Mapping from workload identity to `actor.sub` is deterministic and documented.

### 4.2 Human Principal Chain
- [ ] Human principal source-of-truth defined (OIDC IdP claims and stable subject rule).
- [ ] Delegation chain format frozen (single source for forensic replay).

---

## 5) Security and Threat Hardening (MUST)

### 5.1 Crypto and Key Management
- [ ] Accepted signing algorithms explicitly constrained (no `none`, no weak algs).
- [ ] JWKS rotation policy + cache invalidation behavior documented.
- [x] Key compromise response runbook documented.


Section 5.1 deliverable:
- `KAIF-Key-Compromise-Runbook-v1.md`

### 5.2 Replay and Abuse Protections
- [ ] Replay defense documented (`jti`, TTL, nonce/one-time semantics where applicable).
- [ ] Token flood and introspection abuse controls documented (rate limits, backoff).
- [ ] Delegation abuse and escalation protections documented.

### 5.3 Audit and Non-repudiation
- [ ] Audit event schema frozen for token issuance/access/revocation.
- [ ] Hash-chain verification procedure published.
- [ ] Tamper detection + quarantine response playbook linked.

---

## 6) Open Source Readiness (MUST)

### 6.1 Publication Hygiene
- [ ] Document status changed from confidential/internal wording to public release wording.
- [ ] License selected and published (spec + reference implementation + test kit).
- [ ] Governance model published (maintainers, review policy, versioning policy).

### 6.2 Compatibility Policy
- [ ] Versioning policy published (`MAJOR.MINOR.PATCH`) for spec and claims.
- [ ] Backward-compatibility guarantees defined for Core Profile.
- [ ] Deprecation policy and timeline template published.

---

## 7) Conformance and Test Kit (MUST)

### 7.1 Core Test Vectors
- [ ] Valid happy-path token exchange fixture.
- [ ] Expired token fixture.
- [ ] Wrong audience fixture.
- [ ] Revoked `jti` fixture.
- [ ] mTLS confirmation mismatch fixture.
- [ ] Scope overreach fixture.

### 7.2 Integration Harness
- [ ] CLI or test harness available to run conformance pack.
- [ ] Pass/fail output format standardized (JSON + human-readable summary).
- [ ] CI recipe published for partner self-validation.

---

## 8) Enterprise Adoption Pack (SHOULD)

### 8.1 Reference Integrations
- [ ] Stripe-like relying-party profile guide.
- [ ] Cloud profile guides (Azure/AWS/GCP) with exact mapping tables.
- [ ] Kubernetes deployment baseline with SPIRE and mTLS examples.

### 8.2 Operational Docs
- [ ] Incident response runbook (revocation storms, IdP outage, SPIRE outage).
- [ ] Capacity planning guidance (token QPS, introspection QPS, Redis/JWKS scaling).
- [ ] Observability dashboard baseline (latency, deny rates, revocation lag).

---

## 9) Acceptance Matrix (Release Decision)

### Core v1.0 must pass
- [ ] All Sections 1–7 MUST items complete.
- [ ] Security review signed off.
- [ ] Interop trial completed with at least 2 independent relying-party implementations.
- [ ] Conformance kit published and reproducible.

### Recommended before broad launch
- [ ] Section 8 SHOULD items materially complete.
- [ ] One external design partner case study completed.

---

## 10) Immediate Next Actions (Suggested sequence)

1. Freeze Core claim schema and verification contract.
2. Publish revocation/introspection SLOs and failure-mode policy.
3. Ship conformance fixtures + CLI harness.
4. Open-source package with license + governance docs.
5. Execute 2 design-partner pilots and capture deltas for v1.1.
