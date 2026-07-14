# How To Run KAIF

This file is the operator runbook for the current KAIF state on `2026-06-03`.

It covers:
- local dev
- production-like local compose rehearsal
- Azure Key Vault local container rehearsal
- ACR image publishing
- Azure Container Apps managed-identity deployment shape

## 1. Local dev

Use the repo’s default local stack:

```bash
cp .env.example .env
KAIF_DEV_MODE=true docker compose up -d --build
curl -fsS http://127.0.0.1:8080/health
```

Use this only for development. It keeps local shortcuts such as insecure SPIRE bundle TLS.

## 2. Production-like local compose rehearsal

This is the stricter local path with production guardrails enabled.

Prerequisites:
- `deploy/secrets/spire/bootstrap/bundle.pem`
- `deploy/secrets/kaif/spire-bundle-ca.pem`
- either:
  - `deploy/secrets/kaif/kaif-signing-key.pem`, or
  - Azure Key Vault key-source env vars

Start:

```bash
docker compose \
  --env-file .env.production.example \
  -f docker-compose.yml \
  -f docker-compose.production.yml \
  up -d --build
```

Check:

```bash
docker compose \
  --env-file .env.production.example \
  -f docker-compose.yml \
  -f docker-compose.production.yml \
  ps
```

## 3. Azure Key Vault local container rehearsal

This path is already proven in this workspace.

Current Azure objects:
- resource group: `KAIF_RESOURCE`
- key vault: `kaif-kv-example`
- ACR: `kaifacr-example.azurecr.io`

Current local env file:
- `.env.azure-sp.local` (gitignored)

Start KAIF with service-principal credentials:

```bash
docker compose \
  --env-file .env.production.example \
  --env-file .env.azure-sp.local \
  -f docker-compose.yml \
  -f docker-compose.production.yml \
  up -d --build kaif-server
```

Validate:

```bash
set -a
source .env.azure-sp.local
set +a
KAIF_SERVER_URL=http://127.0.0.1:18080 bash scripts/azure-keyvault-smoke.sh
```

Expected:
- `HEALTH_CODE=200`
- `JWKS_CODE=200`
- `JWKS_KEYS=1`
- `RESULT=PASS`

## 4. Publish the KAIF image to ACR

The current publish script uses:
- ACR name: `kaifacr-example`
- repository: `kaif/server`
- source image: `kaif-kaif-server:latest`

Publish:

```bash
bash scripts/publish-acr-image.sh
```

Current published image from this workspace:

```text
kaifacr-example.azurecr.io/kaif/server:20260603-054625
```

Verify:

```bash
az acr repository show-tags \
  --name kaifacr-example \
  --repository kaif/server \
  --output table
```

## 5. Azure Container Apps managed-identity deployment

This is scaffolded and ready to run once the real deployment inputs are set.

Set these first:

```bash
export RESOURCE_GROUP=KAIF_RESOURCE
export LOCATION=westeurope
export CONTAINERAPPS_ENVIRONMENT=kaif-aca-env
export CONTAINER_APP_NAME=kaif-server-mi
export LOG_ANALYTICS_WORKSPACE=kaif-logs
export KEY_VAULT_NAME=kaif-kv-example
export IMAGE=kaifacr-example.azurecr.io/kaif/server:20260603-054625

export KAIF_REDIS_URL='rediss://<dedicated-redis-endpoint>:6380'
export KAIF_ISSUER='https://kaif.kindredsystems.ai'
export KAIF_ALLOWED_AUDIENCES='https://kaif.kindredsystems.ai'
export KAIF_SPIRE_BUNDLE_ENDPOINT='https://<your-spire-bundle-endpoint>:8081/'
export KAIF_SPIRE_TRUST_DOMAIN='kindred.systems'
export KAIF_IDP_JWKS_URL='https://login.microsoftonline.com/<tenant>/discovery/v2.0/keys'
export KAIF_IDP_ISSUER='https://login.microsoftonline.com/<tenant>/v2.0'

# optional, only if the SPIRE bundle endpoint uses a private CA
export KAIF_SPIRE_BUNDLE_CA_PEM='-----BEGIN CERTIFICATE-----
...
-----END CERTIFICATE-----'
```

Deploy:

```bash
bash scripts/deploy-aca-managed-identity.sh
```

What the script does:
1. creates or reuses the Container Apps environment
2. creates the app with a public bootstrap image
3. assigns a system-managed identity
4. grants `Key Vault Secrets User` on the vault
5. if `IMAGE` is in ACR, grants `AcrPull`
6. configures the registry to use system identity
7. updates the app to the private KAIF image

Validate:

```bash
curl -fsS https://<fqdn>/health
curl -fsS https://<fqdn>/.well-known/jwks.json
```

## 6. The four values you still need to provide

For the real Azure-hosted deployment, the unresolved values are:

1. `KAIF_REDIS_URL`
2. `KAIF_ISSUER`
3. `KAIF_ALLOWED_AUDIENCES`
4. `KAIF_SPIRE_BUNDLE_ENDPOINT`

Optional fifth value if your SPIRE endpoint is private-CA signed:

5. `KAIF_SPIRE_BUNDLE_CA_PEM`

How to think about them:

### `KAIF_REDIS_URL`

This is the real production Azure Managed Redis endpoint KAIF will use in Azure.

Format:

```text
rediss://<host>:6380
```

Example:

```text
rediss://kaif-redis.westeurope.redis.azure.net:6380
```

This should be:
- dedicated to KAIF
- TLS-enabled
- not the local `redis://redis:6379`

### `KAIF_ISSUER`

This is the public base URL that KAIF will claim in the `iss` field of issued JWTs.

Format:

```text
https://<public-kaif-hostname>
```

Example:

```text
https://kaif.kindredsystems.ai
```

Use the real hostname clients will call, not an internal Azure URL unless that is your intended issuer.

### `KAIF_ALLOWED_AUDIENCES`

This is the allowed audience list for tokens KAIF issues or accepts in exchange paths.

If you only want one audience at first, set it equal to the issuer:

```text
https://kaif.kindredsystems.ai
```

If you need more than one, use comma-separated values:

```text
https://kaif.kindredsystems.ai,https://api.kindredsystems.ai
```

### `KAIF_SPIRE_BUNDLE_ENDPOINT`

This is the HTTPS endpoint where KAIF fetches the SPIRE federation/JWKS bundle.

Format:

```text
https://<spire-bundle-host>:8081/
```

Example:

```text
https://spire.kindred.internal:8081/
```

This must be reachable from Azure Container Apps.

### `KAIF_SPIRE_BUNDLE_CA_PEM`

Only needed if the SPIRE bundle endpoint is signed by a private CA that Azure’s default trust store will not trust.

This should be the PEM text of the CA certificate, not the server certificate.

If the SPIRE endpoint uses a publicly trusted CA, leave this unset.

## 7. Current status

Already proven:
- Azure Key Vault host process path
- Azure Key Vault local container service-principal path
- ACR publish path
- managed-identity Container Apps deployment script shape

Not yet proven:
- live Azure Container Apps managed-identity deployment with your real Redis, issuer, audience, and SPIRE endpoint values
