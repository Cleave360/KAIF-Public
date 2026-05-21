#!/usr/bin/env node
import { Command } from 'commander'
import { readFile } from 'fs/promises'
import { allFixtures } from '../fixtures/index.js'
import { runSuite } from './harness.js'
import { formatText, formatJSON } from './reporter.js'
import type { ConformanceEnv } from '../types.js'

const program = new Command()

program
  .name('kaif-conformance')
  .description('KAIF Core Profile v1.0 conformance test kit — run against any KAIF server')
  .version('1.0.0')
  .requiredOption('--server <url>',       'Base URL of KAIF server under test (e.g. http://localhost:8080)')
  .requiredOption('--svid-jwt <path>',    'Path to file containing a valid JWT-SVID for the test agent')
  .requiredOption('--grant-token <token>','A valid human delegation grant token (subject_token)')
  .requiredOption('--agent-id <id>',      'SPIFFE ID of the test agent')
  .option('--output <format>',            'Output format: text | json  (default: text)', 'text')
  .option('--only <ids>',                 'Comma-separated fixture IDs to run (e.g. KAIF-001,KAIF-004)')

program.action(async (opts: {
  server:      string
  svidJwt:     string
  grantToken:  string
  agentId:     string
  output:      string
  only?:       string
}) => {
  let svidJwt: string
  try {
    svidJwt = (await readFile(opts.svidJwt, 'utf8')).trim()
  } catch (err) {
    console.error(`Error reading --svid-jwt file "${opts.svidJwt}": ${String(err)}`)
    process.exit(1)
  }

  const env: ConformanceEnv = {
    server_url:        opts.server.replace(/\/$/, ''),
    valid_svid_jwt:    svidJwt,
    human_grant_token: opts.grantToken,
    test_agent_id:     opts.agentId,
  }

  let fixtures = allFixtures
  if (opts.only) {
    const ids = new Set(opts.only.split(',').map(s => s.trim()))
    fixtures = fixtures.filter(f => ids.has(f.id))
    if (fixtures.length === 0) {
      console.error(`No fixtures matched --only "${opts.only}". Valid IDs: ${allFixtures.map(f => f.id).join(', ')}`)
      process.exit(1)
    }
  }

  const start = Date.now()
  const runs  = await runSuite(fixtures, env)
  const elapsed = Date.now() - start

  const meta = { target: env.server_url, elapsed_ms: elapsed }

  if (opts.output === 'json') {
    console.log(formatJSON(runs, meta))
  } else {
    process.stdout.write(formatText(runs, meta))
  }

  const hasFail = runs.some(r => r.result === 'fail')
  process.exit(hasFail ? 1 : 0)
})

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(String(err))
  process.exit(1)
})
