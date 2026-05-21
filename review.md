# KAIF Repository Review

Review date: 2026-05-21

Implementation update: the high-priority auth findings in this review were addressed on 2026-05-21. See `security/gaps.md` GAP-010 through GAP-013 and `security/PRODUCTION_ATTESTATION_PROTOCOL_PLAN.md` for the remaining production hardening plan.

## Verification Performed

- `pnpm test` passed: server, SDK, and conformance unit suites all green.
- `pnpm build` passed: TypeScript builds for `conformance`, `@kaif/server`, and `@kaif/sdk`.
- `docker compose config` rendered successfully.

The green tests are useful, but several high-impact auth and runtime-path issues are not covered by the current suite.

## Findings

### High: Delegation grants are not bound to the presenting SVID

`/provision` signs a delegation token that names the intended agent in both `actor.sub` and `may_act.sub` (`packages/server/src/routes/provision.ts:137-150`). During exchange, `executeTokenExchange` validates the presented SVID and ACL (`packages/server/src/services/token-exchange.ts:77-93`), but it never compares `svid.spiffe_id` to the subject token's `actor.sub` or `may_act.sub` before minting the new token (`packages/server/src/services/token-exchange.ts:163-201`).

Impact: any registered agent that obtains another agent's delegation token can mint a KAIF access token for itself, as long as its own ACL allows the requested scope and depth. This weakens the central promise that a human grant is cryptographically bound to a specific workload identity.

Recommended fix: reject exchanges unless the subject token's `may_act.sub` and/or provisioned `actor.sub` matches the presented `svid.spiffe_id`, except for an explicitly modeled and authorized sub-delegation flow.

### High: Sub-delegation policy fields are defined but not enforced

The ACL schema includes `may_sub_delegate` and `human_principal_required` (`packages/server/src/types/kaif.ts:51-59`), and the default config uses them (`packages/server/config/agents.yaml:9-12`, `packages/server/config/agents.yaml:21-24`). The token exchange path only checks trust tier, requested scope, TTL, and `max_delegation_depth` (`packages/server/src/services/token-exchange.ts:122-157`).

Impact: agents marked `may_sub_delegate: false` are still able to supply a KAIF token as `subject_token` if the depth check passes. `human_principal_required` also has no effect, so the config suggests guarantees that the server does not enforce.

Recommended fix: when `subject_token` is already a KAIF access token, load the parent actor's ACL and require `may_sub_delegate: true`; also enforce `human_principal_required` before issuing tokens.

### High: Privileged routes accept any valid KAIF token without scope or revocation checks

`requireKAIFAuth` only checks that the bearer token verifies with the KAIF signing key (`packages/server/src/routes/_auth.ts:4-20`). It does not check `jti` revocation, issuer/audience intent, trust tier, or required scopes. Both `/introspect` and `/revoke` use this handler (`packages/server/src/routes/introspect.ts:24-30`, `packages/server/src/routes/revoke.ts:26-32`).

Impact: a token with an ordinary scope like `invoke:completion` can call `/revoke` for arbitrary target tokens if the caller knows the token value. A revoked bearer token can also continue to authenticate to these administrative routes until `exp`.

Recommended fix: replace the generic pre-handler with route-specific authorization. For example, require `audit:read` or a dedicated introspection scope for `/introspect`, require `admin:revoke` for `/revoke`, and deny callers whose bearer `jti` is revoked.

### High: The default mock/conformance agent path cannot complete token exchange

`mock-agent` and `conformance-agent` are configured with `max_delegation_depth: 0` (`packages/server/config/agents.yaml:39-56`). A `/provision` grant is signed with `kaif.delegation_depth: 0` (`packages/server/src/routes/provision.ts:150-157`), and the first `/oauth/token` exchange increments that to `1` (`packages/server/src/services/token-exchange.ts:130-137`). The exchange then rejects any actor whose max depth is lower than `1` (`packages/server/src/services/token-exchange.ts:144-149`).

Impact: the agents used by the documented quick start and conformance flow are configured to fail the first real token exchange. Current integration coverage misses this because the happy path provisions `lyra`, whose `max_delegation_depth` is `1`.

Recommended fix: clarify the depth model. If first human-to-agent issuance should produce `delegation_depth: 1`, set demo/conformance agents to `max_delegation_depth: 1`. If direct human grants should be depth `0`, do not increment when the subject token is a provisioned grant.

### Medium: Missing scope can become an unconstrained grant

The token route treats `scope` as optional (`packages/server/src/routes/token.ts:87-96`). In `executeTokenExchange`, grant scope enforcement only runs when the subject token has at least one parsed scope (`packages/server/src/services/token-exchange.ts:110-120`). A KAIF-signed subject token with an empty or missing `scope` skips the grant-scope check.

Impact: an empty-scope KAIF token can become a broad subject token for any scope allowed by the presenting actor's ACL, subject to depth/trust checks.

Recommended fix: require a non-empty requested scope and require every subject token used for exchange to carry a non-empty grant scope. Treat missing or empty subject scope as `invalid_grant`.

### Medium: The Docker quick start and mock agent do not match the implementation

`docker-compose.yml` starts `mock-agent` with `DELEGATION_TOKEN` defaulting to an empty string (`docker-compose.yml:112-123`), while the mock agent exits if `DELEGATION_TOKEN` is absent (`examples/mock-agent/index.ts:14-20`). The mock agent also reads `/tmp/svid.jwt` (`examples/mock-agent/index.ts:27-31`), but the SPIRE agent config exposes a Workload API socket and does not configure an SVIDStore that writes that file (`spire/agent.conf:1-16`).

The docs compound the mismatch: `QUICKSTART.md` says the mock agent automatically provisions a delegation (`QUICKSTART.md:106-120`), uses a non-existent `http://spire-agent:8006/svid.json` path (`QUICKSTART.md:126-130`), and tells users to send `delegation_id` as `subject_token` (`QUICKSTART.md:153-160`) even though the current server expects `delegation_token`.

Impact: a new user following the quick start is likely to get a failed mock-agent container or an `invalid_grant` token exchange.

Recommended fix: either make the mock agent perform `/provision` itself in `KAIF_DEV_MODE`, or document the working `scripts/demo.sh` flow as the only local happy path. Update all examples to pass `delegation_token`, and either fetch SVIDs through the SPIRE Workload API or configure SVIDStore to write the SDK's expected file.

### Medium: Conformance fixtures can miss the security gaps above

The happy-path fixture does not assert that `actor.sub` equals the configured test agent; it falls back to checking only that the value starts with `spiffe://` (`conformance/fixtures/happy-path.ts:41-49`). The revoked-JTI fixture calls `/revoke` without an Authorization header even though the server requires one (`conformance/fixtures/revoked-jti.ts:16-24`). The CNF mismatch fixture treats any `401` from `/introspect` as success (`conformance/fixtures/cnf-mismatch.ts:27-46`), which can pass because the request is unauthenticated rather than because CNF binding was enforced.

Impact: conformance output can give false confidence around actor binding, revocation behavior, and CNF enforcement.

Recommended fix: provide an auth token for conformance calls to protected endpoints, assert exact `actor.sub`, and distinguish authentication failures from the specific behavior under test.

### Low: ACL reload removes unrelated process SIGHUP listeners

`loadACL` calls `process.removeAllListeners('SIGHUP')` before registering its reload handler (`packages/server/src/services/acl.ts:25-30`). This removes listeners registered by other modules or embedding applications.

Impact: future operational handlers can disappear silently after ACL loading.

Recommended fix: keep a reference to the ACL reload handler and remove only that handler before re-registering.

## Positive Observations

- The repo is modular: token routes, crypto helpers, revocation, audit, trust scoring, SDK, examples, and conformance tests are separated cleanly.
- The key cache race called out in `security/gaps.md` appears fixed with the promise-cache pattern in `packages/server/src/crypto/keys.ts:17-60`.
- Test coverage is broad for the implemented happy path and core utility behavior: 128 tests passed across server, SDK, and conformance packages.
- Security tradeoffs are documented in `SECURITY.md` and `security/gaps.md`, which is valuable for an auth-focused project.

## Suggested Next Steps

1. Add failing tests for actor/SVID binding, `may_sub_delegate`, revoked bearer auth, and the mock-agent first exchange.
2. Fix token exchange authorization semantics before expanding demos or conformance claims.
3. Repair the quick start so `docker compose up -d` plus one documented command produces a real token without hidden manual state.
4. Move the open production gaps from documentation into tracked issues or a release checklist, especially audit atomicity and production SPIRE bootstrap/TLS.
