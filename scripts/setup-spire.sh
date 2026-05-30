#!/usr/bin/env bash
# Bootstraps SPIRE workload entries after docker compose up.
# Run once before any agent can request SVIDs.
#
# Usage: ./scripts/setup-spire.sh

set -euo pipefail

SPIRE_SERVER="docker compose exec spire-server"
TRUST_DOMAIN="kindred.systems"

echo "→ Generating bootstrap join token..."
JOIN_TOKEN=$($SPIRE_SERVER \
  /opt/spire/bin/spire-server token generate \
  -spiffeID "spiffe://${TRUST_DOMAIN}/spire/agent/join_token/bootstrap" \
  | awk -F': ' '/^Token[[:space:]]*:/{print $2; exit}')

if [[ -z "${JOIN_TOKEN}" ]]; then
  echo "ERROR: token generate returned empty output" >&2
  exit 1
fi

echo "  Join token: ${JOIN_TOKEN}"

echo "→ Registering workload entries..."

register() {
  local SPIFFE_ID=$1
  local SELECTOR=$2
  $SPIRE_SERVER \
    /opt/spire/bin/spire-server entry create \
    -spiffeID  "${SPIFFE_ID}" \
    -parentID  "spiffe://${TRUST_DOMAIN}/spire/agent/join_token/bootstrap" \
    -selector  "${SELECTOR}" \
    -jwtSVIDTTL 3600 \
    2>&1 | grep -E "(Entry ID|SPIFFE ID|already exists)"
}

register "spiffe://${TRUST_DOMAIN}/ns/adaptive-layer/agent/lyra"    "unix:uid:1000"
register "spiffe://${TRUST_DOMAIN}/ns/adaptive-layer/agent/orion"   "unix:uid:1000"
register "spiffe://${TRUST_DOMAIN}/ns/adaptive-layer/agent/cipher"  "unix:uid:1000"
register "spiffe://${TRUST_DOMAIN}/ns/examples/agent/mock"          "unix:uid:0"
register "spiffe://${TRUST_DOMAIN}/ns/conformance/agent/test"       "unix:uid:0"

echo ""
echo "✓ SPIRE entries registered"
echo ""
echo "To start the agent manually, add to spire/agent.conf:"
echo "  join_token = \"${JOIN_TOKEN}\""
echo "(Or use the Docker volume socket — the compose agent handles this automatically)"
