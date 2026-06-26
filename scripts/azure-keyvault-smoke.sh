#!/usr/bin/env bash
set -euo pipefail

SERVER_URL="${KAIF_SERVER_URL:-http://127.0.0.1:8080}"

required_env=(
  KAIF_AZURE_KEY_VAULT_URL
  KAIF_AZURE_PRIVATE_KEY_SECRET_NAME
)

echo "KAIF Azure Key Vault smoke"
echo "SERVER_URL=${SERVER_URL}"

for name in "${required_env[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "MISSING_ENV=${name}"
    exit 1
  fi
done

echo "AZURE_KEY_VAULT_URL=${KAIF_AZURE_KEY_VAULT_URL}"
echo "AZURE_PRIVATE_KEY_SECRET_NAME=${KAIF_AZURE_PRIVATE_KEY_SECRET_NAME}"
echo "AZURE_PRIVATE_KEY_SECRET_VERSION=${KAIF_AZURE_PRIVATE_KEY_SECRET_VERSION:-latest}"
echo "AZURE_RETAINED_KEY_SECRETS=${KAIF_AZURE_RETAINED_KEY_SECRETS:-<none>}"
if [[ -n "${AZURE_CLIENT_ID:-}" ]]; then
  echo "AZURE_AUTH_MODE=service-principal"
  echo "AZURE_TENANT_ID=${AZURE_TENANT_ID:-<missing>}"
  echo "AZURE_CLIENT_ID=${AZURE_CLIENT_ID}"
else
  echo "AZURE_AUTH_MODE=host-default-credential"
fi

health_code="$(curl -s -o /tmp/kaif_azure_health.json -w "%{http_code}" "${SERVER_URL}/health" || true)"
echo "HEALTH_CODE=${health_code}"
if [[ "${health_code}" != "200" ]]; then
  echo "HEALTH_BODY=$(cat /tmp/kaif_azure_health.json 2>/dev/null || true)"
  exit 1
fi

jwks_code="$(curl -s -o /tmp/kaif_azure_jwks.json -w "%{http_code}" "${SERVER_URL}/.well-known/jwks.json" || true)"
echo "JWKS_CODE=${jwks_code}"
if [[ "${jwks_code}" != "200" ]]; then
  echo "JWKS_BODY=$(cat /tmp/kaif_azure_jwks.json 2>/dev/null || true)"
  exit 1
fi

if command -v jq >/dev/null 2>&1; then
  key_count="$(jq '.keys | length' /tmp/kaif_azure_jwks.json)"
  first_kid="$(jq -r '.keys[0].kid // empty' /tmp/kaif_azure_jwks.json)"
  echo "JWKS_KEYS=${key_count}"
  echo "JWKS_FIRST_KID=${first_kid}"
else
  echo "JWKS_BODY=$(cat /tmp/kaif_azure_jwks.json)"
fi

if command -v az >/dev/null 2>&1; then
  echo "AZ_CLI=present"
  az account show >/tmp/kaif_azure_account.json 2>/dev/null || {
    echo "AZ_ACCOUNT=not-signed-in"
    if [[ -z "${AZURE_CLIENT_ID:-}" ]]; then
      exit 1
    fi
    echo "AZ_ACCOUNT=service-principal-mode"
    echo "RESULT=PASS"
    exit 0
  }
  echo "AZ_ACCOUNT=$(jq -r '.user.name // .name // \"unknown\"' /tmp/kaif_azure_account.json 2>/dev/null || echo signed-in)"
else
  echo "AZ_CLI=missing"
fi

echo "RESULT=PASS"
