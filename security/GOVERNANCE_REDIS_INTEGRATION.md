# Governance Redis Integration Plan

Status: integration contract draft
Date: 2026-05-21

KAIF is the external receiver for the agentic handshake. The governance engine can decide policy, trust scoring, and tenant posture, but KAIF must remain the component that validates the SPIRE-attested actor, redeems the human delegation grant, and issues the bounded access token.

## Production Boundary

- KAIF production/staging must use a dedicated Redis host or managed instance.
- Shared Redis is acceptable only for local development speed.
- A separate Redis DB/index on a shared server is not enough for production isolation.
- KAIF Redis requires TLS, ACLs, dedicated credentials, backups, and retention settings owned by the KAIF deployment.
- Governance engine Redis remains separately restartable, observable, and governed by its own retention policy.
- KAIF keys stay namespaced with `kaif:*` even when Redis is dedicated.

## Tenant Address

Set `KAIF_TENANT_ADDRESS` when KAIF is attached to a governance tenant. The value should be the tenant address used by the governance engine to identify the KAIF receiver.

Current implementation status:

- `loadConfig()` accepts optional `KAIF_TENANT_ADDRESS`.
- Day 7b evidence reports include the tenant address when set.
- The exact production value is pending from the governance-engine repo/config.

## Integration Pattern

Preferred production pattern:

1. Governance engine emits tenant policy/trust signals through an API or a dedicated bridge.
2. KAIF consumes only the specific signals needed for token issuance, revocation, and trust-tier decisions.
3. KAIF stores derived runtime state in its own Redis under `kaif:*`.
4. Audit evidence records the governance signal version or decision ID, not raw cross-system secrets.
5. Redis credentials are never shared between KAIF and the governance engine in production.

Avoid this production pattern:

- KAIF directly reading and writing the governance engine's primary Redis.
- Governance engine directly mutating KAIF token, revocation, audit, or lock keys.
- Sharing a Redis instance and relying only on logical DB numbers for isolation.

## Signal Contract To Finalize

The governance integration needs a small explicit contract before implementation:

- Governance repo path.
- Exact `KAIF_TENANT_ADDRESS` value.
- Trust signal schema and versioning.
- Redis stream/key names, if a stream bridge is selected.
- Expected failure policy when governance signals are unavailable.
- Whether KAIF should use API pull, stream subscribe, or a one-way replication bridge.
- Tenant-specific retention and audit export requirements.

## Failure Policy

KAIF token issuance should fail closed for Class A operations when required governance signals are unavailable. Lower-criticality Class C paths can use a documented degraded policy only if the relying party explicitly allows it and the Day 7b report marks the degraded decision.

Day 7b `DAY7B-008` is reserved for this behavior. It remains incomplete until Class A and Class C relying-party failure-mode endpoints exist and are wired into the evidence runner.
