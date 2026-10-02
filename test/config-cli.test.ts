import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseArgs, runCli } from '../src/cli'
import { DEFAULT_CONFIG } from '../src/config'

describe('parseArgs: coverage precedence', () => {
  const configured = { ...DEFAULT_CONFIG, coverage: ['out/one.json', 'out/two.json'] }

  it('uses the default when there is no flag and no config', () => {
    expect(parseArgs(['measure'], {})).toMatchObject({ coveragePaths: DEFAULT_CONFIG.coverage })
  })

  it('uses the config when there is no flag', () => {
    expect(parseArgs(['measure'], {}, configured)).toMatchObject({ coveragePaths: ['out/one.json', 'out/two.json'] })
  })

  it('lets the flag override the config', () => {
    expect(parseArgs(['measure', '--coverage', 'flag.json'], {}, configured)).toMatchObject({ coveragePaths: ['flag.json'] })
  })
})

describe('runCli', () => {
  const root = (): string => realpathSync(mkdtempSync(path.join(os.tmpdir(), 'crap-cli-config-')))
  const io = () => {
    const errors: string[] = []
    return { errors, io: { log: () => undefined, error: (s: string) => errors.push(s) } }
  }

  it('exits 1 with the message naming file and key when the config is invalid', async () => {
    const cwd = root()
    mkdirSync(path.join(cwd, 'crap'))
    writeFileSync(path.join(cwd, 'crap/config.json'), '{"threshold": "8"}')
    const out = io()
    expect(await runCli(['check'], {}, cwd, out.io)).toBe(1)
    expect(out.errors).toEqual(['Invalid crap/config.json: key "threshold" must be a number greater than 0'])
  })

  it('exits 1 on an unknown key even for a usage error', async () => {
    const cwd = root()
    mkdirSync(path.join(cwd, 'crap'))
    writeFileSync(path.join(cwd, 'crap/config.json'), '{"nope": 1}')
    const out = io()
    expect(await runCli(['bogus'], {}, cwd, out.io)).toBe(1)
    expect(out.errors[0]).toContain('unknown key "nope"')
  })

  it('reports a usage error as before when the config is absent', async () => {
    const out = io()
    expect(await runCli(['bogus'], {}, root(), out.io)).toBe(1)
    expect(out.errors[0]).toContain('Unknown or missing subcommand: bogus')
  })
})

describe('runCli applies a non-default config end to end', () => {
  const FILE = 'packages/x/src/a.ts'
  const span = { start: { line: 1, column: 0 }, end: { line: 5, column: 1 } }
  const original = process.cwd()

  const sandbox = (config: object): string => {
    const cwd = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'crap-cli-e2e-')))
    mkdirSync(path.join(cwd, 'crap'))
    mkdirSync(path.join(cwd, 'cov'))
    writeFileSync(path.join(cwd, 'crap/config.json'), JSON.stringify(config))
    const abs = path.join(cwd, FILE)
    // cc 2 at coverage 0 scores 6: below the default threshold of 8, above a threshold of 2.
    // The gate lints this source itself; the function sits on lines 1 to 5.
    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, 'export function f(a: number): number {\n  if (a > 1) {\n    return a\n  }\n  return 0\n}\n')
    const entry = { path: abs, statementMap: {}, s: {}, fnMap: { '0': { name: 'f', decl: span, loc: span } }, f: { '0': 0 }, branchMap: {}, b: {} }
    writeFileSync(path.join(cwd, 'cov/c.json'), JSON.stringify({ [abs]: entry }))
    process.chdir(cwd)
    return cwd
  }

  afterEach(() => process.chdir(original))

  const CONFIG = { scope: ['packages/x/src'], coverage: ['cov/c.json'], threshold: 2 }
  const collect = () => {
    const logs: string[] = []
    const errors: string[] = []
    return { logs, errors, io: { log: (s: string) => logs.push(s), error: (s: string) => errors.push(s) } }
  }

  it('measure uses the configured scope, coverage file and threshold', async () => {
    const cwd = sandbox(CONFIG)
    const out = collect()
    expect(await runCli(['measure'], {}, cwd, out.io)).toBe(0)
    expect(out.logs).toEqual(['CRAP measure: functions=1 over5=1 sumOver5=6.0 unmatched=0'])
  })

  it('baseline freezes at the configured threshold and check passes against it', async () => {
    const cwd = sandbox(CONFIG)
    expect(await runCli(['measure'], {}, cwd, collect().io)).toBe(0)
    const base = collect()
    expect(await runCli(['baseline'], {}, cwd, base.io)).toBe(0)
    expect(readFileSync(path.join(cwd, 'crap/baseline.tsv'), 'utf8')).toContain(`${FILE}\tf\t6.000\n`)
    const check = collect()
    expect(await runCli(['check'], {}, cwd, check.io)).toBe(0)
    // `check` now measures first, so its output is the measure line then the unchanged pass line.
    expect(check.logs).toEqual([
      'CRAP measure: functions=1 over5=1 sumOver5=6.0 unmatched=0',
      'CRAP ratchet: pass (1 frozen, 1 functions measured)',
    ])
  })

  it('check reports a new offender against the configured threshold', async () => {
    const cwd = sandbox(CONFIG)
    expect(await runCli(['measure'], {}, cwd, collect().io)).toBe(0)
    writeFileSync(path.join(cwd, 'crap/baseline.tsv'), '# empty\n')
    const out = collect()
    expect(await runCli(['check'], {}, cwd, out.io)).toBe(1)
    expect(out.errors.join('\n')).toContain('above the threshold of 2')
  })

  it('without a config the same inputs measure nothing', async () => {
    const cwd = sandbox({})
    const out = collect()
    expect(await runCli(['measure'], {}, cwd, out.io)).toBe(1)
    expect(out.errors.join('\n')).toContain('Missing coverage input')
  })
})
