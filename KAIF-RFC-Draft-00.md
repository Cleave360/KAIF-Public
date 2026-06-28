# KAIF: Kindred Agent Identity Framework

**Internet-Draft**  
**Expires: 27 December 2026**

| | |
|---|---|
| **Intended Status** | Standards Track |
| **Author** | Geoffrey Lundholm |
| **Organization** | Kindred Systems |
| **Date** | 27 June 2026 |
| **IPR Disclosure** | IETF Trust Legal Provisions (BCP 78) |

## Abstract

The Kindred Agent Identity Framework (KAIF) is an OAuth 2.0 token exchange mechanism for delegated agent-to-service authorization, combining RFC 8693 token exchange with SPIFFE workload identity attestation and operator-defined authorization tiers.

This document specifies KAIF's protocol mechanics, deployment profiles, and interoperability requirements for systems implementing agent authorization with audit accountability. KAIF is intended for scenarios where an operator (human principal) provisionally authorizes an agent (automated workload) to perform bounded actions on their behalf, with cryptographic proof of authorization, delegation depth tracking, and real-time revocation.

**Status of This Memo**

This Internet-Draft is submitted in full conformance with the provisions of BCP 78 and BCP 79.

Internet-Drafts are working documents of the Internet Engineering Task Force (IETF), its areas, and its working groups. Note that other groups may also distribute working documents as Internet-Drafts. The list of current Internet-Drafts is at https://datatracker.ietf.org/drafts/current/.

Internet-Drafts are draft documents valid for a maximum of six months and may be updated, replaced, or obsoleted by other documents at any time. It is inappropriate to use Internet-Drafts as reference material or to cite them other than as "work in progress".

## 1. Introduction

### 1.1 Problem Statement

Contemporary system architectures increasingly rely on autonomous agents—both AI-driven and workflow-based—to execute actions on behalf of human operators in complex, distributed environments. Current authorization models present several challenges:

1. **Coarse-grained control**: Traditional API keys or static tokens provide no granularity on what actions an agent may perform.
2. **Limited auditability**: It is difficult to correlate which agent executed which action, especially in delegated scenarios.
3. **Revocation latency**: Certificate-based models suffer from multi-minute revocation propagation delays.
4. **Workload identity opacity**: There is no standardized way for an authorization service to verify which workload is requesting access.

KAIF addresses these challenges by composing three existing standards:

- **RFC 8693**: OAuth 2.0 Token Exchange for subject-actor separation
- **SPIFFE/SPIRE**: Cryptographic workload identity and JWT-SVID attestation
- **Operator-defined tiers**: A flexible authorization model that avoids hard-coded trust assumptions

### 1.2 Scope and Intended Deployment

KAIF is designed for operator-initiated, agent-executed, boundary-crossing transactions. A "boundary-crossing transaction" is any action where:

- The agent is acting on behalf of a human principal (operator)
- The action modifies state in an external system (payment, API mutation, purchase)
- Regulatory, financial, or security audit requirements require proof of authorization

**Not in scope for v1.0:**

- Behavioral trust scoring (agent action pattern analysis)
- Peer reputation models
- Long-running streaming delegations
- Cross-operator federation (see v2.0 roadmap)

### 1.3 Conventions and Terminology

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in BCP 14 [RFC2119] [RFC8174] when, and only when, they appear in all capitals, as shown here.

**KAIF-specific terms:**

- **Operator**: A human principal (person) who authorizes an agent to act on their behalf.
- **Agent**: An automated workload (software) with a SPIFFE identity that executes actions on behalf of an operator.
- **Boundary Crossing**: An action that crosses a trust boundary—e.g., calling an external API, initiating a payment, or writing to a regulated log.
- **Authorization Tier**: An operator-assigned permission level (PROVISIONAL, STANDARD, VERIFIED, TRUSTED) that determines token TTL and delegation depth.
- **Delegation Depth**: The count of intermediate agents in a delegation chain (depth 0 = direct operator→agent, depth 1 = operator→agent1→agent2).
- **Revocation**: Immediate invalidation of a token via JTI (JWT ID) denylist.
- **Relying Party**: A third-party service that validates KAIF tokens without running a KAIF server instance.

## 2. Protocol Overview

### 2.1 Three-Party Model

```
┌────────────┐
│  Operator  │ (human, OIDC-authenticated)
│ (John@co)  │
└──────┬─────┘
       │
       │ 1. Provision delegation grant
       │ (OIDC id_token → delegation JWT)
       ▼
┌──────────────────────┐
│   KAIF Server        │
│   (Authorization     │
│    Authority)        │
└─────────────────────┬┘
       ▲               │
       │               │ 2. Token Exchange (RFC 8693)
       │               │ (delegation JWT + SVID → access token)
       │               ▼
       │         ┌──────────────┐
       │         │   Agent      │
       │         │  (SPIFFE     │
       │         │   identity)  │
       │         └──────┬───────┘
       │                │
       │                │ 3. Use token at relying party
       │                │
       │                ▼
       │         ┌──────────────┐
       │         │ Relying      │
       │         │ Party        │
       └────────-│ (e.g.,       │
                 │  Payment API)│
                 └──────────────┘
```

### 2.2 Delegation Grant (Subject Token)

An operator provisions a delegation grant—a signed JWT that authorizes an agent to request access tokens. The grant is issued by the KAIF server and contains:

```
{
  "iss": "https://auth.example.com",
  "sub": "operator@example.com",
  "aud": "spiffe://example.com/agent/lyra",
  "iat": 1719489600,
  "exp": 1719493200,
  "jti": "550e8400-e29b-41d4-a716-446655440000",
  "scope": "invoke:completion vault:read:anthropic_key",
  "delegation_id": "d-550e8400-e29b-41d4-a716-446655440000",
  "may_act": {
    "sub": "spiffe://example.com/agent/lyra"
  }
}
```

### 2.3 Token Exchange Request (RFC 8693)

The agent exchanges the delegation grant (subject_token) and its SPIFFE identity JWT-SVID (actor_token) for an access token:

```
POST /oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=urn:ietf:params:oauth:grant-type:token-exchange
&subject_token=<delegation-grant-jwt>
&subject_token_type=urn:ietf:params:oauth:token-type:access_token
&actor_token=<svid-jwt>
&actor_token_type=urn:ietf:params:oauth:token-type:jwt
&scope=invoke:completion
&audience=urn:example:payment-api
```

### 2.4 KAIF Access Token (Response)

The server responds with a signed JWT containing both operator and agent identity, delegation depth, tier, and scope:

```
{
  "iss": "https://auth.example.com",
  "sub": "operator@example.com",
  "aud": "urn:example:payment-api",
  "iat": 1719489600,
  "exp": 1719493200,
  "jti": "650e8400-e29b-41d4-a716-446655440001",
  "scope": "invoke:completion",
  "actor": {
    "sub": "spiffe://example.com/agent/lyra",
    "svid_thumbprint": "sha256:a1b2c3d4..."
  },
  "may_act": {
    "sub": "spiffe://example.com/agent/lyra"
  },
  "kaif": {
    "authorization_tier": "STANDARD",
    "authorization_tier_value": 0.65,
    "delegation_depth": 0,
    "delegation_id": "d-550e8400-e29b-41d4-a716-446655440000",
    "rollback_window": "PT10M",
    "principal_chain": ["operator@example.com"]
  }
}
```

### 2.5 Validation Flow

When an agent uses the access token at a relying party:

```
Agent → Relying Party: "Use this token to execute transaction"
        ↓
        Relying Party checks:
        1. Token signature valid against KAIF issuer JWKS ✓
        2. Token not expired ✓
        3. Token not in revocation denylist (call KAIF /introspect) ✓
        4. Scope permits requested action ✓
        5. Delegation depth within policy ✓
        ↓
        Relying Party: "AUTHORIZED" → execute transaction
        ↓
        Relying Party → KAIF Server: Log receipt/audit event
```

## 3. Detailed Protocol Specification

### 3.1 Endpoint: POST /provision

**Purpose**: Operator provisions a delegation grant to an agent.

**Request**:
```json
{
  "id_token": "eyJhbGc...",
  "agent_id": "lyra",
  "scope": "invoke:completion vault:read:anthropic_key",
  "ttl_seconds": 600
}
```

**Validation**:
- `id_token` MUST be a valid OIDC token from configured IdP
- `agent_id` MUST be registered in operator's ACL
- `scope` MUST be a subset of agent's permitted scopes
- `ttl_seconds` MUST be between 60 and 86400

**Response**:
```json
{
  "delegation_id": "d-550e8400-e29b-41d4-a716-446655440000",
  "delegation_token": "eyJhbGc...",
  "expires_at": 1719493200,
  "agent_id": "lyra",
  "scope": "invoke:completion vault:read:anthropic_key"
}
```

**Errors**:
- `invalid_request` (400): Missing required fields
- `invalid_grant` (400): id_token invalid or expired
- `access_denied` (403): Operator not authorized for agent or scope

### 3.2 Endpoint: POST /oauth/token

**Purpose**: RFC 8693 token exchange (agent requests access token).

**Request**:
```
grant_type=urn:ietf:params:oauth:grant-type:token-exchange
&subject_token=<delegation-jwt>
&subject_token_type=urn:ietf:params:oauth:token-type:access_token
&actor_token=<svid-jwt>
&actor_token_type=urn:ietf:params:oauth:token-type:jwt
&scope=invoke:completion
&audience=urn:example:payment-api
```

**Validation Steps** (in order):

1. Parse and validate subject_token (delegation grant)
   - MUST have valid signature from KAIF issuer
   - MUST not be expired (with 10s clock skew tolerance)
   - MUST not be in JTI revocation denylist
   
2. Parse and validate actor_token (JWT-SVID)
   - MUST have valid signature from SPIRE bundle
   - MUST not be expired
   - SPIFFE ID MUST be registered in ACL
   
3. Validate scope
   - MUST be subset of subject_token scope
   - MUST be subset of actor's permitted scopes (ACL)
   - MUST use glob matching (e.g., "vault:read:*" matches "vault:read:key")
   
4. Check authorization tier
   - Fetch operator-assigned authorization tier (default 0.5 = STANDARD)
   - MUST meet agent's minimum tier requirement
   - Determine token TTL based on tier
   
5. Compute delegation depth
   - If subject_token is direct provision: depth = 0
   - If subject_token is access token from prior exchange: depth = subject.kaif.delegation_depth + 1
   - MUST not exceed: min(actor ACL depth limit, tier depth limit)
   
6. Mint access token with RS256 signature

**Response**:
```json
{
  "access_token": "eyJhbGc...",
"issued_token_type": "urn:ietf:params:oauth:token-type:access_token",
  "token_type": "Bearer",
  "expires_in": 600,
  "scope": "invoke:completion"
}
```

**Errors**:
- `invalid_request` (400): Malformed request
- `invalid_grant` (400): subject_token invalid/expired/revoked
- `invalid_scope` (400): Scope not permitted
- `invalid_client` (401): actor_token invalid
- `insufficient_trust` (403): Authorization tier below minimum
- `delegation_depth_exceeded` (403): Depth would exceed limit

### 3.3 Endpoint: POST /introspect

**Purpose**: RFC 7662 token introspection (for relying parties to verify tokens in real-time).

**Request**:
```json
{
  "token": "eyJhbGc..."
}
```

**Response** (if active):
```json
{
  "active": true,
  "sub": "operator@example.com",
  "aud": "urn:example:payment-api",
  "iat": 1719489600,
  "exp": 1719493200,
  "scope": "invoke:completion",
  "actor": {
    "sub": "spiffe://example.com/agent/lyra"
  },
  "kaif": {
    "authorization_tier": "STANDARD",
    "delegation_depth": 0
  }
}
```

**Response** (if revoked or invalid):
```json
{
  "active": false
}
```

### 3.4 Endpoint: POST /revoke

**Purpose**: Operator revokes a token immediately.

**Request**:
```json
{
  "token": "eyJhbGc...",
  "reason": "operator_request"
}
```

**Response**:
```json
{
  "revoked": true,
  "jti": "650e8400-e29b-41d4-a716-446655440001"
}
```

**Mechanics**:
- Extract JTI from token
- Add to Redis denylist with TTL = token.exp
- Publish to revocation channel for multi-instance sync
- Write audit entry

### 3.5 Endpoint: GET /.well-known/jwks.json

**Purpose**: Public JWKS for external relying parties.

**Response**:
```json
{
  "keys": [
    {
      "kty": "RSA",
      "use": "sig",
      "kid": "2024-06-27-primary",
      "n": "0vx7agoebGcQ...",
      "e": "AQAB",
      "alg": "RS256"
    },
    {
      "kty": "RSA",
      "use": "sig",
      "kid": "2024-06-15-retained",
      "n": "xjlCRBfn...",
      "e": "AQAB",
      "alg": "RS256"
    }
  ]
}
```

**Caching**: MUST set `Cache-Control: max-age=3600`

### 3.6 Endpoint: GET /.well-known/kaif-metadata.json

**Purpose**: Operator-provided metadata for relying parties (KAIF v1.1+).

**Response**:
```json
{
  "issuer": "https://auth.example.com",
"authorization_endpoint": "https://auth.example.com/oauth/authorize",
  "token_endpoint": "https://auth.example.com/oauth/token",
  "introspection_endpoint": "https://auth.example.com/introspect",
  "revocation_endpoint": "https://auth.example.com/revoke",
  "jwks_uri": "https://auth.example.com/.well-known/jwks.json",
  "supported_grant_types": [
    "urn:ietf:params:oauth:grant-type:token-exchange"
  ],
  "token_endpoint_auth_methods_supported": ["none"],
  "response_types_supported": [],
  "scopes_supported": [
    "invoke:completion",
    "vault:read",
    "admin:revoke"
  ],
  "token_endpoint_auth_methods": ["none"],
  "kaif": {
    "authorization_tiers": [
      {
        "tier": "PROVISIONAL",
        "min_value": 0.0,
        "max_value": 0.49,
        "token_ttl": 300,
        "max_delegation_depth": 0
      },
      {
        "tier": "STANDARD",
        "min_value": 0.5,
        "max_value": 0.69,
        "token_ttl": 600,
        "max_delegation_depth": 1
      },
      {
        "tier": "VERIFIED",
        "min_value": 0.7,
        "max_value": 0.89,
        "token_ttl": 900,
        "max_delegation_depth": 2
      },
      {
        "tier": "TRUSTED",
        "min_value": 0.9,
        "max_value": 1.0,
        "token_ttl": 900,
        "max_delegation_depth": 3
      }
    ],
    "revocation_propagation_sla_ms": 100,
    "audit_log_retention_days": 90
  }
}
```

## 4. Authorization Tier Model

KAIF uses operator-assigned authorization tier values (0.0–1.0) to determine access permissions:

| Tier | Range | Token TTL | Max Depth | Use Case |
|------|-------|-----------|-----------|----------|
| PROVISIONAL | 0.0–0.49 | 300s | 0 | New agents, limited trust |
| STANDARD | 0.5–0.69 | 600s | 1 | Established agents |
| VERIFIED | 0.7–0.89 | 900s | 2 | High-confidence agents |
| TRUSTED | 0.9–1.0 | 900s | 3 | Critical operators, full delegation |

**Setting tier values**:

Operators assign tier values to agents based on their operational context (not automated behavioral scoring in v1.0). For example:

- New agent: 0.3 (PROVISIONAL, untested)
- Stable agent with 6 months history: 0.6 (STANDARD)
- Agent in production payment path: 0.85 (VERIFIED)
- Root operator with full authority: 1.0 (TRUSTED)

## 5. Scope Model

KAIF scopes follow OAuth 2.0 conventions with glob-pattern support:

```
scope ::= scope-name ( ":" scope-name )*
scope-name ::= identifier | "*"
```

**Examples**:

- `invoke:completion` — Invoke a specific completion (exact match)
- `vault:read:*` — Read any vault key (glob)
- `admin:*` — All admin operations (glob)
- `vault:read:anthropic_key` — Read one specific key (exact match)

**Validation**: Use micromatch library for glob pattern matching. Exact matches take precedence.

## 6. Delegation Depth and Sub-Delegation

An agent MAY create a delegation chain by using its access token as the subject_token in a second token exchange, creating a sub-delegated token.

**Rules**:

- Depth 0: Operator → Agent (direct)
- Depth 1: Operator → Agent1 → Agent2 (sub-delegation)
- Depth N: Limited by min(ACL max_depth, authorization_tier max_depth)

**Restrictions**:

- Parent token's `may_sub_delegate` flag MUST be true
- Parent token MUST be in VERIFIED or TRUSTED tier
- Sub-delegated token scope MUST be subset of parent scope
- Depth MUST be strictly increasing (no cycles)

**Example**:

```
1. Operator authorizes Agent1
  (depth 0, may_sub_delegate: true, scope: invoke:*)
  -> token T1 with delegation_depth: 0

2. Agent1 uses T1 as subject_token to request sub-delegation for Agent2
  -> verify T1.may_sub_delegate = true
  -> verify T1.delegation_depth + 1 <= ACL max
  -> issue token T2 with delegation_depth: 1
    principal_chain: [operator, agent1]

3. Agent2 attempts to sub-delegate to Agent3
  -> check T2.delegation_depth + 1 <= ACL max
  -> issue token T3 with delegation_depth: 2
```

## 7. Audit and Non-Repudiation

Every KAIF operation appends an immutable audit entry using SHA-256 hash chaining:

```
entry = {
  id: UUID v4,
  ts: ISO 8601,
  action:
    "DELEGATION_PROVISIONED" |
    "TOKEN_ISSUED" |
    "TOKEN_REVOKED" |
    ...,
  agent_id: SPIFFE ID,
  human_id: operator email,
  detail: JSON,
  hash: SHA256(prev_hash | ts | action | detail),
  prev_hash: hash of previous entry
}
```

**Verification**:

External parties can verify audit chain integrity by replaying the hash computation:

```
expected_hash = SHA256(prev_hash | ts | action | detail)
assert actual_hash == expected_hash
```

## 8. Revocation and Propagation

KAIF provides two revocation models:

### 8.1 Lazy Revocation (Default)

Relying parties cache tokens and check expiry locally. Revocation is eventual—denylist is checked on next refresh.

**Latency**: Minutes (depends on token cache TTL)

### 8.2 Strict Revocation

Relying parties call `/introspect` on every token use to check real-time revocation status.

**Latency**: <100ms (Redis denylist lookup)

Operators choose strict vs. lazy based on their risk tolerance and throughput requirements.

### 8.3 HA-Backed Revocation Stores

KAIF deployments commonly back the JTI denylist and audit chain with a managed Redis service.

When the backing store is a managed HA service that does not expose customer-triggerable restart or failover operations, implementations MUST validate continuity through client-observable behavior rather than cluster control-plane actions.

At minimum, a conformant deployment using such a service MUST demonstrate:

- Redis client reconnect after transient disconnect
- Denylist persistence across reconnect
- Audit hash-chain continuity across reconnect
- Resumption of successful writes after reconnect

For Azure Managed Redis Enterprise specifically, customer-triggerable restart and failover operations are not exposed on the `Microsoft.Cache/redisEnterprise` resource path used by this profile. Therefore, conformance for revocation propagation and audit continuity on that platform MUST be established via reconnect and state-continuity tests, not forced failover tests.

## 9. Security Considerations

### 9.1 Token Binding (RFC 8705)

KAIF SHOULD support mutual TLS (mTLS) token binding. When an agent presents a client certificate, KAIF MUST include:

```json
"cnf": {
  "x5t#S256": "sha256:a1b2c3d4..."
}
```

The relying party MUST verify that the mTLS handshake certificate thumbprint matches the token's `cnf` value.

### 9.2 Clock Skew

All timestamp validation MUST use 10-second clock skew tolerance (not configurable).

### 9.3 Key Rotation

KAIF MUST support zero-downtime key rotation by maintaining both active and retained keys in the JWKS. Relying parties MUST accept tokens signed with either key for a retention period (recommended: 7 days).

### 9.4 SPIFFE Trust Domain Validation

KAIF MUST validate that actor_token SPIFFE ID matches the configured SPIRE trust domain. Mismatched trust domains MUST be rejected with `invalid_client`.

### 9.5 Scope Validation

Scope validation MUST use exact-match-first, then glob matching. Substring matching MUST NOT be used (e.g., "vault:read" does NOT match "vault:read:key").

### 9.6 Logging and Redaction

KAIF implementations MUST:
- Log JTI (not token values)
- Redact `subject_token`, `actor_token`, `authorization` headers in HTTP logs
- Never log private key material
- Include request ID for tracing

## 10. Relying Party Profile (Normative)

A third-party service that accepts KAIF tokens MUST implement:

### 10.1 Token Validation

```
1. Fetch JWKS from issuer's /.well-known/jwks.json (cache 3600s)
2. Verify token signature using KID matching (try each key)
3. Verify exp > now (with 10s clock skew)
4. If lazy revocation: done
5. If strict revocation: POST /introspect to check JTI denylist
6. Extract scope, verify requested action is permitted
7. Extract actor.sub (SPIFFE ID), log for audit trail
```

### 10.2 Error Handling

| Condition | Action | HTTP Status |
|-----------|--------|-------------|
| Signature invalid | Reject | 401 Unauthorized |
| Expired | Reject | 401 Unauthorized |
| Revoked (strict mode) | Reject | 401 Unauthorized |
| Scope insufficient | Reject | 403 Forbidden |
| Introspect unreachable (strict mode) | Degrade or reject (policy choice) | 503 Service Unavailable |

### 10.3 Audit Trail

Relying parties SHOULD log:
- Timestamp of token use
- JTI
- Actor SPIFFE ID
- Scope used
- Action executed
- Result (success/failure)

This enables cross-party forensics if a token is misused.

## 11. Backward Compatibility

This is KAIF v1.0 (initial standards track). Future versions:

- **v1.1**: Issuer metadata endpoint (`.well-known/kaif-metadata.json`)
- **v2.0**: Multi-issuer federation, cross-operator delegation
- **v3.0**: Behavioral trust signals (optional, opt-in per operator)

Implementations MUST gracefully ignore unrecognized claims in KAIF tokens to allow forward compatibility.

## 12. IANA Considerations

This document registers the following with IANA:

### 12.1 OAuth 2.0 Grant Type

**Type**: urn:ietf:params:oauth:grant-type:token-exchange (RFC 8693)

**Description**: Token exchange grant (already registered, KAIF profiles its use)

### 12.2 JWT Claims

**Claim name**: `kaif`  
**Claim description**: Container for KAIF-specific claims (authorization_tier, delegation_depth, principal_chain)  
**JWT claims registry**: Requested

## 13. Conformance

An implementation claims KAIF v1.0 conformance if it:

1. ✅ Implements POST /oauth/token with RFC 8693 semantics
2. ✅ Implements POST /introspect with RFC 7662 semantics
3. ✅ Validates actor_token as JWT-SVID from SPIRE bundle
4. ✅ Enforces scope glob matching (via micromatch or equivalent)
5. ✅ Supports delegation depth tracking and enforcement
6. ✅ Publishes JWKS with active + retained keys
7. ✅ Maintains audit trail with SHA-256 hashing
8. ✅ Supports JTI revocation with sub-second propagation
9. ✅ Validates 10-second clock skew (no more)
10. ✅ Passes KAIF conformance test suite

Conformance is verified by passing the test fixtures in [kaif-conformance-kit] (TBD).

### 13.1 Revocation-Store Resilience Profile

If a deployment uses a managed Redis service for denylist and audit persistence, conformance evidence SHOULD include a revocation-store resilience profile.

That profile SHOULD verify:

1. Redis client reconnect recovery
2. Denylist persistence after reconnect
3. Audit chain `prev_hash` continuity after reconnect
4. Successful new delegation, token issuance, and revocation writes after reconnect

If the platform does not expose customer-triggerable failover or restart operations, the implementation MUST document that limitation and MAY satisfy this profile using client-side disconnect and reconnect simulation plus state verification.

## 14. References

### Normative References

- [RFC2119] Bradner, S., "Key words for use in Protocols to Indicate Requirement Levels", BCP 14, RFC 2119, DOI 10.17487/RFC2119, March 1997, <https://www.rfc-editor.org/rfc/rfc2119.html>.

- [RFC6234] Eastlake 3rd, D. and T. Hansen, "US Secure Hash and HMAC: SHA and SHA-based HMAC and HKDF", RFC 6234, DOI 10.17487/RFC6234, May 2011, <https://www.rfc-editor.org/rfc/rfc6234.html>.

- [RFC7231] Fielding, R. and J. Reschke, "Hypertext Transfer Protocol (HTTP/1.1): Semantics and Content", RFC 7231, DOI 10.17487/RFC7231, June 2014, <https://www.rfc-editor.org/rfc/rfc7231.html>.

- [RFC7517] Jones, M., "JSON Web Key (JWK)", STD 81, RFC 7517, DOI 10.17487/RFC7517, May 2015, <https://www.rfc-editor.org/rfc/rfc7517.html>.

- [RFC7662] Richer, J., Ed., "OAuth 2.0 Token Introspection", RFC 7662, DOI 10.17487/RFC7662, October 2015, <https://www.rfc-editor.org/rfc/rfc7662.html>.

- [RFC8174] Leiba, B., "Ambiguity of Uppercase vs Lowercase in RFC 2119 Key Words", BCP 14, RFC 8174, DOI 10.17487/RFC8174, May 2018, <https://www.rfc-editor.org/rfc/rfc8174.html>.

- [RFC8693] Jones, M., Denniss, F., and B. Campbell, "OAuth 2.0 Token Exchange", STD 96, RFC 8693, DOI 10.17487/RFC8693, August 2020, <https://www.rfc-editor.org/rfc/rfc8693.html>.

### Informative References

- [RFC7636] Sakimura, N., Bradley, J., and N. Agarwal, "Proof Key for Public OAuth 2.0 Authorization Code Exchange (PKCE)", RFC 7636, DOI 10.17487/RFC7636, September 2015, <https://www.rfc-editor.org/rfc/rfc7636.html>.

- [RFC8705] Campbell, B., Bradley, J., Sakimura, N., and T. Lodderstedt, "OAuth 2.0 Mutual-TLS Client Authentication and Certificate-Bound Access Tokens", RFC 8705, DOI 10.17487/RFC8705, February 2020, <https://www.rfc-editor.org/rfc/rfc8705.html>.

- [SPIFFE] CNCF, "Secure Production Identity Framework for Everyone", <https://spiffe.io/>.

- [SPIRE] CNCF, "SPIFFE Runtime Environment", <https://spiffe.io/docs/latest/spire/>.

---

**Author's Address**

Geoffrey Lundholm  
Kindred Systems  
London, United Kingdom  
Email: kindred@kindredsystems.ai

---

**Version History**

- v0.0 (2026-06-27): Initial draft, WIP for standardization feedback
