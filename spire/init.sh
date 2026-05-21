#!/bin/sh
set -e
CLI="/opt/spire/bin/spire-server"
SOCK="/run/spire/server-sockets/api.sock"
TD="kindred.systems"

echo "→ Generating join token..."
TOKEN=$(${CLI} token generate -socketPath "${SOCK}" | awk '{print $2}')
if [ -z "${TOKEN}" ]; then
  echo "Error: token generate returned empty output" >&2
  exit 1
fi
printf '%s' "${TOKEN}" > /run/spire/token/join_token
echo "  Token: ${TOKEN}"

# The agent's SPIFFE ID after join_token attestation is:
#   spiffe://<trust-domain>/spire/agent/join_token/<token>
PARENT="spiffe://${TD}/spire/agent/join_token/${TOKEN}"

register() {
  ${CLI} entry create \
    -spiffeID  "$1" \
    -parentID  "${PARENT}" \
    -selector  "unix:uid:$2" \
    -jwtSVIDTTL 3600 \
    -socketPath "${SOCK}" 2>&1 | grep -E "(Entry ID|already exists)" || true
}

echo "→ Registering workload entries..."
register "spiffe://${TD}/ns/adaptive-layer/agent/lyra"   1000
register "spiffe://${TD}/ns/adaptive-layer/agent/orion"  1000
register "spiffe://${TD}/ns/adaptive-layer/agent/cipher" 1000
register "spiffe://${TD}/ns/examples/agent/mock"         0
register "spiffe://${TD}/ns/conformance/agent/test"      0
echo "✓ SPIRE init complete."
