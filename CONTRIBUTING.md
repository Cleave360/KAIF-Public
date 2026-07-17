# Contributing to KAIF

Thanks for helping improve KAIF.

## Development Setup

Prerequisites:
- Node.js 20 LTS
- pnpm 8+
- Docker and Docker Compose v2

Clone and install:

```bash
git clone https://github.com/Cleave360/KAIF-Public.git
cd KAIF
pnpm install
```

Run checks before opening a pull request:

```bash
pnpm test
pnpm exec tsc --noEmit
```

## Commit Format

Use Conventional Commits.

Examples:

```text
feat: add delegation depth guard for sub-delegation flow
fix: enforce 10-second skew tolerance in SVID validation
docs: clarify relying-party revocation modes
test: add revoked-subject-token conformance fixture
chore: bump spire container image version
```

For breaking changes, use the bang form and include a BREAKING CHANGE footer.

## Pull Request Requirements

- Tests pass with no failures.
- Type checking passes with no errors.
- New dependencies are discussed and approved before merge.
- Security-sensitive changes include explicit maintainer review.
- Protocol changes include an accepted RFC and corresponding spec update.

## Code Style

- TypeScript strict mode is required.
- Use ESLint and Prettier config from the repository.
- Keep code clear and explicit; avoid unnecessary abstraction.
- Never log token values; log token identifiers such as jti only.
- Keep Redis keys namespaced with KAIF prefixes.

Useful commands:

```bash
pnpm lint
pnpm format
```

## Security-Sensitive Areas

Changes in the following areas require maintainer security review:
- [packages/server/src/crypto](packages/server/src/crypto)
- [packages/server/src/services/token-exchange.ts](packages/server/src/services/token-exchange.ts)
- [packages/server/src/services/audit.ts](packages/server/src/services/audit.ts)
- [SPEC.md](SPEC.md)

When submitting security-impacting changes, include threat model notes and regression tests.

## Protocol Changes

Normative protocol changes require an RFC document in [rfcs](rfcs) and maintainer consensus. See [GOVERNANCE.md](GOVERNANCE.md).
