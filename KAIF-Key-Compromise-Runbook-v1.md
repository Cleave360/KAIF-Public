# KAIF Key Compromise Runbook (v1)

Status: Draft operational runbook  
Owner: KAIF security engineering  
Last updated: 2026-05-20

## 1. Purpose
Define mandatory response actions for signing-key and key-distribution compromise scenarios affecting KAIF token trust.

This is the normative reference for Core Profile checklist Section 5.1.

## 2. Trigger Conditions
Execute this runbook when any of the following is true:
- suspected private signing key exposure,
- confirmed private signing key exposure,
- unauthorized JWKS mutation or poisoning,
- invalid signature acceptance anomaly indicating verifier trust-chain corruption.

## 3. Severity Levels
- Sev-1: confirmed key compromise or active exploit
- Sev-2: high-confidence suspicion with plausible blast radius
- Sev-3: low-confidence anomaly requiring investigation

## 4. Immediate Containment (0–15 minutes)

### 4.1 Freeze trust expansion
- Disable new token issuance for affected issuer/key set OR constrain to emergency minimal scopes.
- Block sub-delegation issuance.

### 4.2 Revoke active trust material
- Mark compromised `kid` as revoked in key registry.
- Force denylist insertion for all active JTIs minted by compromised key within impact window.
- Trigger global revocation propagation.

### 4.3 Enforce failure mode
- Class A/B integrations MUST fail-closed while trust set is unstable.
- Class C may use bounded degraded mode per SLO policy doc.

## 5. Rotation and Recovery (15–60 minutes)

### 5.1 Emergency key rotation sequence
1. Generate new signing keypair in approved HSM/KMS boundary.
2. Publish new JWKS entry with new `kid`.
3. Keep compromised `kid` listed as revoked/disabled (do not silently remove without tombstone metadata).
4. Re-enable issuance on new key only after verifier can fetch updated JWKS.

### 5.2 Verifier cache invalidation
- Send explicit cache-bust signal/event.
- Enforce max JWKS cache TTL <= 60s during incident.
- Confirm at least one successful verification using new `kid` in each deployment region.

## 6. Blast Radius Assessment

Collect and preserve:
- compromise start/end estimate,
- tokens minted by compromised `kid` in window,
- affected tenants/services/scopes,
- successful uses of compromised tokens (if any),
- potential data/actions impacted.

## 7. Communications

### 7.1 Internal
- T+0: notify security on-call + platform lead
- T+15m: incident commander assigns roles (containment, forensics, comms)
- T+30m: executive technical update

### 7.2 External
- Notify affected partners with:
  - incident window,
  - affected `kid` values,
  - required verifier actions,
  - expected restoration timeline.

Template minimum fields:
- `incident_id`
- `start_ts`
- `affected_kids`
- `required_customer_action`
- `next_update_ts`

## 8. Verification Checklist
Recovery is not complete until all checks pass:
- [ ] compromised `kid` rejected at all verifiers
- [ ] new `kid` accepted at all verifiers
- [ ] token issuance resumed with new key only
- [ ] revocation propagation SLO back within thresholds
- [ ] no false accept of compromised-key tokens in post-rotation window

## 9. Post-Incident Actions (24–72 hours)
- Root cause analysis completed.
- Key custody and access controls reviewed.
- Detection rules improved (signature anomaly, JWKS mutation, issuance spikes).
- Runbook and automation updated.
- Formal postmortem published with corrective actions.

## 10. Required Audit Artifacts
Store immutable evidence for compliance:
- incident timeline,
- compromised/new `kid` metadata,
- issuance disable/enable events,
- revocation propagation evidence,
- partner notification logs,
- final remediation sign-off.

## 11. Automation Hooks (recommended)
- `kaifctl key revoke --kid <kid> --reason compromise`
- `kaifctl token denylist --kid <kid> --window <from,to>`
- `kaifctl jwks rotate --publish --kid <new_kid>`
- `kaifctl verify rollout --kid <new_kid> --all-regions`
