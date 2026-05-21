#!/usr/bin/env bash
# Mints a delegation grant token for the conformance agent using KAIF_DEV_MODE.
# Requires: KAIF server running with KAIF_DEV_MODE=true, jq installed.
#
# Usage:
#   ./scripts/mint-grant-token.sh
#   eval "$(./scripts/mint-grant-token.sh --export)"   # set env vars in current shell
#
# Output (default): prints export statements ready to copy-paste
# Output (--export): prints only the export lines (for eval)

set -euo pipefail

EXPORT_MODE=false
if [[ "${1:-}" == "--export" ]]; then
  EXPORT_MODE=true
fi

KAIF_URL="${KAIF_SERVER_URL:-http://127.0.0.1:8080}"
AGENT_ID="conformance-agent"
SCOPE="invoke:completion"
TTL=900

# Verify jq is available
if ! command -v jq &>/dev/null; then
  echo "Error: jq is required. Install it with: brew install jq" >&2
  exit 1
fi

# Verify the server is reachable
if ! curl -sf "${KAIF_URL}/health" >/dev/null 2>&1; then
  echo "Error: KAIF server not reachable at ${KAIF_URL}" >&2
  echo "  Start it with: docker compose up -d kaif-server" >&2
  echo "  Or set KAIF_SERVER_URL to point to your server." >&2
  exit 1
fi

RESPONSE=$(curl -sf -X POST "${KAIF_URL}/provision" \
  -H "Content-Type: application/json" \
  -d "{
    \"id_token\":    \"dev-mock-token\",
    \"agent_id\":   \"${AGENT_ID}\",
    \"scope\":      \"${SCOPE}\",
    \"ttl_seconds\": ${TTL}
  }")

if [[ -z "$RESPONSE" ]]; then
  echo "Error: /provision returned an empty response." >&2
  echo "  Is KAIF_DEV_MODE=true set on the server?" >&2
  exit 1
fi

# Check for error field
if echo "$RESPONSE" | jq -e '.error' >/dev/null 2>&1; then
  ERROR=$(echo "$RESPONSE" | jq -r '.error')
  DESC=$(echo "$RESPONSE"  | jq -r '.error_description // empty')
  echo "Error from /provision: ${ERROR} — ${DESC}" >&2
  exit 1
fi

DELEGATION_TOKEN=$(echo "$RESPONSE" | jq -r '.delegation_token')
EXPIRES_AT=$(echo "$RESPONSE"       | jq -r '.expires_at')

if [[ "$DELEGATION_TOKEN" == "null" || -z "$DELEGATION_TOKEN" ]]; then
  echo "Error: response did not contain delegation_token." >&2
  echo "Response: $RESPONSE" >&2
  exit 1
fi

if $EXPORT_MODE; then
  echo "export KAIF_GRANT_TOKEN=\"${DELEGATION_TOKEN}\""
  echo "export KAIF_AGENT_ID=\"${AGENT_ID}\""
else
  echo ""
  echo "✓ Delegation token minted for ${AGENT_ID}"
  echo "  Expires at: $(date -r "${EXPIRES_AT}" 2>/dev/null || date -d "@${EXPIRES_AT}" 2>/dev/null || echo "${EXPIRES_AT}")"
  echo ""
  echo "Run the following to set your environment variables:"
  echo ""
  echo "  export KAIF_GRANT_TOKEN=\"${DELEGATION_TOKEN}\""
  echo "  export KAIF_AGENT_ID=\"${AGENT_ID}\""
  echo ""
  echo "Or run:  eval \"\$(./scripts/mint-grant-token.sh --export)\""
  echo ""
  echo "Then run the conformance kit:"
  echo "  kaif-conformance \\"
  echo "    --server http://127.0.0.1:8080 \\"
  echo "    --svid-jwt /tmp/svid.jwt \\"
  echo "    --grant-token \"\$KAIF_GRANT_TOKEN\" \\"
  echo "    --agent-id spiffe://kindred.systems/ns/conformance/agent/test"
fi
