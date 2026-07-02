# Foundry Boundary Receipt Contract V1

Status: draft design contract  
Owner: KAIF + Adaptive integration  
Date: 2026-06-28

## Purpose

Define the boundary-grade contract for a workflow that originates in Adaptive, crosses KAIF for permit/deny and attestation, executes on an external Foundry surface, and returns a receipt that Adaptive can merge into its own context and evidence planes.

This contract is intentionally narrow.

KAIF is:

1. a permit / deny gate
2. an attestation point
3. a boundary event recorder

KAIF is not:

1. the workflow orchestrator
2. the long-lived workflow state plane
3. the external agent runtime

Adaptive remains the owner of workflow state, workflow sequencing, and final CTX merge decisions.

## System roles

### Adaptive Layer

1. owns the workflow run
2. supplies the inbound execution envelope
3. requests boundary authorization from KAIF
4. merges the returned receipt into CTX and audit evidence

### KAIF

1. validates boundary authorization inputs
2. permits or denies the crossing
3. issues a boundary authorization artifact
4. records attestation and boundary events
5. returns a boundary receipt envelope

### Foundry external execution surface

1. receives the authorized outbound request
2. executes or rejects the request in its own trust domain
3. returns an execution receipt or failure receipt

## Contract goals

1. prove which workflow asked for the crossing
2. prove which boundary gate allowed or denied it
3. prove what was sent to Foundry in redacted form
4. prove what Foundry returned
5. let Adaptive merge the result without surrendering workflow ownership to KAIF

## 1. Inbound request: Adaptive to KAIF

Adaptive MUST call KAIF with a boundary authorization request that preserves the existing workflow identity.

Required top-level fields:

1. `schema_version`
2. `request_id`
3. `tenant_id`
4. `workflow`
5. `adaptive_envelope`
6. `boundary_request`

### 1.1 `workflow`

Required fields:

1. `run_id`
2. `workspace_id`
3. `project_id`
4. `ui_instance_id`
5. `principal_id`
6. `principal_type`

Optional fields:

1. `workflow_id`
2. `node_id`
3. `agent_instance_id`
4. `lease_id`

Rules:

1. `run_id` is the primary workflow correlation key across Adaptive, KAIF, and the return receipt.
2. `node_id` SHOULD be included when the boundary crossing belongs to a specific workflow node.
3. KAIF MUST treat these workflow fields as correlation and authorization inputs, not as mutable state.

### 1.2 `adaptive_envelope`

Required minimum fields:

1. `envelope_version`
2. `tenant_id`
3. `workspace_id`
4. `project_id`
5. `run_id`
6. `principal_id`
7. `principal_type`
8. `ui_instance_id`

Rules:

1. `adaptive_envelope.tenant_id` MUST equal the top-level `tenant_id`.
2. `workflow.run_id` MUST equal `adaptive_envelope.run_id`.
3. KAIF MUST reject mismatched tenant or run identifiers fail-closed.

### 1.3 `boundary_request`

Required fields:

1. `target_system`
2. `operation`
3. `requested_scopes`
4. `input_hash`
5. `input_preview`
6. `idempotency_key`

Optional fields:

1. `requested_audience`
2. `reason`
3. `callback_contract`
4. `timeout_ms`
5. `sensitivity`

Rules:

1. `target_system` SHOULD be `foundry` for this contract family.
2. `input_hash` is the integrity reference for the outbound payload body or canonical input set.
3. `input_preview` MUST be redacted and safe for audit logging.
4. `idempotency_key` MUST remain stable across retries for the same intended crossing.

## 2. KAIF authorization decision

KAIF returns either `permit` or `deny`.

Required decision fields:

1. `decision`
2. `decision_id`
3. `decision_ts_ms`
4. `tenant_id`
5. `run_id`
6. `request_id`
7. `policy_decision`
8. `attestation`

### 2.1 `decision`

Allowed values:

1. `permit`
2. `deny`

### 2.2 `policy_decision`

Allowed values:

1. `allow`
2. `deny`
3. `halt`

Mapping:

1. `permit` maps to `policy_decision=allow`
2. `deny` maps to `policy_decision=deny` or `policy_decision=halt`

### 2.3 `attestation`

Required fields:

1. `kaif_token_jti`
2. `delegation_id`
3. `delegation_depth`
4. `actor_spiffe_id`
5. `actor_svid_thumbprint`
6. `authorization_tier`
7. `granted_scopes`

Optional fields:

1. `trust_score`
2. `cnf`
3. `grant_exp_ms`
4. `exchange_exp_ms`

Rules:

1. KAIF MUST bind the permit decision to the actor identity and delegation chain it verified.
2. A deny decision SHOULD still return the available attestation context that explains which chain was denied, except where doing so would leak sensitive policy details.

## 3. KAIF audit and boundary event fields

KAIF MUST record a boundary event for both permit and deny outcomes.

Required audit/event fields:

1. `event_type`
2. `status`
3. `policy_decision`
4. `tenant_id`
5. `run_id`
6. `request_id`
7. `decision_id`
8. `target_system`
9. `operation`

Recommended event mapping:

1. permit before outbound call:
   - `event_type=boundary.authorize`
   - `status=success`
   - `policy_decision=allow`
2. deny:
   - `event_type=boundary.authorize`
   - `status=rejected`
   - `policy_decision=deny|halt`
3. outbound dispatch:
   - `event_type=boundary.dispatch`
   - `status=success`
   - `policy_decision=allow`
4. return receipt accepted:
   - `event_type=boundary.receipt`
   - `status=success`
   - `policy_decision=allow`
5. callback/receipt verification failed:
   - `event_type=boundary.receipt`
   - `status=error`
   - `policy_decision=allow`

## 4. Outbound metadata: KAIF to Foundry

KAIF MUST forward enough metadata for correlation and receipt reconstruction without exporting the full Adaptive internal state.

Required outbound metadata:

1. `x-kaif-decision-id`
2. `x-kaif-request-id`
3. `x-kaif-run-id`
4. `x-kaif-tenant-id`
5. `x-kaif-delegation-id`
6. `x-kaif-token-jti`
7. `x-kaif-input-hash`

Optional outbound metadata:

1. `x-kaif-node-id`
2. `x-kaif-workflow-id`
3. `x-kaif-callback-url`

Rules:

1. KAIF SHOULD keep outbound metadata header-based or envelope-based, but deterministic.
2. Sensitive human or token material MUST NOT be forwarded unless explicitly required by the external platform contract.
3. If Foundry cannot preserve custom metadata, KAIF MUST still retain enough local evidence to correlate the result by `decision_id` and `run_id`.

## 5. Foundry receipt shape

Foundry SHOULD return a receipt object. If the external platform cannot do that natively, KAIF must synthesize a normalized receipt wrapper from the response.

Required normalized receipt fields:

1. `receipt_version`
2. `receipt_id`
3. `decision_id`
4. `request_id`
5. `run_id`
6. `target_system`
7. `result`
8. `occurred_at_ms`

### 5.1 `result`

Required fields:

1. `status`
2. `provider_code`
3. `provider_message`

Allowed `result.status` values:

1. `success`
2. `rejected`
3. `error`
4. `paused`

Optional receipt fields:

1. `provider_request_id`
2. `provider_session_id`
3. `provider_receipt_signature`
4. `output_hash`
5. `output_preview`
6. `usage`
7. `latency_ms`
8. `raw_receipt_ref`

Rules:

1. `decision_id`, `request_id`, and `run_id` MUST survive into the normalized receipt even if KAIF has to synthesize them locally.
2. `output_preview` MUST be redacted.
3. `raw_receipt_ref` SHOULD point to immutable retained evidence, not inline bulk payloads.

## 6. Return-path CTX merge rules

Adaptive owns the return merge.

KAIF MUST return a boundary receipt envelope containing:

1. the original workflow identity
2. the KAIF decision and attestation
3. the normalized Foundry receipt
4. merge hints only

KAIF MUST NOT mutate Adaptive CTX directly.

### 6.1 Merge envelope

Required fields:

1. `schema_version`
2. `tenant_id`
3. `run_id`
4. `request_id`
5. `decision_id`
6. `kaif_decision`
7. `foundry_receipt`
8. `merge`

### 6.2 `merge`

Required fields:

1. `ctx_key`
2. `merge_mode`

Allowed `merge_mode` values:

1. `append_receipt`
2. `append_error`
3. `append_rejection`
4. `append_pause`

Rules:

1. Adaptive SHOULD merge by `run_id` and, when present, `node_id`.
2. Adaptive SHOULD treat KAIF as a boundary receipt source, not the source of truth for workflow progress.
3. A returned `paused` result SHOULD place the workflow into an operator-wait state while preserving the same `run_id`.
4. A later continuation SHOULD emit a new boundary request and correlate it to the same workflow `run_id`; whether it reuses the same `node_id` is a workflow-level decision.

## 7. Failure and deny behavior

### 7.1 KAIF deny

If KAIF denies the crossing:

1. no outbound Foundry call is permitted
2. a deny envelope MUST be returned to Adaptive
3. the deny MUST be auditable

Required deny fields:

1. `decision=deny`
2. `status=rejected`
3. `policy_decision=deny|halt`
4. `deny_code`
5. `deny_reason`
6. `run_id`
7. `request_id`
8. `decision_id`

### 7.2 Foundry transport or execution failure

If the outbound call was authorized but Foundry fails:

1. KAIF returns a failure receipt, not a permit denial rewrite
2. Adaptive receives `status=error`
3. the original permit decision remains historically true

Required failure fields:

1. `result.status=error`
2. `provider_code`
3. `provider_message`
4. `decision_id`
5. `run_id`

### 7.3 Human-in-the-loop pause

If the external flow requires operator input or gated review:

1. the normalized receipt MAY return `result.status=paused`
2. Adaptive decides whether the workflow pauses locally
3. a later continuation MUST correlate back to the same `run_id`

## 8. Multi-workflow and sequencing rules

1. `run_id` is the primary workflow isolation key across tenant-concurrent runs.
2. KAIF decisions for different workflows MAY interleave in the same tenant and still remain valid.
3. Hash-chained or append-only audit streams remain stream-global; workflow reconstruction is done by filtering `run_id`, `request_id`, and `decision_id`.
4. KAIF MUST NOT create a new workflow identity when resuming an already-paused workflow crossing.

## 9. Non-goals

This contract does not yet define:

1. Foundry-native signature verification semantics
2. full callback transport security profile
3. long-lived external session continuation rules
4. multi-hop receipt forwarding beyond one KAIF boundary

## 10. Implementation order

Before DNS blueprint integration:

1. lock this contract
2. map Adaptive envelope fields exactly
3. map KAIF route and audit artifacts
4. define the normalized Foundry receipt adapter
5. define the return-path CTX merge handler in Adaptive
