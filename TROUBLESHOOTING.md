# KAIF Troubleshooting Guide

Common issues, diagnostics, and solutions for KAIF deployment and development.

**Audience:** Operators, developers, integrators  
**Last updated:** 2026-05-20

---

## Table of Contents

- [Startup & Connectivity](#startup--connectivity)
- [Token Exchange Failures](#token-exchange-failures)
- [Docker Compose Issues](#docker-compose-issues)
- [Redis Connectivity](#redis-connectivity)
- [SPIRE & Workload Identity](#spire--workload-identity)
- [JWT & Cryptography](#jwt--cryptography)
- [Authorization & ACL](#authorization--acl)
- [Performance & Resource](#performance--resource)
- [Audit & Compliance](#audit--compliance)
- [Support & Escalation](#support--escalation)

---

## Startup & Connectivity

### Problem: KAIF server won't start

**Symptoms:**
- `docker compose logs kaif-server` shows CrashLoopBackOff
- Port 8080 not listening
- Error: `listen EADDRINUSE :::8080`

**Diagnostics:**

```bash
# 1. Check service is running
docker compose ps kaif-server

# 2. View full logs
docker compose logs kaif-server --tail=50

# 3. Check if port is in use
lsof -i :8080  # macOS/Linux

# 4. Verify environment variables
docker compose config | grep -A 10 'kaif-server:'
```

**Solutions:**

| Error | Solution |
|-------|----------|
| `listen EADDRINUSE :::8080` | Port already in use; kill process or change `KAIF_PORT` |
| `Cannot connect to Redis` | Verify `KAIF_REDIS_URL` matches docker compose service name |
| `npm ERR! code ENOENT` | Run `pnpm install` before building image |
| `Failed to load config` | Check `.env` file exists and `KAIF_AGENTS_CONFIG_PATH` is accessible |

**Recovery:**

```bash
# Kill and restart
docker compose down
KAIF_DEV_MODE=true docker compose up -d --build

# Force rebuild
KAIF_DEV_MODE=true docker compose up -d --build

# Check health after 10 seconds
sleep 10 && curl http://localhost:8080/health | jq .
```

---

### Problem: `/health` endpoint shows degraded

**Symptoms:**
```json
{
  "status": "degraded",
  "redis": "disconnected",
  "spire": "unreachable"
}
```

**Diagnostics:**

```bash
# 1. Verify services are running
docker compose ps

# 2. Test Redis connectivity
docker exec kaif-server redis-cli -u $KAIF_REDIS_URL ping

# 3. Test SPIRE reachability
docker exec kaif-server wget --no-check-certificate -qO- https://spire-server:8081/ | head -20

# 4. Check network connectivity
docker exec kaif-server ping redis
docker exec kaif-server ping spire-server
```

**Solutions:**

| Component | Diagnostic | Solution |
|-----------|-----------|----------|
| Redis | `redis-cli: command not found` | Add redis-cli to container or use DNS check |
| Redis | Connection refused on 6379 | Ensure Redis service is running: `docker compose up redis` |
| SPIRE | 400/404 on `/bundles/jwt` | Use the SPIRE federation root endpoint: `https://spire-server:8081/` |
| SPIRE | Connection refused on 8081 | SPIRE server not running; check logs: `docker compose logs spire-server` |
| Network | `ping: command not found` | Use `nc -z redis 6379` instead |

---

## Token Exchange Failures

### Problem: `invalid_request` error on /oauth/token

**Symptoms:**
```json
{
  "error": "invalid_request",
  "error_description": "Missing or invalid grant_type"
}
```

**Cause:** Request body is malformed or missing required fields

**Diagnostics:**

```bash
# 1. Check request format
curl -v -X POST http://localhost:8080/oauth/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=urn:ietf:params:oauth:grant-type:token-exchange&..."

# 2. Verify form encoding (not JSON)
# Correct: application/x-www-form-urlencoded
# Wrong:   application/json

# 3. Check token values are URL-encoded
TOKEN=$(cat token.jwt | jq -sRr @uri)
curl ... -d "subject_token=${TOKEN}"
```

**Solution:**

Ensure request follows RFC 8693:
- Content-Type: `application/x-www-form-urlencoded`
- All fields URL-encoded
- Required fields: `grant_type`, `subject_token`, `subject_token_type`, `actor_token`, `actor_token_type`

**Correct curl:**
```bash
curl -X POST http://localhost:8080/oauth/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=urn:ietf:params:oauth:grant-type:token-exchange" \
  -d "subject_token=..." \
  -d "subject_token_type=urn:ietf:params:oauth:token-type:access_token" \
  -d "actor_token=..." \
  -d "actor_token_type=urn:ietf:params:oauth:token-type:jwt" \
  -d "scope=invoke:completion"
```

---

### Problem: `invalid_grant` on subject_token

**Symptoms:**
```json
{
  "error": "invalid_grant",
  "error_description": "subject_token invalid, expired, or revoked"
}
```

**Causes:**
- Token expired
- Token not from configured IdP
- Token revoked
- Token signature invalid

**Diagnostics:**

```bash
# 1. Decode token (no verification)
TOKEN="eyJhbGc..."
PAYLOAD=$(echo $TOKEN | cut -d. -f2 | base64 -d)
echo $PAYLOAD | jq .

# 2. Check expiry
PAYLOAD=$(echo $TOKEN | cut -d. -f2 | base64 -d)
EXP=$(echo $PAYLOAD | jq .exp)
NOW=$(date +%s)
[ $EXP -gt $NOW ] && echo "Token valid" || echo "Token expired"

# 3. Check issuer matches config
ISSUER=$(echo $PAYLOAD | jq -r .iss)
echo "Token issuer: $ISSUER"
echo "Expected issuer: $KAIF_IDP_ISSUER"

# 4. Check JTI not revoked
JTI=$(echo $PAYLOAD | jq -r .jti)
docker exec redis redis-cli GET kaif:revoke:$JTI
```

**Solutions:**

| Issue | Solution |
|-------|----------|
| Token expired | Request new token from IdP |
| Issuer mismatch | Update `KAIF_IDP_ISSUER` env var |
| Token revoked | Provision new delegation grant: `POST /provision` |
| Signature invalid | Verify `KAIF_IDP_JWKS_URL` is correct |

---

### Problem: `invalid_client` on actor_token (SVID)

**Symptoms:**
```json
{
  "error": "invalid_client",
  "error_description": "actor_token invalid or SPIFFE ID not registered"
}
```

**Causes:**
- SVID invalid or expired
- SPIFFE ID not in agents.yaml
- SPIFFE ID format wrong
- SPIRE server unreachable

**Diagnostics:**

```bash
# 1. Check SVID validity
SVID=$(docker compose exec spire-agent \
  /opt/spire/bin/spire-agent api fetch jwt \
  -spiffeID spiffe://kindred.systems/ns/examples/agent/mock \
  -audience http://localhost:8080 \
  -socketPath /run/spire/sockets/agent.sock \
  2>/dev/null | grep -v "^Received" | tr -d '[:space:]')

# 2. Decode SVID and check claims
PAYLOAD=$(echo $SVID | cut -d. -f2 | base64 -d)
echo $PAYLOAD | jq .

# 3. Extract SPIFFE ID from SVID
SPIFFE_ID=$(echo $PAYLOAD | jq -r '.sub // .iss // .spiffe_id')
echo "SPIFFE ID: $SPIFFE_ID"

# 4. Check if registered in ACL
grep -q "$SPIFFE_ID" packages/server/config/agents.yaml && echo "Found in ACL" || echo "NOT in ACL"

# 5. Check SPIRE bundle reachability
docker exec kaif-server wget --no-check-certificate -qO- https://spire-server:8081/ | jq '.keys | length'
```

**Solutions:**

| Issue | Solution |
|-------|----------|
| SPIFFE ID not in ACL | Add to `packages/server/config/agents.yaml` and reload |
| SVID expired | Get fresh SVID from SPIRE: `docker exec spire-agent spire-agent api fetch x509` |
| SPIRE unreachable | Check SPIRE server is running: `docker compose ps spire-server` |
| Format invalid | Ensure SVID is JWT format, not X.509 cert |

**Add to agents.yaml:**
```yaml
agents:
  new-agent:
    spiffe_id: "spiffe://kindred.systems/ns/my-namespace/agent/new-agent"
    trust_tier_minimum: PROVISIONAL  # Start low for new agents
    permitted_scopes:
      - "invoke:completion"
    may_sub_delegate: false
    max_delegation_depth: 0
    delegation_ttl_seconds: 300
    human_principal_required: true
```

Then reload:
```bash
docker compose restart kaif-server
```

---

### Problem: `invalid_scope` error

**Symptoms:**
```json
{
  "error": "invalid_scope",
  "error_description": "Requested scope not permitted"
}
```

**Cause:** Requested scope not in agent's ACL or delegation grant

**Diagnostics:**

```bash
# 1. Check agent's permitted scopes in ACL
grep -A 5 "SPIFFE_ID" packages/server/config/agents.yaml | grep permitted_scopes

# 2. Check scope in delegation grant
DELEGATION_ID="..."
docker exec redis redis-cli GET kaif:delegation:$DELEGATION_ID | jq .granted_scopes

# 3. Check requested scope format
# Format: "resource:action:target" or glob like "resource:action:*"

# 4. Test glob matching locally
REQUESTED="vault:read:key1"
PERMITTED="vault:read:*"
# "vault:read:key1" should match "vault:read:*"
```

**Solutions:**

| Issue | Solution |
|-------|----------|
| Scope not in ACL | Add to `permitted_scopes` in agents.yaml |
| Scope not in grant | Provision new delegation with required scope |
| Glob doesn't match | Check glob pattern: `vault:read:*` (not `vault:*:read`) |

**Update agents.yaml:**
```yaml
agents:
  my-agent:
    permitted_scopes:
      - "vault:read:*"        # ✓ Matches vault:read:key1, key2, etc.
      - "vault:write:admin"   # ✓ Exact match only
      - "invoke:*"            # ✓ Matches any invoke scope
```

---

### Problem: `insufficient_trust` error

**Symptoms:**
```json
{
  "error": "insufficient_trust",
  "error_description": "Trust score below minimum tier"
}
```

**Cause:** Agent's trust score < required tier, or trust score not found

**Diagnostics:**

```bash
# 1. Get current trust score
SPIFFE_ID="spiffe://kindred.systems/ns/..."
docker exec redis redis-cli GET kaif:trust:$SPIFFE_ID | jq .

# 2. Check ACL minimum tier
grep -A 5 "$SPIFFE_ID" packages/server/config/agents.yaml | grep trust_tier_minimum

# 3. Understand tier thresholds
# PROVISIONAL: 0.00–0.49
# STANDARD:    0.50–0.69
# VERIFIED:    0.70–0.89
# TRUSTED:     0.90–1.00
```

**Solutions:**

| Issue | Solution |
|-------|----------|
| Score not found | Initialize score: `POST /internal/set-trust-score` (admin endpoint, implement if needed) |
| Score too low | Wait for score to improve or lower `trust_tier_minimum` in ACL |
| Tier too high | Create test agents with `PROVISIONAL` tier for initial testing |

**Lower tier for testing:**
```yaml
agents:
  test-agent:
    trust_tier_minimum: PROVISIONAL  # Start low, increase as agent proves itself
    # ...
```

**Or update trust score (admin API):**
```bash
# If implemented:
curl -X POST http://localhost:8080/internal/set-trust-score \
  -H "Content-Type: application/json" \
  -d '{"spiffe_id": "...", "score": 0.75}'
```

---

### Problem: `delegation_depth_exceeded` error

**Symptoms:**
```json
{
  "error": "delegation_depth_exceeded",
  "error_description": "Sub-delegation chain too deep"
}
```

**Cause:** Agent trying to delegate deeper than ACL allows

**Diagnostics:**

```bash
# 1. Check current depth in token
TOKEN="eyJhbGc..."
PAYLOAD=$(echo $TOKEN | cut -d. -f2 | base64 -d)
DEPTH=$(echo $PAYLOAD | jq '.kaif.delegation_depth')
echo "Current depth: $DEPTH"

# 2. Check ACL max_depth
SPIFFE_ID="..."
grep -A 5 "$SPIFFE_ID" packages/server/config/agents.yaml | grep max_delegation_depth

# Depth rules:
# 0 = direct from human only (no sub-delegation)
# 1 = can delegate to one other agent
# 2 = can delegate, then that agent can delegate
# 3 = deeper chaining allowed
```

**Solutions:**

| Issue | Solution |
|-------|----------|
| Max depth reached | Use direct human grant instead of re-delegating |
| Need to sub-delegate | Increase `max_delegation_depth` in ACL |
| Too deep already | Reduce delegation depth or start fresh from human |

**Allow sub-delegation:**
```yaml
agents:
  delegating-agent:
    may_sub_delegate: true           # Must be true
    max_delegation_depth: 2          # Increase if needed
    # ...
```

---

## Docker Compose Issues

### Problem: Services won't start or keep restarting

**Symptoms:**
```
kaif-server  | exited with code 1
spire-server | CrashLoopBackOff
```

**Diagnostics:**

```bash
# 1. Check Docker daemon running
docker ps

# 2. View service logs
docker compose logs --tail=20 kaif-server

# 3. Inspect container
docker compose exec kaif-server sh

# 4. Check Docker disk space
docker system df

# 5. Rebuild image
docker compose build --no-cache
```

**Solutions:**

```bash
# Clean up and restart
docker compose down -v          # Remove volumes
docker system prune -a          # Remove unused images
docker compose up -d --build    # Rebuild and start

# Or start services individually
docker compose up -d redis
sleep 5
docker compose up -d spire-server
sleep 5
docker compose up -d spire-agent
sleep 5
docker compose up -d kaif-server
```

---

### Problem: `docker compose up` hangs or takes forever

**Symptoms:**
- Stuck on `Creating kaif-server...`
- Dependencies not starting

**Diagnostics:**

```bash
# 1. Check if services are starting
docker compose ps

# 2. View logs with timestamps
docker compose logs -f --timestamps

# 3. Check resource constraints
docker stats

# 4. Check network connectivity between services
docker exec kaif-server curl -v http://redis:6379
docker exec kaif-server wget --no-check-certificate -S -O- https://spire-server:8081/
```

**Solutions:**

```bash
# Stop and clean
docker compose down

# Start one service at a time with delays
docker compose up -d redis && sleep 3
docker compose up -d spire-server && sleep 5
docker compose up -d spire-agent && sleep 3
docker compose up -d kaif-server

# or increase docker timeout
COMPOSE_HTTP_TIMEOUT=120 docker compose up -d
```

---

## Redis Connectivity

### Problem: "Redis connection refused"

**Symptoms:**
- KAIF logs: `Error: connect ECONNREFUSED 127.0.0.1:6379`
- Or: `KAIF_REDIS_URL` doesn't match running service

**Diagnostics:**

```bash
# 1. Verify Redis is running
docker compose ps redis

# 2. Check Redis is listening
docker exec redis redis-cli ping   # Should return PONG

# 3. Test connection from KAIF
docker exec kaif-server redis-cli -u redis://redis:6379 ping

# 4. Check Redis logs
docker compose logs redis

# 5. Verify env var is correct
echo $KAIF_REDIS_URL  # Should be redis://redis:6379
```

**Solution:**

```bash
# Ensure env var uses docker service name (not localhost)
# Wrong: redis://localhost:6379
# Right: redis://redis:6379

# Restart with correct config
docker compose down
docker compose up -d redis
docker compose up -d kaif-server
```

---

### Problem: "Redis data persists when it shouldn't" or "Data lost after restart"

**Symptoms:**
- Audit log resets after `docker compose restart`
- Trust scores disappear

**This is expected:** Redis data is stored in Docker volume `kaif-redis-data`, which is deleted with `docker compose down -v`

**To preserve data between restarts:**
```bash
# Use 'restart' (keeps volumes)
docker compose restart

# Don't use 'down -v' (deletes volumes)
docker compose down         # ← Good (keep data)
docker compose down -v      # ← Bad (delete everything)
```

---

## SPIRE & Workload Identity

### Problem: "SPIRE server not reachable" or "Cannot fetch bundle"

**Symptoms:**
- `/health` shows `spire: unreachable`
- `invalid_client` errors on all token exchanges

**Diagnostics:**

```bash
# 1. Check SPIRE server is running
docker compose ps spire-server

# 2. View SPIRE server logs
docker compose logs spire-server | tail -30

# 3. Test bundle endpoint
docker exec kaif-server wget --no-check-certificate -S -O- https://spire-server:8081/

# 4. Check SPIRE server is initialized
docker exec spire-server spire-server healthcheck

# 5. Verify SPIRE data directory
docker exec spire-server ls -la /run/spire/data/
```

**Solutions:**

| Issue | Solution |
|-------|----------|
| SPIRE not running | Start: `docker compose up -d spire-server` |
| SPIRE healthcheck fails | Wait 30s and retry; SPIRE takes time to initialize |
| Bundle endpoint 400/404 | Check that KAIF uses `https://spire-server:8081/`; `/bundles/jwt` is not served by SPIRE |
| No socket file | Check SPIRE agent is running: `docker compose up -d spire-agent` |
| `certificate signed by unknown authority` after SPIRE config changes | Reset the local SPIRE agent trust cache and re-attest |

```bash
# Reset stale local SPIRE agent trust cache only
docker compose stop spire-agent kaif-server
docker compose rm -f spire-agent
docker volume rm kaif_spire-agent-data
docker compose up -d spire-agent kaif-server
```

---

### Problem: "SVID not valid" or "SPIFFE ID not recognized"

**Symptoms:**
- Token exchange fails with `invalid_client`
- Logs show: `SPIFFE ID format invalid`

**Diagnostics:**

```bash
# 1. Fetch a JWT-SVID from the SPIRE agent
SVID=$(docker compose exec spire-agent \
  /opt/spire/bin/spire-agent api fetch jwt \
  -spiffeID spiffe://kindred.systems/ns/examples/agent/mock \
  -audience http://localhost:8080 \
  -socketPath /run/spire/sockets/agent.sock \
  2>/dev/null | grep -v "^Received" | tr -d '[:space:]')

# 2. Inspect the JWT payload
echo "$SVID" | cut -d. -f2 | base64 -d | jq .

# 3. Validate format
# Should be: spiffe://<trust-domain>/<namespace>/<path>
# Example: spiffe://kindred.systems/ns/adaptive-layer/agent/lyra

# 4. Check if registered in ACL
grep "$SPIFFE_ID" packages/server/config/agents.yaml
```

**Solutions:**

1. **Register SPIFFE ID in ACL:**
```yaml
agents:
  my-agent:
    spiffe_id: "spiffe://kindred.systems/ns/adaptive-layer/agent/my-agent"
    # ... rest
```

2. **Ensure SPIRE is configured for your workload:**
   - Check `spire/server.conf` has correct `trust_domain`
   - Check `spire-entries.json` has workload entries

3. **Reload KAIF:**
```bash
docker compose restart kaif-server
```

---

## JWT & Cryptography

### Problem: "JWT signature invalid" or "Cannot verify token"

**Symptoms:**
- External service rejects token with signature error
- Error when calling `/introspect`

**Diagnostics:**

```bash
# 1. Decode token to see claims
TOKEN="eyJhbGc..."
HEADER=$(echo $TOKEN | cut -d. -f1 | base64 -d); echo $HEADER | jq .
PAYLOAD=$(echo $TOKEN | cut -d. -f2 | base64 -d); echo $PAYLOAD | jq .
SIGNATURE=$(echo $TOKEN | cut -d. -f3)

# 2. Check signing algorithm
HEADER=$(echo $TOKEN | cut -d. -f1 | base64 -d)
ALGO=$(echo $HEADER | jq -r .alg)
echo "Algorithm: $ALGO"  # Should be RS256

# 3. Fetch public keys from KAIF
curl http://localhost:8080/.well-known/jwks.json | jq .

# 4. Verify token against JWKS
# Use site like https://jwt.io (for testing only, never use in production)
```

**Solutions:**

| Issue | Solution |
|-------|----------|
| Algorithm not RS256 | Check crypto/jwt.ts is signing with RS256 |
| Public key mismatch | Ensure external service fetches latest JWKS: `GET /.well-known/jwks.json` |
| Key rotation | Restart KAIF server to force key reload |
| Expired token | Check `exp` claim; issue new token |

---

### Problem: "Cannot read private key" or "ENOENT private.pem"

**Symptoms:**
- KAIF startup fails with: `Error: ENOENT: no such file or directory`
- Logs show: `Failed to load signing key`

**Diagnostics:**

```bash
# 1. Check private key location
echo $KAIF_PRIVATE_KEY_PATH  # From config

# 2. Verify file exists
ls -la ./keys/private.pem

# 3. Check permissions
stat ./keys/private.pem

# 4. Check if path is accessible from container
docker exec kaif-server ls -la $KAIF_PRIVATE_KEY_PATH
```

**Solutions:**

| Scenario | Solution |
|----------|----------|
| Key file doesn't exist | Generate: `./scripts/generate-keys.sh` |
| Wrong path in .env | Update `KAIF_PRIVATE_KEY_PATH` in `.env` |
| Volume not mounted | Check `docker-compose.yml` mounts keys volume |
| Permissions denied | Run: `chmod 600 ./keys/private.pem` |

**Generate keys:**
```bash
mkdir -p keys
openssl genrsa -out keys/private.pem 2048
openssl rsa -in keys/private.pem -pubout -out keys/public.pem

# Verify
openssl rsa -in keys/private.pem -check
```

---

## Authorization & ACL

### Problem: Correct token but "access_denied" on resource

**Symptoms:**
- Token is valid
- But external service returns 403

**Cause:** External service's ACL is stricter than KAIF's

**Diagnostics:**

```bash
# 1. Decode token
TOKEN="eyJhbGc..."
PAYLOAD=$(echo $TOKEN | cut -d. -f2 | base64 -d)
echo $PAYLOAD | jq .

# 2. Check grants
SCOPES=$(echo $PAYLOAD | jq -r .scope)
echo "Scopes: $SCOPES"

# 3. Check external service's ACL
# (Depends on service — e.g., check Vault policy, API Gateway policy, etc.)

# 4. Verify exact scope match
# Request scope: "vault:read:key1"
# Token grant: "vault:read:*"  ← Should match
```

**Solution:** Ensure token scopes include what external service requires

---

### Problem: "Agent not in ACL" but agent is registered

**Symptoms:**
- KAIF has agent in `agents.yaml`
- But still gets `access_denied`

**Cause:** SPIFFE ID mismatch

**Diagnostics:**

```bash
# 1. Get SPIFFE ID from SVID
SVID="eyJhbGc..."
PAYLOAD=$(echo $SVID | cut -d. -f2 | base64 -d)
SPIFFE_FROM_SVID=$(echo $PAYLOAD | jq -r '.sub // .iss')
echo "SPIFFE from SVID: $SPIFFE_FROM_SVID"

# 2. Check agents.yaml
grep -n "spiffe_id:" packages/server/config/agents.yaml

# 3. Compare carefully (case-sensitive!)
# SVID: spiffe://kindred.systems/ns/adaptive-layer/agent/lyra
# ACL:  spiffe://kindred.systems/ns/adaptive-layer/agent/lyra  ← must match exactly
```

**Solution:** Ensure exact match (case-sensitive, no trailing slashes)

---

## Performance & Resource

### Problem: "KAIF is slow" or timeouts on token exchange

**Symptoms:**
- `/oauth/token` takes >5 seconds
- Requests timing out

**Diagnostics:**

```bash
# 1. Check CPU/memory usage
docker stats kaif-server

# 2. Monitor request latency
time curl -X POST http://localhost:8080/oauth/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "..." | jq .expires_in

# 3. Check logs for bottlenecks
docker compose logs kaif-server | grep -i error

# 4. Test Redis latency
docker exec redis redis-cli --latency-history

# 5. Test SPIRE bundle fetch latency
time docker exec kaif-server wget --no-check-certificate -qO- https://spire-server:8081/ > /dev/null
```

**Solutions:**

| Issue | Solution |
|-------|----------|
| High CPU | Check for infinite loops; restart KAIF |
| High memory | Check Redis for memory leaks; restart Redis |
| Slow Redis | Upgrade Redis hardware or reduce data |
| Slow SPIRE | Upgrade SPIRE server; check disk I/O |
| Network latency | Move services to same network; use local IPs |

**Performance tuning:**
```bash
# Restart services for fresh state
docker compose restart

# Monitor during load test
docker stats --no-stream

# Check KAIF server config
docker exec kaif-server env | grep KAIF_
```

---

## Audit & Compliance

### Problem: "Cannot verify audit chain" or tamper suspected

**Symptoms:**
- `verifyChain()` returns false
- Security alert: audit log has gaps

**Diagnostics:**

```bash
# 1. Fetch audit entries
docker exec redis redis-cli LLEN kaif:audit:global  # Count
docker exec redis redis-cli LRANGE kaif:audit:global 0 -1 | head -5

# 2. Check hash chain manually
# Format: key = kaif:audit:global, entries are JSON objects
ENTRY=$(docker exec redis redis-cli LINDEX kaif:audit:global 0)
echo $ENTRY | jq .

# 3. Verify hash continuity
# Each entry's hash must = sha256(prev_hash | timestamp | action | detail)
# Genesis entry must have prev_hash = "0".repeat(64)
```

**Typical causes:**
1. Redis data corruption (rare)
2. Manual tampering (detected!)
3. Log rotation (if history > 1M entries, might be truncated)

**Solution:**

If tamper detected, ALERT and:
```bash
# 1. Preserve evidence
docker exec redis redis-cli --rdb /tmp/audit-backup.rdb

# 2. Investigate timestamp
LAST_ENTRY=$(docker exec redis redis-cli LINDEX kaif:audit:global -1)
echo $LAST_ENTRY | jq .ts

# 3. Escalate to security team
# See Support & Escalation below
```

---

## Support & Escalation

### Getting Help

**Check these resources first:**
1. [QUICKSTART.md](QUICKSTART.md) — For setup issues
2. [CODEBASE_TOUR.md](CODEBASE_TOUR.md) — Understand architecture
3. [wiki.md](wiki.md) — Naming conventions
4. [SPEC.md](SPEC.md) — Protocol details

### Before Reaching Out

**Collect this information:**
```bash
# 1. System info
uname -a
docker --version
node --version

# 2. Error output
docker compose logs --tail=50 kaif-server 2>&1 | tee kaif-logs.txt

# 3. Configuration (redact secrets!)
cat .env | sed 's/=.*/=<redacted>/' > env-config.txt

# 4. Health status
curl http://localhost:8080/health 2>&1 | jq . > health-status.json

# 5. Redis state (redacted)
docker exec redis redis-cli dbsize > redis-stats.txt

# 6. ACL configuration
cat packages/server/config/agents.yaml > acl-config.yaml
```

### Report a Vulnerability

**DO NOT open GitHub issue for security issues**

Instead:
1. Email: `security@kindred.systems`
2. Include: What you found, impact, reproduction steps
3. Reference: [SECURITY.md](SECURITY.md)
4. SLA: Acknowledged within 48h, patched within 14 days for critical

### Known Limitations (v1.0)

| Limitation | Workaround | Planned Fix |
|-----------|-----------|------------|
| No KQL query API for audit | Use Redis CLI for now | v1.1: Add `/audit/query` endpoint |
| No web UI for audit explorer | Use Redis CLI or custom scripts | v1.1: Web dashboard |
| No Kubernetes operator | Manual YAML deployment | v1.1: KO for AKS/GKE/EKS |
| No OpenTelemetry | Use Fastify logs | v1.1: OTel integration |
| No cost tracking per principal | Estimate from audit volume | v1.2: Cost attribution |

---

**Still stuck?** Check [index.md](index.md) for navigation, or open discussion on GitHub Issues (non-security).
