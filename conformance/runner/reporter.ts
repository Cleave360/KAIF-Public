import type { FixtureRun, SuiteResult } from '../types.js'

const C_PASS  = '\x1b[32m'
const C_FAIL  = '\x1b[31m'
const C_WARN  = '\x1b[33m'
const C_RESET = '\x1b[0m'

function resultColor(r: string): string {
  if (r === 'pass') return C_PASS
  if (r === 'fail') return C_FAIL
  return C_WARN
}

export function formatText(
  runs: FixtureRun[],
  meta: { target: string; elapsed_ms: number }
): string {
  const nameWidth = Math.max(...runs.map(r => r.name.length), 28)
  const divider   = '─'.repeat(nameWidth + 30)

  const lines: string[] = [
    'KAIF Conformance Suite v1.0',
    `Target: ${meta.target}`,
    divider,
  ]

  for (const run of runs) {
    const id      = run.id.padEnd(10)
    const name    = run.name.padEnd(nameWidth + 2)
    const label   = run.result.toUpperCase().padEnd(6)
    const colored = `${resultColor(run.result)}${label}${C_RESET}`
    const ms      = `${run.elapsed_ms}ms`.padStart(7)
    const note    = run.advisory ? `  (${run.advisory})` :
                    run.error    ? `  ${run.error}`       : ''

    lines.push(`${id}${name}${colored}${ms}${note}`)
  }

  lines.push(divider)

  const mustPass  = runs.filter(r => r.required && r.result === 'pass').length
  const mustTotal = runs.filter(r => r.required).length
  const warns     = runs.filter(r => r.result === 'warn').length
  const fails     = runs.filter(r => r.result === 'fail').length

  const overallLabel = fails > 0 ? 'FAIL' : 'PASS'
  const overallColor = fails > 0 ? C_FAIL : C_PASS
  const advisoryStr  = warns > 0 ? `  ${warns} advisory` : ''

  lines.push(
    `Result: ${overallColor}${overallLabel}${C_RESET}  ${mustPass}/${mustTotal} MUST${advisoryStr}`
  )
  lines.push(`Elapsed: ${meta.elapsed_ms}ms`)
  lines.push('')

  return lines.join('\n')
}

export function formatJSON(
  runs: FixtureRun[],
  meta: { target: string; elapsed_ms: number }
): string {
  const fails = runs.filter(r => r.result === 'fail').length

  const result: SuiteResult = {
    suite:      'KAIF Core Profile v1.0',
    target:     meta.target,
    timestamp:  new Date().toISOString(),
    elapsed_ms: meta.elapsed_ms,
    result:     fails > 0 ? 'FAIL' : 'PASS',
    summary: {
      pass: runs.filter(r => r.result === 'pass').length,
      fail: fails,
      warn: runs.filter(r => r.result === 'warn').length,
      skip: runs.filter(r => r.result === 'skip').length,
    },
    fixtures: runs.map(r => ({
      id:         r.id,
      name:       r.name,
      result:     r.result.toUpperCase() as 'PASS' | 'FAIL' | 'WARN' | 'SKIP',
      elapsed_ms: r.elapsed_ms,
      error:      r.error,
    })),
  }

  return JSON.stringify(result, null, 2)
}
