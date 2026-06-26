#!/usr/bin/env bash
set -euo pipefail

required_env=(
  RESOURCE_GROUP
  LOCATION
  CONTAINERAPPS_ENVIRONMENT
  CONTAINER_APP_NAME
  LOG_ANALYTICS_WORKSPACE
  KEY_VAULT_NAME
  IMAGE
  KAIF_REDIS_URL
  KAIF_ISSUER
  KAIF_ALLOWED_AUDIENCES
  KAIF_SPIRE_BUNDLE_ENDPOINT
  KAIF_SPIRE_TRUST_DOMAIN
  KAIF_IDP_JWKS_URL
  KAIF_IDP_ISSUER
)

for name in "${required_env[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "MISSING_ENV=${name}"
    exit 1
  fi
done

if ! command -v az >/dev/null 2>&1; then
  echo "MISSING_DEPENDENCY=az"
  exit 1
fi

echo "Deploying KAIF managed-identity Container App"
echo "RESOURCE_GROUP=${RESOURCE_GROUP}"
echo "LOCATION=${LOCATION}"
echo "CONTAINER_APP_NAME=${CONTAINER_APP_NAME}"
echo "KEY_VAULT_NAME=${KEY_VAULT_NAME}"
echo "IMAGE=${IMAGE}"

az provider register --namespace Microsoft.App --wait >/dev/null
az provider register --namespace Microsoft.OperationalInsights --wait >/dev/null

az group create --name "${RESOURCE_GROUP}" --location "${LOCATION}" --output none

if ! az monitor log-analytics workspace show --resource-group "${RESOURCE_GROUP}" --workspace-name "${LOG_ANALYTICS_WORKSPACE}" >/dev/null 2>&1; then
  az monitor log-analytics workspace create \
    --resource-group "${RESOURCE_GROUP}" \
    --workspace-name "${LOG_ANALYTICS_WORKSPACE}" \
    --location "${LOCATION}" \
    --output none
fi

workspace_id="$(az monitor log-analytics workspace show \
  --resource-group "${RESOURCE_GROUP}" \
  --workspace-name "${LOG_ANALYTICS_WORKSPACE}" \
  --query customerId -o tsv)"

workspace_key="$(az monitor log-analytics workspace get-shared-keys \
  --resource-group "${RESOURCE_GROUP}" \
  --workspace-name "${LOG_ANALYTICS_WORKSPACE}" \
  --query primarySharedKey -o tsv)"

if ! az containerapp env show --name "${CONTAINERAPPS_ENVIRONMENT}" --resource-group "${RESOURCE_GROUP}" >/dev/null 2>&1; then
  az containerapp env create \
    --name "${CONTAINERAPPS_ENVIRONMENT}" \
    --resource-group "${RESOURCE_GROUP}" \
    --location "${LOCATION}" \
    --logs-workspace-id "${workspace_id}" \
    --logs-workspace-key "${workspace_key}" \
    --output none
fi

bootstrap_image="${BOOTSTRAP_IMAGE:-mcr.microsoft.com/k8se/quickstart:latest}"
registry_server=""
if [[ "${IMAGE}" == *"/"* ]]; then
  registry_server="${IMAGE%%/*}"
fi

containerapp_args=(
  containerapp create
  --name "${CONTAINER_APP_NAME}"
  --resource-group "${RESOURCE_GROUP}"
  --environment "${CONTAINERAPPS_ENVIRONMENT}"
  --image "${bootstrap_image}"
  --target-port 8080
  --ingress external
  --system-assigned
  --env-vars
  NODE_ENV=production
  KAIF_DEV_MODE=false
  KAIF_HOST=0.0.0.0
  KAIF_PORT=8080
  "KAIF_REDIS_URL=${KAIF_REDIS_URL}"
  "KAIF_ISSUER=${KAIF_ISSUER}"
  "KAIF_ALLOWED_AUDIENCES=${KAIF_ALLOWED_AUDIENCES}"
  "KAIF_SPIRE_BUNDLE_ENDPOINT=${KAIF_SPIRE_BUNDLE_ENDPOINT}"
  "KAIF_SPIRE_TRUST_DOMAIN=${KAIF_SPIRE_TRUST_DOMAIN}"
  "KAIF_IDP_JWKS_URL=${KAIF_IDP_JWKS_URL}"
  "KAIF_IDP_ISSUER=${KAIF_IDP_ISSUER}"
  "KAIF_AGENTS_CONFIG_PATH=/app/config/agents.yaml"
  "KAIF_AZURE_KEY_VAULT_URL=https://${KEY_VAULT_NAME}.vault.azure.net/"
  "KAIF_AZURE_PRIVATE_KEY_SECRET_NAME=${KAIF_AZURE_PRIVATE_KEY_SECRET_NAME:-kaif-signing-key}"
  "KAIF_AZURE_PRIVATE_KEY_SECRET_VERSION=${KAIF_AZURE_PRIVATE_KEY_SECRET_VERSION:-}"
  "KAIF_AZURE_RETAINED_KEY_SECRETS=${KAIF_AZURE_RETAINED_KEY_SECRETS:-}"
)

if [[ -n "${KAIF_SPIRE_BUNDLE_CA_PEM:-}" ]]; then
  containerapp_args+=(--secrets "spire-bundle-ca-pem=${KAIF_SPIRE_BUNDLE_CA_PEM}")
  containerapp_args+=(--env-vars "KAIF_SPIRE_BUNDLE_CA_PEM=secretref:spire-bundle-ca-pem")
fi

az "${containerapp_args[@]}" \
  --query "{id:id,identity:identity,latestRevisionName:properties.latestRevisionName,fqdn:properties.configuration.ingress.fqdn}" \
  --output json

principal_id="$(az containerapp show \
  --name "${CONTAINER_APP_NAME}" \
  --resource-group "${RESOURCE_GROUP}" \
  --query identity.principalId -o tsv)"

key_vault_scope="$(az keyvault show --name "${KEY_VAULT_NAME}" --query id -o tsv)"

az role assignment create \
  --assignee-object-id "${principal_id}" \
  --assignee-principal-type ServicePrincipal \
  --role "Key Vault Secrets User" \
  --scope "${key_vault_scope}" \
  --output none || true

if [[ -n "${registry_server}" && "${registry_server}" == *.azurecr.io ]]; then
  registry_name="${registry_server%%.azurecr.io}"
  registry_scope="$(az acr show --name "${registry_name}" --query id -o tsv)"

  az role assignment create \
    --assignee-object-id "${principal_id}" \
    --assignee-principal-type ServicePrincipal \
    --role AcrPull \
    --scope "${registry_scope}" \
    --output none || true

  az containerapp registry set \
    --name "${CONTAINER_APP_NAME}" \
    --resource-group "${RESOURCE_GROUP}" \
    --server "${registry_server}" \
    --identity system \
    --output none

  az containerapp update \
    --name "${CONTAINER_APP_NAME}" \
    --resource-group "${RESOURCE_GROUP}" \
    --image "${IMAGE}" \
    --output none
fi

echo "MANAGED_IDENTITY_PRINCIPAL_ID=${principal_id}"
echo "KEY_VAULT_SCOPE=${key_vault_scope}"
if [[ -n "${registry_server}" && "${registry_server}" == *.azurecr.io ]]; then
  echo "REGISTRY_SERVER=${registry_server}"
fi
echo "NEXT=validate https://$(az containerapp show --name "${CONTAINER_APP_NAME}" --resource-group "${RESOURCE_GROUP}" --query properties.configuration.ingress.fqdn -o tsv)/health"
