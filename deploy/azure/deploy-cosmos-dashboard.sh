#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: deploy-cosmos-dashboard.sh [--dry-run|-n]

Required env vars:
  AZURE_RESOURCE_GROUP

Optional env vars:
  AZURE_LOCATION=ukwest
  KAIF_COSMOS_ACCOUNT_ID=<resource id>
  KAIF_COSMOS_ACCOUNT_NAME=<fallback account name>
  COSMOS_DASHBOARD_NAME=kaif-cosmos-warm-store
EOF
}

DRY_RUN=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run|-n)
      DRY_RUN=true
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Error: unknown argument '$1'"
      usage
      exit 1
      ;;
  esac
done

: "${AZURE_RESOURCE_GROUP:?AZURE_RESOURCE_GROUP is required}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="$SCRIPT_DIR/cosmos-dashboard.template.json"
RENDERED="$SCRIPT_DIR/cosmos-dashboard.json"

AZURE_LOCATION="${AZURE_LOCATION:-ukwest}"
COSMOS_DASHBOARD_NAME="${COSMOS_DASHBOARD_NAME:-kaif-cosmos-warm-store}"

if ! command -v az >/dev/null 2>&1; then
  echo "Error: Azure CLI (az) is not installed or not in PATH"
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "Error: jq is required"
  exit 1
fi

if [[ -n "${KAIF_COSMOS_ACCOUNT_ID:-}" ]]; then
  COSMOS_ACCOUNT_ID="$KAIF_COSMOS_ACCOUNT_ID"
else
  COSMOS_ACCOUNT_NAME="${KAIF_COSMOS_ACCOUNT_NAME:-$(az cosmosdb list --query '[0].name' -o tsv)}"
  if [[ -z "$COSMOS_ACCOUNT_NAME" ]]; then
    echo "Error: could not discover a Cosmos DB account"
    exit 1
  fi
  COSMOS_ACCOUNT_ID="$(az cosmosdb list --query "[?name=='$COSMOS_ACCOUNT_NAME'].id | [0]" -o tsv)"
fi

if [[ -z "$COSMOS_ACCOUNT_ID" ]]; then
  echo "Error: could not resolve COSMOS_ACCOUNT_ID"
  exit 1
fi

sed \
  -e "s|__DASHBOARD_NAME__|$COSMOS_DASHBOARD_NAME|g" \
  -e "s|__DASHBOARD_LOCATION__|$AZURE_LOCATION|g" \
  -e "s|__COSMOS_ACCOUNT_ID__|$COSMOS_ACCOUNT_ID|g" \
  "$TEMPLATE" > "$RENDERED"

jq . "$RENDERED" >/dev/null

if [[ "$DRY_RUN" == true ]]; then
  echo "Dry run complete. Rendered dashboard: $RENDERED"
  exit 0
fi

az rest \
  --method put \
  --url "https://management.azure.com/subscriptions/$(az account show --query id -o tsv)/resourceGroups/$AZURE_RESOURCE_GROUP/providers/Microsoft.Portal/dashboards/$COSMOS_DASHBOARD_NAME?api-version=2022-12-01-preview" \
  --body "@$RENDERED" \
  --query '{name:name,id:id}' -o json

echo "Cosmos dashboard deployed: $COSMOS_DASHBOARD_NAME"