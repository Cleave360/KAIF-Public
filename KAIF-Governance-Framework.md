# KAIF Governance Framework

**Version**: 1.0  
**Effective Date**: 2026-06-27  
**Status**: PROPOSAL (Seeking community feedback)

## 1. Overview

This document establishes governance structures, decision-making processes, and maintenance responsibilities for the Kindred Agent Identity Framework (KAIF) as it transitions from a proprietary reference implementation to a potential open standards protocol.

The goal is to create a lightweight, inclusive governance model that:
- Ensures protocol stability and backward compatibility
- Enables rapid community contribution
- Maintains security and audit integrity
- Remains agnostic to any single operator or use case

## 2. Project Roles and Responsibilities

### 2.1 Maintainers

**Definition**: Maintainers have write access to the canonical repository and can approve/merge pull requests.

**Responsibilities**:
- Review PRs for conformance with KAIF specification and security policy
- Respond to issues and vulnerability reports within 48 hours
- Update changelog and version tags
- Publish releases
- Represent the project at standards bodies (IETF, CNCF, etc.)

**Appointment**:
- Initial maintainers: Kindred Systems (until community grows)
- Additional maintainers: Nominated by existing maintainers, approved by 2/3 consensus
- Maintainer tenure: 1 year, renewable

**Current Maintainers**:
- Geoffrey Lundholm (Kindred Systems)

**Emeritus**: None (first round)

### 2.2 Contributors

**Definition**: Contributors submit PRs, file issues, and provide feedback.

**Responsibilities**:
- Follow CONTRIBUTING.md conventions
- Ensure PRs have tests (>90% coverage for services, 100% for crypto)
- Ensure commits follow Conventional Commits format
- Participate in RFCs for protocol changes

**Recognition**: Named in CONTRIBUTORS.md with PR/issue counts

### 2.3 Adopters

**Definition**: Organizations using KAIF in production or pre-production.

**Responsibilities**:
- Report security findings and deployment issues
- Provide feedback on protocol usability
- Contribute reference implementations or tooling (optional)

**Recognition**: Listed in ADOPTERS.md with use case description

### 2.4 Security Team (New)

**Definition**: Volunteers responsible for handling vulnerability reports.

**Responsibilities**:
- Triage vulnerability reports
- Coordinate patches with maintainers
- Publish security advisories
- Coordinate responsible disclosure timeline (14 days default)

**Members**: TBD (invite CNCF security volunteers)

## 3. Decision-Making Process

### 3.1 Protocol Changes (RFC Process)

Any change to the KAIF protocol specification requires an RFC (Request for Comments).

**Process**:

1. **Proposal Phase** (1-2 weeks)
   - Author opens GitHub Issue tagged `rfc-proposal`
   - Describes problem, proposed solution, and impact
   - Community provides initial feedback
   
2. **RFC Drafting** (2-4 weeks)
   - Author creates `/rfcs/KAIF-RFC-NNNN.md` with:
     - Problem statement
     - Proposed specification changes
     - Backward compatibility impact
     - Security implications
     - Reference implementation sketch
   - Maintainers assign RFC number
   
3. **Review Period** (2 weeks minimum)
   - Posted to KAIF Issue tracker and community channels
   - Feedback incorporated by author
   - Maintainers solicit external review (IETF OAuth WG, SPIFFE community, etc.)
   
4. **Acceptance Decision** (Maintainers consensus)
   - Unanimous approval: Accepted
   - 1 maintainer dissent: Discuss until consensus or vote
   - 2+ maintainers dissent: Withdrawn (may resubmit)
   - Vote (if no consensus): 2/3 approval required

5. **Implementation**
   - Author or volunteer implements in reference implementation
   - PR must include tests + updated spec
   - Binds to next MINOR version (X.Y.0)

**Example RFCs**:
- `KAIF-RFC-0001: Issuer Metadata Endpoint (.well-known/kaif-metadata.json)`
- `KAIF-RFC-0002: Multi-Issuer Federation`
- `KAIF-RFC-0003: Behavioral Trust Signals (Optional, Opt-In)`

### 3.2 Implementation Changes (PR Process)

**Non-protocol changes** (bugfixes, performance, new language bindings, tooling) use standard PR review:

1. Author submits PR with:
   - Clear description of change
   - Tests (at least 80% coverage for affected code)
   - Updated CHANGELOG.md with entry under `[Unreleased]`
   
2. Maintainers review for:
   - Correctness
   - Security (flagged by maintainers for crypto changes)
   - Test coverage
   - Lint compliance (ESLint, Prettier)
   
3. Approval: 1 maintainer sign-off minimum (code review + tests)

4. Merge: Squash commit with PR title + author name

**Fast-track bugfixes**:
- Security hotfixes: 1 maintainer + 1 community reviewer → merge immediately
- Regression fixes: 1 maintainer approval → merge immediately (no 24h wait)

### 3.3 Release Versioning

KAIF uses semantic versioning: MAJOR.MINOR.PATCH

- **PATCH** (X.Y.Z): Bugfixes, no spec changes
  - Release cadence: As needed (within 48h of merged PR)
  - Example: 1.0.0 → 1.0.1
  
- **MINOR** (X.Y.0): Backward-compatible spec additions
  - RFC required, community review
  - Release cadence: Quarterly
  - Example: 1.0.0 → 1.1.0
  
- **MAJOR** (X.0.0): Breaking changes
  - RFC + standards body engagement required
  - Deprecation period minimum: 2 minor versions (6+ months)
  - Example: 1.0.0 → 2.0.0

**Support Lifecycle**:

- Current version: Receives all patches
- Previous MINOR version: Receives security patches for 6 months
- Older versions: No support

Example support matrix:

| Version | Status | Patches | Until |
|---------|--------|---------|-------|
| 1.2.0 | Current | Yes | - |
| 1.1.x | LTS | Security only | 2026-12-27 |
| 1.0.x | EOL | None | 2026-06-27 |

## 4. Standards Body Engagement

KAIF is being positioned as a potential standard in multiple forums:

### 4.1 IETF OAuth Working Group

**Timeline**: Q3 2026 (6 months from now)

**Objectives**:
- Present KAIF as OAuth 2.0 extension (RFC 8693 use case)
- Request expert review from OAuth experts
- Target: IETF Proposed Standard (RFC publication)

**Engagement**:
- Submit draft-kaif-token-exchange-00 (individual submission)
- Present at IETF 117 (July 2026)
- Incorporate WG feedback in draft-01

### 4.2 CNCF Security Technical Advisory Group (TAG-Security)

**Timeline**: Q3 2026

**Objectives**:
- Nominate KAIF as CNCF incubation project (future)
- Align with SPIFFE/SPIRE community
- Request security audit sponsorship

**Engagement**:
- Submit CNCF Sandbox application (2026-09-01)
- Security audit via CNCF partners (NCC Group, Trail of Bits)
- Graduate to Incubation if audit passes + 2+ independent implementations

### 4.3 SPIFFE Steering Committee

**Timeline**: Q4 2026

**Objectives**:
- Establish KAIF as recommended JWT-SVID consumer
- Coordinate with SPIFFE roadmap

**Engagement**:
- Present at CNCF KubeCon 2026 (North America)
- Propose KAIF use cases in SPIFFE documentation

## 5. Trademark and Licensing

### 5.1 License

KAIF protocol specification and reference implementation are dual-licensed:

- **Specification** (KAIF-RFC-Draft-00.md, KAIF-Research-Paper-Architecture-WIP.md): 
  - CC BY-SA 4.0 (attribution required, derivatives must license identically)
  
- **Source Code** (packages/server, packages/sdk, examples):
  - Apache License 2.0 (permissive, commercial-friendly)
  
- **Test Suite**:
  - Apache License 2.0

### 5.2 Trademark

"KAIF" and "Kindred Agent Identity Framework" are trademarks of Kindred Systems.

**Use Policy**:
- Implementations may reference "KAIF-conformant" if they pass conformance suite
- Implementations may NOT claim to be "KAIF" or "official KAIF implementation"
- Adopters listed in ADOPTERS.md with fair attribution

## 6. Contribution Guidelines

### 6.1 Submitting Changes

All contributors must:

1. **Sign the CLA** (Contributor License Agreement)
   - Single CLA for all KAIF contributors
   - Assigns copyright to the project (not individual)
   - Ensures IETF/standards body compatibility

2. **Follow Conventional Commits**
   ```
   type(scope): subject
   
   body (if needed)
   
   Fixes #ISSUE_NUMBER
   ```
   
   Types: `feat`, `fix`, `docs`, `test`, `chore`, `refactor`
   
   Example:
   ```
   feat(token-exchange): add RFC 8705 CNF binding support
   
   Implements certificate-bound access tokens per RFC 8705.
   Token now includes cnf.x5t#S256 when mTLS client cert provided.
   
   Fixes #42
   ```

3. **Run Tests Locally**
   ```bash
   pnpm install
   pnpm test
   pnpm lint
   ```

4. **Include Tests**
   - New service features: ≥90% coverage
   - Crypto changes: 100% coverage
   - Bugfixes: Regression test required

5. **Update Documentation**
   - README.md if user-facing
   - CHANGELOG.md under `[Unreleased]`
   - Inline code comments for non-obvious logic

### 6.2 Code of Conduct

KAIF adheres to the Contributor Covenant Code of Conduct v2.1.

**Enforcement**:
- Report violations to: kindred@kindredsystems.ai
- Maintainers investigate and respond within 10 business days
- Consequences: Warning → PR blocking → project ban (escalation)

## 7. Security Policy

### 7.1 Vulnerability Reporting

**DO NOT** file security issues on GitHub. Instead:

Email: **kindred@kindredsystems.ai**

Include:
- Description of vulnerability
- Affected version(s)
- Steps to reproduce
- Impact assessment

### 7.2 Response Process

1. **Triage** (24-48 hours)
   - Security team reviews and confirms severity
   - Reporter is notified of confirmation + timeline
   
2. **Fix Development** (varies)
   - CRITICAL: Fix within 3 days, patch released within 5 days
   - HIGH: Fix within 10 days, patch released within 14 days
   - MEDIUM: Fix within 30 days, patch released within next minor release
   - LOW: Fix in next release (no urgent patch)
   
3. **Coordinated Disclosure** (varies)
   - Pre-notification sent to adopters listed in ADOPTERS.md (72-hour window)
   - Patch + advisory published simultaneously
   - Credit given to researcher (with permission)

### 7.3 Security Audit

External security audit is REQUIRED before IETF Proposed Standard submission.

**Scope**: Specification + reference implementation + test suite

**Audit Schedule**: 
- Q4 2026 (before IETF-118 standards track push)
- Annual re-audit thereafter

**Auditors** (preferred): NCC Group, Trail of Bits, Cure53

## 8. Communication Channels

| Channel | Purpose | Cadence |
|---------|---------|---------|
| GitHub Issues | Bug reports, feature requests, RFCs | Ongoing |
| GitHub Discussions | Design discussions, questions | Ongoing |
| Slack (TBD) | Real-time chat, coordination | Daily |
| Mailing List (TBD) | Formal announcements, standards updates | Weekly |
| Community Call | Sync on roadmap, RFC reviews | Monthly (Tuesdays 10am PT) |
| Office Hours | Ad-hoc Q&A with maintainers | Fridays 3pm PT (30-min slots) |

## 9. Funding and Sponsorship

### 9.1 Governance Independence

KAIF governance is **independent** of any single vendor or operator.

- Kindred Systems commits initial funding (software, infrastructure, personnel)
- Maintainer roles rotatable (no single vendor control)
- Protocol changes require community consensus (not unilateral)

### 9.2 CNCF Sandbox (Future)

Once KAIF has 2+ independent implementations, apply for CNCF Sandbox:

- Provides neutral home for the project
- Access to CNCF infrastructure (CI/CD, security scanning, design docs)
- Legal/trademark support
- Visibility in CNCF ecosystem

**Milestones**:
- 2026-09-01: CNCF Sandbox application submitted
- 2026-12-01: Expected acceptance into Sandbox
- 2027-06-01: Target graduation to Incubation

## 10. Deprecation Policy

KAIF maintains strict backward compatibility. Breaking changes are only introduced with:

1. **Deprecation period**: 2 MINOR versions minimum (6 months) before removal
2. **Deprecation notice**: Clearly marked in specification, changelog, and code comments
3. **Migration guide**: Users provided clear path to updated behavior
4. **Major version bump**: Breaking change triggers MAJOR version increment

**Example (v1.0 → v1.1 → v1.2 → v2.0)**:

```
v1.0: Feature X works normally
v1.1: Feature X marked @deprecated, replacement available as Feature X'
v1.2: Feature X marked @deprecated (reminder), Feature X' now recommended
v2.0: Feature X removed, Feature X' is only option
```

## 11. Roadmap Transparency

### 11.1 Public Roadmap

Roadmap is published in [KAIF-Global-Adoption-Roadmap.md](./KAIF-Global-Adoption-Roadmap.md) and updated quarterly.

**Sections**:
- Current phase (where we are)
- Next 6 months (planned work)
- 6-12 months (in discussion)
- 12+ months (exploratory)

Roadmap is advisory only—implementation depends on community contribution and prioritization.

### 11.2 Issue Prioritization

Issues are labeled by category + priority:

**Categories**: `type:bug`, `type:feature`, `type:docs`, `type:test`, `type:security`

**Priority**: `priority:critical`, `priority:high`, `priority:medium`, `priority:low`

Triaged weekly; maintainers solicit community input on priority conflicts.

## 12. Governance Review

This governance framework will be reviewed annually (June 27, 2027).

**Review includes**:
- Number of active contributors
- Number of independent implementations
- Standards body engagement outcomes
- Community feedback (survey)
- Proposed governance changes

**Changes to governance**:
- RFC process (same as protocol changes)
- 2/3 maintainer consensus required
- Updated version number in this document

## 13. Acknowledgments

This governance framework is inspired by:

- Apache Software Foundation governance
- IETF RFC 7934 (Open Standing IETF Research Agenda)
- CNCF Project Lifecycle
- Python Software Foundation governance
- Kubernetes community structure

---

**Document History**

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-06-27 | Initial proposal |

---

**For Questions or Feedback**

Email: kindred@kindredsystems.ai
GitHub: Open an issue tagged `governance-discussion`
