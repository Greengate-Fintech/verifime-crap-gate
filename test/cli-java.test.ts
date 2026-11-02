import { cpSync, existsSync, mkdirSync, readFileSync, symlinkSync } from 'fs'
import path from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runCli, runMeasure } from '../src/cli'
import { inDirectory, makeIo, tempRoot, writeFileIn } from './helpers/sandbox'

// ESLint must not run for Java: the lint boundary throws, so a Java run that reached it would exit 1.
const lintScope = vi.hoisted(() => vi.fn(async (): Promise<never[]> => []))
const ESLINT_MUST_NOT_RUN = 'ESLint must not run for Java'
vi.mock('../src/eslint', () => ({ lintScope }))

const FIXTURE = path.join(__dirname, 'e2e', 'java-project')
const MEASURE_LINE = 'CRAP measure: functions=10 over5=6 sumOver5=54.0 unmatched=0'
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
  lintScope.mockReset()
  lintScope.mockRejectedValue(new Error(ESLINT_MUST_NOT_RUN))
})

describe('the Java path', () => {
  it.each(['measure', 'check', 'baseline'])('%s succeeds although the ESLint boundary throws, and never calls it', async (command) => {
    const r = await run(javaProject(), command)
    expect(r.errors).toEqual([])
    expect(r.code).toBe(0)
    expect(r.logs).toContain(MEASURE_LINE)
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
    expect(report.summary).toEqual({ functions: 10, over5: 6, sumOver5: 54, unmatched: 0 })
    expect(report.unmatched).toEqual([])
  })

  it('reads JaCoCo files named by --coverage instead of the configured ones', async () => {
    const root = javaProject()
    const r = await run(root, 'measure', '--coverage', 'web/build/reports/jacoco/test/jacocoTestReport.xml')
    expect(r.code).toBe(0)
    expect(r.logs.at(-1)).toBe('CRAP measure: functions=3 over5=2 sumOver5=12.0 unmatched=0')
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
    lintScope.mockResolvedValueOnce([])
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
    lintScope.mockResolvedValueOnce([])
    const root = tempRoot('crap-ts-flag')
    writeFileIn(root, 'crap/config.json', JSON.stringify({ coverage: ['coverage/coverage-final.json'] }))
    writeFileIn(root, 'coverage/coverage-final.json', '{}')
    writeFileIn(root, 'other.json', '{}')
    const r = await run(root, 'measure', '--coverage', 'other.json')
    expect(r.logs.some((l) => l.startsWith('--coverage'))).toBe(false)
  })
})

const CORE_REPORT = 'core/build/reports/jacoco/test/jacocoTestReport.xml'
const WEB_REPORT = 'web/build/reports/jacoco/test/jacocoTestReport.xml'
const SCOPE_MESSAGE = 'Scored no methods: 2 classes skipped (0 not-Java, 0 no source file name, 2 source not found under any scope root, 0 excluded); check "scope" and "extensions"'

const withConfig = (root: string, change: Record<string, unknown>): void => {
  const config = JSON.parse(read(root, 'crap/config.json'))
  writeFileIn(root, 'crap/config.json', JSON.stringify({ ...config, ...change }))
}

describe('T3: a Java run where every class is skipped fails', () => {
  it.each(['measure', 'check', 'baseline'])('%s exits 1 with the no-method problems and "No functions were measured"', async (command) => {
    const root = javaProject()
    mkdirSync(path.join(root, 'empty-root'))
    withConfig(root, { scope: ['empty-root'] })
    const r = await run(root, command)
    expect(r).toEqual({
      code: 1,
      logs: [
        'Classes skipped: 4 (0 not-Java, 0 no source file name, 4 source not found under any scope root, 0 excluded)',
        'CRAP measure: functions=0 over5=0 sumOver5=0.0 unmatched=0',
      ],
      errors: [
        'No functions were measured',
        `Problem: ${CORE_REPORT} ${SCOPE_MESSAGE}`,
        `Problem: ${WEB_REPORT} ${SCOPE_MESSAGE}`,
      ],
    })
  })
})

describe('T4: crap/unmatched.tsv with a Java run', () => {
  const GHOST = 'core/src/main/java/com/example/core/Pricing.java\tPricing#ghost()\n'
  const withGhost = (): string => {
    const root = javaProject()
    writeFileIn(root, 'crap/unmatched.tsv', `${read(root, 'crap/unmatched.tsv')}${GHOST}`)
    return root
  }

  it('check fails on a hand-added entry as a stale unmatched entry, since JaCoCo lists every method', async () => {
    const r = await run(withGhost(), 'check')
    expect(r.code).toBe(1)
    expect(r.errors).toEqual([
      'Stale unmatched entry: core/src/main/java/com/example/core/Pricing.java#Pricing#ghost(); delete this line from crap/unmatched.tsv, or run npm run crap:baseline',
    ])
  })

  it('measure --accept-unmatched passes, marks the report as accepted, and ignores the entry', async () => {
    const root = withGhost()
    const r = await run(root, 'measure', '--accept-unmatched')
    expect(r.code).toBe(0)
    const report = JSON.parse(read(root, 'coverage/crap-report.json'))
    expect(report).toMatchObject({ acceptedUnmatched: true, unmatched: [], listedUnmatched: [], staleUnmatched: [] })
  })

  it('baseline drops the entry and writes an empty unmatched list', async () => {
    const root = withGhost()
    const r = await run(root, 'baseline')
    expect(r.code).toBe(0)
    expect(r.logs.at(-1)).toBe(`CRAP baseline: wrote 0 unmatched rows to ${path.join('crap', 'unmatched.tsv')}`)
    expect(read(root, 'crap/unmatched.tsv')).not.toContain('ghost')
  })
})

describe('T6: pinned behaviour', () => {
  it('reports the invalid key before the missing required key (validate, then require)', async () => {
    const root = tempRoot('crap-java-order')
    writeFileIn(root, 'crap/config.json', '{"language": "java", "threshold": -1}')
    const r = await run(root, 'measure')
    expect(r.errors).toEqual(['Invalid crap/config.json: key "threshold" must be a number greater than 0'])
  })

  it('counts an excluded class in the skipped total', async () => {
    const root = javaProject()
    // The generated class goes, and a Util class beside Pricing is excluded by path, so exactly one class is skipped.
    writeFileIn(root, WEB_REPORT, read(root, WEB_REPORT).replace(/<class name="com\/example\/web\/GeneratedClient"[\s\S]*?<\/class>/, ''))
    writeFileIn(root, 'core/src/main/java/com/example/core/Util.java', 'package com.example.core;\n\npublic class Util {\n}\n')
    writeFileIn(
      root,
      CORE_REPORT,
      read(root, CORE_REPORT).replace(
        '</package>',
        '<class name="com/example/core/Util" sourcefilename="Util.java"><method name="&lt;init&gt;" desc="()V" line="3"><counter type="LINE" missed="0" covered="1"/><counter type="COMPLEXITY" missed="0" covered="1"/></method></class></package>',
      ),
    )
    withConfig(root, { exclude: ['/Util\\.java$'] })
    const r = await run(root, 'measure')
    expect(r.errors).toEqual([])
    expect(r.logs).toEqual([
      'Classes skipped: 1 (0 not-Java, 0 no source file name, 0 source not found under any scope root, 1 excluded)',
      MEASURE_LINE,
    ])
  })

  it('measures through a symlinked repository root', async () => {
    const real = javaProject()
    const link = path.join(tempRoot('crap-java-link'), 'link')
    symlinkSync(real, link)
    const r = await run(link, 'measure')
    expect(r.errors).toEqual([])
    expect(r.logs.at(-1)).toBe(MEASURE_LINE)
  })

  it('fails with the system error when the repository root does not exist', () => {
    const missing = path.join(tempRoot('crap-java-gone'), 'gone')
    const out = makeIo()
    const code = runMeasure(
      { eslintPath: '', coveragePaths: ['a.xml'], unmatchedListPath: 'u.tsv', acceptUnmatched: false, outPath: path.join(tempRoot('crap-java-out'), 'r.json'), repoRoot: missing, config: { language: 'java', scope: ['src'], scopeFrom: 'crap/config.json', anchors: [], extensions: ['.java'], exclude: [], coverage: ['a.xml'], threshold: 5 } },
      out.io,
    )
    expect(code).toBe(1)
    expect(out.errors).toHaveLength(1)
    // The message of the call that resolves the root (not the later scope check).
    expect(out.errors[0]).toBe(`ENOENT: no such file or directory, lstat '${missing}'`)
  })

  it('runMeasure removes an earlier report before a Java measure that fails before it writes one', () => {
    const root = javaProject()
    const outPath = path.join(root, 'coverage/crap-report.json')
    writeFileIn(root, 'coverage/crap-report.json', '{"stale": true}')
    const out = makeIo()
    const config = { language: 'java' as const, scope: ['core/src/main/jav'], scopeFrom: 'crap/config.json', anchors: [], extensions: ['.java'], exclude: [], coverage: [CORE_REPORT], threshold: 5 }
    expect(runMeasure({ eslintPath: '', coveragePaths: [CORE_REPORT], unmatchedListPath: 'crap/unmatched.tsv', acceptUnmatched: false, outPath, repoRoot: root, config }, out.io)).toBe(1)
    expect(existsSync(outPath)).toBe(false)
  })

  it('removes an earlier report when the Java measure fails before it writes one', async () => {
    const root = javaProject()
    writeFileIn(root, 'coverage/crap-report.json', '{"stale": true}')
    withConfig(root, { scope: ['core/src/main/java', 'web/src/main/jav'] })
    const r = await run(root, 'measure')
    expect(r.code).toBe(1)
    expect(existsSync(path.join(root, 'coverage/crap-report.json'))).toBe(false)
  })
})
