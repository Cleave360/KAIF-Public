#!/usr/bin/env bash
set -euo pipefail

# One-shot helper to render and import/update both KAIF workbooks.
#
# Required environment variables:
#   AZURE_RESOURCE_GROUP
#   APP_INSIGHTS_RESOURCE_ID
#   LOG_ANALYTICS_WORKSPACE_RESOURCE_ID
#
# Optional environment variables:
#   AZURE_LOCATION (default: ukwest)
#   RESEARCH_WORKBOOK_NAME (default: KAIF-Research-Metrics)
#   RESEARCH_WORKBOOK_DISPLAY (default: KAIF Research Metrics)
#   PAPER_WORKBOOK_NAME (default: KAIF-Paper-Figures)
#   PAPER_WORKBOOK_DISPLAY (default: KAIF Paper Figures)
#
# Optional flags:
#   --dry-run | -n  Render and validate workbook JSON, skip Azure API calls.

usage() {
  cat <<'EOF'
Usage: run-workbook-import.sh [--dry-run|-n]

Required environment variables (always):
  APP_INSIGHTS_RESOURCE_ID
  LOG_ANALYTICS_WORKSPACE_RESOURCE_ID

Required environment variables (when not using --dry-run):
  AZURE_RESOURCE_GROUP
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
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

: "${APP_INSIGHTS_RESOURCE_ID:?APP_INSIGHTS_RESOURCE_ID is required}"
: "${LOG_ANALYTICS_WORKSPACE_RESOURCE_ID:?LOG_ANALYTICS_WORKSPACE_RESOURCE_ID is required}"

if [[ "$DRY_RUN" != true ]]; then
  : "${AZURE_RESOURCE_GROUP:?AZURE_RESOURCE_GROUP is required}"
fi

AZURE_LOCATION="${AZURE_LOCATION:-ukwest}"
RESEARCH_WORKBOOK_NAME="${RESEARCH_WORKBOOK_NAME:-KAIF-Research-Metrics}"
RESEARCH_WORKBOOK_DISPLAY="${RESEARCH_WORKBOOK_DISPLAY:-KAIF Research Metrics}"
PAPER_WORKBOOK_NAME="${PAPER_WORKBOOK_NAME:-KAIF-Paper-Figures}"
PAPER_WORKBOOK_DISPLAY="${PAPER_WORKBOOK_DISPLAY:-KAIF Paper Figures}"

RENDERER="$SCRIPT_DIR/render-workbook.sh"
RESEARCH_TEMPLATE="$SCRIPT_DIR/workbook-kaif-research.template.json"
RESEARCH_RENDERED="$SCRIPT_DIR/workbook-kaif-research.json"
PAPER_TEMPLATE="$SCRIPT_DIR/workbook-kaif-paper-figures.template.json"
PAPER_RENDERED="$SCRIPT_DIR/workbook-kaif-paper-figures.json"

if [[ "$DRY_RUN" != true ]]; then
  if ! command -v az >/dev/null 2>&1; then
    echo "Error: Azure CLI (az) is not installed or not in PATH"
    exit 1
  fi
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "Error: jq is required"
  exit 1
fi

if [[ ! -x "$RENDERER" ]]; then
  echo "Error: renderer script is missing or not executable: $RENDERER"
  exit 1
fi

if [[ ! -f "$RESEARCH_TEMPLATE" || ! -f "$PAPER_TEMPLATE" ]]; then
  echo "Error: workbook template files are missing in $SCRIPT_DIR"
  exit 1
fi

if [[ "$DRY_RUN" != true ]]; then
  echo "[1/5] Verifying Azure CLI login"
  az account show >/dev/null
else
  echo "[dry-run 1/4] Rendering and validation only; Azure API calls will be skipped"
fi

if [[ "$DRY_RUN" != true ]]; then
  echo "[2/5] Rendering workbook JSON files"
else
  echo "[dry-run 2/4] Rendering workbook JSON files"
fi
"$RENDERER" "$APP_INSIGHTS_RESOURCE_ID" "$LOG_ANALYTICS_WORKSPACE_RESOURCE_ID" "$RESEARCH_RENDERED"
"$RENDERER" "$APP_INSIGHTS_RESOURCE_ID" "$LOG_ANALYTICS_WORKSPACE_RESOURCE_ID" "$PAPER_RENDERED" < /dev/null

# render-workbook.sh always reads the research template.
# For paper figures, run direct replacement against the paper template.
sed \
  -e "s|APP_INSIGHTS_RESOURCE_ID|$APP_INSIGHTS_RESOURCE_ID|g" \
  -e "s|LOG_ANALYTICS_WORKSPACE_RESOURCE_ID|$LOG_ANALYTICS_WORKSPACE_RESOURCE_ID|g" \
  "$PAPER_TEMPLATE" > "$PAPER_RENDERED"

if [[ "$DRY_RUN" != true ]]; then
  echo "[3/5] Validating rendered JSON"
else
  echo "[dry-run 3/4] Validating rendered JSON"
fi
jq . "$RESEARCH_RENDERED" >/dev/null
jq . "$PAPER_RENDERED" >/dev/null

create_or_update_workbook() {
  local workbook_name="$1"
  local display_name="$2"
  local rendered_path="$3"

  if az monitor app-insights workbook show \
    --resource-group "$AZURE_RESOURCE_GROUP" \
    --name "$workbook_name" >/dev/null 2>&1; then
    echo "Updating workbook: $workbook_name"
    az monitor app-insights workbook update \
      --resource-group "$AZURE_RESOURCE_GROUP" \
      --name "$workbook_name" \
      --serialized-data "@$rendered_path" >/dev/null
  else
    echo "Creating workbook: $workbook_name"
    az monitor app-insights workbook create \
      --resource-group "$AZURE_RESOURCE_GROUP" \
      --name "$workbook_name" \
      --location "$AZURE_LOCATION" \
      --category workbook \
      --display-name "$display_name" \
      --serialized-data "@$rendered_path" >/dev/null
  fi
}

if [[ "$DRY_RUN" != true ]]; then
  echo "[4/5] Importing workbooks"
  create_or_update_workbook "$RESEARCH_WORKBOOK_NAME" "$RESEARCH_WORKBOOK_DISPLAY" "$RESEARCH_RENDERED"
  create_or_update_workbook "$PAPER_WORKBOOK_NAME" "$PAPER_WORKBOOK_DISPLAY" "$PAPER_RENDERED"
else
  echo "[dry-run 4/4] Skipping workbook import (--dry-run enabled)"
fi

if [[ "$DRY_RUN" != true ]]; then
  echo "[5/5] Done"
  echo "Workbooks are ready in resource group: $AZURE_RESOURCE_GROUP"
else
  echo "[dry-run] Done"
fi
echo "Rendered files:"
echo "- $RESEARCH_RENDERED"
echo "- $PAPER_RENDERED"
