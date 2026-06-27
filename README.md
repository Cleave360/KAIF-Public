# KAIF — Kindred Agent Identity Framework

KAIF is an open protocol for authorising autonomous AI agents. It composes SPIFFE/SPIRE workload attestation with RFC 8693 token exchange to produce agent credentials that are short-lived, scoped, and cryptographically traceable to a human principal. Status: **v0.1.0-alpha** — reference implementation.

---

## The Problem

- No existing standard provides workload-attested agent identity + human-principal-traced delegation + adaptive revocation as a unified protocol.
- Service accounts authenticate with static secrets. KAIF agents authenticate with ephemeral SVIDs.
- OAuth tokens assert what a caller *claims* to be. KAIF tokens *prove* what a workload is, attested by SPIRE.
- Current auth systems treat trust as binary or internal-only. KAIF gates token authority on operator-assigned authorization tiers with precise revocation control.

---

## Quick Start

```bash
git clone https://github.com/kindred-systems/kaif
cd kaif
KAIF_DEV_MODE=true docker compose up -d --build
./scripts/demo.sh
```

Four commands. Working demo. Decoded JWT on screen.

> **Note:** `demo.sh` sets `KAIF_DEV_MODE=true` so no real OIDC IdP is required locally. Never enable `KAIF_DEV_MODE` in production — the server refuses to start if `NODE_ENV=production` and `KAIF_DEV_MODE=true`.

> ⚠️ The default SPIRE config uses `insecure_bootstrap = true`. This is safe for local development only. For production, use [security/SPIRE_PRODUCTION_DEPLOYMENT.md](security/SPIRE_PRODUCTION_DEPLOYMENT.md) and [spire/agent.production.conf](spire/agent.production.conf).

---

## How It Works

```
Human Principal (kindred@kindredsystems.ai)
          │
          │ POST /provision  (OIDC id_token)
          ▼
┌─────────────────────────────┐
│      KAIF Token Server      │  ← validates OIDC token
│  (RFC 8693 Token Exchange)  │  ← issues DelegationGrant
└──────────────┬──────────────┘
               │
               │ delegation_token passed out-of-band to agent
               │
               │ POST /oauth/token  (subject_token=grant, actor_token=SVID)
               ▼
┌─────────────────────────────┐        ┌─────────────────┐
│      KAIF Token Server      │◄───────│  SPIRE Agent    │
│  validates SVID + trust     │        │  (workload id)  │
│  score + scope + depth      │        └─────────────────┘
└──────────────┬──────────────┘
               │
               │ KAIF JWT (sub=human, actor.sub=SPIFFE ID, kaif.trust_score)
               ▼
┌─────────────────────────────┐
│    Downstream Service       │  ← verifies JWT via /.well-known/jwks.json
│    (vault, LLM API, etc.)   │  ← checks scope, trust_tier, delegation_depth
└─────────────────────────────┘
```

The KAIF JWT binds three things in one credential: the human principal who authorised the action (`sub`), the workload identity of the executing agent (`actor.sub`, SPIRE-attested), and a live trust score that governs token TTL and scope ceiling.

---

## Token Format

```typescript
{
  iss:  "https://auth.kindred.systems",   // KAIF server
  sub:  "kindred@kindredsystems.ai",          // human principal — always present
  aud:  "urn:kaif:target-service",
  iat:  1716220800,
  exp:  1716221700,                       // iat + tier TTL (300–900s)
  jti:  "550e8400-e29b-41d4-a716-...",    // UUID v4 — denylist key

  scope: "invoke:completion",

  actor: {
    sub:             "spiffe://kindred.systems/ns/adaptive-layer/agent/lyra",
    svid_thumbprint: "sha256:3a4b..."     // JWT-SVID signing JWK thumbprint
  },

  cnf: { jkt: "sha256:3a4b..." },         // confirmation binding for replay checks

  may_act: { sub: "spiffe://kindred.systems/..." },

  kaif: {
    authorization_tier_value: 0.82,   // 0.0–1.0, operator-assigned
    authorization_tier:        "VERIFIED",        // PROVISIONAL | STANDARD | VERIFIED | TRUSTED
    delegation_depth: 0,                 // 0 = direct human grant
    delegation_id:    "uuid-v4",
    rollback_window:  "PT15M",           // ISO 8601 duration
    principal_chain:  ["kindred@kindredsystems.ai"]
  }
}
```

`sub` is always the human who authorised the chain. `actor.sub` is the SPIRE-attested workload identity of the executing agent. `kaif.authorization_tier_value` (operator-assigned, not behavioral) determines token TTL and maximum scope. `kaif.delegation_depth` enforces sub-delegation limits.

---

## Verification (for relying parties)

Six-step sequence per KAIF Core Profile v1.0 §2.1:

1. Verify JWT signature against KAIF server JWKS (`/.well-known/jwks.json`)
2. Verify `iss` matches your configured KAIF server URL
3. Verify `exp` — reject expired tokens (10-second clock skew tolerance maximum)
4. Verify `jti` is not in the local denylist (or call `/introspect` in strict mode)
5. Verify `scope` contains the required permission
6. Verify `kaif.trust_tier` meets your service's minimum requirement

```typescript
import { createRemoteJWKSet, jwtVerify } from 'jose'

const JWKS = createRemoteJWKSet(
  new URL('https://your-kaif-server/.well-known/jwks.json')
)

const { payload } = await jwtVerify(token, JWKS, {
  issuer: 'https://your-kaif-server',
})
// payload.sub      → human principal
// payload.actor.sub → SPIFFE ID of executing agent
// payload.kaif.authorization_tier → PROVISIONAL | STANDARD | VERIFIED | TRUSTED (operator-assigned)
```

See `examples/mock-service/index.ts` for a complete relying-party implementation.

---

## Configuration

### Environment Variables

| Variable | Type | Default | Description |
|---|---|---|---|
| `KAIF_PORT` | number | `8080` | HTTP listen port |
| `KAIF_HOST` | string | `0.0.0.0` | HTTP listen host |
| `KAIF_ISSUER` | string | required | JWT `iss` claim, e.g. `https://kaif.kindredsystems.ai` |
| `KAIF_ALLOWED_AUDIENCES` | comma-separated strings | `KAIF_ISSUER` | Explicit token-exchange `audience` values KAIF may mint; start with `https://kaif.kindredsystems.ai` |
| `KAIF_REDIS_URL` | string | required | Redis connection URL |
| `KAIF_TENANT_ADDRESS` | string | `tenant-dev` in local examples | Tenant address used by Adaptive governance/agent handoff integrations |
| `KAIF_ALLOW_INSECURE_REDIS` | boolean | `false` | Allows non-TLS Redis when `NODE_ENV=production`; only for controlled production-like tests |
| `KAIF_GOVERNANCE_AUDIT_APPEND_URL` | string | — | Adaptive `POST /v1/audit/append` URL for auth-layer evidence |
| `KAIF_GOVERNANCE_WORKSPACE_ID` | string | `ws-kaif` | Adaptive envelope workspace ID |
| `KAIF_GOVERNANCE_PROJECT_ID` | string | `kaif` | Adaptive envelope project ID |
| `KAIF_GOVERNANCE_UI_INSTANCE_ID` | string | `ui-kaif` | Adaptive envelope UI instance ID |
| `KAIF_CLASS_C_DEGRADED_OPEN` | boolean | `false` | Allows Class C relying-party degraded-open behavior when governance evidence append is unavailable |
| `KAIF_SPIRE_BUNDLE_ENDPOINT` | string | required | SPIRE HTTPS federation bundle endpoint for SVID validation |
| `KAIF_SPIRE_BUNDLE_CA_PATH` | string | — | Optional CA bundle path for validating a private SPIRE HTTPS bundle endpoint |
| `KAIF_SPIRE_BUNDLE_CA_PEM` | string | — | Optional inline CA PEM for validating a private SPIRE HTTPS bundle endpoint without a mounted file |
| `KAIF_SPIRE_BUNDLE_TLS_INSECURE` | boolean | `false` | Local development only; rejected when `NODE_ENV=production` |
| `KAIF_SPIRE_TRUST_DOMAIN` | string | required | SPIFFE trust domain, e.g. `kindred.systems` |
| `KAIF_IDP_JWKS_URL` | string | required* | OIDC IdP JWKS URL for `/provision` id_token validation |
| `KAIF_IDP_ISSUER` | string | required* | OIDC IdP issuer claim |
| `KAIF_PRIVATE_KEY_PATH` | string | — | RSA private key PEM path; generates ephemeral key if unset |
| `KAIF_PRIVATE_KEY_PEM` | string | — | Inline RSA private key PEM for secret-store or env injection workflows |
| `KAIF_RETAINED_KEY_PATHS` | comma-separated strings | — | Optional retained PEM key paths published in JWKS for verification during key rotation |
| `KAIF_RETAINED_KEY_PEMS` | PEM blocks separated by `\n---\n` | — | Optional retained public-key PEM material published in JWKS without filesystem staging |
| `KAIF_AZURE_KEY_VAULT_URL` | string | — | Azure Key Vault URL when loading key material from Key Vault secrets |
| `KAIF_AZURE_PRIVATE_KEY_SECRET_NAME` | string | — | Azure Key Vault secret name containing the active RSA private key PEM |
| `KAIF_AZURE_PRIVATE_KEY_SECRET_VERSION` | string | — | Optional Azure Key Vault secret version for the active private key |
| `KAIF_AZURE_RETAINED_KEY_SECRETS` | comma-separated strings | — | Optional retained public-key secrets from Azure Key Vault, each as `name` or `name@version` |
| `KAIF_AGENTS_CONFIG_PATH` | string | required | Path to `agents.yaml` |
| `KAIF_LOG_LEVEL` | string | `info` | Pino log level |
| `KAIF_STRICT_REVOCATION` | boolean | `false` | If `true`, every token use calls `/introspect` |
| `KAIF_DEV_MODE` | boolean | `false` | Accept `dev-mock-token` at `/provision`. **Never use in production.** |

*Not required when `KAIF_DEV_MODE=true`.

For local isolation, run KAIF Redis on host port `6380` and keep Adaptive on `6379`:

```bash
KAIF_REDIS_URL=redis://localhost:6380
redis-cli -p 6380 PING
```

If `6380` is already occupied by another local stack, keep the Redis separation and choose another host port for KAIF:

```bash
KAIF_REDIS_HOST_PORT=6381 docker compose --env-file .env.example up -d redis
redis-cli -p 6381 PING
```

For production and serious staging, give KAIF its own Redis host or managed instance with TLS, ACLs, and dedicated credentials. Sharing a Redis server with the governance engine is acceptable for local development only; a separate Redis DB/index is not enough isolation for production-grade retention, restart, and security policy boundaries. Keep KAIF keys under `kaif:*`.

Adaptive governance integration is API-first: KAIF posts auth-layer evidence to Adaptive `POST /v1/audit/append` with `layer="auth"` and `envelope.tenant_id=KAIF_TENANT_ADDRESS`. KAIF must not directly mutate governance-engine Redis in production.

For production SPIRE deployment:
- `KAIF_SPIRE_BUNDLE_ENDPOINT` must use `https://`
- `KAIF_SPIRE_BUNDLE_TLS_INSECURE` must remain unset or `false`
- private CA deployments should set `KAIF_SPIRE_BUNDLE_CA_PATH`
- the current supported SDK production SVID mode is file-based `svid_path`, not direct Workload API integration

See [security/SPIRE_PRODUCTION_DEPLOYMENT.md](security/SPIRE_PRODUCTION_DEPLOYMENT.md).
For manual signing-key rotation, use [security/KEY_ROTATION_RUNBOOK.md](security/KEY_ROTATION_RUNBOOK.md).

For a production-like local rehearsal, use [.env.production.example](.env.production.example) with [docker-compose.production.yml](docker-compose.production.yml).

### Agent ACL (`agents.yaml`)

| Field | Type | Description |
|---|---|---|
| `spiffe_id` | string | SPIFFE workload ID — must match SVID exactly |
| `trust_tier_minimum` | `PROVISIONAL\|STANDARD\|VERIFIED\|TRUSTED` | Minimum trust score to receive a token |
| `permitted_scopes` | string[] | Allowed scopes; glob supported (`vault:read:*`) |
| `may_sub_delegate` | boolean | Whether agent can pass its token as subject_token |
| `max_delegation_depth` | number | Maximum depth of the delegation chain |
| `delegation_ttl_seconds` | number | Override TTL for grants to this agent |
| `human_principal_required` | boolean | If `true`, delegation chain must include a human `sub` |

---

## SDK Usage

```typescript
import { KAIFClient } from '@kaif/sdk'

const client = new KAIFClient({
  server_url:          'http://kaif-server:8080',
  spiffe_id:           'spiffe://kindred.systems/ns/adaptive-layer/agent/lyra',
  svid_path:           '/run/spire/sockets/svid.jwt',   // supported production mode today
  delegation_token:    delegationTokenJWT,               // from POST /provision
})

const token  = await client.getToken('invoke:completion', 'urn:kaif:my-service')
const header = await client.authHeader('invoke:completion', 'urn:kaif:my-service')
// → "Bearer eyJ..."

await client.revoke()   // revoke all cached tokens on shutdown
```

See [`packages/sdk/`](packages/sdk/) for the full API.

---

## Conformance

```bash
npx kaif-conformance \
  --server https://your-kaif-server \
  --svid-jwt /tmp/svid.jwt \
  --grant-token <delegation-grant-token> \
  --agent-id spiffe://your-domain/your/agent
```

See [`conformance/README.md`](conformance/README.md) for setup and fixture details.

---

## Standards

| Standard | Role in KAIF |
|---|---|
| [RFC 8693](https://www.rfc-editor.org/rfc/rfc8693) | Token exchange protocol — the core grant type |
| [RFC 9068](https://www.rfc-editor.org/rfc/rfc9068) | JWT Profile for OAuth 2.0 Access Tokens — claim structure |
| [RFC 8705](https://www.rfc-editor.org/rfc/rfc8705) | Mutual TLS certificate binding — `cnf/x5t#S256` |
| [RFC 7519](https://www.rfc-editor.org/rfc/rfc7519) | JSON Web Tokens |
| [RFC 7638](https://www.rfc-editor.org/rfc/rfc7638) | JSON Web Key Thumbprint — JWK thumbprint for actor binding |
| [SPIFFE SVID](https://github.com/spiffe/spiffe/blob/main/standards/SPIFFE-ID.md) | Workload identity attestation format |
| [SPIRE](https://spiffe.io/docs/latest/spire-about/) | SPIFFE Runtime Environment for SVID issuance |
| [NIST SP 800-207](https://csrc.nist.gov/publications/detail/sp/800-207/final) | Zero Trust Architecture — conceptual framework |

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).
Governance model: [GOVERNANCE.md](GOVERNANCE.md).
Adopter directory: [ADOPTERS.md](ADOPTERS.md).

---

## Licence

Apache 2.0. See [LICENSE](LICENSE).

KAIF is designed and maintained by Geoff, Kindred Systems OS.
