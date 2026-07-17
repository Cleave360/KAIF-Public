#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 3 ]]; then
  echo "Usage: $0 <app_insights_resource_id> <log_analytics_workspace_resource_id> <output_file>"
  exit 1
fi

APP_INSIGHTS_ID="$1"
WORKSPACE_ID="$2"
OUT_FILE="$3"
TEMPLATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE_FILE="$TEMPLATE_DIR/workbook-kaif-research.template.json"

if [[ ! -f "$TEMPLATE_FILE" ]]; then
  echo "Template not found: $TEMPLATE_FILE"
  exit 1
fi

sed \
  -e "s|APP_INSIGHTS_RESOURCE_ID|$APP_INSIGHTS_ID|g" \
  -e "s|LOG_ANALYTICS_WORKSPACE_RESOURCE_ID|$WORKSPACE_ID|g" \
  "$TEMPLATE_FILE" > "$OUT_FILE"

echo "Rendered workbook file: $OUT_FILE"
