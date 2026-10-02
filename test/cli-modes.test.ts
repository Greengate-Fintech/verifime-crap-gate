import { spawnSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { runCli } from '../src/cli'
import { cc3Coverage, CC3_SOURCE, inDirectory, makeIo, tempRoot, writeFileIn } from './helpers/sandbox'

const TSX = path.join(__dirname, '..', 'node_modules', '.bin', 'tsx')
const ENTRY = path.join(__dirname, '..', 'src', 'cli.ts')

// The default config lists a second coverage file (cdk/coverage/coverage-final.json), and a
// missing coverage file fails the measure, so these projects name the one they have.
const ONE_COVERAGE = JSON.stringify({ coverage: ['coverage/coverage-final.json'] })

const project = (withCoverage = true): string => {
  const root = tempRoot('crap-e2e')
  writeFileIn(root, 'crap/config.json', ONE_COVERAGE)
  writeFileIn(root, 'src/busy.ts', CC3_SOURCE)
  if (withCoverage) writeFileIn(root, 'coverage/coverage-final.json', cc3Coverage(path.join(root, 'src/busy.ts')))
  return root
}

const run = async (root: string, ...argv: string[]) => {
  const out = makeIo()
  const code = await inDirectory(root, () => runCli(argv, {}, root, out.io))
  return { code, logs: out.logs, errors: out.errors }
}

const read = (root: string, rel: string): string => readFileSync(path.join(root, rel), 'utf8')

describe('measure', () => {
  it('lints, joins coverage and writes the report in one run', async () => {
    const root = project()
    const r = await run(root, 'measure')
    expect(r).toEqual({ code: 0, logs: ['CRAP measure: functions=1 over5=1 sumOver5=12.0 unmatched=0'], errors: [] })
    const report = JSON.parse(read(root, 'coverage/crap-report.json'))
    expect(report.functions).toMatchObject([{ file: 'src/busy.ts', symbol: 'busy', cc: 3, cov: 0, crap: 12 }])
  })

  it('writes no ESLint report file', async () => {
    const root = project()
    await run(root, 'measure')
    expect(existsSync(path.join(root, 'coverage/crap-eslint.json'))).toBe(false)
  })

  it('reads the --coverage flag instead of the configured files', async () => {
    const root = project(false)
    writeFileIn(root, 'other/cov.json', cc3Coverage(path.join(root, 'src/busy.ts')))
    expect((await run(root, 'measure', '--coverage', 'other/cov.json')).code).toBe(0)
  })

  it('exits 1 and leaves no report when the coverage file is missing', async () => {
    const root = project(false)
    const r = await run(root, 'measure')
    expect(r.code).toBe(1)
    expect(r.errors.join('\n')).toContain('Missing coverage input')
    expect(existsSync(path.join(root, 'coverage/crap-report.json'))).toBe(false)
  })

  it('exits 1 with the system error when the run directory does not exist, leaving no report', async () => {
    const missing = path.join(tempRoot('crap-e2e-gone'), 'gone')
    const out = makeIo()
    expect(await runCli(['measure'], {}, missing, out.io)).toBe(1)
    expect(out.errors.join('\n')).toContain('ENOENT')
    expect(out.logs).toEqual([])
  })

  it('exits 1 on a file that does not parse, naming it, rather than skipping it', async () => {
    const root = project()
    writeFileIn(root, 'src/bad.ts', 'export const = (\n')
    const r = await run(root, 'measure')
    expect(r.code).toBe(1)
    expect(r.errors.join('\n')).toContain('src/bad.ts')
  })

  it('exits 1 with the existing message when no scope directory exists', async () => {
    const root = tempRoot('crap-e2e-empty')
    writeFileIn(root, 'crap/config.json', ONE_COVERAGE)
    writeFileIn(root, 'coverage/coverage-final.json', '{}')
    const r = await run(root, 'measure')
    expect(r.code).toBe(1)
    expect(r.errors).toEqual(['No functions were measured'])
  })

  it('fails an unmatched function that is not listed', async () => {
    const root = project(false)
    writeFileIn(root, 'coverage/coverage-final.json', '{}')
    const r = await run(root, 'measure')
    expect(r.code).toBe(1)
    expect(r.errors.join('\n')).toContain('Unmatched function: src/busy.ts:1 busy (cc 3)')
  })

  it('accepts unmatched functions with --accept-unmatched', async () => {
    const root = project(false)
    writeFileIn(root, 'coverage/coverage-final.json', '{}')
    expect((await run(root, 'measure', '--accept-unmatched')).code).toBe(0)
    expect(JSON.parse(read(root, 'coverage/crap-report.json')).acceptedUnmatched).toBe(true)
  })
})

describe('baseline and check', () => {
  it('baseline measures, accepts unmatched, writes both files; check then passes', async () => {
    const root = project()
    const base = await run(root, 'baseline')
    expect(base.code).toBe(0)
    expect(base.logs).toEqual([
      'CRAP measure: functions=1 over5=1 sumOver5=12.0 unmatched=0',
      `CRAP baseline: wrote 1 rows to ${path.join('crap', 'baseline.tsv')}`,
      `CRAP baseline: wrote 0 unmatched rows to ${path.join('crap', 'unmatched.tsv')}`,
    ])
    expect(read(root, 'crap/baseline.tsv')).toContain('src/busy.ts\tbusy\t12.000\n')
    const check = await run(root, 'check')
    expect(check).toEqual({
      code: 0,
      logs: ['CRAP measure: functions=1 over5=1 sumOver5=12.0 unmatched=0', 'CRAP ratchet: pass (1 frozen, 1 functions measured)'],
      errors: [],
    })
  })

  it('baseline freezes an unmatched function into crap/unmatched.tsv', async () => {
    const root = project(false)
    writeFileIn(root, 'coverage/coverage-final.json', '{}')
    expect((await run(root, 'baseline')).code).toBe(0)
    expect(read(root, 'crap/unmatched.tsv')).toContain('src/busy.ts\tbusy\n')
  })

  it('check fails on a new offender, running the measure first', async () => {
    const root = project()
    writeFileIn(root, 'crap/baseline.tsv', '# empty\n')
    const r = await run(root, 'check')
    expect(r.code).toBe(1)
    expect(r.errors.join('\n')).toContain('CRAP ratchet: NEW OFFENDER src/busy.ts#busy')
  })

  it('check keeps the advice to regenerate the baseline for a stale entry', async () => {
    const root = project()
    writeFileIn(root, 'crap/baseline.tsv', '# h\nsrc/busy.ts\tbusy\t12.000\nsrc/gone.ts\tgone\t9.000\n')
    const r = await run(root, 'check')
    expect(r.code).toBe(1)
    expect(r.errors.join('\n')).toContain('delete this line from crap/baseline.tsv, or run npm run crap:baseline')
  })

  it('check stops with 1 when the measure fails, and never runs the ratchet', async () => {
    const root = project(false)
    writeFileIn(root, 'crap/baseline.tsv', '# empty\n')
    const r = await run(root, 'check')
    expect(r.code).toBe(1)
    expect(r.errors.join('\n')).toContain('Missing coverage input')
    expect(r.errors.join('\n')).not.toContain('CRAP ratchet')
  })

  it('check never trusts a report left by baseline: it measures afresh', async () => {
    const root = project()
    await run(root, 'baseline')
    writeFileIn(root, 'coverage/coverage-final.json', '{}')
    const r = await run(root, 'check')
    expect(r.code).toBe(1)
    expect(r.errors.join('\n')).toContain('Unmatched function')
  })

  it('baseline refuses growth without --allow-growth and writes nothing', async () => {
    const root = project()
    writeFileIn(root, 'crap/baseline.tsv', '# empty\nsrc/other.ts\tz\t9.000\n')
    const r = await run(root, 'baseline')
    expect(r.code).toBe(1)
    expect(r.errors.join('\n')).toContain('refusing to grow the baseline')
    expect(read(root, 'crap/baseline.tsv')).toBe('# empty\nsrc/other.ts\tz\t9.000\n')
  })

  it('baseline --allow-growth accepts it', async () => {
    const root = project()
    writeFileIn(root, 'crap/baseline.tsv', '# empty\nsrc/busy.ts\tbusy\t5.000\n')
    expect((await run(root, 'baseline', '--allow-growth')).code).toBe(0)
  })

  it('baseline stops with 1 when the measure fails, writing no baseline', async () => {
    const root = project(false)
    expect((await run(root, 'baseline')).code).toBe(1)
    expect(existsSync(path.join(root, 'crap/baseline.tsv'))).toBe(false)
  })

  it('applies crap/config.json: scope, extensions and threshold', async () => {
    const root = tempRoot('crap-e2e-config')
    writeFileIn(root, 'crap/config.json', JSON.stringify({ scope: ['packages/x/src'], coverage: ['coverage/coverage-final.json'], threshold: 20 }))
    writeFileIn(root, 'packages/x/src/busy.ts', CC3_SOURCE)
    writeFileIn(root, 'coverage/coverage-final.json', cc3Coverage(path.join(root, 'packages/x/src/busy.ts')))
    const r = await run(root, 'measure')
    expect(r.logs).toEqual(['CRAP measure: functions=1 over5=0 sumOver5=0.0 unmatched=0'])
  })
})

describe('the CLI entry point', () => {
  // Two tsx start-ups: well over the default timeout on a slow runner.
  it('runs a mode as a process and exits with its code', { timeout: 60_000 }, () => {
    const root = project()
    const ok = spawnSync(TSX, [ENTRY, 'measure'], { cwd: root, encoding: 'utf8' })
    expect(ok.status).toBe(0)
    expect(ok.stdout).toBe('CRAP measure: functions=1 over5=1 sumOver5=12.0 unmatched=0\n')
    const bad = spawnSync(TSX, [ENTRY, 'nope'], { cwd: root, encoding: 'utf8' })
    expect(bad.status).toBe(1)
    expect(bad.stderr).toContain('Unknown or missing subcommand: nope')
  })
})
