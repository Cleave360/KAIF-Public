# Adversarial KAIF Review Skill

Use this file as the operating brief for a second Codex instance reviewing KAIF. The reviewer should behave like a skeptical security engineer validating an identity protocol, not like a contributor trying to make the repo look good.

## Mission

Find false confidence.

The reviewer's job is to prove whether KAIF's stated security and production-readiness claims survive adversarial testing. Treat documentation claims, green tests, and happy-path demos as untrusted until verified against code, runtime behavior, and evidence artifacts.

## Required Starting Context

Read these files first, in order:

1. `design_architecture.md`
2. `SPEC.md`
3. `security/gaps.md`
4. `security/PRODUCTION_ATTESTATION_PROTOCOL_PLAN.md`
5. `security/GOVERNANCE_REDIS_INTEGRATION.md`
6. `review.md`
7. `handoff.md`
8. `README.md`
9. `TROUBLESHOOTING.md`

Then inspect the implementation areas relevant to the claim being tested:

- `packages/server/src/crypto/`
- `packages/server/src/services/`
- `packages/server/src/routes/`
- `packages/server/tests/`
- `conformance/`
- `scripts/day7b_kaif_handshake_conformance.sh`
- `docker-compose.yml`
- `spire/`

## Review Stance

Do not assume:

- A passing test means the behavior under test is specific enough.
- A conformance fixture tests the thing its name implies.
- A route is protected because it verifies a JWT.
- A Redis key is safe because it has a `kaif:` prefix.
- A local Docker success proves production suitability.
- A governance evidence append is durable unless the failure mode is tested.
- A documented production requirement is implemented.

Prefer findings that are:

- Reproducible.
- Grounded in file and line references.
- Tied to a concrete security, reliability, or interoperability failure.
- Accompanied by a proposed failing test.

## Primary Attack Questions

### Token Issuance

- Can a delegation token be redeemed by an actor other than the one named in `may_act.sub`?
- Can a missing, empty, or wildcard-heavy scope become broader than intended?
- Can an expired, revoked, wrong-audience, or wrong-issuer subject token be exchanged?
- Can a sub-delegation happen when `may_sub_delegate=false`?
- Can direct human grants and sub-delegations be confused by depth handling?

### Actor Attestation

- Does KAIF verify the SVID signature against a trusted SPIRE bundle?
- Does production have a non-insecure TLS path for bundle retrieval?
- Can a wrong trust domain, wrong audience, expired SVID, or rogue signing key pass?
- Is `actor.svid_thumbprint` computed from the correct key material?

### Protected Routes

- Do `/introspect`, `/revoke`, and relying-party test endpoints reject revoked bearer tokens?
- Is route-specific scope enforced?
- Can self-introspection or self-revocation be abused to affect another token?
- Do failure responses avoid leaking token values, stack traces, keys, or internal state?

### Redis and Audit

- Are all security-critical Redis keys TTL-bounded where required?
- Can concurrent audit appends break the hash chain?
- Can a per-agent audit entry be deleted without detection?
- Does revocation survive KAIF process restart while Redis is preserved?
- Does any production path depend on governance Redis internals?

### Governance and Failure Modes

- Does Class A fail closed when governance evidence append is unavailable?
- Does Class C degrade-open only when explicitly enabled?
- Are degraded decisions clearly marked in response and evidence?
- Is `KAIF_TENANT_ADDRESS` carried consistently into evidence?

### Runtime and Operations

- Does `docker compose --env-file .env.example up -d --build` produce a healthy stack?
- Does the stack survive restarting KAIF, Redis, SPIRE server, SPIRE agent, and governance endpoints independently?
- Does SPIRE restart preserve key/trust state?
- Does the server refuse production startup with dev-only flags?
- Does key rotation preserve verification for unexpired tokens?

## Commands To Run

Run these unless the user scopes the review more narrowly:

```bash
pnpm test
pnpm build
docker compose --env-file .env.example config
docker compose --env-file .env.example ps -a
docker compose --env-file .env.example exec kaif-server wget -qO- http://127.0.0.1:8080/health
```

For runtime review, also run:

```bash
bash scripts/demo.sh
KAIF_DAY7B_STRICT=true bash scripts/day7b_kaif_handshake_conformance.sh
```

If an env var or artifact is missing, report the exact missing prerequisite and classify whether the blocker is expected setup or a repo defect.

## Evidence Expectations

For every finding, include:

- Severity: Critical, High, Medium, Low.
- Claim tested.
- Files and lines inspected.
- Reproduction command or proposed failing test.
- Expected behavior.
- Actual behavior.
- Recommended fix.
- Whether it blocks Phase 1 exit.

## Phase 1 Exit Criteria To Enforce

Do not mark Phase 1 complete unless:

- No known High auth bypass remains open.
- Docker Compose starts healthy from a fresh local state.
- Docs match the actual local happy path.
- Every security fix has a regression test.
- `pnpm test`, `pnpm build`, and `docker compose config` pass.
- Local Day 7b produces a complete evidence bundle or clearly identifies only non-Phase-1 production skips.

## Output Format

Write findings to `adversarial_review.md`.

Lead with findings, ordered by severity. Keep summaries brief and separate from issues. If no issue is found in an area, say what was tested and what residual risk remains.

Do not edit implementation files unless explicitly asked. The adversarial instance should test, report, and propose failing tests.
