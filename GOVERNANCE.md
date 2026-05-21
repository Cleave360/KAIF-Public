# KAIF Governance

## Project Roles

**Maintainer** — merge authority, protocol decisions, release sign-off. Responsible for SPEC.md changes and the RFC process.

**Contributor** — PR author, issue reporter, documentation contributor. No merge authority.

**Adopter** — production user of the KAIF protocol. Invited to share integration feedback and conformance results.

**Current maintainers:** Geoff (Kindred Systems OS)

---

## Decision Making

**Routine code changes** — one maintainer approval required. "Routine" means: no protocol changes, no new dependencies, no security-sensitive files.

**Protocol changes (SPEC.md)** — require a KAIF-RFC document in `/rfcs`, a 7-day public comment period, and maintainer consensus. Consensus means no maintainer objects; silence is consent.

**New dependencies** — require maintainer approval before a PR is opened. This is a security project; every dependency is an attack surface.

**New maintainers** — nominated by an existing maintainer, seconded by one contributor, 14-day objection period. Nomination requires demonstrated sustained contribution.

**Security-sensitive changes** — any change to `packages/server/src/crypto/`, `services/token-exchange.ts`, or `services/audit.ts` requires maintainer code review regardless of PR size.

---

## RFC Process

1. Open a GitHub issue with the prefix `[RFC]` and a one-line summary
2. Create `rfcs/KAIF-RFC-<number>-<slug>.md` using the template in `rfcs/TEMPLATE.md`
3. 7-day comment period — all feedback must be addressed or explicitly declined with reasoning
4. Maintainer decision: **accept** / **reject** / **revise**
5. Accepted RFCs are merged; the corresponding SPEC.md change is made in the same PR

Protocol changes require a MAJOR version bump to the spec version header. Implementation semver follows independently.

---

## Versioning

**Spec:** The `KAIF Core Profile vX.Y` header in `SPEC.md` is the spec version. Breaking changes to normative claims require a MAJOR bump. Additive normative changes require a MINOR bump. Clarifications require a PATCH bump.

**Implementation:** Semver in `package.json`. The implementation version tracks the spec it implements, not necessarily in lockstep.

Breaking changes to the Core claims (`sub`, `actor`, `kaif.*`) require both a MAJOR spec bump and a deprecation notice published at least 30 days before the change takes effect.

---

## CNCF Intent

KAIF intends to apply for CNCF Sandbox status once:

- Two independent conforming implementations exist (verified by the conformance kit)
- The conformance kit is publicly reproducible from a clean clone
- This governance model has been operational for at least 90 days
- A public mailing list or discussion forum is established

CNCF candidacy is subject to the CNCF TOC review process and is not guaranteed.
