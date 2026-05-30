# KAIF Quick Start Guide

Get KAIF running locally in **5 minutes** with Docker Compose. This guide covers the minimal happy path.

**Status:** Reference Implementation v1.0  
**Time to completion:** ~5 min (once Docker is running)

---

## Prerequisites

Before you start, ensure you have:

- **Docker & Docker Compose** (`v24.0+`) — [Install](https://docs.docker.com/get-started/get-docker/)
- **Git** — For cloning the repo
- **Node.js 20 LTS** (optional, only for local dev outside Docker)
- **pnpm** (optional, only for local dev: `npm install -g pnpm`)

**Verify your setup:**
```bash
docker --version          # Docker 24+
docker compose version    # v2.x+
git --version
```

---

## Setup (2 minutes)

### 1. Clone the Repository

```bash
git clone https://github.com/Cleave360/KAIF.git
cd KAIF
```

### 2. Copy Environment Variables

```bash
cp .env.example .env
```

Review `.env` — all values are pre-configured for local development:
```bash
# Server
KAIF_PORT=8080
KAIF_HOST=0.0.0.0
KAIF_ISSUER=https://auth.kindred.systems
KAIF_LOG_LEVEL=info
KAIF_DEV_MODE=true

# Redis
KAIF_REDIS_URL=redis://localhost:6380
KAIF_REDIS_HOST_PORT=6380

# SPIRE
KAIF_SPIRE_BUNDLE_ENDPOINT=https://spire-server:8081/
# Local dev only; production must use trusted TLS for this endpoint.
KAIF_SPIRE_BUNDLE_TLS_INSECURE=true
KAIF_SPIRE_TRUST_DOMAIN=kindred.systems

# IdP (mock — use real IdP in production)
KAIF_IDP_JWKS_URL=http://localhost:9999/fake-jwks
KAIF_IDP_ISSUER=https://fake-idp.example.com

# Config
KAIF_AGENTS_CONFIG_PATH=./packages/server/config/agents.yaml
KAIF_STRICT_REVOCATION=false
```

---

## Start the Stack (1 minute)

```bash
KAIF_DEV_MODE=true docker compose up -d --build
```

This brings up:
- **Redis** (7) — Audit log & token storage
- **SPIRE Server** (1.9.0) — Workload identity issuer
- **SPIRE Agent** (1.9.0) — Workload identity receiver
- **KAIF Server** (Fastify on port 8080)

`KAIF_DEV_MODE=true` is for local demos only. It lets `/provision` accept `dev-mock-token` instead of requiring a real OIDC provider.

**Verify health:**
```bash
# Wait ~10 sec for services to start, then:
docker compose ps

# Check KAIF is responding:
curl -s http://localhost:8080/health | jq .
```

Expected output:
```json
{
  "status": "ok",
  "redis": "connected",
  "spire": "reachable",
  "uptime": 5,
  "version": "0.1.0"
}
```

---

## Your First Token Exchange (2 minutes)

Run the end-to-end demo against the running stack:

```bash
./scripts/demo.sh
```

You'll see a provisioned delegation token, a successful RFC 8693 exchange, and decoded KAIF JWT claims:
```
Delegation ID: ...
Delegation token: eyJ...
Decoded KAIF JWT:
{
  "sub": "dev@local",
  "actor": { "sub": "spiffe://kindred.systems/ns/examples/agent/mock" },
  "kaif": { "delegation_depth": 0, ... }
}
```

### Manual Token Exchange

If you want to test the API directly, use the SPIRE agent CLI to fetch a JWT-SVID and use the signed `delegation_token` returned by `/provision`.

**Step 1: Get an SVID from SPIRE**
```bash
SVID=$(docker compose exec spire-agent \
  /opt/spire/bin/spire-agent api fetch jwt \
  -spiffeID "spiffe://kindred.systems/ns/examples/agent/mock" \
  -audience "http://localhost:8080" \
  -socketPath /run/spire/sockets/agent.sock \
  2>/dev/null | grep -v "^Received" | tr -d '[:space:]')
echo "SVID extracted: $SVID"
```

**Step 2: Provision a delegation grant**
```bash
curl -X POST http://localhost:8080/provision \
  -H "Content-Type: application/json" \
  -d '{
    "id_token": "dev-mock-token",
    "agent_id": "mock-agent",
    "scope": "invoke:completion",
    "ttl_seconds": 300
  }' | jq .
```

Response (sample):
```json
{
  "delegation_id": "550e8400-e29b-41d4-a716-446655440000",
  "delegation_token": "eyJhbGciOiJSUzI1NiIsImtpZCI6...",
  "expires_at": 1716252000
}
```

**Step 3: Exchange for KAIF JWT**
```bash
# Copy delegation_token from the /provision response
DELEGATION_TOKEN="eyJhbGciOiJSUzI1NiIsImtpZCI6..."

curl -X POST http://localhost:8080/oauth/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "grant_type=urn:ietf:params:oauth:grant-type:token-exchange" \
  --data-urlencode "subject_token=$DELEGATION_TOKEN" \
  --data-urlencode "subject_token_type=urn:ietf:params:oauth:token-type:access_token" \
  --data-urlencode "actor_token=$SVID" \
  --data-urlencode "actor_token_type=urn:ietf:params:oauth:token-type:jwt" \
  --data-urlencode "scope=invoke:completion" | jq .
```

Response (sample):
```json
{
  "access_token": "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...",
  "issued_token_type": "urn:ietf:params:oauth:token-type:access_token",
  "token_type": "Bearer",
  "expires_in": 600,
  "scope": "invoke:completion"
}
```

**Step 4: Decode the token** (for inspection):
```bash
TOKEN="eyJhbGciOiJSUzI1NiIs..."  # from above

# Decode (no verification — just for testing):
echo $TOKEN | cut -d. -f2 | base64 -d | jq .
```

---

## Inspect the System

### View Audit Log

```bash
# Inspect the Redis-backed global audit chain
docker compose exec redis redis-cli LRANGE kaif:audit:global 0 -1
```

### View JWKS (Public Keys)

```bash
curl -s http://localhost:8080/.well-known/jwks.json | jq .
```

### Check Redis Data

```bash
docker compose exec redis redis-cli

# Inside redis-cli:
keys kaif:*           # List all KAIF keys
get kaif:audit:global # View audit log
get kaif:trust:*      # View trust scores
exit
```

### View Server Logs

```bash
docker compose logs -f kaif-server
```

---

## Common Commands

| Task | Command |
|------|---------|
| Start server stack | `KAIF_DEV_MODE=true docker compose up -d --build` |
| Run local token demo | `./scripts/demo.sh` |
| Stop services | `docker compose down` |
| View logs (live) | `docker compose logs -f kaif-server` |
| Restart KAIF | `docker compose restart kaif-server` |
| View all services | `docker compose ps` |
| Clean up everything | `docker compose down -v` |
| Shell into KAIF container | `docker compose exec kaif-server sh` |
| Shell into Redis | `docker compose exec redis redis-cli` |
| Run optional mock-agent profile | `DELEGATION_TOKEN=<token> docker compose --profile demo-agent up mock-agent` |

---

## Next Steps

### For Integrators

1. **Read** [CODEBASE_TOUR.md](CODEBASE_TOUR.md) — Understand the structure
2. **Review** [wiki.md](wiki.md) — Naming conventions & API reference
3. **Study** `examples/mock-agent/` — See how agents use KAIF SDK
4. **Integrate** [KAIFClient](packages/sdk/src/client.ts) into your agent

### For Developers

1. **Stop Docker:** `docker compose down`
2. **Install dependencies:** `pnpm install`
3. **Read** [CONTRIBUTING.md](CONTRIBUTING.md)
4. **Review** [CLAUDE.md](CLAUDE.md) — Implementation phases
5. **Start coding:** `pnpm test` to run tests

### For Operators

1. **Read** [SECURITY.md](SECURITY.md) — Vulnerability policy & SLO
2. **Review** `docker-compose.yml` — Infrastructure as code
3. **Plan** KAIF deployment on Kubernetes (roadmap v1.1)
4. **Set up** Azure Key Vault for private key storage (production)

### For Architects

1. **Study** [SPEC.md](SPEC.md) — Protocol specification
2. **Review** [wiki.md](wiki.md) — Trust model & audit chain
3. **Design** delegation policy for your agents
4. **Plan** trust score computation strategy

---

## Troubleshooting

**KAIF not responding?**
```bash
# Check health
curl http://localhost:8080/health

# View logs
docker compose logs kaif-server | tail -20

# Restart
docker compose restart kaif-server
```

**Redis connection error?**
```bash
# Verify Redis is running
docker compose ps redis

# Test connection
docker exec redis redis-cli ping  # Should return PONG

# If not: docker compose restart redis
```

**SPIRE server not reachable?**
```bash
# Check SPIRE health
docker compose logs spire-server | tail -10

# Verify agent can reach server
docker exec spire-agent spire-agent healthcheck
```

**For more issues**, see [TROUBLESHOOTING.md](TROUBLESHOOTING.md)

---

## Project Layout

```
kaif/
├── index.md                    ← Master navigation (START HERE after quickstart)
├── wiki.md                     ← Naming conventions & reference
├── CODEBASE_TOUR.md           ← Detailed code walkthrough
├── TROUBLESHOOTING.md         ← Common issues & fixes
├── SPEC.md                     ← Protocol specification
├── SECURITY.md                ← Vulnerabilities & SLO
├── CONTRIBUTING.md            ← Developer guide
├── CLAUDE.md                   ← Implementation spec
│
├── docker-compose.yml          ← Full stack
├── .env.example               ← Environment template
├── packages/server/           ← KAIF server (Fastify)
├── packages/sdk/              ← KAIF SDK (what agents import)
├── examples/mock-agent/       ← Example: How to use KAIF
├── spire/                     ← SPIRE config files
└── scripts/                   ← Utility scripts
```

---

## Key Concepts (TL;DR)

| Concept | Explanation |
|---------|-------------|
| **KAIF** | Composable protocol stack for agent identity & authority |
| **SPIFFE** | Workload identity standard; KAIF builds on SPIFFE/SPIRE |
| **SVID** | JWT certificate issued by SPIRE (proof of agent identity) |
| **Trust Tier** | Classification: PROVISIONAL, STANDARD, VERIFIED, TRUSTED |
| **Delegation** | Human grants scope to agent; agent exchanges for KAIF JWT |
| **Audit Chain** | SHA-256 hash-linked log of all auth events (immutable) |
| **RFC 8693** | Token Exchange standard; KAIF implements this |

---

**Questions?** Check [TROUBLESHOOTING.md](TROUBLESHOOTING.md) or [index.md](index.md#-how-to-use-this-index)

**Ready to dive deeper?** Read [CODEBASE_TOUR.md](CODEBASE_TOUR.md)

---

**Last updated:** 2026-05-20  
**Status:** Ready for v1.0 Launch
