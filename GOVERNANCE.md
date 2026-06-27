# KAIF Governance

Version: 1.1
Status: Active
Last updated: 2026-06-27

## Project Roles

Maintainer:
Owns repository health, protocol integrity, releases, and security response coordination. Maintainers have merge rights.

Contributor:
Proposes and implements code, test, and documentation changes through issues and pull requests. Contributors do not have merge rights.

Adopter:
Runs KAIF in pre-production or production and provides interoperability, operability, and security feedback.

Current maintainers:
- Geoff Lundholm (Kindred Systems OS)

## Decision Making

Code changes:
- Pull requests require at least one maintainer approval.
- Security-sensitive changes always require maintainer review, regardless of size.

Protocol changes:
- Any normative change to [SPEC.md](SPEC.md) requires a KAIF RFC document in [rfcs](rfcs) and maintainer consensus.
- Maintainer consensus means no explicit maintainer objection at decision time.

Dependency changes:
- New runtime dependencies require maintainer approval before merge.

Maintainer onboarding:
- Nominated by a maintainer and seconded by a contributor.
- 14-day public objection window before appointment.

## RFC Process

1. Open an issue prefixed with [RFC] and summarize the proposed change.
2. Submit an RFC document at [rfcs](rfcs) using the naming pattern KAIF-RFC-NNNN-slug.md.
3. Keep the RFC open for at least 7 days for review and comments.
4. Address feedback or record rationale for declined suggestions.
5. Maintainers decide: accept, revise, or reject.
6. If accepted, merge RFC and related spec or implementation changes.

## Versioning Policy

Specification versioning:
- Protocol version is declared in [SPEC.md](SPEC.md) and is versioned independently.
- MAJOR for breaking normative changes.
- MINOR for backward-compatible normative additions.
- PATCH for clarifications and editorial corrections.

Implementation versioning:
- Runtime and packages follow SemVer in [package.json](package.json).
- Implementation and protocol versions are related but not required to be lockstep.

Deprecation:
- Breaking protocol changes must include a deprecation notice and migration guidance.

## Security-Sensitive Areas

The following areas require explicit maintainer security review:
- [packages/server/src/crypto](packages/server/src/crypto)
- [packages/server/src/services/token-exchange.ts](packages/server/src/services/token-exchange.ts)
- [packages/server/src/services/audit.ts](packages/server/src/services/audit.ts)
- [SPEC.md](SPEC.md)

## CNCF Intent

KAIF intends to pursue CNCF Sandbox once the project demonstrates:
- At least two independent conformant implementations.
- Publicly reproducible conformance results.
- Active open governance in this repository.
- Ongoing public community discussion.

Sandbox and later Incubation outcomes depend on CNCF TOC review and are not guaranteed.
