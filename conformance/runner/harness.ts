import type { ConformanceFixture, ConformanceEnv, FixtureRun } from '../types.js'
import { toFormBody } from '../fixtures/helpers.js'

export async function runFixture(
  fixture: ConformanceFixture,
  env: ConformanceEnv
): Promise<FixtureRun> {
  const start = Date.now()

  try {
    // Non-standard fixtures (e.g. KAIF-005 testing /introspect) override execute()
    if (fixture.execute) {
      const { outcome, advisory } = await fixture.execute(env)
      return {
        id:         fixture.id,
        name:       fixture.name,
        required:   fixture.required,
        result:     outcome,
        elapsed_ms: Date.now() - start,
        error:      null,
        ...(advisory !== undefined ? { advisory } : {}),
      }
    }

    // Standard path: buildRequest → POST /oauth/token → assert
    const req = await fixture.buildRequest(env)
    const resp = await fetch(`${env.server_url}/oauth/token`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    toFormBody(req as unknown as Record<string, string | undefined>),
    })

    let body: unknown
    try {
      body = await resp.json()
    } catch {
      body = {}
    }

    await fixture.assert(resp, body, env)

    return {
      id:         fixture.id,
      name:       fixture.name,
      required:   fixture.required,
      result:     'pass',
      elapsed_ms: Date.now() - start,
      error:      null,
    }
  } catch (err) {
    return {
      id:         fixture.id,
      name:       fixture.name,
      required:   fixture.required,
      result:     fixture.required ? 'fail' : 'warn',
      elapsed_ms: Date.now() - start,
      error:      err instanceof Error ? err.message : String(err),
    }
  }
}

export async function runSuite(
  fixtures: ConformanceFixture[],
  env: ConformanceEnv
): Promise<FixtureRun[]> {
  const runs: FixtureRun[] = []
  for (const fixture of fixtures) {
    runs.push(await runFixture(fixture, env))
  }
  return runs
}
