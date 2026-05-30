# Governance Redis Integration Plan

Status: integration contract accepted for current dev integration
Date: 2026-05-21

KAIF is the external receiver for the agentic handshake. The governance engine can decide policy, trust scoring, and tenant posture, but KAIF must remain the component that validates the SPIRE-attested actor, redeems the human delegation grant, and issues the bounded access token.

Current Adaptive governance repo:

- `/Users/geofflundholm/Documents/adaptive_layer`

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
- Current dev integration uses `KAIF_TENANT_ADDRESS=tenant-dev`.
- Production should keep the same tenant-slug model, for example `acme-prod`.

The Adaptive evidence stream for the current tenant is:

- `audit:auth:tenant-dev:<yyyy-mm-dd>`

## Integration Pattern

Preferred production pattern:

1. KAIF posts auth-layer evidence to Adaptive through `POST /v1/audit/append`.
2. KAIF sets `layer = "auth"` and `envelope.tenant_id = KAIF_TENANT_ADDRESS`.
3. KAIF stores derived runtime state in its own Redis under `kaif:*`.
4. Audit evidence records the governance signal version or decision ID, not raw cross-system secrets.
5. Redis credentials are never shared between KAIF and the governance engine in production.

Avoid this production pattern:

- KAIF directly reading and writing the governance engine's primary Redis.
- Governance engine directly mutating KAIF token, revocation, audit, or lock keys.
- Sharing a Redis instance and relying only on logical DB numbers for isolation.

## Adaptive Auth Evidence Contract

Endpoint:

- `POST /v1/audit/append`

Canonical payload:

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

KAIF uses `KAIF_GOVERNANCE_AUDIT_APPEND_URL` for the full Adaptive endpoint URL. `KAIF_GOVERNANCE_WORKSPACE_ID`, `KAIF_GOVERNANCE_PROJECT_ID`, and `KAIF_GOVERNANCE_UI_INSTANCE_ID` default to `ws-kaif`, `kaif`, and `ui-kaif`.

## Failure Policy

KAIF token issuance should fail closed for Class A operations when required governance signals are unavailable. Lower-criticality Class C paths can use a documented degraded policy only if the relying party explicitly allows it and the Day 7b report marks the degraded decision.

Day 7b `DAY7B-008` uses these KAIF test-surface relying-party endpoints:

- `POST /relying/class-a/authorize`
- `POST /relying/class-c/authorize`

Required behavior when governance evidence append is unavailable:

- Class A fails closed with `policy_decision=halt` and `status=rejected`.
- Class C fails closed by default.
- Class C may degraded-open only when `KAIF_CLASS_C_DEGRADED_OPEN=true`, and must return `evidence_marker=kaif.introspect.degraded`.
