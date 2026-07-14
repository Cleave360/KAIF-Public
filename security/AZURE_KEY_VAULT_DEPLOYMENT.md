# KAIF Azure Key Vault Deployment

Status: operator setup for Azure-backed signing-key loading  
Date: 2026-06-02

This document covers the first supported Azure production path for KAIF signing keys:
- Key Vault stores the active RSA private key PEM as a secret
- Key Vault stores retained public-key PEMs as secrets
- KAIF loads those secrets at startup using `DefaultAzureCredential`

This is secret-backed loading, not remote HSM signing. The private key still enters KAIF process memory after retrieval.

## What you need from Azure

1. An Azure subscription and tenant
2. A Key Vault
3. A workload identity that can read Key Vault secrets:
- local development: Azure CLI login is acceptable
- local container rehearsal: service principal env credentials are acceptable
- hosted deployment: managed identity is preferred
4. Secrets in Key Vault:
- active private key PEM
- zero or more retained public-key PEMs

## Required environment variables

```env
KAIF_AZURE_KEY_VAULT_URL=https://<vault-name>.vault.azure.net
KAIF_AZURE_PRIVATE_KEY_SECRET_NAME=kaif-signing-key
KAIF_AZURE_PRIVATE_KEY_SECRET_VERSION=
KAIF_AZURE_RETAINED_KEY_SECRETS=kaif-signing-key-v1-public,kaif-signing-key-v2-public@<version>
```

Notes:
- `KAIF_AZURE_PRIVATE_KEY_SECRET_VERSION` is optional. Leave it unset to use the latest version.
- `KAIF_AZURE_RETAINED_KEY_SECRETS` is optional.
- Do not set `KAIF_PRIVATE_KEY_PATH` or `KAIF_PRIVATE_KEY_PEM` at the same time.

For local container rehearsal with a service principal, also set:

```env
AZURE_TENANT_ID=<tenant-id>
AZURE_CLIENT_ID=<client-id>
AZURE_CLIENT_SECRET=<client-secret>
```

## Secret content format

- active key secret value: full RSA private key PEM
- retained key secret value: full RSA public key PEM

Example active secret value:

```pem
-----BEGIN PRIVATE KEY-----
...
-----END PRIVATE KEY-----
```

Example retained public secret value:

```pem
-----BEGIN PUBLIC KEY-----
...
-----END PUBLIC KEY-----
```

## Local operator flow

You will need to sign into the Microsoft business account at this point.

1. Install Azure CLI if it is not already present.
2. Sign in:

```bash
az login
```

3. Select the correct subscription:

```bash
az account set --subscription "<subscription-name-or-id>"
```

4. Create or reuse a Key Vault.
5. Upload the secrets.
6. Export the KAIF Azure env vars.
7. Start KAIF with the production overlay.
8. Run the smoke check.

## Local container rehearsal with a service principal

This is the supported way to make `docker compose` authenticate to Key Vault on a developer machine. Your host `az login` is not automatically visible inside the KAIF container.

1. Create an app registration / service principal.
2. Grant it `Key Vault Secrets User` on the KAIF vault.
3. Store the client credentials in a gitignored local env file such as `.env.azure-sp.local`.
4. Start the production overlay with both env files.

Example local env file:

```env
KAIF_AZURE_KEY_VAULT_URL=https://kaif-kv-example.vault.azure.net/
KAIF_AZURE_PRIVATE_KEY_SECRET_NAME=kaif-signing-key
AZURE_TENANT_ID=<tenant-id>
AZURE_CLIENT_ID=<client-id>
AZURE_CLIENT_SECRET=<client-secret>
```

## Upload examples

Create the active private-key secret:

```bash
az keyvault secret set \
  --vault-name <vault-name> \
  --name kaif-signing-key \
  --file deploy/secrets/kaif/kaif-signing-key.pem
```

Create a retained public-key secret:

```bash
az keyvault secret set \
  --vault-name <vault-name> \
  --name kaif-signing-key-v1-public \
  --file /path/to/kaif-signing-key-v1-public.pem
```

## Compose startup example

```bash
export KAIF_AZURE_KEY_VAULT_URL=https://<vault-name>.vault.azure.net
export KAIF_AZURE_PRIVATE_KEY_SECRET_NAME=kaif-signing-key
export KAIF_AZURE_RETAINED_KEY_SECRETS=kaif-signing-key-v1-public
export KAIF_SPIRE_BUNDLE_CA_PATH=/run/secrets/spire-bundle-ca.pem

docker compose \
  --env-file .env.production.example \
  -f docker-compose.yml \
  -f docker-compose.production.yml \
  up -d --build
```

For local container rehearsal with a service principal:

```bash
docker compose \
  --env-file .env.production.example \
  --env-file .env.azure-sp.local \
  -f docker-compose.yml \
  -f docker-compose.production.yml \
  up -d --build
```

## Smoke validation

Run:

```bash
bash scripts/azure-keyvault-smoke.sh
```

Expected:
- `/health` returns `200`
- `/.well-known/jwks.json` returns `200`
- JWKS contains at least one key
- if running in host-login mode, Azure CLI is installed and signed in
- if running in service-principal mode, `AZURE_CLIENT_ID` is set and the server still returns healthy/JWKS responses

## Release gate for the Azure path

Do not call this production-ready unless:
- Key Vault access is least-privilege and read-only for KAIF
- local file key paths are not set alongside Azure envs
- retained public keys are published for the full old-token TTL window
- the deployment identity is managed identity or equivalent, not a static secret
- startup and smoke validation are part of deployment evidence
