import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'
import { describe, expect, it } from 'vitest'
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

  it('exits 1 with the message naming file and key when the config is invalid', () => {
    const cwd = root()
    mkdirSync(path.join(cwd, 'crap'))
    writeFileSync(path.join(cwd, 'crap/config.json'), '{"threshold": "8"}')
    const out = io()
    expect(runCli(['check'], {}, cwd, out.io)).toBe(1)
    expect(out.errors).toEqual(['Invalid crap/config.json: key "threshold" must be a number greater than 0'])
  })

  it('exits 1 on an unknown key even for a usage error', () => {
    const cwd = root()
    mkdirSync(path.join(cwd, 'crap'))
    writeFileSync(path.join(cwd, 'crap/config.json'), '{"nope": 1}')
    const out = io()
    expect(runCli(['bogus'], {}, cwd, out.io)).toBe(1)
    expect(out.errors[0]).toContain('unknown key "nope"')
  })

  it('reports a usage error as before when the config is absent', () => {
    const out = io()
    expect(runCli(['bogus'], {}, root(), out.io)).toBe(1)
    expect(out.errors[0]).toContain('Unknown or missing subcommand: bogus')
  })
})
