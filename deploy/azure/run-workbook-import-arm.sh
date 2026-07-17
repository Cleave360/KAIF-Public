#!/usr/bin/env bash
set -euo pipefail

# Import/update KAIF workbooks via ARM (az rest), no CLI extension required.
#
# Required env vars:
#   AZURE_RESOURCE_GROUP
#   APP_INSIGHTS_RESOURCE_ID
#   LOG_ANALYTICS_WORKSPACE_RESOURCE_ID
#
# Optional env vars:
#   AZURE_SUBSCRIPTION_ID            (auto-detected from az account show)
#   AZURE_LOCATION                   (default: ukwest)
#   RESEARCH_WORKBOOK_DISPLAY        (default: KAIF Research Metrics)
#   PAPER_WORKBOOK_DISPLAY           (default: KAIF Paper Figures)
#   RESEARCH_WORKBOOK_RESOURCE_ID    (GUID workbook name to update existing)
#   PAPER_WORKBOOK_RESOURCE_ID       (GUID workbook name to update existing)
#
# Optional flags:
#   --dry-run | -n                   Render/validate only, skip ARM calls

usage() {
  cat <<'EOF'
Usage: run-workbook-import-arm.sh [--dry-run|-n]

Required env vars:
  AZURE_RESOURCE_GROUP
  APP_INSIGHTS_RESOURCE_ID
  LOG_ANALYTICS_WORKSPACE_RESOURCE_ID
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

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

: "${AZURE_RESOURCE_GROUP:?AZURE_RESOURCE_GROUP is required}"
: "${APP_INSIGHTS_RESOURCE_ID:?APP_INSIGHTS_RESOURCE_ID is required}"
: "${LOG_ANALYTICS_WORKSPACE_RESOURCE_ID:?LOG_ANALYTICS_WORKSPACE_RESOURCE_ID is required}"

AZURE_LOCATION="${AZURE_LOCATION:-ukwest}"
RESEARCH_WORKBOOK_DISPLAY="${RESEARCH_WORKBOOK_DISPLAY:-KAIF Research Metrics}"
PAPER_WORKBOOK_DISPLAY="${PAPER_WORKBOOK_DISPLAY:-KAIF Paper Figures}"

RENDERER="$SCRIPT_DIR/render-workbook.sh"
RESEARCH_RENDERED="$SCRIPT_DIR/workbook-kaif-research.json"
PAPER_RENDERED="$SCRIPT_DIR/workbook-kaif-paper-figures.json"

if ! command -v az >/dev/null 2>&1; then
  echo "Error: Azure CLI (az) is not installed or not in PATH"
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "Error: jq is required"
  exit 1
fi
if [[ ! -x "$RENDERER" ]]; then
  echo "Error: renderer script missing or not executable: $RENDERER"
  exit 1
fi

API_VERSION="2023-06-01"
AZURE_SUBSCRIPTION_ID="${AZURE_SUBSCRIPTION_ID:-$(az account show --query id -o tsv)}"

if [[ -z "$AZURE_SUBSCRIPTION_ID" ]]; then
  echo "Error: could not resolve AZURE_SUBSCRIPTION_ID"
  exit 1
fi

if [[ "$DRY_RUN" != true ]]; then
  echo "[1/5] Verifying Azure login"
  az account show >/dev/null
else
  echo "[dry-run 1/4] Rendering and validation only; skipping ARM calls"
fi

if [[ "$DRY_RUN" != true ]]; then
  echo "[2/5] Rendering workbook JSON"
else
  echo "[dry-run 2/4] Rendering workbook JSON"
fi
"$RENDERER" "$APP_INSIGHTS_RESOURCE_ID" "$LOG_ANALYTICS_WORKSPACE_RESOURCE_ID" "$RESEARCH_RENDERED"

sed \
  -e "s|APP_INSIGHTS_RESOURCE_ID|$APP_INSIGHTS_RESOURCE_ID|g" \
  -e "s|LOG_ANALYTICS_WORKSPACE_RESOURCE_ID|$LOG_ANALYTICS_WORKSPACE_RESOURCE_ID|g" \
  "$SCRIPT_DIR/workbook-kaif-paper-figures.template.json" > "$PAPER_RENDERED"

if [[ "$DRY_RUN" != true ]]; then
  echo "[3/5] Validating rendered JSON"
else
  echo "[dry-run 3/4] Validating rendered JSON"
fi
jq . "$RESEARCH_RENDERED" >/dev/null
jq . "$PAPER_RENDERED" >/dev/null

research_name="${RESEARCH_WORKBOOK_RESOURCE_ID:-$(uuidgen | tr '[:upper:]' '[:lower:]')}"
paper_name="${PAPER_WORKBOOK_RESOURCE_ID:-$(uuidgen | tr '[:upper:]' '[:lower:]')}"

create_or_update_arm_workbook() {
  local workbook_name="$1"
  local display_name="$2"
  local rendered_file="$3"
  local serialized
  local body

  serialized="$(jq -c . "$rendered_file")"
  body="$(jq -n \
    --arg location "$AZURE_LOCATION" \
    --arg display "$display_name" \
    --arg sd "$serialized" \
    --arg source "$APP_INSIGHTS_RESOURCE_ID" \
    '{location:$location, kind:"shared", properties:{displayName:$display, category:"workbook", sourceId:$source, version:"Notebook/1.0", serializedData:$sd}}')"

  az rest \
    --method put \
    --url "https://management.azure.com/subscriptions/$AZURE_SUBSCRIPTION_ID/resourceGroups/$AZURE_RESOURCE_GROUP/providers/Microsoft.Insights/workbooks/$workbook_name?api-version=$API_VERSION" \
    --headers 'Content-Type=application/json' \
    --body "$body" \
    --query '{id:id,name:name,displayName:properties.displayName}' -o json
}

if [[ "$DRY_RUN" != true ]]; then
  echo "[4/5] Importing via ARM"
  echo "Research workbook resource ID: $research_name"
  create_or_update_arm_workbook "$research_name" "$RESEARCH_WORKBOOK_DISPLAY" "$RESEARCH_RENDERED"
  echo "Paper workbook resource ID: $paper_name"
  create_or_update_arm_workbook "$paper_name" "$PAPER_WORKBOOK_DISPLAY" "$PAPER_RENDERED"
  echo "[5/5] Done"
  echo "Use these workbook resource IDs for future updates:"
  echo "- RESEARCH_WORKBOOK_RESOURCE_ID=$research_name"
  echo "- PAPER_WORKBOOK_RESOURCE_ID=$paper_name"
else
  echo "[dry-run 4/4] Skipping ARM import (--dry-run enabled)"
  echo "[dry-run] Done"
fi

echo "Rendered files:"
echo "- $RESEARCH_RENDERED"
echo "- $PAPER_RENDERED"
