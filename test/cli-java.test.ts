import { cpSync, existsSync, readFileSync } from 'fs'
import path from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runCli } from '../src/cli'
import { inDirectory, makeIo, tempRoot, writeFileIn } from './helpers/sandbox'

// ESLint must not run for Java: the lint boundary fails the test if the Java path reaches it.
const lintScope = vi.hoisted(() => vi.fn(async (): Promise<never[]> => []))
vi.mock('../src/eslint', () => ({ lintScope }))

const FIXTURE = path.join(__dirname, 'e2e', 'java-project')
const MEASURE_LINE = 'CRAP measure: functions=6 over5=3 sumOver5=24.0 unmatched=0'
const SKIPPED_LINE =
  'Classes skipped: 1 (0 not-Java, 0 no source file name, 1 source not found under any scope root, 0 excluded)'

const javaProject = (): string => {
  const root = tempRoot('crap-java-cli')
  cpSync(FIXTURE, root, { recursive: true })
  return root
}

const read = (root: string, rel: string): string => readFileSync(path.join(root, rel), 'utf8')

const run = async (root: string, ...argv: string[]) => {
  const out = makeIo()
  const code = await inDirectory(root, () => runCli(argv, {}, root, out.io))
  return { code, logs: out.logs, errors: out.errors }
}

beforeEach(() => {
  lintScope.mockClear()
})

describe('the Java path', () => {
  it('measure never runs ESLint, and needs no node toolchain in the project', async () => {
    const root = javaProject()
    const r = await run(root, 'measure')
    expect(r.code).toBe(0)
    expect(lintScope).not.toHaveBeenCalled()
    expect(existsSync(path.join(root, 'node_modules'))).toBe(false)
    expect(existsSync(path.join(root, 'package.json'))).toBe(false)
  })

  it.each(['check', 'baseline'])('%s never runs ESLint', async (command) => {
    const root = javaProject()
    expect((await run(root, command)).code).toBe(0)
    expect(lintScope).not.toHaveBeenCalled()
  })

  it('prints the skipped breakdown, then the summary line last', async () => {
    const r = await run(javaProject(), 'measure')
    expect(r).toEqual({ code: 0, logs: [SKIPPED_LINE, MEASURE_LINE], errors: [] })
  })

  it('prints the skipped line even when nothing was skipped', async () => {
    const root = javaProject()
    writeFileIn(root, 'web/build/reports/jacoco/test/jacocoTestReport.xml', readFileSync(path.join(root, 'web/build/reports/jacoco/test/jacocoTestReport.xml'), 'utf8').replace(/<class name="com\/example\/web\/GeneratedClient"[\s\S]*?<\/class>/, ''))
    const r = await run(root, 'measure')
    expect(r.logs[0]).toBe('Classes skipped: 0 (0 not-Java, 0 no source file name, 0 source not found under any scope root, 0 excluded)')
  })

  it('writes the same report shape as TypeScript, with Java rows', async () => {
    const root = javaProject()
    await run(root, 'measure')
    const report = JSON.parse(readFileSync(path.join(root, 'coverage/crap-report.json'), 'utf8'))
    expect(Object.keys(report)).toEqual(['summary', 'functions', 'unmatched', 'listedUnmatched', 'staleUnmatched', 'acceptedUnmatched'])
    expect(report.summary).toEqual({ functions: 6, over5: 3, sumOver5: 24, unmatched: 0 })
    expect(report.unmatched).toEqual([])
  })

  it('reads JaCoCo files named by --coverage instead of the configured ones', async () => {
    const root = javaProject()
    const r = await run(root, 'measure', '--coverage', 'web/build/reports/jacoco/test/jacocoTestReport.xml')
    expect(r.code).toBe(0)
    expect(r.logs.at(-1)).toBe('CRAP measure: functions=3 over5=1 sumOver5=6.0 unmatched=0')
  })

  it('exits 1 for a problem, naming the report', async () => {
    const root = javaProject()
    const r = await run(root, 'measure', '--coverage', 'nowhere/jacoco.xml')
    expect(r.code).toBe(1)
    expect(r.errors).toContain('Problem: nowhere/jacoco.xml Cannot read the JaCoCo report (ENOENT)')
  })

  it('check stops with 1 on a problem and never runs the ratchet', async () => {
    const root = javaProject()
    writeFileIn(root, 'web/build/reports/jacoco/test/jacocoTestReport.xml', 'not xml')
    const r = await run(root, 'check')
    expect(r.code).toBe(1)
    expect(r.errors.join('\n')).toContain('Problem: web/build/reports/jacoco/test/jacocoTestReport.xml')
    expect(r.errors.join('\n')).not.toContain('CRAP ratchet')
  })

  it('exits 1 with the system error when the run directory does not exist', async () => {
    const missing = path.join(tempRoot('crap-java-gone'), 'gone')
    const out = makeIo()
    expect(await runCli(['measure'], {}, missing, out.io)).toBe(1)
    expect(out.errors.join('\n')).toContain('ENOENT')
  })

  it('fails with the TypeScript message when no coverage file is given to measure', async () => {
    const root = javaProject()
    const { runMeasure } = await import('../src/cli')
    const out = makeIo()
    const code = runMeasure(
      { eslintPath: '', coveragePaths: [], unmatchedListPath: 'crap/unmatched.tsv', acceptUnmatched: false, outPath: path.join(root, 'out.json'), repoRoot: root, config: { language: 'java', scope: ['core/src/main/java'], anchors: [], extensions: ['.java'], exclude: [], coverage: [], threshold: 5 } },
      out.io,
    )
    expect(code).toBe(1)
    expect(out.errors).toEqual(['No coverage input given'])
  })
})

describe('the TypeScript path is unchanged', () => {
  it('still runs ESLint, and prints no skipped line', async () => {
    const root = tempRoot('crap-ts-cli')
    writeFileIn(root, 'crap/config.json', JSON.stringify({ coverage: ['coverage/coverage-final.json'] }))
    writeFileIn(root, 'coverage/coverage-final.json', '{}')
    const r = await run(root, 'measure')
    expect(lintScope).toHaveBeenCalledTimes(1)
    expect(r.logs.some((l) => l.startsWith('Classes skipped'))).toBe(false)
  })
})

describe('A1: a scope root that is not an existing directory fails, as for TypeScript', () => {
  const withScope = (scope: string[]): string => {
    const root = javaProject()
    const config = JSON.parse(readFileSync(path.join(root, 'crap/config.json'), 'utf8'))
    writeFileIn(root, 'crap/config.json', JSON.stringify({ ...config, scope }))
    return root
  }
  const TYPO = ['core/src/main/java', 'web/src/main/jav']
  const MESSAGE = 'Invalid crap/config.json: key "scope" entry "web/src/main/jav" is not an existing directory'

  it.each(['measure', 'check', 'baseline'])('%s exits 1 with the TypeScript message and prints no summary', async (command) => {
    const r = await run(withScope(TYPO), command)
    expect(r).toEqual({ code: 1, logs: [], errors: [MESSAGE] })
  })

  /** One aggregated report that lists both modules, as a multi-module JaCoCo report does. */
  const aggregated = (scope: string[]): string => {
    const root = withScope(scope)
    const core = read(root, 'core/build/reports/jacoco/test/jacocoTestReport.xml')
    const web = read(root, 'web/build/reports/jacoco/test/jacocoTestReport.xml')
    const webPackage = web.slice(web.indexOf('<package'), web.indexOf('</package>') + '</package>'.length)
    writeFileIn(root, 'all/jacoco.xml', core.replace('</report>', `${webPackage}</report>`))
    const config = JSON.parse(read(root, 'crap/config.json'))
    writeFileIn(root, 'crap/config.json', JSON.stringify({ ...config, coverage: ['all/jacoco.xml'] }))
    return root
  }

  it('baseline leaves the existing baseline and unmatched files untouched when a root hides a module of one report', async () => {
    const root = aggregated(TYPO)
    const before = [read(root, 'crap/baseline.tsv'), read(root, 'crap/unmatched.tsv')]
    const r = await run(root, 'baseline', '--allow-growth')
    expect(r.errors).toEqual([MESSAGE])
    expect([read(root, 'crap/baseline.tsv'), read(root, 'crap/unmatched.tsv')]).toEqual(before)
  })

  it('the same aggregated report passes with the right roots', async () => {
    expect((await run(aggregated(['core/src/main/java', 'web/src/main/java']), 'check')).code).toBe(0)
  })

  it('fails for a scope entry that is a file', async () => {
    const r = await run(withScope(['core/src/main/java', 'crap/config.json']), 'measure')
    expect(r.errors).toEqual(['Invalid crap/config.json: key "scope" entry "crap/config.json" is not an existing directory'])
  })

  it('still skips and counts a class whose source is under no existing root', async () => {
    const r = await run(javaProject(), 'measure')
    expect(r.code).toBe(0)
    expect(r.logs[0]).toMatch(/^Classes skipped: 1 /)
  })
})

describe('A3: --coverage replaces the configured list, and says so', () => {
  const WEB = 'web/build/reports/jacoco/test/jacocoTestReport.xml'
  const CORE = 'core/build/reports/jacoco/test/jacocoTestReport.xml'
  const NOTE = '--coverage overrides the configured coverage: reading 1 report from the flag, 2 configured reports ignored'

  it('prints one line first when the flag names a different list', async () => {
    const r = await run(javaProject(), 'measure', '--coverage', WEB)
    expect(r.logs[0]).toBe(NOTE)
    expect(r.logs.filter((l) => l.startsWith('--coverage'))).toHaveLength(1)
    expect(r.code).toBe(0)
  })

  it('counts several flags, and says "report" for one configured report', async () => {
    const root = javaProject()
    const config = JSON.parse(read(root, 'crap/config.json'))
    writeFileIn(root, 'crap/config.json', JSON.stringify({ ...config, coverage: [CORE] }))
    const r = await run(root, 'measure', '--coverage', WEB, '--coverage', CORE)
    expect(r.logs[0]).toBe('--coverage overrides the configured coverage: reading 2 reports from the flag, 1 configured report ignored')
  })

  it('prints nothing when the flag names exactly the configured list', async () => {
    const r = await run(javaProject(), 'measure', '--coverage', CORE, '--coverage', WEB)
    expect(r.logs.some((l) => l.startsWith('--coverage'))).toBe(false)
  })

  it('prints nothing without the flag, and check and baseline ignore the flag', async () => {
    expect((await run(javaProject(), 'measure')).logs.some((l) => l.startsWith('--coverage'))).toBe(false)
    const root = javaProject()
    const r = await run(root, 'check')
    expect(r.logs.some((l) => l.startsWith('--coverage'))).toBe(false)
  })

  it('prints nothing for TypeScript, which has always replaced the list silently', async () => {
    const root = tempRoot('crap-ts-flag')
    writeFileIn(root, 'crap/config.json', JSON.stringify({ coverage: ['coverage/coverage-final.json'] }))
    writeFileIn(root, 'coverage/coverage-final.json', '{}')
    writeFileIn(root, 'other.json', '{}')
    const r = await run(root, 'measure', '--coverage', 'other.json')
    expect(r.logs.some((l) => l.startsWith('--coverage'))).toBe(false)
  })
})
