#!/usr/bin/env bash
# End-to-end KAIF demo.
# Brings up the full stack, provisions a delegation grant,
# executes a token exchange, and prints the decoded KAIF JWT.
#
# Prerequisites: Docker, docker compose, curl, python3
# Usage: ./scripts/demo.sh

set -euo pipefail

KAIF_HOST_PORT="${KAIF_HOST_PORT:-8080}"
KAIF="${KAIF_SERVER_URL:-http://localhost:${KAIF_HOST_PORT}}"
COMPOSE_ARGS=()
if [ -n "${KAIF_COMPOSE_ENV_FILE:-}" ]; then
  COMPOSE_ARGS=(--env-file "${KAIF_COMPOSE_ENV_FILE}")
fi
BOLD=$(tput bold 2>/dev/null || true)
RESET=$(tput sgr0 2>/dev/null || true)

header() { echo ""; echo "${BOLD}▶ $1${RESET}"; }

# ── 1. Start stack ────────────────────────────────────────────────

header "Starting KAIF stack with dev_mode enabled..."
KAIF_DEV_MODE=true \
KAIF_HOST_PORT="${KAIF_HOST_PORT}" \
KAIF_ISSUER="${KAIF_ISSUER:-${KAIF}}" \
docker compose "${COMPOSE_ARGS[@]}" up -d --build

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
SVID=$(docker compose "${COMPOSE_ARGS[@]}" exec spire-agent \
  /opt/spire/bin/spire-agent api fetch jwt \
  -spiffeID "spiffe://kindred.systems/ns/examples/agent/mock" \
  -audience "${KAIF}" \
  -socketPath /run/spire/sockets/agent.sock \
  2>/dev/null | grep -v "^Received" | tr -d '[:space:]')

if [ -z "${SVID}" ]; then
  echo "ERROR: Could not fetch JWT-SVID. Is the mock-agent registered?"
  echo "Check spire-init and spire-agent logs with: docker compose logs spire-init spire-agent"
  exit 1
fi
echo "  SVID obtained (${#SVID} chars)"

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
  pnpm --filter @kaif/conformance build --silent 2>/dev/null || true
  npx --prefix conformance kaif-conformance \
    --server "${KAIF}" \
    --svid-jwt <(echo "${SVID}") \
    --grant-token "${DELEGATION_TOKEN}" \
    --agent-id "spiffe://kindred.systems/ns/examples/agent/mock" \
    2>&1 || true
else
  echo "  (conformance kit not available — skipping)"
fi

header "Done."
if [ -n "${KAIF_COMPOSE_ENV_FILE:-}" ]; then
  echo "  Stack is still running. Stop with: docker compose --env-file ${KAIF_COMPOSE_ENV_FILE} down"
else
  echo "  Stack is still running. Stop with: docker compose down"
fi
