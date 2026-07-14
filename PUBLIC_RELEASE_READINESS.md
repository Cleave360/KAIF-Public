# KAIF Public Release Readiness

Date: 2026-07-14
Status: Public branch requires one more sanitize pass before publish

## Remaining Public-Branch Goals

- keep protocol and reference implementation public
- remove private deployment identifiers
- keep examples synthetic
- keep secrets and local release artifacts out of git

## Branch Checklist

1. Remove concrete Azure export JSON that embeds real resource IDs.
2. Keep template variants only for Azure workbooks and dashboards.
3. Replace live-looking DNS and Foundry values in tests with synthetic placeholders.
4. Rewrite any security or deployment doc that still names a real vault, registry, tenant, or audience.
5. Confirm `deploy/secrets/` and local env files are untracked.

## Verification Commands

```bash
git ls-files | rg '(^|/)\.env($|\.|/)|\.pem$|\.key$|deploy/secrets'
git grep -nE '7460a200-e4dc-4e0f-8c3e-7db55e47647c|rg-kindred-2461|kindred-1882-resource|kaif-kv-a4c02bd7|kaifacra4c02bd7' -- . ':(exclude)PUBLIC_RELEASE_READINESS.md'
git grep -nE 'tenant-dev|dev-department-head-token|urn:kindred:foundry:kindred-1882:gpt-5-mini' -- . ':(exclude)PUBLIC_RELEASE_READINESS.md'
```

Expected result:

- no tracked secret material
- no real Azure subscription or resource IDs
- no live DNS or Foundry seam values in public docs or tests
