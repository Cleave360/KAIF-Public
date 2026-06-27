# KAIF Global Protocol Adoption Roadmap

**Version**: 1.0  
**Status**: DRAFT FOR COMMUNITY FEEDBACK  
**Planning Horizon**: 18 months (2026-06-27 to 2027-12-31)  
**Last Updated**: 2026-06-27

---

## Executive Summary

This roadmap outlines the path from KAIF v0.9.1 (staging-ready reference implementation) to IETF Proposed Standard + CNCF Incubation Project status.

**Key milestones**:

| Phase | Timeline | Goal | Success Metric |
|-------|----------|------|-----------------|
| **Phase 0: Standardization Foundation** | Jun–Aug 2026 | IETF draft + conformance kit | RFC-format spec + 3 passing reference implementations |
| **Phase 1: Ecosystem Proof** | Sep–Nov 2026 | 2+ independent implementations + early adopter | Python/Go implementations passing conformance, live deployment case study |
| **Phase 2: Standards & Governance** | Dec 2026–Feb 2027 | CNCF Sandbox application + security audit | Audit passed, CNCF Sandbox accepted, first community call |
| **Phase 3: Community Growth** | Mar–Jun 2027 | Ecosystem visibility + adoption signals | 5+ adopters, 3rd language implementation, KubeCon talk accepted |
| **Phase 4: Standards Convergence** | Jul–Dec 2027 | IETF Working Group adoption + graduation | KAIF draft in IETF OAuth WG, CNCF Incubation graduation |

**Estimated total effort**: 12-15 FTE months across 4-6 people

---

## Phase 0: Standardization Foundation (Jun–Aug 2026)

### 0.1 RFC Draft Specification

**Objective**: Publish KAIF as an IETF individual draft (not yet WG item).

**Deliverables**:

- [ ] **KAIF-RFC-Draft-00.md** (complete)
  - Status: Written (see /KAIF-RFC-Draft-00.md)
  - Next: Solicit feedback from OAuth WG experts via email
  - Due: 2026-07-15

- [ ] **Submit to IETF Datatracker**
  - Process: Upload to datatracker.ietf.org as individual draft
  - Format: Convert Markdown to RFC XML format (using mmark or pandoc)
  - Due: 2026-07-20
  - Post-submission: Announce on IETF oauth-wg mailing list

- [ ] **Incorporate Initial Feedback** (1 revision cycle)
  - Gather responses from IETF experts
  - RFC author addresses concerns, updates draft
  - Due: 2026-08-15

**Dependencies**: None (RFC skeleton is complete)

**Effort**: 2 weeks (1 person)

**Owner**: Geoffrey Lundholm

---

### 0.2 Conformance Test Suite (Public Release)

**Objective**: Formalize 7 existing integration tests as a vendor-neutral conformance kit.

**Deliverables**:

- [ ] **Conformance Test Specification** (`/conformance/SPEC.md`)
  - Documents 7 test fixtures with pass/fail criteria
  - Each test: problem statement + input + expected output
  - Includes both positive (happy path) and negative (error) cases
  - Due: 2026-07-10

  Test fixtures to document:
  1. **Token Exchange Happy Path**: Operator provision → RFC 8693 exchange → valid token
  2. **JWT-SVID Validation**: Invalid actor_token rejected with 401
  3. **Scope Enforcement**: Requested scope > permitted scope → 400 invalid_scope
  4. **Authorization Tier Minimum**: Trust score below ACL minimum → 403 insufficient_trust
  5. **Delegation Depth Exceeded**: Sub-delegation depth > ACL max → 403 depth_exceeded
  6. **Token Revocation**: Post-revocation, introspect returns { active: false }
  7. **Audit Chain Verification**: Hash chain integrity check succeeds for unmodified logs

- [ ] **Reference Test Harness** (TypeScript, vendor-neutral format)
  - Executable test suite in /conformance/test-harness/
  - Generates HTML + JSON report with pass/fail per fixture
  - CI-friendly: Runs in GitHub Actions, Docker
  - Due: 2026-07-20

- [ ] **Test Results for KAIF Reference Implementation**
  - Run test harness against /packages/server
  - Publish report showing 7/7 PASS
  - Document environment (Node.js version, Redis version, etc.)
  - Due: 2026-07-25

**Dependencies**: Existing integration tests (already passing)

**Effort**: 1.5 weeks (1 person)

**Owner**: TBD (new contributor welcome)

---

### 0.3 Relying Party Profile Specification

**Objective**: Single-page spec for external services to validate KAIF tokens without running KAIF server.

**Deliverables**:

- [ ] **Relying Party Profile** (`/docs/RELYING_PARTY_PROFILE.md`)
  - Sections:
    1. Trust bootstrap (issuer discovery, JWKS caching)
    2. Token validation algorithm (signature, expiry, scope)
    3. Revocation checking (lazy vs. strict modes)
    4. RFC 8705 mTLS binding validation
    5. Error handling and fallback behavior
    6. Example implementations (pseudo-code in 3 languages)
    7. Audit logging requirements
  - Length: ~4-5 pages
  - Due: 2026-07-30

- [ ] **Example Relying Party Implementation** (Node.js)
  - /examples/mock-relying-party/
  - Demonstrates token validation + audit logging
  - Includes unit tests
  - Due: 2026-08-15

**Dependencies**: RFC draft (to reference sections)

**Effort**: 1 week (1 person)

**Owner**: TBD

---

### 0.4 Documentation Refresh

**Objective**: Update repo docs to reflect standardization path + governance.

**Deliverables**:

- [ ] **README.md** rewrite
  - Add "Standardization Status" section (IETF individual draft, CNCF Sandbox planned)
  - Add "Get Involved" section (how to contribute, governance link)
  - Clarify external vs. internal deployment use cases
  - Due: 2026-07-15

- [ ] **GOVERNANCE.md** (complete—see `/KAIF-Governance-Framework.md`)
  - Status: Written
  - Action: Move content to /GOVERNANCE.md in repo
  - Due: 2026-07-10

- [ ] **CONTRIBUTING.md** (new)
  - CLA requirement
  - Conventional Commits format
  - PR process (tests, lint, coverage)
  - Security disclosure process
  - Due: 2026-07-10

- [ ] **ADOPTERS.md** (new, empty template)
  - Template for organizations to list their KAIF usage
  - Include: company name, use case, deployment date
  - Due: 2026-07-10

**Dependencies**: None

**Effort**: 3-4 days (0.5 person)

**Owner**: Geoffrey Lundholm

---

## Phase 1: Ecosystem Proof (Sep–Nov 2026)

### 1.1 Reference Implementation: Python (Fastapi)

**Objective**: Port KAIF server to Python to prove protocol language-agnostic.

**Deliverables**:

- [ ] **KAIF Server (Python/Fastapi)**
  - Location: /reference-implementations/python-fastapi/
  - Implements all endpoints from RFC spec:
    - POST /provision, /oauth/token, /introspect, /revoke
    - GET /.well-known/jwks.json, /health
  - Features:
    - SPIRE bundle JWT-SVID validation
    - Redis-backed ACL + revocation
    - SHA-256 audit chain
    - OAuth 2.0 error responses (RFC 6749)
  - Test coverage: ≥90%
  - Due: 2026-10-15

- [ ] **KAIF SDK (Python)**
  - Location: /reference-implementations/python-fastapi/kaif_sdk/
  - KAIFClient class (mirror of TypeScript SDK)
  - Methods: getToken(), refreshToken(), revoke()
  - Due: 2026-10-20

- [ ] **Conformance Test Results**
  - Run /conformance/test-harness against Python implementation
  - Publish report: 7/7 PASS
  - Due: 2026-10-25

**Dependencies**: Phase 0 conformance test suite

**Effort**: 6-8 weeks (1.5 FTE)

**Owner**: TBD (Python community member)

---

### 1.2 Reference Implementation: Go

**Objective**: Prove KAIF portable to statically-typed, cloud-native language.

**Deliverables**:

- [ ] **KAIF Server (Go/net-http)**
  - Location: /reference-implementations/go-net/
  - Same endpoints as Python implementation
  - Features:
    - gRPC SPIRE workload API (vs. REST bundle endpoint)
    - Optimized for Kubernetes (Alpine image, minimal startup time)
  - Test coverage: ≥90%
  - Due: 2026-11-15

- [ ] **KAIF SDK (Go)**
  - Location: /reference-implementations/go-net/kaif/
  - Package kaif with KAIFClient interface
  - Due: 2026-11-20

- [ ] **Conformance Test Results**
  - Run /conformance/test-harness against Go implementation
  - Publish report: 7/7 PASS
  - Due: 2026-11-25

**Dependencies**: Phase 0 conformance test suite + Python implementation (template)

**Effort**: 6-8 weeks (1.5 FTE)

**Owner**: TBD (Go/cloud-native community member)

---

### 1.3 Early Adopter Case Study

**Objective**: Real-world deployment to validate protocol assumptions.

**Deliverables**:

- [ ] **Select Adopter** (by 2026-09-15)
  - Criteria:
    - Boundary-crossing transaction use case (payment, regulated API, purchase)
    - Willing to document integration publicly
    - 3-6 month commitment to staging/production pilot
  - Candidates: fintech API, e-commerce platform, cloud infrastructure provider
  - Owner: Geoffrey Lundholm (outreach)

- [ ] **Deployment & Integration** (2026-09-15 to 2026-10-31)
  - Adopter integrates KAIF token validation into their service
  - Use cases tested:
    - Token validation latency
    - Revocation propagation time
    - Audit trail correlation
  - Operational runbook documented

- [ ] **Case Study Report** (`/docs/CASE_STUDY_FirstAdopter.md`)
  - Sections:
    1. Company profile (anonymized if needed) + use case
    2. Integration approach (how they validated tokens)
    3. Metrics: latency, uptime, error rates
    4. Lessons learned + feedback
    5. Recommendations for protocol v1.1
  - Due: 2026-11-30

**Dependencies**: Phase 0.3 (Relying Party Profile) must be finalized first

**Effort**: 2-3 weeks (1 person full-time to coordinate integration)

**Owner**: Geoffrey Lundholm + Adopter's engineering team

---

### 1.4 Developer Experience Improvements

**Objective**: Reduce friction for implementers.

**Deliverables**:

- [ ] **Docker Compose Stack** (enhanced)
  - Include all 3 reference implementations
  - Simplify local development
  - One-command: `docker compose -f dev.full-stack.yml up`
  - Due: 2026-10-15

- [ ] **Client SDK Docs** (all 3 languages)
  - TypeScript: Enhanced README with examples
  - Python: PyPI package + docs
  - Go: pkg.go.dev documentation
  - Due: 2026-11-15

- [ ] **Quickstart Guide** (`/docs/QUICKSTART.md`)
  - 5-minute walkthrough
  - Spin up KAIF locally + run example token exchange
  - Minimal dependencies
  - Due: 2026-09-30

**Dependencies**: Phase 1.1, 1.2 implementations

**Effort**: 1-2 weeks (shared effort)

**Owner**: Community contributors (documentation-focused)

---

## Phase 2: Standards & Governance (Dec 2026–Feb 2027)

### 2.1 Security Audit (External)

**Objective**: Third-party audit of spec + implementation for credibility.

**Deliverables**:

- [ ] **Audit RFP & Vendor Selection** (by 2026-10-01)
  - Scope:
    - RFC specification review (protocol correctness)
    - Reference implementations (all 3 languages)
    - Conformance test suite
    - Crypto primitives (JWT, SVID validation, audit hashing)
  - Estimated cost: $30-50K
  - Vendors: NCC Group, Trail of Bits, Cure53
  - Due: 2026-12-01 (audit starts)

- [ ] **Audit Report** (2027-02-01)
  - Findings + severity levels
  - Remediation plan
  - Public disclosure (with embargo period if needed)

- [ ] **Remediation** (2027-02-15)
  - Patch vulnerabilities found by audit
  - Publish patch release(s)
  - Re-audit critical fixes (if any)

**Dependencies**: Phase 1 implementations complete (gives audit multiple code bases)

**Effort**: Audit firm effort (not KAIF maintainer effort), ~3-4 weeks to coordinate

**Owner**: Geoffrey Lundholm (procurement + coordination)

**Budget**: $30-50K (seek CNCF sponsorship)

---

### 2.2 CNCF Sandbox Application

**Objective**: Move KAIF to neutral home under CNCF umbrella.

**Deliverables**:

- [ ] **CNCF Sandbox Application** (submit 2026-09-01)
  - Sections:
    1. Project description + alignment with CNCF mission
    2. Current maturity (staging-ready, 3 implementations)
    3. Governance model (RFC process, community-driven)
    4. Roadmap (path to Incubation, then Graduated)
    5. Use cases + potential adopters
    6. IP/licensing (Apache 2.0 spec, Apache 2.0 code)
  - Link: https://www.cncf.io/sandbox-projects/
  - Due: 2026-09-01

- [ ] **TOC (Technical Oversight Committee) Presentation** (2026-10-15)
  - 30-minute slot at CNCF TOC meeting
  - Demo: End-to-end token exchange + audit trail
  - Q&A with CNCF members
  - Owner: Geoffrey Lundholm

- [ ] **Sandbox Acceptance** (target 2026-12-01)
  - Expected outcome: KAIF added to CNCF Sandbox portfolio
  - Unlocks: CNCF CI/CD infrastructure, legal support, branding

**Dependencies**: Phase 1 (need 3 implementations + case study as proof)

**Effort**: 2-3 weeks (Geoffrey + community input)

**Owner**: Geoffrey Lundholm

---

### 2.3 Formal Governance Adoption

**Objective**: Transition from Kindred Systems stewardship to community governance.

**Deliverables**:

- [ ] **Governance Framework Finalization** (`/KAIF-Governance-Framework.md`)
  - Status: Written (see document above)
  - Action: Move to repo root, create GitHub discussions for feedback
  - Call for maintainers: Accept nominations from community
  - Due: 2026-12-15

- [ ] **First Maintainer Election** (2026-12-15)
  - Nominate 2-3 additional maintainers (beyond Geoffrey)
  - Candidates: Contributors with 5+ merged PRs or 100+ lines of code
  - Voting: Existing maintainers + founding contributors
  - Target: Announce on 2026-12-31

- [ ] **RFC Process Inauguration** (2027-01-15)
  - Tag first RFC issues (if any pending)
  - Publish RFC template in /rfcs/KAIF-RFC-TEMPLATE.md
  - Host community call to explain RFC process
  - Due: 2027-01-15

- [ ] **Security Advisory Process Launch** (2027-01-01)
  - Publish SECURITY.md with reporting instructions
  - Set up security@kindred.systems email alias
  - Recruit security team volunteers (3-5 people)
  - Due: 2027-01-01

**Dependencies**: Phase 2.1 (security audit) should be initiated first

**Effort**: 2-3 weeks (mostly coordination)

**Owner**: Geoffrey Lundholm (with community input)

---

### 2.4 Community Infrastructure

**Objective**: Establish communication channels for growing community.

**Deliverables**:

- [ ] **Slack Workspace** (or Discord)
  - Public channels: #general, #announcements, #help, #dev, #security
  - Private channels: #maintainers, #security-team
  - Due: 2026-12-15

- [ ] **Mailing List** (or forum)
  - kaif-dev@googlegroups.com (or similar)
  - Used for RFCs, standards announcements, release notes
  - Mirrored to GitHub Issues/Discussions
  - Due: 2027-01-01

- [ ] **Community Calendar**
  - Monthly community call (Tuesdays 10am PT)
  - Friday office hours (30-min slots, by appointment)
  - Maintain shared Google Calendar
  - Due: 2027-01-15

- [ ] **First Community Call** (2027-01-22)
  - Attendees: maintainers, contributors, interested adopters
  - Agenda:
    - Project status (audit done, CNCF Sandbox accepted)
    - Roadmap for 2027
    - Q&A from community
    - Breakout: "Implementing KAIF" for new adopters
  - Recording published on YouTube

**Dependencies**: None (can run in parallel)

**Effort**: 1 week (communication/logistics)

**Owner**: Community manager (new role, could be intern)

---

## Phase 3: Community Growth (Mar–Jun 2027)

### 3.1 Ecosystem Visibility

**Objective**: Get KAIF in front of adoption-ready organizations.

**Deliverables**:

- [ ] **KubeCon Talk** (2027-04-15, KubeCon EU)
  - 30-minute slot: "KAIF: Agent Authorization for Cloud-Native Apps"
  - Demo: End-to-end KAIF flow
  - Audience: Platform engineers, security architects
  - Owner: Geoffrey Lundholm + community co-presenter

- [ ] **CNCF Blog Post** (2027-03-15)
  - "Introducing KAIF: A Protocol for Agent Authorization"
  - Byline: Geoffrey Lundholm + 1-2 contributors
  - Shared to CNCF newsletter (~50K subscribers)

- [ ] **Academic/Standards Venue Talks** (2027-Q2)
  - IETF 117 (July 2027): "KAIF: Token Exchange for Agent Workloads"
  - OpenTelemetry Community Call: "Agent Authorization & Observability"
  - Papers/Posters: AI Safety conference, distributed systems workshop

- [ ] **Media Coverage** (target 2-3 tech publications)
  - Pitch: "How AI agents prove authority in distributed systems"
  - Outlets: TheNewStack, Docker blog, CNCF blog

**Dependencies**: Phase 2 complete (CNCF Sandbox, security audit)

**Effort**: 4-6 weeks (speaking prep, slides, coordination)

**Owner**: Geoffrey Lundholm + volunteer speakers

---

### 3.2 Third Language Implementation (Rust)

**Objective**: Demonstrate protocol is truly language-agnostic.

**Deliverables**:

- [ ] **KAIF Server (Rust/Actix-web)**
  - Location: /reference-implementations/rust-actix/
  - Same endpoints as Python/Go
  - Focus: Performance-optimized (lowest latency reference)
  - Benchmark results published
  - Due: 2027-05-15

- [ ] **Conformance Results**
  - Run test harness against Rust implementation
  - Publish: 7/7 PASS + performance benchmarks
  - Due: 2027-05-25

**Dependencies**: Phase 0 (conformance suite), existing Python/Go implementations

**Effort**: 6-8 weeks (1.5 FTE)

**Owner**: TBD (Rust community)

**Priority**: Medium (if resources available; not blocking)

---

### 3.3 Adopter Growth

**Objective**: Grow from 1 case study to 5+ publicly acknowledged adopters.

**Deliverables**:

- [ ] **Identify 4+ additional adopters** (by 2027-03-01)
  - Target sectors: fintech, e-commerce, cloud platforms, AI infrastructure
  - Recruitment: Reach out via KAIF talks, community calls, industry connections
  - Commitment: Staging/production pilot over 3-6 months

- [ ] **Integration Support** (Mar–Jun)
  - Dedicate 1 person (or split across team) to adopter support
  - Weekly check-ins
  - Help debug integration issues
  - Document best practices

- [ ] **Adopters Page** (`/docs/ADOPTERS_FEATURED.md`)
  - Write case studies for each adopter (with permission)
  - Publish: Company name, logo, use case, integration timeline
  - Link to adopters listing on website
  - Due: 2027-06-30

**Dependencies**: Relying Party Profile (Phase 0.3) + developer experience improvements (Phase 1.4)

**Effort**: 6-8 weeks (1 FTE to coordinate + support)

**Owner**: Community manager or adopter success role

---

### 3.4 Interoperability Testing

**Objective**: Cross-validate implementations.

**Deliverables**:

- [ ] **Cross-Implementation Test Matrix** (2027-04-15)
  - Combinations:
    - TypeScript server → Python SDK
    - Python server → Go SDK
    - Go server → Rust SDK
    - Rust server → TypeScript SDK
  - Each combination: Execute token exchange, verify audit trail
  - Results: 12/12 PASS (3 implementations × 4 combinations)
  - Published: /docs/CROSS_IMPLEMENTATION_MATRIX.md

- [ ] **Conformance Suite Expansion** (2027-05-15)
  - Add 3-5 new test fixtures:
    - Multi-issuer federation (v2.0 preview, optional)
    - Performance benchmarks (latency SLA validation)
    - Chaos/failure scenarios (SPIRE down, Redis down, timeouts)
  - Target: 10-12 total fixtures

**Dependencies**: Phase 1 (3 implementations) + Phase 3.2 (Rust)

**Effort**: 2-3 weeks (test design + execution)

**Owner**: Community contributor (testing-focused)

---

## Phase 4: Standards Convergence (Jul–Dec 2027)

### 4.1 IETF OAuth Working Group Adoption

**Objective**: Move KAIF draft into IETF WG for standards-track RFC publication.

**Deliverables**:

- [ ] **IETF 117 Presentation** (2027-07-25, IETF 117 San Francisco)
  - 30-minute slot at OAuth WG
  - Pitch: "KAIF: RFC 8693 Profile for Agent Workloads"
  - Demo + Q&A
  - Owner: Geoffrey Lundholm

- [ ] **WG Adoption Call** (2027-08-15)
  - OAuth WG votes to adopt draft-kaif-token-exchange as WG item
  - Renumbered to draft-ietf-oauth-agent-token-exchange-00
  - KAIF project can claim "IETF WG draft"

- [ ] **Refined RFC** (2027-10-15)
  - Incorporate OAuth WG feedback
  - Publish draft-ietf-oauth-agent-token-exchange-02
  - Target: IETF 118 (November 2027) discussion

**Dependencies**: Phase 2 (security audit, governance), Phase 3 (visibility)

**Effort**: 3-4 weeks (Gary, IETF participation + revisions)

**Owner**: Geoffrey Lundholm + IETF expert contributor

---

### 4.2 CNCF Incubation Graduation

**Objective**: Move KAIF from Sandbox to Incubation within CNCF.

**Deliverables**:

- [ ] **Incubation Application** (submit 2027-08-01)
  - Criteria (per CNCF):
    - ✅ 3+ independent implementations (Phase 1 + 3.2)
    - ✅ Security audit passed (Phase 2.1)
    - ✅ Community governance in place (Phase 2.3)
    - ✅ 5+ production adopters (Phase 3.3)
    - ✅ Sustainable project velocity (ongoing contributions)
    - ✅ Clear roadmap (this document + next phase)

- [ ] **TOC Presentation** (2027-09-15)
  - Present maturity, adoption, governance to CNCF TOC
  - Vote on Incubation promotion
  - Expected: APPROVED (if all criteria met)

- [ ] **Incubation Status** (target 2027-10-01)
  - Project badge on GitHub + website
  - Unlocks: CNCF marketing, cross-promotion with projects like SPIFFE/SPIRE
  - Opens pathway to Graduated status (typically 18-24 months in Incubation)

**Dependencies**: All prior phases

**Effort**: 1-2 weeks (application + presentation)

**Owner**: Geoffrey Lundholm + CNCF liaison

---

### 4.3 Specification Maturity

**Objective**: Finalize v1.0 specification and roadmap for v2.0.

**Deliverables**:

- [ ] **KAIF v1.0 Final Specification** (2027-11-15)
  - Incorporate all feedback from:
    - IETF OAuth WG review
    - Security audit findings
    - 3 reference implementations
    - 5+ adopter feedback
  - Published as `/KAIF-SPEC-1.0.md` (frozen)
  - Status: "Ratified, IETF Proposed Standard candidate"

- [ ] **v1.1 RFC Roadmap** (2027-11-15)
  - Already drafted: Issuer metadata endpoint, relying-party interop improvements
  - Submit first KAIF-RFC for v1.1 features
  - Timeline: v1.1 release target 2028-Q2

- [ ] **v2.0 Roadmap** (exploratory, 2027-11-15)
  - Multi-issuer federation
  - Behavioral trust signals (optional, opt-in)
  - Cross-operator delegation
  - Timeline: v2.0 target 2028-Q4 (tentative)

**Dependencies**: All other phases

**Effort**: 2-3 weeks (spec finalization + roadmap)

**Owner**: Geoffrey Lundholm + IETF WG contributors

---

### 4.4 Long-Term Sustainability

**Objective**: Transition from startup to sustainable community project.

**Deliverables**:

- [ ] **Maintainer Succession Planning** (2027-11-01)
  - Identify 2-3 maintainers to take lead (not just Geoffrey)
  - Mentor new maintainers on decision-making
  - Document maintainer responsibilities

- [ ] **Funding Sustainability** (2027-12-01)
  - Options:
    1. CNCF Incubation project funding (annual budget from CNCF)
    2. Member organization sponsorships (adopters fund infrastructure)
    3. Consulting/support contracts (commercial entities build businesses on top)
  - Target: $50-100K annual budget for maintainer effort + infrastructure

- [ ] **Roadmap v2028** (2027-12-15)
  - 18-month roadmap for 2028-2029
  - Includes: v1.1 features, v2.0 exploration, adopter support, standards engagement
  - Published publicly

**Dependencies**: None

**Effort**: Ongoing (quarterly reviews)

**Owner**: Geoffrey Lundholm + CNCF program officer

---

## Success Metrics & Checkpoints

### Quarterly Checkpoints

| Date | Checkpoint | Go/No-Go |
|------|-----------|----------|
| **2026-09-30** | RFC draft published + CNCF Sandbox application submitted | Go → Phase 1 |
| **2026-12-31** | 3 implementations passing conformance + early adopter case study | Go → Phase 2 |
| **2027-03-31** | CNCF Sandbox accepted + security audit complete + governance live | Go → Phase 3 |
| **2027-06-30** | 5+ adopters + 3 reference implementations + KubeCon talk | Go → Phase 4 |
| **2027-09-30** | IETF WG adoption + CNCF Incubation promotion | Go → Sustainability |

### Success Metrics (12-month horizon)

| Metric | Target | Current | Status |
|--------|--------|---------|--------|
| Reference implementations | 3+ | 1 (TypeScript) | 🟡 In progress |
| Independent adopters | 5+ | 1 (target) | 🟡 In progress |
| Conformance test fixtures | 10+ | 7 | 🟢 Planned |
| GitHub stars | 500+ | ~50 | 🟡 Target when public |
| Community contributors (merged PRs) | 10+ | 1 | 🟡 Target 2027 Q2 |
| IETF draft publication | draft-ietf-oauth-* | Individual draft | 🟡 Target Oct 2027 |
| CNCF project status | Incubation | Sandbox application | 🟡 Target Oct 2027 |
| Security audit | Passed | Planned Q4 2026 | ⏳ Next |

---

## Resource Allocation

### Effort Estimate by Phase

| Phase | Duration | FTE Required | Owner |
|-------|----------|--------------|-------|
| **Phase 0** | 10 weeks | 1.5 | Geoffrey + community contributors |
| **Phase 1** | 12 weeks | 3-4 | Python dev (1.5 FTE) + Go dev (1.5 FTE) + adopter support (1 FTE) |
| **Phase 2** | 12 weeks | 2-3 | Geoffrey (0.5) + security audit firm (external) + governance coordinator (1 FTE) |
| **Phase 3** | 16 weeks | 2-3 | Marketing/community (1 FTE) + Rust dev (1.5 FTE) + adopter support (0.5 FTE) |
| **Phase 4** | 24 weeks | 1-2 | Geoffrey (0.5 FTE) + IETF engagement (0.5 FTE) + community |
| **TOTAL** | 74 weeks / 18 months | 9-13 FTE | ~12-15 FTE-months |

### Budget Estimate

| Item | Estimated Cost | Source |
|------|-----------------|--------|
| Security audit (external firm) | $35-50K | Seek CNCF sponsorship or member funding |
| Maintainer time (12 months @ $200/hr) | $50-75K | Kindred Systems + community contributions |
| Infrastructure (CI/CD, servers, hosting) | $5-10K annually | CNCF or adopter donations |
| Community events (summits, talks) | $5-10K annually | CNCF support + adopter sponsorships |
| **Total Year 1** | **$95-145K** | Mixed funding model |

---

## Risks & Mitigation

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|-----------|
| Difficulty recruiting 2nd/3rd language implementers | Medium | Delays ecosystem proof (Phase 1) | Start outreach in May 2026, offer mentorship |
| Early adopter hard to find | Low-Medium | Delays case study (Phase 1.3) | Pre-identify 3-5 candidates, contact now |
| Security audit finds critical issues | Low | Blocks CNCF Sandbox approval | Prioritize crypto review, allocate rework time |
| IETF OAuth WG skeptical of agent use case | Medium | Extends standards timeline to 2028 | Present early, get feedback, refine narrative |
| Community contributors plateau | Medium | Maintainability risk | Invest in onboarding docs, office hours, mentorship |
| Competing standards emerge (e.g., from AWS, Google) | Low | Market fragmentation | Publish KAIF aggressively, build community first |

---

## Conclusion

This roadmap is aggressive but achievable. The key dependencies are:

1. **Phase 0** (next 10 weeks): Publish RFC, conformance suite, governance
2. **Phase 1** (Sep–Nov): Recruit 2 more language implementations + 1 early adopter
3. **Phase 2** (Dec–Feb): Security audit + CNCF Sandbox acceptance
4. **Phase 3** (Mar–Jun): Ecosystem visibility + 5+ adopter growth
5. **Phase 4** (Jul–Dec): IETF WG adoption + CNCF Incubation promotion

**Success = KAIF becomes a recognized standard for agent authorization by end of 2027.**

---

## Next Steps (Immediate: This Week)

1. **Share this roadmap** with Kindred leadership + get budget buy-in
2. **Open GitHub Issues** for Phase 0 deliverables (RFC, conformance, governance)
3. **Start recruitment** for Python/Go implementers (LinkedIn, Rust/Go communities)
4. **Pre-identify** 3-5 potential early adopters (fintech, e-commerce, cloud)
5. **Schedule IETF OAuth WG presentation** for July/August 2026
6. **Create KAIF project board** to track Phase 0 progress publicly

---

**Document History**

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-06-27 | Initial draft |

**For feedback or questions:**  
Email: roadmap@kindred.systems  
GitHub: Open an issue tagged `roadmap`  
Community call: First call 2027-01-22 (details TBD)
