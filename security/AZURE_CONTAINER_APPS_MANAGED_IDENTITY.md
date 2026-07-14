# KAIF Azure Container Apps Managed Identity

Status: deployment shape for Azure-hosted KAIF with managed identity  
Date: 2026-06-03

This is the next Azure step after the local service-principal rehearsal. It removes static app credentials from KAIF and moves Key Vault access to a system-assigned managed identity on Azure Container Apps.

## Why this path

- KAIF server is already containerized.
- Azure Container Apps supports system-assigned managed identity.
- Azure Key Vault integration is already proven in KAIF code.
- `KAIF_SPIRE_BUNDLE_CA_PEM` closes the last platform gap where SPIRE trust previously depended on a mounted CA file.

## Current scope

This deployment shape covers the KAIF server. It does not solve full SPIRE workload deployment for arbitrary agents. The server only needs:
- Redis
- SPIRE bundle endpoint reachability
- Key Vault access for signing key retrieval

## Required inputs

Environment variables for the deployment script:

```env
RESOURCE_GROUP=KAIF_RESOURCE
LOCATION=westeurope
CONTAINERAPPS_ENVIRONMENT=kaif-aca-env
CONTAINER_APP_NAME=kaif-server-mi
LOG_ANALYTICS_WORKSPACE=kaif-logs
KEY_VAULT_NAME=kaif-kv-example
IMAGE=<registry>/<repo>:<tag>
KAIF_REDIS_URL=rediss://<dedicated-redis-endpoint>:6380
KAIF_ISSUER=https://kaif.kindredsystems.ai
KAIF_ALLOWED_AUDIENCES=https://kaif.kindredsystems.ai
KAIF_SPIRE_BUNDLE_ENDPOINT=https://spire-bundle.example.internal:8081/
KAIF_SPIRE_BUNDLE_CA_PEM=-----BEGIN CERTIFICATE-----...-----END CERTIFICATE-----
KAIF_SPIRE_TRUST_DOMAIN=kindred.systems
KAIF_IDP_JWKS_URL=https://login.microsoftonline.com/<tenant>/discovery/v2.0/keys
KAIF_IDP_ISSUER=https://login.microsoftonline.com/<tenant>/v2.0
KAIF_AZURE_PRIVATE_KEY_SECRET_NAME=kaif-signing-key
KAIF_AZURE_PRIVATE_KEY_SECRET_VERSION=
KAIF_AZURE_RETAINED_KEY_SECRETS=
```

Notes:
- `IMAGE` must already exist in a registry reachable by Azure Container Apps.
- `KAIF_REDIS_URL` should be a dedicated Azure Managed Redis TLS endpoint for real deployment.
- `KAIF_SPIRE_BUNDLE_CA_PEM` is optional if the SPIRE bundle endpoint chains to a public CA.

For ACR publishing in this repo, use a registry name like:

```text
exampleacr.azurecr.io
```

Publish with:

```bash
bash scripts/publish-acr-image.sh
```

Example published image reference:

```text
exampleacr.azurecr.io/kaif/server:20260603-054625
```

## Deployment script

Use:

```bash
bash scripts/deploy-aca-managed-identity.sh
```

The script:
1. registers required Azure providers
2. creates or reuses the resource group
3. creates or reuses Log Analytics
4. creates or reuses the Container Apps environment
5. deploys `kaif-server` with a system-assigned managed identity
6. configures KAIF to load its signing key from Key Vault
7. grants `Key Vault Secrets User` on the vault to the app identity
8. if `IMAGE` points at Azure Container Registry, grants `AcrPull`, configures registry identity, and switches the app from a public bootstrap image to the private KAIF image

## Validation

After deployment:

1. Retrieve the FQDN from the script output.
2. Check:

```bash
curl -fsS https://<fqdn>/health
curl -fsS https://<fqdn>/.well-known/jwks.json
```

Expected:
- `/health` returns `200`
- `jwks.json` returns at least one key
- the `kid` matches the same signing key lineage expected from Key Vault

## Bootstrap detail

The deployment script uses a public bootstrap image first, because a system-assigned managed identity does not exist until the Container App exists. Once Azure assigns the identity, the script:
- grants `AcrPull` on the target ACR
- configures `az containerapp registry set --identity system`
- updates the app to the private KAIF image

## Azure references used

This shape follows Microsoft Learn guidance that:
- Azure Container Apps can use system-assigned managed identity ([Managed identities in Azure Container Apps](https://learn.microsoft.com/en-us/azure/container-apps/managed-identity))
- Container Apps secrets can be referenced in environment variables and can use Key Vault references ([Manage secrets in Azure Container Apps](https://learn.microsoft.com/en-us/azure/container-apps/manage-secrets))

## Remaining gap after this step

After the managed-identity deployment shape exists, the next high-value step is deployment automation around image publishing and environment promotion:
- managed-identity image pull if using ACR
- release evidence capture for the deployed revision
