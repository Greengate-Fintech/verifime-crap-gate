import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'
import { runBaseline, runCheck, runMeasure } from '../../src/cli'
import type { MeasureOptions } from '../../src/cli'

// Runs the whole gate (measure, accept, baseline, measure, check) over the copied fixtures plus
// one synthetic offender and one synthetic unmatched function, and records every output.

const FIXTURES = path.join(__dirname, '..', 'fixtures')
const FAKE_ROOT = '/fake/repo'

export interface Observed {
  [step: string]: unknown
}

const readFixture = (name: string): string => readFileSync(path.join(FIXTURES, name), 'utf8')

const hotEslint = (): unknown => ({
  filePath: `${FAKE_ROOT}/src/hot.ts`,
  messages: [
    { ruleId: 'complexity', message: "Function 'hot' has a complexity of 12. Maximum allowed is 0.", line: 3, column: 8 },
    { ruleId: 'complexity', message: "Function 'lost' has a complexity of 9. Maximum allowed is 0.", line: 90, column: 1 },
  ],
})

const hotCoverage = (): unknown => {
  const span = { start: { line: 3, column: 0 }, end: { line: 9, column: 1 } }
  return {
    path: `${FAKE_ROOT}/src/hot.ts`,
    statementMap: {},
    s: {},
    fnMap: { '0': { name: 'hot', decl: span, loc: span } },
    f: { '0': 0 },
    branchMap: {},
    b: {},
  }
}

const eslintText = (root: string): string => {
  const base = JSON.parse(readFixture('eslint.json')) as unknown[]
  return JSON.stringify([...base, hotEslint()], null, 2).split(FAKE_ROOT).join(root)
}

const coverageText = (root: string): string => {
  const base = JSON.parse(readFixture('coverage-final.json')) as Record<string, unknown>
  const all = { ...base, [`${FAKE_ROOT}/src/hot.ts`]: hotCoverage() }
  return JSON.stringify(all, null, 2).split(FAKE_ROOT).join(root)
}

const capture = (root: string) => {
  const logs: string[] = []
  const errors: string[] = []
  const scrub = (s: string): string => s.split(root).join('<root>')
  return {
    io: { log: (s: string) => logs.push(scrub(s)), error: (s: string) => errors.push(scrub(s)) },
    logs,
    errors,
    scrub,
  }
}

type Overrides = Partial<Pick<MeasureOptions, 'config'>>

export const observe = (overrides: Overrides = {}, threshold?: number): Observed => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'crap-parity-')))
  mkdirSync(path.join(root, 'src'))
  mkdirSync(path.join(root, 'coverage'))
  writeFileSync(path.join(root, 'src/sample.ts'), readFixture('sample.ts'))
  writeFileSync(path.join(root, 'coverage/crap-eslint.json'), eslintText(root))
  writeFileSync(path.join(root, 'coverage/coverage-final.json'), coverageText(root))
  const opts: MeasureOptions = {
    eslintPath: path.join(root, 'coverage/crap-eslint.json'),
    coveragePaths: [path.join(root, 'coverage/coverage-final.json')],
    unmatchedListPath: path.join(root, 'crap/unmatched.tsv'),
    acceptUnmatched: false,
    outPath: path.join(root, 'coverage/crap-report.json'),
    repoRoot: root,
    ...overrides,
  }
  const out: Observed = {}
  const measureStep = (name: string, accept: boolean): void => {
    const c = capture(root)
    const code = runMeasure({ ...opts, acceptUnmatched: accept }, c.io)
    out[name] = { code, logs: c.logs, errors: c.errors, report: c.scrub(readFileSync(opts.outPath, 'utf8')) }
  }
  measureStep('measure', false)
  measureStep('measureAccept', true)
  const b = capture(root)
  const bcode = runBaseline(
    {
      reportPath: opts.outPath,
      baselinePath: path.join(root, 'crap/baseline.tsv'),
      unmatchedListPath: opts.unmatchedListPath,
      allowGrowth: false,
      threshold,
    },
    b.io,
  )
  out.baseline = {
    code: bcode,
    logs: b.logs,
    errors: b.errors,
    baselineTsv: readFileSync(path.join(root, 'crap/baseline.tsv'), 'utf8'),
    unmatchedTsv: readFileSync(path.join(root, 'crap/unmatched.tsv'), 'utf8'),
  }
  measureStep('measureListed', false)
  const k = capture(root)
  const kcode = runCheck(
    { reportPath: opts.outPath, baselinePath: path.join(root, 'crap/baseline.tsv'), githubActions: false, threshold },
    k.io,
  )
  out.check = { code: kcode, logs: k.logs, errors: k.errors }
  return out
}
