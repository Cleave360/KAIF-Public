#!/usr/bin/env bash
set -euo pipefail

OUT_PATH="${1:-./deploy/secrets/spire/bootstrap/bundle.pem}"
SOCKET_PATH="${SPIRE_SERVER_SOCKET_PATH:-/run/spire/server-sockets/api.sock}"
SPIRE_SERVER_SERVICE="${SPIRE_SERVER_SERVICE:-spire-server}"

mkdir -p "$(dirname "${OUT_PATH}")"

docker compose exec -T "${SPIRE_SERVER_SERVICE}" \
  /opt/spire/bin/spire-server bundle show \
  -format pem \
  -socketPath "${SOCKET_PATH}" > "${OUT_PATH}"

echo "Wrote SPIRE bootstrap bundle to ${OUT_PATH}"
