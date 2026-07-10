# KAIF First-Contact Contract Seam

This document defines the first-contact seam between Digital Nervous System (DNS) and KAIF for the Foundry boundary workflow.

It describes how a DNS runtime that has never previously spoken to KAIF must bootstrap authorization before it can call `POST /v1/boundary/authorize`.

## Core Rule

The DNS envelope is context, not proof.

KAIF does not trust:
- `adaptive_envelope`
- `route_context`
- `human_intent`
- `kaif_subject`

as sufficient identity or grant evidence on their own.

KAIF requires two distinct proofs before a boundary crossing can succeed:
- a KAIF-issued delegation grant (`subject_token`)
- a workload identity proof (`actor_token`)

## Current KAIF Flow

### Phase 1: Provision

DNS or a DNS-operated pre-boundary step must call `POST /provision` first.

Purpose:
- establish the human authority
- bind that authority to a named KAIF agent entry
- validate requested scopes against the KAIF ACL
- mint a signed `delegation_token`

Inputs:
- `id_token`
- `agent_id`
- `scope`

Output:
- `delegation_token`

In the current KAIF implementation, the `delegation_token` is the `subject_token` that must later be presented to the protected boundary route.

### Phase 2: Boundary Authorize

After DNS has a `delegation_token`, node `5` can call `POST /v1/boundary/authorize`.

Required proof fields:
- `subject_token`
- `subject_token_type`
- `actor_token`
- `actor_token_type`

Required declared actor fields:
- `kaif_subject.agent_id`
- `kaif_subject.agent_spiffe_id`

Purpose:
- validate the structured boundary request
- validate the declared agent against KAIF ACL
- validate the runtime workload identity
- bind the workload identity to the previously issued delegation grant
- authorize or deny the boundary crossing

## Why KAIF Needs The DNS Agent In ACL

KAIF must know the boundary caller ahead of time.

The agent ACL is not a convenience lookup. It is the allow-list that defines:
- which named agents are recognized
- which SPIFFE identities they correspond to
- which scopes they may request
- whether sub-delegation is allowed
- what trust tier and delegation limits apply

This means the DNS runtime identity that will call KAIF must exist in KAIF ACL before first contact.

The same logical agent must stay aligned across:
- the ACL entry in KAIF
- `POST /provision.agent_id`
- `kaif_subject.agent_id`
- `kaif_subject.agent_spiffe_id`
- the workload identity proven by `actor_token`

If these do not line up, KAIF should deny.

## Why The Envelope Alone Is Not Enough

If KAIF accepted the DNS envelope as sufficient proof, any caller could:
- self-assert a workflow
- self-assert a node
- self-assert a human principal
- self-assert an agent identity

That would collapse the boundary into a transport shim instead of an authorization gate.

The envelope tells KAIF what the caller is trying to do.

The grant token and workload identity tell KAIF who is actually allowed to do it.

## Correct DNS-Side Mental Model

Do not model node `5` as:
- "call KAIF, let KAIF mint credentials, then continue the same protected call"

Model it as:
1. a pre-boundary bootstrap step obtains a KAIF delegation grant
2. node `5` resumes with the resulting `delegation_token`
3. node `5` calls `POST /v1/boundary/authorize` with both grant proof and workload proof
4. KAIF either denies or proceeds to the real Foundry path

If DNS wants this represented explicitly in the recipe, a separate logical step such as `5a` is valid as an orchestration concept.

But that step must happen before the protected boundary authorize call, not inside it.

## Canonical First-Contact Sequence

1. DNS determines the runtime agent that will call KAIF.
2. KAIF has an ACL entry for that DNS agent identity.
3. DNS obtains a human token or approved bootstrap identity.
4. DNS calls `POST /provision` with:
   - `id_token`
   - `agent_id`
   - `scope`
5. KAIF returns `delegation_token`.
6. DNS stores that token into node `5` input/state.
7. DNS calls `POST /v1/boundary/authorize` with:
   - `subject_token = delegation_token`
   - `actor_token = DNS workload proof`
   - declared `kaif_subject` matching the ACL entry
8. KAIF validates:
   - agent exists in ACL
   - SPIFFE identity matches ACL
   - grant scope matches request
   - actor proof matches the grant's allowed actor
9. If valid, KAIF continues into the Foundry boundary path.

## Practical Implication For DNS Codex

DNS must not assume KAIF can infer trust solely from the envelope.

Before DNS can treat KAIF as a live boundary service, DNS must ensure:
- the DNS boundary agent is registered in KAIF ACL
- the provision step runs before boundary authorize
- the returned `delegation_token` is forwarded as `subject_token`
- the workload identity presented in `actor_token` is the same agent identity granted by KAIF

## Exact Node 6 Values For The Current Live KAIF Surface

DNS should not guess these values from generic Foundry or boundary assumptions.

For the current live KAIF container in this repo, node `6` must use the Azure-facing audience that KAIF is actually configured to permit:

- `action.audience = "urn:kindred:foundry:kindred-1882:gpt-5-mini"`

Values that are known to fail against the current live KAIF config:
- `urn:external-agent-platform`
- `urn:microsoft-foundry-agent`

### Node 6 Must Know The KAIF-Facing Agent Identity

Node `6` is not a generic external HTTP hop from KAIF's perspective.

At execution time, node `6` must know:
- the KAIF-facing `agent_id`
- the matching KAIF-facing `agent_spiffe_id`
- the `actor_token` proving that same workload identity
- the `subject_token` that was provisioned for that same agent
- the exact `action.audience` value KAIF currently allows

For the current successful KAIF live proof in this repo, the working agent path was:
- `agent_id = "lyra"`
- `agent_spiffe_id = "spiffe://kindred.systems/ns/adaptive-layer/agent/lyra"`
- `scope = "invoke:completion"`
- `action.audience = "urn:kindred:foundry:kindred-1882:gpt-5-mini"`

### Clean-Run Checklist For DNS

Before retrying the live DNS -> KAIF -> Foundry path, DNS should confirm all of the following are true in the same run:

1. node `5` or `5a` calls `POST /provision`
2. `POST /provision` uses the same KAIF agent identity that node `6` will later declare
3. the returned `delegation_token` is stored and forwarded into node `6` as `subject_token`
4. node `6` sets:
   - `kaif_subject.agent_id = "lyra"` or another KAIF ACL-registered agent
   - `kaif_subject.agent_spiffe_id` to the matching SPIFFE ID for that agent
   - `action.scope = "invoke:completion"`
   - `action.audience = "urn:kindred:foundry:kindred-1882:gpt-5-mini"`
5. node `6` presents an `actor_token` proving the same agent identity that KAIF provisioned

If any one of those values drifts, KAIF should deny.

## Code Anchors In KAIF

Relevant implementation anchors:
- `/Users/geofflundholm/Documents/KAIF/packages/server/src/routes/provision.ts`
- `/Users/geofflundholm/Documents/KAIF/packages/server/src/services/boundary.ts`
- `/Users/geofflundholm/Documents/KAIF/packages/server/src/services/token-exchange.ts`
- `/Users/geofflundholm/Documents/KAIF/packages/server/config/agents.yaml`
- `/Users/geofflundholm/Documents/KAIF/packages/server/src/services/svid.ts`
