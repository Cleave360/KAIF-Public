# KAIF SLO: Revocation and Introspection (v1)

Status: Draft v1 for implementation  
Owner: KAIF core maintainers  
Last updated: 2026-05-20

## 1. Scope
This document defines operational SLOs and failure-mode policy for:
- token revocation propagation,
- token introspection availability and latency,
- enforcement behavior during partial outages.

This is the normative reference for Core Profile checklist Section 3.2.

## 2. Definitions
- Revocation event: a state transition that invalidates one or more token JTIs.
- Propagation complete: revocation materialized and enforceable at all active enforcement points.
- Introspection endpoint: KAIF endpoint used by relying parties/services to validate token status.
- Integration class: category of relying service that determines fail-open/fail-closed behavior.

## 3. SLO Targets

### 3.1 Revocation propagation latency
Measured from `revocation_accepted_ts` to `last_enforcer_applied_ts`.

- SLO-R1 P95: <= 2 seconds
- SLO-R2 P99: <= 5 seconds
- SLO-R3 hard max: <= 10 seconds

Alerting thresholds:
- Warn if rolling P95 > 2s for 5 minutes
- Critical if rolling P99 > 5s for 5 minutes
- Incident if any propagation > 10s

### 3.2 Introspection endpoint availability
Monthly target (per region):
- SLO-I1 availability: >= 99.95%

Error budget per 30 days:
- <= 21m 36s total unavailability

### 3.3 Introspection latency
- SLO-I2 P95 latency: <= 100ms
- SLO-I3 P99 latency: <= 250ms
- SLO-I4 hard timeout budget: 1s

### 3.4 Correctness SLO
- SLO-C1 false-accept rate for revoked tokens: 0 (no tolerated false accepts)
- SLO-C2 false-reject rate for valid tokens: < 0.01% (excluding explicit policy denies)

## 4. Failure-Mode Policy

### 4.1 Integration classes
Class A: High-risk control-plane actions (payments, secrets, privileged writes)  
Class B: Medium-risk writes / mutating operations  
Class C: Read-only and non-sensitive operations

### 4.2 Policy matrix
When introspection cannot be completed within timeout budget:

- Class A: MUST fail-closed (`deny`)
- Class B: SHOULD fail-closed (`deny`) unless explicit emergency override policy is active
- Class C: MAY fail-open for bounded window (max 60s) with mandatory audit flag `degraded_open=true`

When revocation stream is stale beyond 10s hard max:
- Class A/B: MUST deny tokens requiring freshness guarantees
- Class C: MAY continue in degraded mode with warning and enhanced logging

## 5. Measurement Method

### 5.1 Required timestamps
Every revocation event MUST record:
- `revocation_id`
- `revocation_accepted_ts`
- `enforcer_id`
- `enforcer_applied_ts`

### 5.2 SLI computation
- Propagation latency = max(`enforcer_applied_ts`) - `revocation_accepted_ts`
- Availability = successful introspection responses / total valid introspection attempts
- Latency percentiles computed on successful introspection requests only

### 5.3 Sampling and retention
- Metrics rollup window: 1 minute
- SLO evaluation windows: 5m, 1h, 24h, 30d
- Retention: 400 days for compliance reporting

## 6. Incident States and Escalation

### 6.1 Degraded states
- `DEGRADED_INTROSPECTION`: latency or availability SLO breach
- `DEGRADED_REVOCATION`: propagation SLO breach
- `SEVERE_AUTH_DEGRADATION`: both in breach simultaneously

### 6.2 Escalation
- T+0: alert platform on-call
- T+5m: incident commander assigned
- T+15m: external partner status update (if customer impact)
- T+60m: interim postmortem notes started

## 7. Audit Requirements
During any degraded mode, logs MUST include:
- `integration_class`
- `failure_mode_applied` (`fail_closed` or `degraded_open`)
- `reason_code`
- `run_id` / `delegation_id` / `jti` where available

## 8. Acceptance Criteria
This document is considered implemented when:
- SLO metrics are emitted and visible on dashboards,
- alert rules are active with the thresholds above,
- failure-mode policy is enforced in authorization path,
- one game-day test verifies each degraded-mode branch.
