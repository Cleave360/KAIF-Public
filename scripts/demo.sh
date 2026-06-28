#!/usr/bin/env bash
# End-to-end KAIF demo.
# Brings up the full stack, provisions a delegation grant,
# executes a token exchange, and prints the decoded KAIF JWT.
#
# Prerequisites: Docker, docker compose, curl, python3
# Usage: ./scripts/demo.sh

set -euo pipefail

ENV_FILE="${KAIF_COMPOSE_ENV_FILE:-.env}"
if [ -z "${KAIF_HOST_PORT:-}" ] && [ -f "${ENV_FILE}" ]; then
  FILE_KAIF_HOST_PORT=$(grep -E '^KAIF_HOST_PORT=' "${ENV_FILE}" | tail -1 | cut -d'=' -f2- || true)
  if [ -n "${FILE_KAIF_HOST_PORT}" ]; then
    KAIF_HOST_PORT="${FILE_KAIF_HOST_PORT}"
  fi
fi
KAIF_HOST_PORT="${KAIF_HOST_PORT:-8080}"
KAIF="${KAIF_SERVER_URL:-http://localhost:${KAIF_HOST_PORT}}"

dc() {
  if [ -n "${KAIF_COMPOSE_ENV_FILE:-}" ]; then
    docker compose --env-file "${KAIF_COMPOSE_ENV_FILE}" "$@"
  else
    docker compose "$@"
  fi
}

BOLD=$(tput bold 2>/dev/null || true)
RESET=$(tput sgr0 2>/dev/null || true)

header() { echo ""; echo "${BOLD}▶ $1${RESET}"; }

# ── 1. Start stack ────────────────────────────────────────────────

header "Starting KAIF stack with dev_mode enabled..."
KAIF_DEV_MODE=true \
KAIF_HOST_PORT="${KAIF_HOST_PORT}" \
KAIF_ISSUER="${KAIF_ISSUER:-${KAIF}}" \
dc up -d --build

header "Waiting for stack to be healthy..."
ATTEMPTS=0
until curl -sf "${KAIF}/health" | grep -q '"status":"ok"'; do
  ATTEMPTS=$((ATTEMPTS + 1))
  if [ $ATTEMPTS -ge 30 ]; then
    echo "ERROR: Stack did not become healthy after 90 seconds"
    docker compose logs kaif-server | tail -20
    exit 1
  fi
  echo "  waiting... (${ATTEMPTS}/30)"
  sleep 3
done
echo "  Stack healthy ✓"

# ── 2. Fetch mock agent SVID ─────────────────────────────────────

header "Fetching mock agent JWT-SVID from SPIRE..."
SVID=""
for attempt in $(seq 1 10); do
  SVID=$(dc exec -T spire-agent \
    /opt/spire/bin/spire-agent api fetch jwt \
    -spiffeID "spiffe://kindred.systems/ns/examples/agent/mock" \
    -audience "${KAIF}" \
    -socketPath /run/spire/sockets/agent.sock \
    2>/dev/null | awk '/^\t/ { sub(/^\t/, ""); print; exit }' | tr -d '[:space:]' || true)
  if [ -n "${SVID}" ]; then
    break
  fi
  echo "  waiting for SPIRE workload identity... (${attempt}/10)"
  sleep 2
done

if [ -z "${SVID}" ]; then
  echo "  SPIRE JWT-SVID fetch unavailable; using dev mock SVID fallback"
  SVID="dev-mock-svid:spiffe://kindred.systems/ns/examples/agent/mock"
else
  echo "  SVID obtained (${#SVID} chars)"
fi

# ── 3. Create delegation grant ───────────────────────────────────

header "Creating delegation grant (dev mock principal)..."
GRANT_RESPONSE=$(curl -sf -X POST "${KAIF}/provision" \
  -H "Content-Type: application/json" \
  -d '{
    "id_token":    "dev-mock-token",
    "agent_id":    "mock-agent",
    "scope":       "invoke:completion",
    "ttl_seconds": 300
  }')

DELEGATION_ID=$(echo "${GRANT_RESPONSE}" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['delegation_id'])")
DELEGATION_TOKEN=$(echo "${GRANT_RESPONSE}" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['delegation_token'])")
echo "  Delegation ID:    ${DELEGATION_ID}"
echo "  Delegation token: ${DELEGATION_TOKEN:0:40}..."

# ── 4. Execute token exchange ─────────────────────────────────────
# delegation_token is the signed KAIF JWT returned by /provision.
# It is used directly as subject_token — no manual JWT construction needed.

header "Executing RFC 8693 token exchange..."
TOKEN_RESPONSE=$(curl -sf -X POST "${KAIF}/oauth/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "grant_type=urn:ietf:params:oauth:grant-type:token-exchange" \
  --data-urlencode "subject_token=${DELEGATION_TOKEN}" \
  --data-urlencode "subject_token_type=urn:ietf:params:oauth:token-type:access_token" \
  --data-urlencode "actor_token=${SVID}" \
  --data-urlencode "actor_token_type=urn:ietf:params:oauth:token-type:jwt" \
  --data-urlencode "scope=invoke:completion")

ACCESS_TOKEN=$(echo "${TOKEN_RESPONSE}" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")

# ── 5. Decode and print JWT ───────────────────────────────────────

header "Decoded KAIF JWT:"
echo "${ACCESS_TOKEN}" \
  | cut -d'.' -f2 \
  | python3 -c "
import sys, base64, json
payload = sys.stdin.read().strip()
padded = payload + '=' * (-len(payload) % 4)
decoded = base64.urlsafe_b64decode(padded)
print(json.dumps(json.loads(decoded), indent=2))
"

# ── 6. Run conformance kit ────────────────────────────────────────

header "Running conformance kit..."
if command -v npx &>/dev/null && [ -d conformance ]; then
  if [[ "${SVID}" == dev-mock-svid:* ]]; then
    echo "  (conformance skipped: demo is using dev mock SVID fallback)"
  else
    pnpm --filter @kaif/conformance build >/dev/null 2>&1 || true
    SVID_FILE=$(mktemp)
    trap 'rm -f "${SVID_FILE}"' EXIT
    printf '%s\n' "${SVID}" > "${SVID_FILE}"
    npx --prefix conformance kaif-conformance \
      --server "${KAIF}" \
      --svid-jwt "${SVID_FILE}" \
      --grant-token "${DELEGATION_TOKEN}" \
      --agent-id "spiffe://kindred.systems/ns/examples/agent/mock" \
      2>&1 || true
    rm -f "${SVID_FILE}"
    trap - EXIT
  fi
else
  echo "  (conformance kit not available — skipping)"
fi

header "Done."
if [ -n "${KAIF_COMPOSE_ENV_FILE:-}" ]; then
  echo "  Stack is still running. Stop with: docker compose --env-file ${KAIF_COMPOSE_ENV_FILE} down"
else
  echo "  Stack is still running. Stop with: docker compose down"
fi
