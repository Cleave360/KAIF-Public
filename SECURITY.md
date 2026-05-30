# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | ✓         |

---

## Reporting a Vulnerability

Email: **security@kindred.systems**

Please include:

- Description of the vulnerability
- Steps to reproduce
- Affected versions
- Potential impact

We follow coordinated disclosure. We will credit reporters in release notes unless anonymity is requested.

**Response SLA:**

| Severity | Acknowledge | Patch |
|---|---|---|
| Critical / High | 48 hours | 14 days |
| Medium | 48 hours | 60 days |
| Low | 48 hours | Next scheduled release |

---

## Scope

**In scope:**

- Token exchange endpoint authentication bypass
- Audit chain integrity bypass
- Trust score manipulation without legitimate signals
- SVID validation bypass
- JTI denylist circumvention
- Scope elevation (receiving scopes not in ACL)
- Delegation depth limit bypass

**Out of scope:**

- SPIRE server vulnerabilities — report to the [SPIFFE project](https://github.com/spiffe/spiffe/security)
- Redis vulnerabilities — report to [Redis](https://redis.io/security)
- Social engineering attacks
- Denial of service (rate limiting is best-effort in v0.1)

---

## Security Architecture

KAIF credentials are ephemeral by design: token TTLs are bounded by trust tier (300–900 seconds), every JTI is independently revocable in O(1) time, and the audit log forms a SHA-256 hash chain that detects tampering at any position. Trust score gating ensures that agents with degraded trust receive tokens with reduced scope and shorter TTLs automatically, without manual intervention.

See [SPEC.md §9](SPEC.md) for the full normative security requirements.

---

## Deployment Security Gate (Grounded + Falsifiable)

Security approval for production deployment should be based on objective, testable criteria.

| Criterion | Go Now Threshold | Pilot Threshold | Hold Trigger |
|---|---|---|---|
| Critical auth findings | 0 open | 0 open, medium findings tracked | Any open critical or high bypass finding |
| Revocation enforcement | p99 revoke-to-deny under 5s | p99 under 30s | p99 above 30s or unstable under load |
| Conformance MUST set | 100% pass on 2 independent implementations | 100% pass on 1 implementation | Any MUST failure |
| Audit integrity | Continuous automated chain verification | Daily verification + alerting | Missing verification or repeated breaks |
| Abuse-case drills | Completed and signed off | In progress with dated closure plan | Not scheduled or failed with no remediation |

Falsifiability checks:
- If red-team token theft produces blast radius comparable to static API keys, the architecture claim is not validated.
- If revocation benchmarks do not improve incident containment versus baseline, revocation strategy is not validated.
- If independent implementations cannot pass the same MUST fixtures, interoperability claims are not validated.

---

## Consumer-Grade Profile Strategy (Low Friction + High Robustness)

Consumer-facing agent deployments may require a separate delivery model while retaining KAIF security invariants.

Governance options:
- Branch model: maintain a `consumer-profile` branch in this repository for rapid iteration.
- Repository model: publish a separate `kaif-consumer-profile` repository with independent release policy and threat model.

Low-friction controls:
- SDK-first default flow with minimal configuration and safe fallback behavior.
- Managed identity bootstrap and automated key rotation; avoid manual trust-plane setup for app teams.
- Predefined policy bundles for common consumer actions instead of unconstrained custom scope strings.

High-robustness controls (non-negotiable):
- Keep short-lived tokens and enforce JTI revocation.
- Preserve immutable audit-chain guarantees and verification tooling.
- Enforce actor-to-authority binding and strict delegation constraints.
- Preserve compatibility with KAIF Core Profile MUST conformance fixtures.

Promotion gates for consumer profile GA:
- 30-day pilot with no unresolved high-severity auth issues.
- Published latency/error SLO attainment for token issuance and revocation enforcement.
- Independent adversarial review completed and accepted.

---

## Key Management Note

The `_cachePromise` pattern in `packages/server/src/crypto/keys.ts` prevents a concurrency race where two concurrent callers could each generate a different RSA keypair. If this race were allowed, some issued JWTs would be signed with a key that no longer matches the JWKS endpoint, causing silent verification failures for relying parties — without any error visible to the KAIF server. Do not modify key loading logic without reading this note and understanding the race first.

---

## PGP Key

PGP fingerprint: *(to be published before v1.0 GA)*

Until then, encrypt sensitive reports using the public key posted on [keybase.io/kindredsystems](https://keybase.io).
