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

## Key Management Note

The `_cachePromise` pattern in `packages/server/src/crypto/keys.ts` prevents a concurrency race where two concurrent callers could each generate a different RSA keypair. If this race were allowed, some issued JWTs would be signed with a key that no longer matches the JWKS endpoint, causing silent verification failures for relying parties — without any error visible to the KAIF server. Do not modify key loading logic without reading this note and understanding the race first.

---

## PGP Key

PGP fingerprint: *(to be published before v1.0 GA)*

Until then, encrypt sensitive reports using the public key posted on [keybase.io/kindredsystems](https://keybase.io).
