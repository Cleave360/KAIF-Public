#!/usr/bin/env bash
set -euo pipefail

# Day 7b KAIF handshake conformance wrapper
# Runs KAIF conformance fixtures (KAIF-001..007) and writes evidence artifacts.

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

DEFAULT_HOST_PORT="${KAIF_HOST_PORT:-8080}"
SERVER_URL="${KAIF_SERVER_URL:-http://127.0.0.1:${DEFAULT_HOST_PORT}}"
SVID_JWT_PATH="${KAIF_SVID_JWT_PATH:-/tmp/kaif_test_svid.jwt}"
GRANT_TOKEN="${KAIF_GRANT_TOKEN:-}"
AGENT_ID="${KAIF_AGENT_ID:-spiffe://kindred.systems/ns/conformance/agent/test}"
TENANT_ADDRESS="${KAIF_TENANT_ADDRESS:-tenant-dev}"
CLASS_A_FAILURE_URL="${KAIF_CLASS_A_FAILURE_URL:-${SERVER_URL%/}/relying/class-a/authorize}"
CLASS_C_FAILURE_URL="${KAIF_CLASS_C_FAILURE_URL:-${SERVER_URL%/}/relying/class-c/authorize}"
DAY7B_STRICT="${KAIF_DAY7B_STRICT:-false}"

TS="$(date -u +%Y%m%d_%H%M%S)"
RUN_ID="run-kaif-day7b-${TS}"
OUT_DIR="${ROOT_DIR}/reports/day7b_conformance/${RUN_ID}"
mkdir -p "$OUT_DIR"

if [[ -z "$GRANT_TOKEN" ]]; then
  echo "FAIL: KAIF_GRANT_TOKEN is required" | tee "$OUT_DIR/summary.txt"
  exit 2
fi

if [[ ! -f "$SVID_JWT_PATH" ]]; then
  echo "FAIL: KAIF_SVID_JWT_PATH file not found: $SVID_JWT_PATH" | tee "$OUT_DIR/summary.txt"
  exit 2
fi

if [[ ! -d "${ROOT_DIR}/conformance/dist" ]]; then
  echo "[build] conformance dist missing; building @kaif/conformance"
  pnpm --filter @kaif/conformance build
fi

echo "RUN_ID=${RUN_ID}" | tee "$OUT_DIR/summary.txt"
echo "SERVER_URL=${SERVER_URL}" | tee -a "$OUT_DIR/summary.txt"
echo "SVID_JWT_PATH=${SVID_JWT_PATH}" | tee -a "$OUT_DIR/summary.txt"
echo "AGENT_ID=${AGENT_ID}" | tee -a "$OUT_DIR/summary.txt"
echo "KAIF_DAY7B_STRICT=${DAY7B_STRICT}" | tee -a "$OUT_DIR/summary.txt"
echo "KAIF_TENANT_ADDRESS=${TENANT_ADDRESS}" | tee -a "$OUT_DIR/summary.txt"
echo "KAIF_CLASS_A_FAILURE_URL=${CLASS_A_FAILURE_URL}" | tee -a "$OUT_DIR/summary.txt"
echo "KAIF_CLASS_C_FAILURE_URL=${CLASS_C_FAILURE_URL}" | tee -a "$OUT_DIR/summary.txt"

echo "[run] KAIF conformance suite"
set +e
node conformance/dist/runner/index.js \
  --server "$SERVER_URL" \
  --svid-jwt "$SVID_JWT_PATH" \
  --grant-token "$GRANT_TOKEN" \
  --agent-id "$AGENT_ID" \
  --output json > "$OUT_DIR/conformance_result.json" 2> "$OUT_DIR/conformance_stderr.log"
RC=$?
set -e

# text render for operator readability
if [[ -s "$OUT_DIR/conformance_result.json" ]]; then
  node - "$OUT_DIR/conformance_result.json" \
    "$OUT_DIR/conformance_result.txt" \
    "$OUT_DIR/day7b_report.json" \
    "$OUT_DIR/day7b_result.txt" \
    "$OUT_DIR/day7b_status.env" \
    "$OUT_DIR/day7b_failure_mode_payloads.json" \
    "$SERVER_URL" \
    "$SVID_JWT_PATH" \
    "$GRANT_TOKEN" \
    "$AGENT_ID" \
    "$TENANT_ADDRESS" \
    "$CLASS_A_FAILURE_URL" \
    "$CLASS_C_FAILURE_URL" \
    "$RUN_ID" <<'NODE' || true
const fs = require('fs')

const [
  conformancePath,
  conformanceTextPath,
  day7bJsonPath,
  day7bTextPath,
  statusEnvPath,
  failurePayloadsPath,
  serverUrl,
  svidJwtPath,
  grantToken,
  agentId,
  tenantAddress,
  classAFailureUrl,
  classCFailureUrl,
  runId,
] = process.argv.slice(2)

async function readJson(response) {
  const text = await response.text()
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text.slice(0, 500) }
  }
}

async function postJson(url, token, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  return {
    status: response.status,
    body: await readJson(response),
  }
}

async function mintFailureModeToken() {
  const actorToken = fs.readFileSync(svidJwtPath, 'utf8').trim()
  const form = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
    subject_token: grantToken,
    subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
    actor_token: actorToken,
    actor_token_type: 'urn:ietf:params:oauth:token-type:jwt',
    scope: 'invoke:completion',
  })
  const response = await fetch(`${serverUrl.replace(/\/$/, '')}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  })
  const body = await readJson(response)
  if (!response.ok || typeof body.access_token !== 'string') {
    throw new Error(`failure-mode token exchange failed: HTTP ${response.status}`)
  }
  return body.access_token
}

async function runFailureModeEvidence() {
  const evidence = {
    request: {
      class_a_url: classAFailureUrl,
      class_c_url: classCFailureUrl,
      body: { run_id: runId, resource: 'day7b-failure-mode' },
    },
    response: {},
  }

  try {
    const token = await mintFailureModeToken()
    const classA = await postJson(classAFailureUrl, token, evidence.request.body)
    const classC = await postJson(classCFailureUrl, token, evidence.request.body)
    evidence.response.class_a = classA
    evidence.response.class_c = classC

    const classAPass = classA.status >= 400
      && classA.body.authorized === false
      && ['deny', 'halt'].includes(String(classA.body.policy_decision))
      && classA.body.status === 'rejected'

    const classCFailClosed = classC.status >= 400
      && classC.body.authorized === false
      && ['deny', 'halt'].includes(String(classC.body.policy_decision))
      && classC.body.status === 'rejected'

    const classCDegradedOpen = classC.status === 200
      && classC.body.authorized === true
      && classC.body.degraded === true
      && classC.body.evidence_marker === 'kaif.introspect.degraded'
      && classC.body.policy_decision === 'allow'

    const pass = classAPass && (classCFailClosed || classCDegradedOpen)
    fs.writeFileSync(failurePayloadsPath, `${JSON.stringify(evidence, null, 2)}\n`)

    return {
      id: 'DAY7B-008',
      name: 'Failure-mode behavior',
      fixture: null,
      production_required: true,
      status: pass ? 'PASS' : 'FAIL',
      evidence_fixture_status: null,
      note: pass
        ? 'Class A failed closed; Class C either failed closed or emitted explicit degraded-open marker'
        : `Expected Class A fail-closed and Class C fail-closed or explicit degraded-open; got A=${classA.status} C=${classC.status}`,
      evidence_artifact: 'day7b_failure_mode_payloads.json',
    }
  } catch (err) {
    evidence.response.error = err instanceof Error ? err.message : String(err)
    fs.writeFileSync(failurePayloadsPath, `${JSON.stringify(evidence, null, 2)}\n`)
    return {
      id: 'DAY7B-008',
      name: 'Failure-mode behavior',
      fixture: null,
      production_required: true,
      status: 'FAIL',
      evidence_fixture_status: null,
      note: evidence.response.error,
      evidence_artifact: 'day7b_failure_mode_payloads.json',
    }
  }
}

async function main() {
  const suite = JSON.parse(fs.readFileSync(conformancePath, 'utf8'))
  const rows = Array.isArray(suite.fixtures)
    ? suite.fixtures
    : Array.isArray(suite.runs)
      ? suite.runs
      : []

  const advisoryIds = new Set(['KAIF-005'])
  const normalized = rows.map((row) => {
    const id = String(row.id)
    const result = String(row.result ?? '').toUpperCase()
    return {
      id,
      name: String(row.name ?? ''),
      result,
      required: !advisoryIds.has(id),
      elapsed_ms: Number(row.elapsed_ms ?? 0),
      error: row.error ?? null,
    }
  })

  const mustTotal = normalized.filter((row) => row.required).length
  const mustFail = normalized.filter((row) => row.required && row.result === 'FAIL').length
  const conformanceLines = [
    `fixtures=${normalized.length}`,
    `must_total=${mustTotal}`,
    `must_fail=${mustFail}`,
    ...normalized.map((row) => `${row.id} ${row.result} ${row.required ? 'MUST' : 'ADVISORY'}`),
  ]
  fs.writeFileSync(conformanceTextPath, `${conformanceLines.join('\n')}\n`)

  const byId = new Map(normalized.map((row) => [row.id, row]))
  const mappedCases = [
    { id: 'DAY7B-001', name: 'Valid exchange -> valid access', fixture: 'KAIF-001', production_required: true },
    { id: 'DAY7B-002', name: 'Wrong aud rejected', fixture: 'KAIF-003', production_required: true },
    { id: 'DAY7B-003', name: 'Expired token rejected', fixture: 'KAIF-002', production_required: true },
    { id: 'DAY7B-004', name: 'Revoked jti rejected', fixture: 'KAIF-004', production_required: true },
    {
      id: 'DAY7B-005',
      name: 'cnf/mTLS binding mismatch rejected',
      fixture: 'KAIF-005',
      production_required: true,
      warn_blocks_production: true,
    },
    { id: 'DAY7B-006', name: 'Scope overreach rejected', fixture: 'KAIF-006', production_required: true },
    { id: 'DAY7B-007', name: 'Delegation depth limit enforced', fixture: 'KAIF-007', production_required: true },
  ]

  const day7bCases = mappedCases.map((testCase) => {
    const fixture = byId.get(testCase.fixture)
    if (!fixture) {
      return {
        ...testCase,
        status: 'MISSING',
        evidence_fixture_status: null,
        note: `No conformance fixture result found for ${testCase.fixture}`,
      }
    }

    if (fixture.result === 'PASS') {
      return { ...testCase, status: 'PASS', evidence_fixture_status: fixture.result, note: null }
    }

    const status = fixture.result === 'WARN' && testCase.warn_blocks_production ? 'FAIL' : fixture.result
    return {
      ...testCase,
      status,
      evidence_fixture_status: fixture.result,
      note: fixture.error ?? 'Conformance fixture did not pass production Day 7b criteria',
    }
  })

  day7bCases.push(await runFailureModeEvidence())

  const blockingCases = day7bCases.filter((testCase) =>
    testCase.production_required && testCase.status !== 'PASS'
  )
  const hasSkipOnly = blockingCases.length > 0 && blockingCases.every((testCase) => testCase.status === 'SKIP')
  const productionAttestation = blockingCases.length === 0 ? 'PASS' : hasSkipOnly ? 'INCOMPLETE' : 'FAIL'

  const day7bReport = {
    run_id: runId,
    generated_at: new Date().toISOString(),
    server_url: serverUrl,
    agent_id: agentId,
    tenant_address: tenantAddress || null,
    suite_result: suite.result ?? null,
    production_attestation: productionAttestation,
    blocking_cases: blockingCases.map((testCase) => testCase.id),
    cases: day7bCases,
    artifacts: {
      conformance_json: 'conformance_result.json',
      conformance_text: 'conformance_result.txt',
      conformance_stderr: 'conformance_stderr.log',
      day7b_json: 'day7b_report.json',
      day7b_text: 'day7b_result.txt',
      day7b_status_env: 'day7b_status.env',
      day7b_failure_mode_payloads: 'day7b_failure_mode_payloads.json',
      summary: 'summary.txt',
    },
    adaptive_contract: {
      governance_repo_path: '/Users/geofflundholm/Documents/adaptive_layer',
      endpoint: 'POST /v1/audit/append',
      layer: 'auth',
      expected_stream: `audit:auth:${tenantAddress}:<yyyy-mm-dd>`,
    },
    redis_guidance: [
      'Local dev may share Redis when key prefixes and ports are explicit.',
      'Production and serious staging require dedicated KAIF Redis with TLS, ACLs, and independent credentials.',
      'A separate Redis DB/index is not sufficient for production-grade isolation.',
      'Keep KAIF keys namespaced with kaif:* and keep governance-engine Redis independently restartable and observable.',
    ],
  }

  fs.writeFileSync(day7bJsonPath, `${JSON.stringify(day7bReport, null, 2)}\n`)

  const day7bLines = [
    `production_attestation=${productionAttestation}`,
    `blocking_cases=${blockingCases.map((testCase) => testCase.id).join(',') || 'none'}`,
    ...day7bCases.map((testCase) => {
      const evidence = testCase.fixture ? ` evidence=${testCase.fixture}:${testCase.evidence_fixture_status}` : ''
      const artifact = testCase.evidence_artifact ? ` artifact=${testCase.evidence_artifact}` : ''
      const note = testCase.note ? ` note=${testCase.note}` : ''
      return `${testCase.id} ${testCase.status}${evidence}${artifact}${note}`
    }),
  ]
  fs.writeFileSync(day7bTextPath, `${day7bLines.join('\n')}\n`)
  fs.writeFileSync(statusEnvPath, [
    `DAY7B_PRODUCTION_ATTESTATION=${productionAttestation}`,
    `DAY7B_BLOCKING_CASES=${blockingCases.map((testCase) => testCase.id).join(',') || 'none'}`,
    '',
  ].join('\n'))
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
NODE
else
  echo "No conformance JSON was produced" > "$OUT_DIR/conformance_result.txt"
fi

if [[ "$RC" -eq 0 ]]; then
  echo "DAY7B_KAIF_CONFORMANCE=PASS" | tee -a "$OUT_DIR/summary.txt"
else
  echo "DAY7B_KAIF_CONFORMANCE=FAIL" | tee -a "$OUT_DIR/summary.txt"
fi

FINAL_RC="$RC"
if [[ -s "$OUT_DIR/day7b_status.env" ]]; then
  cat "$OUT_DIR/day7b_status.env" | tee -a "$OUT_DIR/summary.txt"
  DAY7B_STATUS="$(grep '^DAY7B_PRODUCTION_ATTESTATION=' "$OUT_DIR/day7b_status.env" | cut -d= -f2-)"
  if [[ "$DAY7B_STRICT" == "true" && "$DAY7B_STATUS" != "PASS" ]]; then
    FINAL_RC=1
  fi
fi

echo "CONFORMANCE_EXIT_CODE=${RC}" | tee -a "$OUT_DIR/summary.txt"
echo "EXIT_CODE=${FINAL_RC}" | tee -a "$OUT_DIR/summary.txt"
echo "ARTIFACT_DIR=${OUT_DIR}" | tee -a "$OUT_DIR/summary.txt"
echo "ARTIFACTS=conformance_result.json,conformance_result.txt,conformance_stderr.log,day7b_report.json,day7b_result.txt,day7b_status.env,day7b_failure_mode_payloads.json,summary.txt" | tee -a "$OUT_DIR/summary.txt"

# Redis note for operators (dev/prod separation)
cat >> "$OUT_DIR/summary.txt" <<'NOTE'
REDIS_GUIDANCE:
- For local dev, KAIF may share Redis if namespaced and isolated by key prefixes.
- For production and serious staging, use dedicated KAIF Redis host/instance with TLS + ACL.
- A separate Redis DB/index is not enough for production-grade isolation.
- Keep Adaptive/governance and KAIF independently restartable and observable.
- Recommended env for isolated dev test: KAIF_REDIS_URL=redis://localhost:6380
NOTE

exit "$FINAL_RC"
