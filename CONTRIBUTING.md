# Contributing to KAIF

## Development Setup

**Prerequisites:** Node.js 20 LTS, pnpm 8+, Docker, Docker Compose v2.

```bash
git clone https://github.com/kindred-systems/kaif
cd kaif
pnpm install
pnpm test          # must pass before any changes
```

`pnpm test` runs `vitest run` across all packages. All 128 tests must pass before submitting a PR.

---

## Making Changes

1. Open a GitHub issue describing the change — get alignment before writing code
2. Fork the repo and create a branch: `feat/<slug>` or `fix/<slug>`
3. Write tests first for any new behaviour
4. Run `pnpm test` — 0 failures required
5. Run `pnpm exec tsc --noEmit` in each modified package — 0 TypeScript errors required
6. Open a PR against `main`

For new dependencies: get maintainer approval before adding to `package.json`. See [GOVERNANCE.md](GOVERNANCE.md).

---

## Commit Format

[Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add GNAP grant negotiation endpoint
fix: correct clock skew tolerance in svid.ts (was 30s, must be 10s)
docs: clarify cnf/jkt normative statement in SPEC.md
test: add scope overreach fixture to conformance kit
chore: update SPIRE to 1.9.1
refactor: extract scope glob matching to shared utility
```

Breaking changes: append `!` after the type (`feat!:`) and add a `BREAKING CHANGE:` footer.

---

## PR Requirements

- Tests pass (`pnpm test`) — 0 failures
- TypeScript strict mode — 0 errors (`pnpm exec tsc --noEmit`)
- No new dependencies without prior maintainer approval
- Security review required for changes to security-sensitive files (see below)
- Protocol changes require an accepted RFC (see [GOVERNANCE.md](GOVERNANCE.md))

---

## Security-Sensitive Files

Changes to these files require maintainer code review regardless of PR size:

| File | Why |
|---|---|
| `packages/server/src/crypto/` | Key generation and JWT signing primitives |
| `packages/server/src/services/token-exchange.ts` | Core RFC 8693 flow — all auth paths |
| `packages/server/src/services/audit.ts` | SHA-256 hash chain — tamper detection |
| `SPEC.md` | Normative protocol specification — changes require RFC |

When modifying `crypto/keys.ts`: read the `_cachePromise` comment in `SECURITY.md` before touching key loading logic. The race it prevents is non-obvious and the failure mode is silent.

---

## Code Style

- TypeScript strict mode — `strict: true`, `exactOptionalPropertyTypes: true`, `noUncheckedIndexedAccess: true`
- No comments unless the *why* is non-obvious. Never comment what the code does.
- No new abstractions unless three concrete call sites exist. Duplication over premature abstraction.
- All Redis keys MUST use KAIF prefixes: `kaif:audit:`, `kaif:trust:`, `kaif:delegation:`, `kaif:revoke:`
- Never log token values. Log `jti` only.

ESLint and Prettier configs live in the repo root. Run `pnpm lint` and `pnpm format` before submitting.
