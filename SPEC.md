# KAIF Core Profile v1.0

**Status:** Alpha  
**Authors:** Geoff, Kindred Systems OS  
**License:** Apache 2.0

This document specifies the KAIF (Kindred Agent Identity Framework) Core Profile. Key words in this document are interpreted per [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119): MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT, RECOMMENDED, MAY, and OPTIONAL.

---

## 1. Abstract (informative)

KAIF defines a composable authentication and authorisation protocol for autonomous AI agents. It composes three existing standards — SPIFFE/SPIRE workload attestation, RFC 8693 OAuth 2.0 Token Exchange, and RFC 9068 JWT Access Tokens — into a unified credential that:

- Proves the workload identity of the executing agent via a SPIRE-issued JWT-SVID
- Traces authority to a named human principal who explicitly delegated it
- Encodes a live trust score governing token scope and time-to-live
- Supports auditable, revocable sub-delegation chains

KAIF does not replace SPIFFE, OAuth 2.0, or OIDC. It composes them.

---

## 2. Problem Statement (informative)

Autonomous AI agents executing tasks on behalf of human principals require credentials that satisfy four properties simultaneously:

1. **Workload-attested identity** — the credential must prove *which workload* is making the request, not merely which static secret was presented
2. **Human-principal traceability** — every agent action must be traceable to the human who authorised it
3. **Adaptive scope** — the set of permitted operations SHOULD vary with the agent's observed trust score
4. **Revocability** — any issued credential MUST be revocable in O(1) time without rotating long-lived secrets

No existing deployed standard satisfies all four. KAIF fills this gap.

---

## 3. Token Format (normative)

A KAIF Access Token is a compact JWS (JWT, RS256) containing the following claims.

### 3.1 Standard Claims

| Claim | Type | REQUIRED | Description |
|---|---|---|---|
| `iss` | string | MUST | KAIF server URL |
| `sub` | string | MUST | Human principal identifier (email or OIDC `sub`) |
| `aud` | string or string[] | MUST | Intended audience(s) |
| `iat` | number | MUST | Issued-at time (Unix seconds) |
| `exp` | number | MUST | Expiry time (Unix seconds); determined by trust tier |
| `jti` | string | MUST | UUID v4; used as denylist key |
| `scope` | string | MUST | Space-separated list of granted scopes |

### 3.2 Actor Claim

```json
"actor": {
  "sub":             "spiffe://trust-domain/workload/path",
  "svid_thumbprint": "sha256:<lowercase-hex>"
}
```

| Field | REQUIRED | Description |
|---|---|---|
| `actor.sub` | MUST | SPIFFE ID of the executing workload |
| `actor.svid_thumbprint` | MUST | RFC 8705 thumbprint of the JWT-SVID public key |

For token exchange, the validated JWT-SVID `sub` MUST match the subject token's `may_act.sub` or, if absent, `actor.sub`. A mismatch MUST be rejected with `access_denied`.

### 3.3 KAIF Extension Claims

```json
"kaif": {
  "trust_score":      0.82,
  "trust_tier":       "VERIFIED",
  "delegation_depth": 0,
  "delegation_id":    "550e8400-e29b-41d4-a716-446655440000",
  "rollback_window":  "PT15M",
  "principal_chain":  ["kindred@kindredsystems.ai"]
}
```

| Field | Type | REQUIRED | Description |
|---|---|---|---|
| `kaif.trust_score` | number [0.0, 1.0] | MUST | Agent trust score at time of issuance |
| `kaif.trust_tier` | string | MUST | `PROVISIONAL` / `STANDARD` / `VERIFIED` / `TRUSTED` |
| `kaif.delegation_depth` | integer >= 0 | MUST | Depth in delegation chain; 0 = direct human grant |
| `kaif.delegation_id` | UUID v4 | MUST | Links token to the originating delegation grant |
| `kaif.rollback_window` | ISO 8601 duration | MUST | Maximum lookback for audit chain verification |
| `kaif.principal_chain` | string[] | MUST | Human principals in the delegation chain, oldest first |

---

## 4. Verification Steps (normative)

A relying party receiving a KAIF token MUST perform the following checks in order. Failure at any step MUST result in rejection.

1. **Signature** — Verify the JWT signature using the KAIF server's JWKS from `/.well-known/jwks.json`. Implementations MUST NOT use a cached JWKS older than the `Cache-Control: max-age` value returned by the JWKS endpoint.

2. **Issuer** — Verify `iss` matches the known KAIF server URL. Implementations MUST reject tokens with an unexpected issuer.

3. **Expiry** — Verify `exp > now`. A clock skew tolerance of at most 10 seconds MAY be applied. Implementations MUST NOT apply a tolerance greater than 10 seconds.

4. **JTI denylist** — Verify the `jti` is not in the local revocation denylist. In strict mode, relying parties SHOULD call `POST /introspect` on every request.

5. **Scope** — Verify the token's `scope` contains the permission(s) required by the protected operation. Scope matching MUST use exact match or glob matching with `:` as the separator. Substring matching MUST NOT be used.

6. **Trust tier** — Verify `kaif.trust_tier` meets the minimum required by the operation. Implementations MAY enforce per-operation tier minimums.

---

## 5. Trust Tiers (normative)

| Tier | Score Range | Token TTL | Max Delegation Depth |
|---|---|---|---|
| `PROVISIONAL` | 0.00 – 0.49 | 300 s | 0 |
| `STANDARD` | 0.50 – 0.69 | 600 s | 1 |
| `VERIFIED` | 0.70 – 0.89 | 900 s | 2 |
| `TRUSTED` | 0.90 – 1.00 | 900 s | 3 |

Trust scores MUST be clamped to [0.0, 1.0] before tier resolution. A score of exactly 0.5 MUST resolve to `STANDARD`. Tier resolution uses the last tier whose `minScore ≤ score`.

---

## 6. Revocation Modes (normative)

### 6.1 Standard Mode

On revocation, the JTI MUST be added to a denylist with a TTL matching the token's remaining validity (`exp - now`). The denylist MUST NOT use infinite TTL. Relying parties check the denylist on each request (local cache) or on-demand.

### 6.2 Strict Mode (`KAIF_STRICT_REVOCATION=true`)

In strict mode, every token use triggers a `POST /introspect` call to the KAIF server. The server's response is authoritative. This provides real-time revocation at the cost of one additional network round-trip per request.

### 6.3 Revocation Propagation

KAIF servers MUST publish `RevocationEvent` messages to the `kaif:revocation` channel when a JTI is revoked. Multi-instance deployments MUST subscribe to this channel to maintain consistent denylist state across instances.

---

## 7. Attestation Binding (normative)

KAIF binds actor tokens to their key material using JWK Thumbprints per RFC 7638.

**For JWT-SVID actor tokens, the `cnf` claim SHALL contain a `jkt` member whose value is the JWK Thumbprint (SHA-256) of the public key that signed the JWT-SVID, computed per RFC 7638. Implementations MUST NOT use `x5t#S256` when the actor token is a JWT-SVID.**

When a TLS client certificate is presented during token exchange (RFC 8705 mTLS), the KAIF server MAY additionally include `cnf.x5t#S256` computed from the client certificate DER bytes.

Relying parties that enforce certificate binding MUST verify the `cnf` claim matches the presented credential. Relying parties that do not enforce binding SHOULD log a warning if `cnf` is absent.

---

## 8. Error Codes (normative)

All error responses MUST conform to RFC 6749 §5.2:

```json
{
  "error": "invalid_grant",
  "error_description": "subject_token is expired"
}
```

| Code | HTTP Status | Description |
|---|---|---|
| `invalid_request` | 400 | Malformed request; missing required parameter |
| `invalid_grant` | 400 | `subject_token` invalid, expired, or revoked |
| `invalid_client` | 401 | `actor_token` (JWT-SVID) invalid or expired |
| `invalid_scope` | 400 | Requested scope not permitted for this agent or grant |
| `insufficient_scope` | 403 | Bearer token lacks the scope required for a protected KAIF route |
| `insufficient_trust` | 403 | Agent trust score below tier minimum for this operation |
| `delegation_depth_exceeded` | 403 | Delegation depth exceeds agent's `max_delegation_depth` |
| `access_denied` | 403 | General authorisation failure |
| `server_error` | 500 | Internal error; stack traces MUST NOT be exposed |
| `too_many_requests` | 429 | Rate limit exceeded |

Implementations MUST NOT expose stack traces or internal system details in error responses.

---

## 9. Security Considerations (normative)

### 9.1 Token Logging

Implementations MUST NOT log token values. Log the `jti` only. Fastify redaction MUST cover `body.subject_token`, `body.actor_token`, `headers.authorization`, `body.token`, and `body.id_token`.

### 9.2 Key Management

The JWT signing private key MUST NOT leave process memory. It MUST NOT be written to logs, Redis, or any external storage. The key generation function MUST use the `_cachePromise` pattern to prevent concurrent callers from generating divergent keypairs, which would cause signature verification failures.

### 9.3 Clock Skew

Clock skew tolerance MUST be exactly 10 seconds. This value MUST NOT be configurable. Larger windows increase the attack surface for token replay.

### 9.4 Scope Matching

Scope validation MUST use exact match or glob matching. The glob separator is `:`. Substring matching MUST NOT be used — `vault:read:anthropic` must not match `vault:read:anthropic_key`.

### 9.5 SPIFFE ID Validation

SPIFFE ID format validation is REQUIRED before any ACL lookup. IDs not matching `spiffe://<trust-domain>/<path>` MUST be rejected. This prevents injection attacks via malformed SPIFFE IDs.

### 9.6 Redis Key TTL

All Redis denylist entries MUST use a TTL matching the token's remaining validity. Infinite TTL is prohibited and will cause unbounded memory growth.

### 9.7 Development Mode

`KAIF_DEV_MODE=true` bypasses IdP verification at `/provision` and MUST be rejected at startup when `NODE_ENV=production`. This guard is non-negotiable.

---

## 10. References

- [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) — Key words for use in RFCs
- [RFC 7519](https://www.rfc-editor.org/rfc/rfc7519) — JSON Web Token (JWT)
- [RFC 7638](https://www.rfc-editor.org/rfc/rfc7638) — JSON Web Key (JWK) Thumbprint
- [RFC 8693](https://www.rfc-editor.org/rfc/rfc8693) — OAuth 2.0 Token Exchange
- [RFC 8705](https://www.rfc-editor.org/rfc/rfc8705) — OAuth 2.0 Mutual TLS Certificate Binding
- [RFC 9068](https://www.rfc-editor.org/rfc/rfc9068) — JWT Profile for OAuth 2.0 Access Tokens
- [SPIFFE ID](https://github.com/spiffe/spiffe/blob/main/standards/SPIFFE-ID.md) — SPIFFE Identity Document
- [SPIRE](https://spiffe.io/docs/latest/spire-about/) — SPIFFE Runtime Environment
- [NIST SP 800-207](https://csrc.nist.gov/publications/detail/sp/800-207/final) — Zero Trust Architecture
