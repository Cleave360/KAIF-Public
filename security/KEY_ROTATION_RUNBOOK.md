# KAIF Key Rotation Runbook

Status: operator runbook for manual JWKS rotation  
Date: 2026-06-02

This runbook covers the current supported KAIF signing-key rotation model:
- one active signing key from `KAIF_PRIVATE_KEY_PATH`
- zero or more retained verification keys from `KAIF_RETAINED_KEY_PATHS`

Equivalent secret-injection forms are also supported:
- active key: `KAIF_PRIVATE_KEY_PEM`
- retained keys: `KAIF_RETAINED_KEY_PEMS`

Azure Key Vault secret loading is also supported:
- active key: `KAIF_AZURE_KEY_VAULT_URL` + `KAIF_AZURE_PRIVATE_KEY_SECRET_NAME`
- optional active key pinning: `KAIF_AZURE_PRIVATE_KEY_SECRET_VERSION`
- retained keys: `KAIF_AZURE_RETAINED_KEY_SECRETS` as `name` or `name@version`

## Preconditions

1. The new RSA private key PEM has been generated and stored securely.
2. The current active key's public key PEM has been exported for retention.
3. Token TTL policy is known. Retained keys must stay published until all tokens signed by the old key expire.

## Rotation procedure

1. Export the current active public key to a retained PEM file.

2. Stage the new files on every KAIF server:
- `KAIF_PRIVATE_KEY_PATH` -> new private key PEM
- `KAIF_RETAINED_KEY_PATHS` -> comma-separated list including the previous public key PEM

Or stage them through secret injection:
- `KAIF_PRIVATE_KEY_PEM` -> new private key PEM content
- `KAIF_RETAINED_KEY_PEMS` -> retained public PEM blocks separated by `\n---\n`

Or stage them through Azure Key Vault secrets:
- `KAIF_AZURE_KEY_VAULT_URL` -> vault base URL
- `KAIF_AZURE_PRIVATE_KEY_SECRET_NAME` -> active private key secret name
- `KAIF_AZURE_PRIVATE_KEY_SECRET_VERSION` -> optional pinned version for the active private key
- `KAIF_AZURE_RETAINED_KEY_SECRETS` -> retained public-key secrets as `name` or `name@version`

3. Restart KAIF instances one at a time.

4. Validate the rotation:
- `GET /.well-known/jwks.json` contains both the new key and the retained previous key
- a token signed before restart still verifies
- a token issued after restart verifies and carries the new `kid`

5. After the maximum lifetime of the old tokens has elapsed, remove the retained public key from `KAIF_RETAINED_KEY_PATHS` and restart again.

## Local rehearsal example

```bash
export KAIF_PRIVATE_KEY_PATH=/run/secrets/kaif-signing-key-v2.pem
export KAIF_RETAINED_KEY_PATHS=/run/secrets/kaif-signing-key-v1-public.pem
```

## Current limitations

- Rotation is manual; there is no automatic keyset loader or scheduler.
- Retained keys are verification-only. Private signing fallback is not supported.
- Direct HSM-backed remote signing is not implemented yet.
