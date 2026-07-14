# KAIF Public Release Readiness

Date: 2026-07-14
Status: Not safe to publish as-is
Target: Create a public-release branch from the current private repo, then perform a second pass on that branch only.

## Release Decision

The KAIF protocol story is strong enough to share publicly.

The repository, in its current private working state, is not yet safe to publish unchanged. The remaining issues are mostly release-hygiene and deployment-specific exposure, not protocol weakness.

Public release should proceed as a curated branch with:

- live infrastructure identifiers removed or templated
- internal seam/runbook material rewritten or excluded
- local secret-bearing artifacts confirmed absent from git
- draft and research materials intentionally classified

## Stop-Ship Blockers

These must be resolved before any public push.

### 1. Live cloud resource identifiers are checked in

Tracked files currently include concrete subscription IDs, resource groups, and named Azure resources:

- `deploy/azure/workbook-kaif-research.json`
- `deploy/azure/workbook-kaif-paper-figures.json`
- `deploy/azure/cosmos-dashboard.json`
- `security/AZURE_KEY_VAULT_DEPLOYMENT.md`
- `security/AZURE_CONTAINER_APPS_MANAGED_IDENTITY.md`

Why this blocks release:

- exposes real cloud topology
- exposes resource naming conventions
- makes examples look normative instead of illustrative

Required action:

- replace real Azure IDs and names with placeholders
- keep only `*.template.json` variants public where possible
- remove or rewrite concrete vault and registry names in security docs

### 2. Internal first-contact seam doc contains live deployment values

Tracked file:

- `kaif_contract_first_contact.md`

Current content includes live audience, tenant, and agent-path assumptions such as:

- `urn:kindred:foundry:kindred-1882:gpt-5-mini`
- `spiffe://kindred.systems/ns/adaptive-layer/agent/lyra`

Why this blocks release:

- this is internal deployment truth, not protocol truth
- it leaks one specific integration seam into the public repo
- it may confuse readers about what KAIF requires versus what one deployment required

Required action:

- either exclude this file from the public branch
- or rewrite it as a generic example seam doc with placeholder values only

### 3. Local secret-bearing artifacts exist in the working tree

Observed locally:

- `.env`
- `.env.azure-sp.local`
- `.env.backup.*`
- `deploy/secrets/kaif/kaif-signing-key.pem`
- `deploy/secrets/kaif/spire-bundle-ca.pem`

Current check:

- these do not appear to be tracked by git

Why this still blocks release readiness:

- accidental add/publish risk remains high on a branch cut
- the signing-key path is especially sensitive even if ignored

Required action:

- verify these files are still untracked on the public branch
- do not copy them into any release tarball, archive, or demo pack
- if there is any doubt that `kaif-signing-key.pem` was ever committed elsewhere, rotate that key before public release

## Strongly Recommended Before Public Release

These are not as severe as the stop-ship items, but they should be handled on the public branch.

### 4. Separate protocol material from internal research and operations

Candidate files to exclude, quarantine, or clearly label:

- `handoff.md`
- `KAIF-Research-Paper-Architecture-WIP.md`
- `security/gaps.md`
- `security/STATUS.md`
- any internal timing, telemetry, or operator runbook material

Why:

- these files read as active operator memory rather than public documentation
- they mix internal status with public protocol narrative

Recommended action:

- move internal notes to a private branch or private companion repo
- keep public repo focused on protocol, implementation, conformance, examples, and sanitized deployment guidance

### 5. Normalize test fixtures that currently use live-looking integration values

Examples:

- `packages/server/tests/dns-delivery.test.ts`
- `packages/server/tests/foundry.test.ts`
- `packages/server/tests/config.test.ts`
- `packages/server/tests/boundary-authorize-async.test.ts`

Current values include:

- `tenant-dev`
- `dev-department-head-token`
- `kindred-1882`
- the live-looking Foundry audience and project endpoint

Why:

- these are probably test-only, but they read as real operational values
- public fixtures should clearly be placeholder or synthetic

Recommended action:

- replace with obviously synthetic values such as `tenant-example`, `dev-example-token`, `urn:example:foundry:agent:model`, and `https://example-resource.services.ai.azure.com/...`

### 6. Decide which Azure deployment artifacts belong in the public repo

Likely keep:

- `deploy/azure/*.template.json`
- generic shell helpers that work with placeholders

Likely remove or rewrite:

- concrete `*.json` exports that embed real resource IDs

## Draft/Publishing Posture

These items are acceptable if positioned honestly:

- `KAIF-RFC-Draft-00.md` as an early Internet-Draft candidate
- README/QUICKSTART/codebase docs that describe the protocol and reference implementation
- conformance and mock/dev-mode support, as long as public docs clearly distinguish local demo mode from production mode

These items should be explicitly labeled:

- RFC draft is still a draft
- conformance kit references marked `TBD` should be either resolved or called out as upcoming
- any “WIP” research doc should not sit in the public root unless intentionally published as a working note

## Public Branch Checklist

Copilot can use this as the exact branch checklist.

1. Create a public-release branch from the current repo.
2. Remove or template all real Azure subscription IDs, resource groups, and named resources.
3. Remove or rewrite `kaif_contract_first_contact.md` for public consumption.
4. Remove or quarantine internal handoff and research-state docs not meant for external readers.
5. Replace live-looking test fixture values with clearly synthetic placeholders.
6. Keep only sanitized Azure deployment templates in the public branch.
7. Confirm no secret-bearing files are tracked.
8. Confirm no rendered artifacts or local-only scratch outputs are tracked unless intentionally published.
9. Run a final grep-based scrub before push.

## Final Verification Commands

Run these on the public branch before pushing.

### Check for tracked secrets and key material

```bash
git ls-files | rg '(^|/)\.env($|\.|/)|\.pem$|\.key$|deploy/secrets|private[_-]?key|client[_-]?secret'
```

Expected result:

- no tracked local env files
- no tracked private key material
- no tracked `deploy/secrets` paths

### Check for live cloud identifiers

```bash
git grep -nE '7460a200-e4dc-4e0f-8c3e-7db55e47647c|rg-kindred-2461|kindred-1882-resource|kaif-kv-a4c02bd7|kaifacra4c02bd7'
```

Expected result:

- no hits, or only intentionally templated/example strings

### Check for internal DNS/Foundry seam values

```bash
git grep -nE 'tenant-dev|dev-department-head-token|urn:kindred:foundry:kindred-1882:gpt-5-mini|spiffe://kindred.systems/ns/adaptive-layer/agent/lyra'
```

Expected result:

- no hits in public docs
- test fixtures only if intentionally retained and clearly marked synthetic

### Check public docs for internal-state language

```bash
git grep -nE 'WIP|work in progress|internal only|private repo|handoff|operator note|live proof in this repo'
```

Expected result:

- no accidental internal-status phrasing in public-facing docs

## Definition Of Safe To Publish

The public branch is safe to publish when all of the following are true:

- no tracked secrets or private key material exist
- no real cloud subscription/resource identifiers remain
- no internal-only seam docs remain in live form
- public docs describe KAIF as protocol plus reference implementation, not as one private deployment snapshot
- tests and examples use clearly synthetic values
- release artifacts are intentional, minimal, and understandable by an external reader

## Recommended Public Layout

If time is limited, bias toward a smaller public tree:

- `README.md`
- `QUICKSTART.md`
- `CODEBASE_TOUR.md`
- `index.md`
- `wiki.md`
- `KAIF-RFC-Draft-00.md`
- `packages/server/`
- `examples/`
- `conformance/`
- sanitized `security/` and `deploy/azure/*.template.json`

Keep private or move out:

- `handoff.md`
- live seam notes
- concrete workbook/dashboard exports with real IDs
- internal research-state documents not meant for outside readers
