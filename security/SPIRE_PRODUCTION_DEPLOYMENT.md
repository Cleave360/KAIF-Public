# SPIRE Production Deployment

Status: supported production path for KAIF Workstream A  
Date: 2026-06-02

This document defines the production SPIRE posture for KAIF. It replaces the local-development assumptions in `docker-compose.yml`, `spire/agent.conf`, and `.env.example`.

For local production rehearsal in this repo, use:
- [.env.production.example](/Users/geofflundholm/Documents/KAIF/.env.production.example:1)
- [docker-compose.production.yml](/Users/geofflundholm/Documents/KAIF/docker-compose.production.yml:1)
- [scripts/export-spire-bootstrap-bundle.sh](/Users/geofflundholm/Documents/KAIF/scripts/export-spire-bootstrap-bundle.sh:1)

The checked-in Compose overlay is deterministic on purpose:
- it pins local rehearsal values such as `https://localhost:18080` and `https://spire-server:8081/`
- it keeps `KAIF_ALLOW_INSECURE_REDIS=true` only because the local Redis container is not TLS-enabled
- real deployment values should come from your deployment system, not from the rehearsal overlay

## Required production rules

1. `KAIF_SPIRE_BUNDLE_ENDPOINT` must use `https://`.
2. `KAIF_SPIRE_BUNDLE_TLS_INSECURE` must be unset or `false`.
3. If the SPIRE bundle endpoint is signed by a private CA, set `KAIF_SPIRE_BUNDLE_CA_PATH` to the trusted CA PEM on disk.
   `KAIF_SPIRE_BUNDLE_CA_PEM` is also supported when the deployment platform cannot mount the CA as a file cleanly.
4. SPIRE agents must not use `insecure_bootstrap = true`.
5. SPIRE agents must bootstrap with either:
   - `trust_bundle_path` plus a short-lived join token, or
   - an approved upstream authority/bootstrap mechanism.
6. KAIF SDK production agents currently support only the SPIRE-managed JWT-SVID file path (`svid_path`). Direct SPIRE Workload API integration is not implemented yet.

## Supported KAIF server configuration

```env
NODE_ENV=production
KAIF_SPIRE_BUNDLE_ENDPOINT=https://spire-server.example.internal:8081/
KAIF_SPIRE_BUNDLE_CA_PATH=/run/secrets/spire-bundle-ca.pem
KAIF_SPIRE_TRUST_DOMAIN=kindred.systems
```

Notes:
- If the SPIRE bundle endpoint chains to a publicly trusted CA, `KAIF_SPIRE_BUNDLE_CA_PATH` may be omitted.
- `KAIF_SPIRE_BUNDLE_CA_PEM` may be used instead of `KAIF_SPIRE_BUNDLE_CA_PATH`, but not together with it.
- Production startup already rejects `KAIF_SPIRE_BUNDLE_TLS_INSECURE=true`.
- The checked-in `.env.production.example` is for local production rehearsal with Compose. Real production should switch `KAIF_REDIS_URL` back to `rediss://...` and disable `KAIF_ALLOW_INSECURE_REDIS`.

## Supported SPIRE agent configuration

Use [spire/agent.production.conf](/Users/geofflundholm/Documents/KAIF/spire/agent.production.conf:1) as the baseline template.

Required differences from local development:
- remove `insecure_bootstrap = true`
- provide `trust_bundle_path`
- replace the rehearsal `server_address = "spire-server"` with the real SPIRE server address in non-Compose deployments
- inject a real bootstrap method at deploy time

## Production rehearsal in this repo

1. Prepare secrets and trust material:

```bash
mkdir -p deploy/secrets/spire/bootstrap deploy/secrets/kaif
./scripts/export-spire-bootstrap-bundle.sh
cp /path/to/kaif-signing-key.pem deploy/secrets/kaif/kaif-signing-key.pem
cp /path/to/spire-bundle-ca.pem deploy/secrets/kaif/spire-bundle-ca.pem
```

If you are using Azure Key Vault for KAIF signing material instead of local secret files, see [AZURE_KEY_VAULT_DEPLOYMENT.md](/Users/geofflundholm/Documents/KAIF/security/AZURE_KEY_VAULT_DEPLOYMENT.md:1). In that mode:
- keep SPIRE trust material on disk or from your platform trust store
- unset `KAIF_PRIVATE_KEY_PATH`
- set the `KAIF_AZURE_*` variables instead

2. Start the production-like overlay:

```bash
docker compose \
  --env-file .env.production.example \
  -f docker-compose.yml \
  -f docker-compose.production.yml \
  up -d --build
```

3. Verify the guardrails:
- `kaif-server` must refuse to start if `KAIF_SPIRE_BUNDLE_ENDPOINT` is not `https://`
- `kaif-server` must refuse to start if `KAIF_SPIRE_BUNDLE_TLS_INSECURE=true`
- `spire-agent` must use `trust_bundle_path` from `spire/agent.production.conf`
- the checked-in rehearsal uses `KAIF_ALLOW_INSECURE_REDIS=true` only because local Compose Redis is not TLS-enabled

## Supported SDK SVID retrieval mode

Current supported production mode:
- SPIRE writes a JWT-SVID file to disk
- the agent passes that path as `svid_path`
- the SDK re-reads the file on every token exchange to tolerate SPIRE rotation

This is the only supported production SDK mode today. The repository does not yet support fetching JWT-SVIDs directly from the SPIRE Workload API socket.

Example:

```ts
const client = new KAIFClient({
  server_url: "https://kaif.example.internal",
  spiffe_id: "spiffe://kindred.systems/ns/adaptive-layer/agent/lyra",
  svid_path: "/run/spire/sockets/svid.jwt",
  delegation_token,
})
```

## Release gate for Workstream A

A deployment is not production-ready unless:
- no config uses `insecure_bootstrap = true`
- the bundle endpoint is `https://`
- private CA deployments provide `KAIF_SPIRE_BUNDLE_CA_PATH`
- the agent bootstrap path is documented for the target environment
- the deployed agent uses `svid_path` or the codebase gains a tested Workload API integration
