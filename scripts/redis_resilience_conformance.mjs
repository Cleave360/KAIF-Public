#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const ROOT_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const REPORTS_DIR = path.join(ROOT_DIR, 'reports', 'redis_resilience')
const DEFAULT_SERVER_URL = process.env.KAIF_SERVER_URL ?? 'http://127.0.0.1:18080'
const DEFAULT_AGENT_SPIFFE_ID = process.env.KAIF_AGENT_ID ?? 'spiffe://kindred.systems/ns/examples/agent/mock'
const DEFAULT_SCOPE = 'invoke:completion'
const DEFAULT_ID_TOKEN = 'dev-mock-token'
const DEFAULT_COMPOSE_ENV_FILE = process.env.KAIF_COMPOSE_ENV_FILE ?? ''
const RUN_ID = `run-kaif-redis-resilience-${new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '_')}`
const OUT_DIR = path.join(REPORTS_DIR, RUN_ID)

function dcArgs(...args) {
  if (DEFAULT_COMPOSE_ENV_FILE) {
    return ['compose', '--env-file', DEFAULT_COMPOSE_ENV_FILE, ...args]
  }
  return ['compose', ...args]
}

function runCommand(command, args, options = {}) {
  try {
    return execFileSync(command, args, {
      cwd: ROOT_DIR,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    }).trim()
  } catch (error) {
    if (options.allowFailure) {
      const stdout = error.stdout?.toString?.() ?? ''
      const stderr = error.stderr?.toString?.() ?? ''
      return `${stdout}${stderr}`.trim()
    }
    throw error
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitForHealth(serverUrl, timeoutMs = 120000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(`${serverUrl}/health`)
      if (response.ok) {
        const body = await response.json()
        if (body.status === 'ok') return body
      }
    } catch {
      // wait and retry
    }
    await sleep(2000)
  }
  throw new Error(`Timed out waiting for KAIF health at ${serverUrl}`)
}

function computeAuditHash(prevHash, ts, action, detail) {
  return createHash('sha256').update(`${prevHash}|${ts}|${action}|${detail}`).digest('hex')
}

function decodeJwtPayload(token) {
  const parts = token.split('.')
  if (parts.length !== 3) throw new Error('JWT does not have 3 parts')
  const payload = Buffer.from(parts[1], 'base64url').toString('utf8')
  return JSON.parse(payload)
}

function parseRedisUrl(url) {
  const parsed = new URL(url)
  return {
    protocol: parsed.protocol,
    hostname: parsed.hostname,
    port: parsed.port,
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options)
  const text = await response.text()
  let body
  try {
    body = text ? JSON.parse(text) : {}
  } catch {
    body = { raw: text }
  }
  return { response, body }
}

async function postJson(url, body, headers = {}) {
  return fetchJson(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  })
}

async function postForm(url, form) {
  return fetchJson(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  })
}

function resolveRedisUrl() {
  if (process.env.KAIF_REDIS_URL) return process.env.KAIF_REDIS_URL
  const envText = runCommand('docker', dcArgs('exec', '-T', 'kaif-server', 'env'))
  const line = envText.split('\n').find(entry => entry.startsWith('KAIF_REDIS_URL='))
  if (!line) throw new Error('KAIF_REDIS_URL not found in kaif-server container environment')
  return line.slice('KAIF_REDIS_URL='.length)
}

function fetchActorToken(serverUrl) {
  const output = runCommand(
    'docker',
    dcArgs(
      'exec',
      '-T',
      'spire-agent',
      '/opt/spire/bin/spire-agent',
      'api',
      'fetch',
      'jwt',
      '-spiffeID',
      DEFAULT_AGENT_SPIFFE_ID,
      '-audience',
      serverUrl,
      '-socketPath',
      '/run/spire/sockets/agent.sock'
    ),
    { allowFailure: true }
  )

  const tokenLine = output.split('\n').find(line => line.startsWith('\t'))
  if (!tokenLine) {
    return {
      mode: 'dev-mock',
      token: `dev-mock-svid:${DEFAULT_AGENT_SPIFFE_ID}`,
      note: 'SPIRE JWT-SVID fetch unavailable; using dev mock fallback',
    }
  }

  return {
    mode: 'spire-jwt-svid',
    token: tokenLine.trim(),
    note: 'Fetched real JWT-SVID from SPIRE agent',
  }
}

async function createDelegation(serverUrl) {
  const { response, body } = await postJson(`${serverUrl}/provision`, {
    id_token: DEFAULT_ID_TOKEN,
    agent_id: 'mock-agent',
    scope: DEFAULT_SCOPE,
    ttl_seconds: 300,
  })
  if (!response.ok || typeof body.delegation_token !== 'string') {
    throw new Error(`Provision failed: HTTP ${response.status} ${JSON.stringify(body)}`)
  }
  return body
}

async function exchangeToken(serverUrl, delegationToken, actorToken) {
  const { response, body } = await postForm(`${serverUrl}/oauth/token`, {
    grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
    subject_token: delegationToken,
    subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
    actor_token: actorToken,
    actor_token_type: 'urn:ietf:params:oauth:token-type:jwt',
    scope: DEFAULT_SCOPE,
  })
  if (!response.ok || typeof body.access_token !== 'string') {
    throw new Error(`Token exchange failed: HTTP ${response.status} ${JSON.stringify(body)}`)
  }
  return body
}

async function authorizeWithToken(serverUrl, token, resource) {
  return postJson(
    `${serverUrl}/relying/class-a/authorize`,
    { run_id: RUN_ID, resource },
    { authorization: `Bearer ${token}` }
  )
}

async function revokeToken(serverUrl, token) {
  return postJson(
    `${serverUrl}/revoke`,
    { token, reason: 'redis-resilience-check' },
    { authorization: `Bearer ${token}` }
  )
}

function loadAuditSnapshot(revocationJtis = []) {
  const script = `
    import Redis from 'ioredis';
    import { createHash } from 'node:crypto';
    const r = new Redis(process.env.KAIF_REDIS_URL, { lazyConnect: true });
    await r.connect();
    const raw = await r.lrange('kaif:audit:global', 0, -1);
    const entries = raw.map(line => JSON.parse(line));
    let chainValid = true;
    let expectedPrevHash = '0'.repeat(64);
    for (const entry of entries) {
      const expectedHash = createHash('sha256').update(\`\${entry.prev_hash}|\${entry.ts}|\${entry.action}|\${entry.detail}\`).digest('hex');
      if (entry.prev_hash !== expectedPrevHash || entry.hash !== expectedHash) {
        chainValid = false;
        break;
      }
      expectedPrevHash = entry.hash;
    }
    const revocationJtis = ${JSON.stringify(revocationJtis)};
    const revocationValues = {};
    for (const jti of revocationJtis) {
      revocationValues[jti] = await r.get(\`kaif:revoke:\${jti}\`);
    }
    console.log(JSON.stringify({
      length: entries.length,
      entries,
      chainValid,
      lastHash: entries.length > 0 ? entries[entries.length - 1].hash : '0'.repeat(64),
      revocationValues,
    }));
    await r.quit();
  `

  return JSON.parse(
    runCommand('docker', dcArgs('exec', '-T', 'kaif-server', 'node', '--input-type=module', '-e', script))
  )
}

async function issueAndRevokeCycle(serverUrl, actorToken, label) {
  const delegation = await createDelegation(serverUrl)
  const exchange = await exchangeToken(serverUrl, delegation.delegation_token, actorToken)
  const accessToken = exchange.access_token
  const payload = decodeJwtPayload(accessToken)
  const jti = payload.jti

  const authorizeBefore = await authorizeWithToken(serverUrl, accessToken, `${label}-before-revoke`)
  const revoke = await revokeToken(serverUrl, accessToken)
  const authorizeAfter = await authorizeWithToken(serverUrl, accessToken, `${label}-after-revoke`)

  return {
    label,
    delegation_id: delegation.delegation_id,
    delegation_token_jti: decodeJwtPayload(delegation.delegation_token).jti,
    access_token: accessToken,
    access_token_jti: jti,
    authorize_before_revoke: {
      status: authorizeBefore.response.status,
      body: authorizeBefore.body,
    },
    revoke: {
      status: revoke.response.status,
      body: revoke.body,
    },
    authorize_after_revoke: {
      status: authorizeAfter.response.status,
      body: authorizeAfter.body,
    },
    access_payload: payload,
  }
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })

  const serverUrl = DEFAULT_SERVER_URL.replace(/\/$/, '')
  await waitForHealth(serverUrl)
  const redisUrl = resolveRedisUrl()
  const actor = fetchActorToken(serverUrl)
  const redisInfo = parseRedisUrl(redisUrl)
  const baselineAudit = loadAuditSnapshot()
  const cycleOne = await issueAndRevokeCycle(serverUrl, actor.token, 'pre-restart')
  const afterCycleOne = loadAuditSnapshot([cycleOne.access_token_jti])
  const revokedBeforeRestart = cycleOne.authorize_after_revoke.status === 401
  const revokedKeyBeforeRestart = afterCycleOne.revocationValues[cycleOne.access_token_jti] ?? null

  runCommand('docker', dcArgs('restart', 'kaif-server'))
  const healthAfterRestart = await waitForHealth(serverUrl)

  const revokedAfterRestartResp = await authorizeWithToken(
    serverUrl,
    cycleOne.access_token,
    'post-restart-revoked-check'
  )
  const afterRestartAudit = loadAuditSnapshot([cycleOne.access_token_jti])
  const revokedKeyAfterRestart = afterRestartAudit.revocationValues[cycleOne.access_token_jti] ?? null

  const cycleTwo = await issueAndRevokeCycle(serverUrl, actor.token, 'post-restart')
  const finalAudit = loadAuditSnapshot([cycleOne.access_token_jti, cycleTwo.access_token_jti])
  const finalRevokedKey = finalAudit.revocationValues[cycleTwo.access_token_jti] ?? null

  const cycleTwoNewEntries = finalAudit.entries.slice(afterRestartAudit.length)
  const firstEntryAfterRestart = cycleTwoNewEntries[0] ?? null

  const checks = [
    {
      id: 'REDIS-001',
      name: 'Revoked token denied before reconnect',
      status: revokedBeforeRestart ? 'PASS' : 'FAIL',
      note: `HTTP ${cycleOne.authorize_after_revoke.status}`,
    },
    {
      id: 'REDIS-002',
      name: 'Revocation key persisted before reconnect',
      status: revokedKeyBeforeRestart === '1' ? 'PASS' : 'FAIL',
      note: `redis_value=${revokedKeyBeforeRestart ?? 'null'}`,
    },
    {
      id: 'REDIS-003',
      name: 'KAIF recovered after reconnect',
      status: healthAfterRestart.status === 'ok' ? 'PASS' : 'FAIL',
      note: `health=${JSON.stringify(healthAfterRestart)}`,
    },
    {
      id: 'REDIS-004',
      name: 'Revoked token denied after reconnect',
      status: revokedAfterRestartResp.response.status === 401 ? 'PASS' : 'FAIL',
      note: `HTTP ${revokedAfterRestartResp.response.status}`,
    },
    {
      id: 'REDIS-005',
      name: 'Revocation key persisted after reconnect',
      status: revokedKeyAfterRestart === '1' ? 'PASS' : 'FAIL',
      note: `redis_value=${revokedKeyAfterRestart ?? 'null'}`,
    },
    {
      id: 'REDIS-006',
      name: 'Audit chain remained valid after reconnect',
      status: afterRestartAudit.chainValid ? 'PASS' : 'FAIL',
      note: `audit_len=${afterRestartAudit.length}`,
    },
    {
      id: 'REDIS-007',
      name: 'Writes resumed after reconnect',
      status: finalAudit.length > afterRestartAudit.length ? 'PASS' : 'FAIL',
      note: `audit_len_before=${afterRestartAudit.length} audit_len_after=${finalAudit.length}`,
    },
    {
      id: 'REDIS-008',
      name: 'Audit continuity preserved across reconnect',
      status: firstEntryAfterRestart && firstEntryAfterRestart.prev_hash === afterRestartAudit.lastHash ? 'PASS' : 'FAIL',
      note: firstEntryAfterRestart
        ? `prev_hash=${firstEntryAfterRestart.prev_hash} expected=${afterRestartAudit.lastHash}`
        : 'no new audit entries recorded after reconnect',
    },
    {
      id: 'REDIS-009',
      name: 'New revocation persisted after reconnect',
      status: finalRevokedKey === '1' ? 'PASS' : 'FAIL',
      note: `redis_value=${finalRevokedKey ?? 'null'}`,
    },
    {
      id: 'REDIS-010',
      name: 'Final audit chain valid',
      status: finalAudit.chainValid ? 'PASS' : 'FAIL',
      note: `audit_len=${finalAudit.length}`,
    },
  ]

  const overall = checks.every(check => check.status === 'PASS') ? 'PASS' : 'FAIL'
  const report = {
    run_id: RUN_ID,
    timestamp: new Date().toISOString(),
    target: {
      server_url: serverUrl,
      redis: redisInfo,
      actor_mode: actor.mode,
      actor_note: actor.note,
    },
    azure_platform_note: 'Azure Managed Redis Enterprise on Microsoft.Cache/redisEnterprise does not expose customer-triggerable failover/restart actions for this profile; resilience is attested via reconnect and state continuity checks.',
    baseline: {
      audit_length: baselineAudit.length,
      last_hash: baselineAudit.lastHash,
    },
    checkpoints: {
      after_cycle_one: {
        audit_length: afterCycleOne.length,
        last_hash: afterCycleOne.lastHash,
      },
      after_restart: {
        audit_length: afterRestartAudit.length,
        last_hash: afterRestartAudit.lastHash,
      },
      final: {
        audit_length: finalAudit.length,
        last_hash: finalAudit.lastHash,
      },
    },
    evidence: {
      cycle_one: {
        ...cycleOne,
        access_token: '<redacted>',
      },
      cycle_two: {
        ...cycleTwo,
        access_token: '<redacted>',
      },
      revoked_after_restart: {
        status: revokedAfterRestartResp.response.status,
        body: revokedAfterRestartResp.body,
      },
      audit_tail: finalAudit.entries.slice(-8),
    },
    checks,
    overall,
  }

  const summaryLines = [
    `RUN_ID=${RUN_ID}`,
    `SERVER_URL=${serverUrl}`,
    `REDIS_HOST=${redisInfo.hostname}`,
    `ACTOR_MODE=${actor.mode}`,
    `OVERALL=${overall}`,
    ...checks.map(check => `${check.id}=${check.status} ${check.name} :: ${check.note}`),
  ]

  fs.writeFileSync(path.join(OUT_DIR, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  fs.writeFileSync(path.join(OUT_DIR, 'summary.txt'), `${summaryLines.join('\n')}\n`)

  console.log(summaryLines.join('\n'))
  if (overall !== 'PASS') {
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exit(1)
})
