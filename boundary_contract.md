# Boundary Contract

Status: draft  
Date: 2026-06-30  
Audience: Adaptive Layer implementers, KAIF implementers, external agent platform integrators

This document defines the vendor-neutral contract for boundary-grade authorization between:

- a workflow/orchestration plane
- KAIF as the permit/deny and attestation boundary
- an external agent platform or relying party

The goal is simple: when a workflow crosses a trust boundary, every system involved must agree on the same identifiers, decision fields, evidence fields, and return receipt shape.

KAIF's role in this contract is intentionally narrow:

- decide `permit` or `deny`
- bind authority to an attested workload identity
- emit auditable boundary evidence
- return enough structured data for the orchestration plane to continue or halt

KAIF is not the workflow engine, not the long-lived state plane, and not the external execution platform.

---

## 1. System Roles

| System | Role | Must Own | Must Not Own |
|---|---|---|---|
| Agentic Proxy Store | Minted agent/skill provenance | agent package identity, skill policy, issuance metadata | runtime workflow execution |
| Workflow plane | Orchestration and `CTX` state | run lifecycle, step ordering, merge rules, retry semantics | final cross-boundary auth decision |
| KAIF | Boundary-grade authorization gate | permit/deny, actor attestation, boundary evidence, revocation state | business workflow state |
| External agent platform | Relying party / external executor | execution receipt, external run ID, result metadata | internal workflow truth |
| Evidence store(s) | Durable audit | append-only evidence retention and replay support | authorization decisions |

---

## 2. Contract Goals

Any implementation claiming this contract MUST satisfy:

1. One canonical correlation path across systems
2. Explicit permit/deny semantics at the KAIF boundary
3. Stable field names for outbound auth metadata
4. Stable receipt fields for the return path
5. Fail-closed behavior when required evidence is missing
6. Clear separation between orchestration state and boundary evidence
7. Explicit human-intent handling for human-delegated boundary crossings

---

## 3. Canonical Identifiers

The following fields are the minimum shared identifiers.

| Field | Scope | Description |
|---|---|---|
| `envelope_version` | workflow plane | Canonical envelope schema version |
| `tenant_id` | global | Tenant or organizational boundary identifier |
| `workspace_id` | workflow plane | Workspace/project grouping identifier |
| `project_id` | workflow plane | Logical project or blueprint namespace |
| `blueprint_id` | workflow plane | Optional blueprint identifier |
| `blueprint_version` | workflow plane | Optional blueprint version |
| `run_id` | workflow plane | End-to-end workflow run identifier |
| `workflow_id` | workflow plane | Workflow definition identifier carried in route context |
| `node_id` | workflow plane | Authoritative workflow node identifier |
| `request_id` | boundary | Unique boundary request identifier minted upstream |
| `principal_id` | workflow plane | Workflow principal identifier |
| `principal_type` | workflow plane | Workflow principal type |
| `ui_instance_id` | workflow plane | UI or runtime instance identifier |
| `intent_id` | workflow plane | Human intent identifier |
| `intent_type` | workflow plane | Intent classification |
| `intent_hash` | workflow plane | Stable fingerprint of the full intent object |
| `delegation_id` | KAIF | Delegation grant identifier |
| `token_jti` | KAIF | Access token JTI for boundary event |
| `agent_id` | workflow plane | Logical minted agent name or ID |
| `agent_spiffe_id` | identity | Attested workload identity |
| `human_sub` | authority | Human authority principal |
| `external_run_id` | external platform | External platform execution identifier |
| `receipt_id` | external platform | Returned receipt identifier |

Rules:

- `run_id` MUST remain stable for the full workflow
- `request_id` MUST be minted by the workflow plane before the KAIF boundary call
- in the current Adaptive/DNS profile, `workflow_id` SHOULD equal `adaptive_envelope.blueprint_id` when `blueprint_id` is present
- `workflow_id` MUST NOT be repurposed to mean `run_id`
- `node_id` remains the authoritative workflow-step identifier in Adaptive/DNS
- `node_id` MUST be explicit and non-null on every KAIF boundary call
- if another consumer requires `step_id`, it MUST be derived from `node_id` and MUST NOT become a second source of truth
- `delegation_id` and `token_jti` MUST be recorded whenever KAIF permits
- `external_run_id` and `receipt_id` MUST be merged back into `CTX` when the external platform returns them

---

## 4. Input Contract

The workflow plane MUST provide a structured boundary request input to KAIF.  
The exact transport MAY vary, but the logical shape MUST be preserved.

### Required Input Shape

```json
{
  "adaptive_envelope": {
    "envelope_version": "v1",
    "tenant_id": "tenant-dns",
    "workspace_id": "ws-dns",
    "project_id": "dns-blueprint",
    "blueprint_id": "bp-dns-001",
    "blueprint_version": "2026-06-30",
    "run_id": "run-123",
    "principal_id": "operator@example.com",
    "principal_type": "human",
    "ui_instance_id": "ui-dns-01"
  },
  "route_context": {
    "workflow_id": "wf-dns-001",
    "node_id": "node-foundry-exec",
    "request_id": "req-123"
  },
  "human_intent": {
    "intent_id": "intent-123",
    "intent_mode": "bound",
    "intent_type": "dns_change_request",
    "intent_summary": "Propose and validate DNS change for target zone",
    "intent_scope": [
      "dns.read",
      "dns.propose_change"
    ],
    "intent_hash": "sha256:abcd1234"
  },
  "kaif_subject": {
    "human_sub": "operator@example.com",
    "agent_id": "dns-final-agent",
    "agent_spiffe_id": "spiffe://example.org/ns/dns/agent/final"
  },
  "action": {
    "operation": "external-agent.invoke",
    "scope": "invoke:completion",
    "audience": "urn:external-agent-platform",
    "resource": "dns.change-request"
  },
  "governance": {
    "policy_version": "v1",
    "minted_agent_ref": "aps://agents/dns-final-agent",
    "minted_skill_refs": [
      "aps://skills/dns-read",
      "aps://skills/dns-change"
    ]
  }
}
```

### Input Rules

- `adaptive_envelope.envelope_version`, `adaptive_envelope.tenant_id`, `adaptive_envelope.workspace_id`, `adaptive_envelope.project_id`, `adaptive_envelope.run_id`, `adaptive_envelope.principal_id`, `adaptive_envelope.principal_type`, and `adaptive_envelope.ui_instance_id` MUST be present
- `route_context.workflow_id`, `route_context.node_id`, and `route_context.request_id` MUST be present
- when `adaptive_envelope.blueprint_id` is present, `route_context.workflow_id` SHOULD equal `adaptive_envelope.blueprint_id`
- `route_context.node_id` MUST be a concrete workflow node identifier and MUST NOT be null or inferred from free text
- `kaif_subject.human_sub` MUST identify the delegating human authority
- `kaif_subject.agent_spiffe_id` MUST match the workload identity expected to present the actor token
- `action.scope` and `action.audience` MUST be explicit; wildcard-by-omission is forbidden
- `adaptive_envelope.principal_id` and `kaif_subject.human_sub` SHOULD resolve to the same human authority when the boundary is human-delegated
- `governance` SHOULD contain minted agent/skill references when available

### Human Intent Rules

- `human_intent.intent_mode` MUST be either `bound` or `abstracted`
- when `intent_mode=bound`, `intent_id`, `intent_type`, `intent_summary`, and `intent_hash` MUST be present
- `intent_hash` MUST be a stable fingerprint of the full intent object retained by the workflow plane
- when `intent_mode=abstracted`, the request MUST include:

```json
{
  "human_intent": {
    "intent_mode": "abstracted",
    "intent_absence_reason": "system_reconciliation"
  }
}
```

- intent absence MUST be explicit on ingress and egress; silent omission is forbidden
- if policy requires a human-bound intent, KAIF MUST deny when `human_intent` is absent, unverifiable, or hash-mismatched

---

## 5. KAIF Boundary Request

The workflow plane or boundary caller submits:

1. the canonical envelope plus route context
2. the human intent object
3. the KAIF subject object
4. a delegation grant or equivalent human authority token
5. an attested actor token for the workload

Conceptually, KAIF receives:

```json
{
  "adaptive_envelope": { "...": "..." },
  "route_context": { "...": "..." },
  "human_intent": { "...": "..." },
  "kaif_subject": { "...": "..." },
  "action": { "...": "..." },
  "subject_token": "<delegation-grant>",
  "actor_token": "<jwt-svid-or-equivalent>",
  "subject_token_type": "urn:ietf:params:oauth:token-type:access_token",
  "actor_token_type": "urn:ietf:params:oauth:token-type:jwt"
}
```

KAIF MUST:

- validate human authority
- validate actor identity
- bind the request to the declared human intent
- enforce scope, audience, trust tier, and delegation depth
- either deny or issue a boundary authorization result

---

## 6. KAIF Decision Contract

KAIF MUST return a structured decision envelope.  
This envelope is the canonical response the workflow plane consumes.

### Permit Response

```json
{
  "decision": "permit",
  "boundary": {
    "request_id": "req-123",
    "decision_id": "dec-123",
    "tenant_id": "tenant-dns",
    "run_id": "run-123",
    "workflow_id": "wf-dns-001",
    "node_id": "node-foundry-exec"
  },
  "authority": {
    "human_sub": "operator@example.com",
    "agent_spiffe_id": "spiffe://example.org/ns/dns/agent/final",
    "delegation_id": "d-123",
    "token_jti": "jti-123",
    "scope": "invoke:completion",
    "audience": "urn:external-agent-platform"
  },
  "intent": {
    "intent_mode": "bound",
    "intent_id": "intent-123",
    "intent_type": "dns_change_request",
    "intent_hash": "sha256:abcd1234"
  },
  "attestation": {
    "trust_tier": "STANDARD",
    "trust_score": 0.5,
    "delegation_depth": 0,
    "cnf": {
      "jkt": "sha256:abcd"
    }
  },
  "evidence": {
    "audit_event_id": "evt-123",
    "audit_hash": "sha256-...",
    "prev_hash": "sha256-...",
    "recorded_at": "2026-06-30T12:00:00Z"
  },
  "token": {
    "access_token": "<kaif-access-token>",
    "token_type": "Bearer",
    "expires_in": 300
  }
}
```

### Deny Response

```json
{
  "decision": "deny",
  "boundary": {
    "request_id": "req-123",
    "decision_id": "dec-123",
    "tenant_id": "tenant-dns",
    "run_id": "run-123",
    "workflow_id": "wf-dns-001",
    "node_id": "node-foundry-exec"
  },
  "intent": {
    "intent_mode": "bound",
    "intent_id": "intent-123",
    "intent_type": "dns_change_request",
    "intent_hash": "sha256:abcd1234"
  },
  "error": {
    "code": "invalid_client",
    "reason": "actor_token invalid or expired"
  },
  "evidence": {
    "audit_event_id": "evt-124",
    "audit_hash": "sha256-...",
    "prev_hash": "sha256-...",
    "recorded_at": "2026-06-30T12:00:00Z"
  }
}
```

### Decision Rules

- `decision` MUST be either `permit` or `deny`
- permit responses MUST include `delegation_id`, `token_jti`, and `audit_hash`
- deny responses MUST include a stable machine-readable `error.code`
- both permit and deny SHOULD emit boundary evidence
- if `human_intent.intent_mode=bound`, the returned decision envelope MUST preserve `intent_id`, `intent_type`, and `intent_hash`

---

## 7. Outbound External Request Contract

If KAIF permits, the workflow plane MAY call an external agent platform.  
The outbound request MUST include correlation and boundary metadata.

### Minimum Outbound Metadata

```json
{
  "boundary_context": {
    "tenant_id": "tenant-dns",
    "workspace_id": "ws-dns",
    "project_id": "dns-blueprint",
    "run_id": "run-123",
    "workflow_id": "wf-dns-001",
    "node_id": "node-foundry-exec",
    "request_id": "req-123",
    "delegation_id": "d-123",
    "token_jti": "jti-123",
    "agent_id": "dns-final-agent",
    "agent_spiffe_id": "spiffe://example.org/ns/dns/agent/final",
    "intent_id": "intent-123",
    "intent_hash": "sha256:abcd1234"
  }
}
```

Rules:

- outbound metadata SHOULD be passed explicitly in the request body or trusted headers
- the external platform MUST receive enough data to emit a correlatable receipt
- the workflow plane MUST NOT rewrite `run_id`, `request_id`, `delegation_id`, or `intent_hash` between KAIF and the external platform

---

## 8. External Receipt Contract

The external platform MUST return a receipt-like object, even if it is not cryptographically signed.

### Receipt Shape

```json
{
  "receipt": {
    "receipt_id": "rcpt-123",
    "external_run_id": "ext-run-123",
    "status": "completed",
    "recorded_at": "2026-06-30T12:00:05Z",
    "platform": {
      "name": "external-agent-platform",
      "instance": "prod-eu-1"
    },
    "request_binding": {
      "request_id": "req-123",
      "run_id": "run-123",
      "workflow_id": "wf-dns-001",
      "node_id": "node-foundry-exec",
      "delegation_id": "d-123",
      "token_jti": "jti-123",
      "intent_id": "intent-123",
      "intent_hash": "sha256:abcd1234"
    },
    "result": {
      "type": "structured-json",
      "summary": "dns change proposed"
    }
  }
}
```

### Receipt Rules

- `receipt.request_binding.request_id` MUST equal the original boundary `request_id`
- `receipt.request_binding.run_id` MUST equal the original workflow `run_id`
- if `delegation_id`, `token_jti`, `intent_id`, or `intent_hash` are echoed, they MUST match the KAIF-issued or workflow-issued values
- if the external platform cannot provide a receipt, the workflow plane MUST record that absence explicitly

Important:

- an unsigned receipt is an execution receipt, not cryptographic proof of authorship
- if stronger assurance is needed, the external platform SHOULD sign the receipt or expose verifiable attestation metadata

---

## 9. Return-Path CTX Merge Rules

After external execution, the workflow plane MUST merge the receipt into `CTX`.

### Required Merge Fields

```json
{
  "ctx": {
    "boundary": {
      "decision": "permit",
      "request_id": "req-123",
      "delegation_id": "d-123",
      "token_jti": "jti-123",
      "audit_hash": "sha256-...",
      "intent_hash": "sha256:abcd1234"
    },
    "external_receipt": {
      "receipt_id": "rcpt-123",
      "external_run_id": "ext-run-123",
      "status": "completed"
    }
  }
}
```

Rules:

- the workflow plane MUST preserve the original `run_id`
- receipt data MUST be additive; it MUST NOT overwrite KAIF evidence fields
- if an external receipt is malformed or missing, the workflow plane MUST record that explicitly
- if `intent_mode=bound`, the merged return path MUST preserve `intent_hash`

---

## 10. Fail-Closed Rules

This contract is boundary-grade. Certain failures MUST halt progression.

### MUST Deny or Halt

- missing or invalid human authority token
- missing or invalid actor token
- audience mismatch
- scope overreach
- delegation depth exceeded
- trust tier below policy minimum
- required boundary evidence not recorded
- `intent_mode=bound` but `intent_hash` missing
- external receipt correlation does not match `request_id` or `run_id` when receipt correlation is required by policy

### MAY Degrade Only If Explicitly Allowed

- optional downstream receipt enrichment unavailable
- non-authoritative advisory metadata unavailable
- non-critical secondary logging unavailable

The workflow plane MUST distinguish:

- `deny`: KAIF refused the crossing
- `halt`: orchestration stopped because required evidence or receipt rules were not satisfied

---

## 11. Evidence Requirements

Every permit or deny decision SHOULD create evidence with:

- `request_id`
- `run_id`
- `workflow_id`
- `node_id`
- `tenant_id`
- `human_sub`
- `agent_spiffe_id`
- `delegation_id` when issued
- `token_jti` when issued
- `decision`
- `intent_mode`
- `intent_hash` when bound
- `audit_hash`
- `prev_hash`

If an external receipt is returned, the workflow plane SHOULD also record:

- `receipt_id`
- `external_run_id`
- `receipt_status`

---

## 12. Profiles

### Development Profile

- mock actor tokens MAY be used
- receipt signing MAY be absent
- platform-specific shortcuts MAY exist
- all shortcuts MUST be explicitly labeled as development-only
- `intent_mode=abstracted` MAY be used for isolated protocol testing if explicitly recorded

### Production Profile

- mock actor tokens MUST be rejected
- real workload identity MUST be used
- permit/deny MUST fail closed
- receipt correlation fields MUST be preserved exactly
- boundary evidence MUST be durable and replayable
- `intent_mode=bound` SHOULD be the default for human-delegated boundary crossings

---

## 13. Open Integration Inputs

Before final implementation, the following Adaptive-side inputs should be confirmed:

1. whether `workflow_id` is already distinct from `run_id` in the live DNS/Adaptive path
2. exact full object used to compute `intent_hash`
3. whether `intent_summary` should be operator-authored, workflow-authored, or normalized upstream
4. exact envelope nesting rules for returned external receipts
5. whether Agentic Proxy Store minted skill references already have a canonical URI format

These should be aligned before the DNS blueprint and external agent path are implemented end to end.

---

## 14. Implementation Order

Recommended order:

1. Align Adaptive canonical envelope + route context to this contract
2. Add `human_intent` and stable `intent_hash`
3. Implement KAIF request/decision envelope mapping
4. Add external request metadata propagation
5. Define receipt parser and CTX merge rules
6. Add replayable evidence checks across Adaptive + KAIF
7. Add a production-profile test with no dev fallback

This keeps the tunnel clean before the workflow logic is layered on top.
