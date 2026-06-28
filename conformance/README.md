# KAIF Conformance Kit

Verifies that a KAIF Token Exchange Server correctly implements the **KAIF Core Profile v1.0** — regardless of the underlying platform or language.

Run it against your own implementation to confirm interoperability before claiming KAIF compatibility.

---

## Quick start (5 steps)

**Prerequisites:** Node.js ≥ 20, a running KAIF server, a valid JWT-SVID for a registered test agent, and a human delegation grant token.

**1. Install**

```bash
npm install -g @kaif/conformance
# or, from this repo:
pnpm --filter @kaif/conformance build
```

**2. Obtain a JWT-SVID for your test agent**

```bash
# From a SPIRE agent:
spire-agent api fetch jwt \
  --spiffeID spiffe://<trust-domain>/your/test/agent \
  --audience kaif-conformance \
  --socketPath /run/spire/sockets/agent.sock \
  2>/dev/null | awk '/^\t/ { sub(/^\t/, ""); print; exit }' | tr -d '[:space:]' > /tmp/svid.jwt

# Or use a pre-generated test SVID provided by your SPIRE administrator.
```

**3. Provision a delegation grant**

```bash
curl -X POST https://your-kaif-server/provision \
  -H 'Content-Type: application/json' \
  -d '{
    "id_token": "<your-oidc-id-token>",
    "agent_id": "conformance-agent",
    "scope": "invoke:completion",
    "ttl_seconds": 900
  }'
# Save the returned delegation_token (a signed JWT) as your GRANT_TOKEN
```

**Running against the local Docker Compose stack with KAIF_DEV_MODE=true?**  
Use the mint script instead — it handles the `/provision` call automatically:

```bash
# Mints a delegation token and prints the export command
./scripts/mint-grant-token.sh

# Or set the env var directly in the current shell:
eval "$(./scripts/mint-grant-token.sh --export)"
```

**Running in CI with `KAIF_DEV_MODE=true` and no stable SPIRE JWT-SVID path?**
The workflow MAY use:

```text
dev-mock-svid:spiffe://kindred.systems/ns/examples/agent/mock
```

as the actor token fallback. This is acceptable only for the dev-mode CI profile. Production or interoperability claims SHOULD use a real JWT-SVID or a pre-generated `CI_TEST_SVID_JWT` secret.

**4. Run the suite**

```bash
kaif-conformance \
  --server https://your-kaif-server \
  --svid-jwt /tmp/svid.jwt \
  --grant-token <delegation_token-from-step-3> \
  --agent-id spiffe://kindred.systems/ns/conformance/agent/test
```

**5. Interpret results**

```
KAIF Conformance Suite v1.0
Target: https://your-kaif-server
─────────────────────────────────────────────────────
KAIF-001  Happy path token exchange       PASS   142ms
KAIF-002  Expired subject_token rejected  PASS    38ms
KAIF-003  Wrong audience rejected         PASS    41ms
KAIF-004  Revoked JTI rejected            PASS    89ms
KAIF-005  CNF binding mismatch            WARN    44ms  (CNF binding not enforced (§1.2 advisory))
KAIF-006  Scope overreach rejected        PASS    37ms
KAIF-007  Sub-delegation/depth enforcement PASS   43ms
─────────────────────────────────────────────────────
Result: PASS  6/6 MUST  1 advisory
Elapsed: 434ms
```

Exit code `0` = all MUST fixtures passed. Exit code `1` = one or more MUST fixtures failed.  
`WARN` results are advisory — they indicate optional features that are not enforced.

---

## Fixtures

| ID       | Section      | Required | Tests                                      |
|----------|--------------|----------|--------------------------------------------|
| KAIF-001 | §1.1, §1.2   | MUST     | Happy path — valid exchange, claims correct |
| KAIF-002 | §2.1 step 3  | MUST     | Expired subject_token → `invalid_grant`    |
| KAIF-003 | §2.1 step 2  | MUST     | Unpermitted audience → non-200             |
| KAIF-004 | §3.1         | MUST     | Revoked JTI → `invalid_grant`              |
| KAIF-005 | §1.2, §2.1 step 5 | SHOULD | CNF thumbprint mismatch (advisory)    |
| KAIF-006 | §1.3         | MUST     | Scope overreach → `invalid_scope`          |
| KAIF-007 | §1.4, §2.1   | MUST     | Unauthorized sub-delegation/depth overrun → non-200 |

---

## Options

```
Options:
  --server <url>        Base URL of KAIF server under test (required)
  --svid-jwt <path>     Path to file containing a valid JWT-SVID (required)
  --grant-token <token> A valid human delegation grant token (required)
  --agent-id <id>       SPIFFE ID of the test agent (required)
  --output <format>     text | json  (default: text)
  --only <ids>          Comma-separated fixture IDs, e.g. KAIF-001,KAIF-004
  -V, --version         Print version
  -h, --help            Show help
```

## JSON output

```bash
kaif-conformance --server http://localhost:8080 ... --output json
```

Returns a JSON document conforming to the `SuiteResult` schema. Pipe to `jq` or upload as a CI artifact.

---

## CI integration

See [`ci/conformance.yml`](./ci/conformance.yml) for a ready-to-use GitHub Actions workflow that spins up the full KAIF stack (SPIRE + Redis + server) and runs the conformance suite on every push.

## Redis resilience evidence

The core fixture suite validates KAIF token exchange semantics. Managed Redis HA behavior is tracked separately because platforms such as Azure Managed Redis Enterprise do not expose customer-triggerable failover operations on the `Microsoft.Cache/redisEnterprise` path.

Use the repo-level resilience runner to capture reconnect and state-continuity evidence:

```bash
node scripts/redis_resilience_conformance.mjs
```

The runner records:

- revoked-token denial before reconnect
- revoked-token denial after reconnect
- revocation key persistence across reconnect
- audit hash-chain continuity across reconnect
- resumed delegation / token issuance / revoke writes after reconnect

Evidence is written under `reports/redis_resilience/`.

---

## Adding fixtures

Implement `ConformanceFixture` from `types.ts` and add your fixture to `fixtures/index.ts`.  
The harness calls `buildRequest` → `POST /oauth/token` → `assert` for standard fixtures.  
For fixtures testing other endpoints (e.g. `/introspect`), implement `execute()` instead.
