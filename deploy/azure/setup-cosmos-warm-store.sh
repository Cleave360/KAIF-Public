#!/usr/bin/env bash
set -euo pipefail

# Creates a low-cost Cosmos DB warm store for KAIF Redis channel offload.
#
# Required env vars:
#   AZURE_RESOURCE_GROUP
#
# Optional env vars:
#   AZURE_LOCATION=ukwest
#   KAIF_COSMOS_ACCOUNT_NAME=kaifwarm<unique>
#   KAIF_COSMOS_ENABLE_FREE_TIER=true
#   KAIF_COSMOS_ENABLE_SERVERLESS=false
#   KAIF_COSMOS_PRINT_KEY=false
#   KAIF_COSMOS_DATABASE=kaif-warm
#   KAIF_COSMOS_CONTAINER=channel-events
#   KAIF_COSMOS_CONTAINER_PARTITION_KEY=/channel
#   KAIF_COSMOS_DEFAULT_TTL_SECONDS=2592000

: "${AZURE_RESOURCE_GROUP:?AZURE_RESOURCE_GROUP is required}"

AZURE_LOCATION="${AZURE_LOCATION:-ukwest}"
KAIF_COSMOS_ACCOUNT_NAME="${KAIF_COSMOS_ACCOUNT_NAME:-kaifwarm$(date +%s)}"
KAIF_COSMOS_ENABLE_FREE_TIER="${KAIF_COSMOS_ENABLE_FREE_TIER:-true}"
KAIF_COSMOS_ENABLE_SERVERLESS="${KAIF_COSMOS_ENABLE_SERVERLESS:-false}"
KAIF_COSMOS_PRINT_KEY="${KAIF_COSMOS_PRINT_KEY:-false}"
KAIF_COSMOS_DATABASE="${KAIF_COSMOS_DATABASE:-kaif-warm}"
KAIF_COSMOS_CONTAINER="${KAIF_COSMOS_CONTAINER:-channel-events}"
KAIF_COSMOS_CONTAINER_PARTITION_KEY="${KAIF_COSMOS_CONTAINER_PARTITION_KEY:-/channel}"
KAIF_COSMOS_DEFAULT_TTL_SECONDS="${KAIF_COSMOS_DEFAULT_TTL_SECONDS:-2592000}"

if ! command -v az >/dev/null 2>&1; then
  echo "Azure CLI is required."
  exit 1
fi

az account show >/dev/null

echo "[1/4] Creating Cosmos DB account (free tier requested)"
create_args=(
  -g "$AZURE_RESOURCE_GROUP"
  -n "$KAIF_COSMOS_ACCOUNT_NAME"
  --locations "regionName=$AZURE_LOCATION" "failoverPriority=0" "isZoneRedundant=False"
  --default-consistency-level Session
)

if [[ "$KAIF_COSMOS_ENABLE_FREE_TIER" == "true" ]]; then
  create_args+=(--enable-free-tier true)
fi

if [[ "$KAIF_COSMOS_ENABLE_SERVERLESS" == "true" ]]; then
  create_args+=(--capabilities EnableServerless)
fi

az cosmosdb create "${create_args[@]}" >/dev/null

echo "[2/4] Creating SQL database"
az cosmosdb sql database create \
  -g "$AZURE_RESOURCE_GROUP" \
  --account-name "$KAIF_COSMOS_ACCOUNT_NAME" \
  --name "$KAIF_COSMOS_DATABASE" >/dev/null

echo "[3/4] Creating container"
container_args=(
  -g "$AZURE_RESOURCE_GROUP"
  --account-name "$KAIF_COSMOS_ACCOUNT_NAME"
  --database-name "$KAIF_COSMOS_DATABASE"
  --name "$KAIF_COSMOS_CONTAINER"
  --partition-key-path "$KAIF_COSMOS_CONTAINER_PARTITION_KEY"
)

if [[ "$KAIF_COSMOS_ENABLE_SERVERLESS" != "true" ]]; then
  container_args+=(--throughput 400)
fi

az cosmosdb sql container create "${container_args[@]}" >/dev/null

echo "[4/4] Applying default TTL"
az cosmosdb sql container update \
  -g "$AZURE_RESOURCE_GROUP" \
  --account-name "$KAIF_COSMOS_ACCOUNT_NAME" \
  --database-name "$KAIF_COSMOS_DATABASE" \
  --name "$KAIF_COSMOS_CONTAINER" \
  --ttl "$KAIF_COSMOS_DEFAULT_TTL_SECONDS" >/dev/null

COSMOS_ENDPOINT="$(az cosmosdb show -g "$AZURE_RESOURCE_GROUP" -n "$KAIF_COSMOS_ACCOUNT_NAME" --query documentEndpoint -o tsv)"
COSMOS_KEY="$(az cosmosdb keys list -g "$AZURE_RESOURCE_GROUP" -n "$KAIF_COSMOS_ACCOUNT_NAME" --query primaryMasterKey -o tsv)"

echo
echo "Warning: Cosmos primary keys are sensitive. This script does not print the key unless KAIF_COSMOS_PRINT_KEY=true."
echo "Fetch it on demand with:"
echo "  az cosmosdb keys list -g \"$AZURE_RESOURCE_GROUP\" -n \"$KAIF_COSMOS_ACCOUNT_NAME\" --query primaryMasterKey -o tsv"
echo
echo "Cosmos warm store created. Add these to your .env:"
echo "KAIF_COSMOS_ENDPOINT=$COSMOS_ENDPOINT"
if [[ "$KAIF_COSMOS_PRINT_KEY" == "true" ]]; then
  echo "KAIF_COSMOS_KEY=$COSMOS_KEY"
else
  echo "KAIF_COSMOS_KEY=<fetch on demand using the az cosmosdb keys list command above>"
fi
echo "KAIF_COSMOS_DATABASE=$KAIF_COSMOS_DATABASE"
echo "KAIF_COSMOS_CONTAINER=$KAIF_COSMOS_CONTAINER"
echo "KAIF_COSMOS_CONTAINER_PARTITION_KEY=$KAIF_COSMOS_CONTAINER_PARTITION_KEY"
echo "KAIF_COSMOS_DEFAULT_TTL_SECONDS=$KAIF_COSMOS_DEFAULT_TTL_SECONDS"
echo "KAIF_REDIS_CHANNELS=kaif:audit,kaif:revocation,kaif:authorization-tier"
