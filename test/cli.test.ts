import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'
import { beforeEach, describe, expect, it } from 'vitest'
import { escapeData, escapeProperty, isMoveSuspect, parseArgs, runBaseline, runBaselineDiff, runCheck, runMeasure, summarise } from '../src/cli'
import type { MeasureOptions } from '../src/cli'
import type { Violation } from '../src/ratchet'
import type { FunctionScore } from '../src/types'
import { withPointSpansText } from './helpers/spans'

const FIXTURES = path.join(__dirname, 'fixtures')
const FAKE_ROOT = '/fake/repo'

const readFixture = (name: string): string => readFileSync(path.join(FIXTURES, name), 'utf8')
const withRoot = (text: string, root: string): string => text.split(FAKE_ROOT).join(root)

interface Sandbox {
  root: string
  opts: MeasureOptions
}

const makeSandbox = (): Sandbox => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'crap-cli-')))
  mkdirSync(path.join(root, 'src'))
  mkdirSync(path.join(root, 'coverage'))
  writeFileSync(path.join(root, 'src/sample.ts'), readFixture('sample.ts'))
  return {
    root,
    opts: {
      eslintPath: path.join(root, 'coverage/crap-eslint.json'),
      coveragePaths: [path.join(root, 'coverage/coverage-final.json')],
      unmatchedListPath: path.join(root, 'crap/unmatched.tsv'),
      acceptUnmatched: false,
      outPath: path.join(root, 'coverage/crap-report.json'),
      repoRoot: root,
    },
  }
}

const writeInputs = (box: Sandbox, eslintText = readFixture('eslint.json')): void => {
  writeFileSync(box.opts.eslintPath, withRoot(withPointSpansText(eslintText), box.root))
  writeFileSync(box.opts.coveragePaths[0], withRoot(readFixture('coverage-final.json'), box.root))
}

const makeIo = () => {
  const logs: string[] = []
  const errors: string[] = []
  return { logs, errors, io: { log: (s: string) => logs.push(s), error: (s: string) => errors.push(s) } }
}

describe('runMeasure', () => {
  let box: Sandbox
  beforeEach(() => {
    box = makeSandbox()
  })

  it('returns 1 naming the ESLint file when it is missing', () => {
    const { io, errors } = makeIo()
    const missing = { ...box.opts, eslintPath: path.join(box.root, 'coverage/nope-eslint.json') }
    expect(runMeasure(missing, io)).toBe(1)
    expect(errors.join('\n')).toContain('nope-eslint.json')
  })

  it('returns 1 naming the coverage file when it is missing', () => {
    writeInputs(box)
    const { io, errors } = makeIo()
    const missing = { ...box.opts, coveragePaths: [path.join(box.root, 'coverage/nope-cov.json')] }
    expect(runMeasure(missing, io)).toBe(1)
    expect(errors.join('\n')).toContain('nope-cov.json')
  })

  it('returns 1 when zero functions are measured', () => {
    writeInputs(box, '[]')
    const { io, errors } = makeIo()
    expect(runMeasure(box.opts, io)).toBe(1)
    expect(errors.join('\n')).toMatch(/no functions/i)
  })

  it('returns 1 naming the file when an input is not JSON', () => {
    writeInputs(box)
    writeFileSync(box.opts.eslintPath, 'not json {')
    const { io, errors } = makeIo()
    expect(runMeasure(box.opts, io)).toBe(1)
    expect(errors.join('\n')).toContain('crap-eslint.json')
  })

  it('removes a stale report when the run fails', () => {
    writeInputs(box)
    writeFileSync(box.opts.outPath, '{"stale":true}')
    const { io } = makeIo()
    const missing = { ...box.opts, eslintPath: path.join(box.root, 'coverage/nope-eslint.json') }
    expect(runMeasure(missing, io)).toBe(1)
    expect(existsSync(box.opts.outPath)).toBe(false)
  })

  it('returns 1 naming file, line and text for a parse error message', () => {
    const eslint = JSON.parse(readFixture('eslint.json'))
    eslint[0].messages.push({
      ruleId: null,
      fatal: true,
      severity: 2,
      message: 'Parsing error: Unexpected token',
      line: 42,
      column: 1,
    })
    writeInputs(box, JSON.stringify(eslint))
    const { io, errors } = makeIo()
    expect(runMeasure(box.opts, io)).toBe(1)
    expect(errors.join('\n')).toContain('src/sample.ts:42')
    expect(errors.join('\n')).toContain('Parsing error: Unexpected token')
  })

  it('returns 1 for a message from another rule', () => {
    const eslint = JSON.parse(readFixture('eslint.json'))
    eslint[0].messages.push({
      ruleId: 'no-unused-vars',
      message: "'x' is unused",
      line: 7,
      column: 1,
    })
    writeInputs(box, JSON.stringify(eslint))
    const { io, errors } = makeIo()
    expect(runMeasure(box.opts, io)).toBe(1)
    expect(errors.join('\n')).toContain('no-unused-vars')
  })

  it('returns 1 for a reworded complexity message', () => {
    const eslint = JSON.parse(readFixture('eslint.json'))
    eslint[0].messages.push({
      ruleId: 'complexity',
      message: 'Too twisty',
      line: 8,
      column: 1,
    })
    writeInputs(box, JSON.stringify(eslint))
    const { io, errors } = makeIo()
    expect(runMeasure(box.opts, io)).toBe(1)
    expect(errors.join('\n')).toContain('Too twisty')
  })

  it('returns 1 naming an in-scope coverage file that ESLint did not cover', () => {
    writeInputs(box)
    const coverage = JSON.parse(readFileSync(box.opts.coveragePaths[0], 'utf8'))
    const [entry] = Object.values(coverage)
    coverage[path.join(box.root, 'src/other.ts')] = entry
    writeFileSync(box.opts.coveragePaths[0], JSON.stringify(coverage))
    const { io, errors } = makeIo()
    expect(runMeasure(box.opts, io)).toBe(1)
    expect(errors.join('\n')).toContain('src/other.ts')
  })

  it('returns 1 and lists every function when coverage has only foreign keys', () => {
    writeInputs(box)
    const coverage = JSON.parse(readFileSync(box.opts.coveragePaths[0], 'utf8'))
    const [entry] = Object.values(coverage)
    writeFileSync(box.opts.coveragePaths[0], JSON.stringify({ '/elsewhere/thing.ts': entry }))
    const { io, errors } = makeIo()
    expect(runMeasure(box.opts, io)).toBe(1)
    expect(errors.filter((e) => e.startsWith('Unmatched function'))).toHaveLength(7)
  })

  it('prints the failure lines before the summary line', () => {
    const eslint = JSON.parse(readFixture('eslint.json'))
    eslint[0].messages.push({ ruleId: 'complexity', message: 'Too twisty', line: 8, column: 1 })
    writeInputs(box, JSON.stringify(eslint))
    const order: string[] = []
    const io = { log: () => order.push('log'), error: () => order.push('error') }
    runMeasure(box.opts, io)
    expect(order[0]).toBe('error')
    expect(order[order.length - 1]).toBe('log')
  })

  it('returns 1 and lists each unmatched entry', () => {
    const eslint = JSON.parse(readFixture('eslint.json'))
    eslint[0].messages.push({
      ruleId: 'complexity',
      message: "Function 'ghost' has a complexity of 3. Maximum allowed is 0.",
      line: 99,
      column: 1,
    })
    writeInputs(box, JSON.stringify(eslint))
    const { io, errors } = makeIo()
    expect(runMeasure(box.opts, io)).toBe(1)
    const out = errors.join('\n')
    expect(out).toContain('src/sample.ts')
    expect(out).toContain('ghost')
    expect(out).toContain('99')
  })

  it('returns 0, writes the report and prints the summary line', () => {
    writeInputs(box)
    const { io, logs } = makeIo()
    expect(runMeasure(box.opts, io)).toBe(0)
    const report = JSON.parse(readFileSync(box.opts.outPath, 'utf8'))
    expect(report.summary).toEqual({ functions: 7, over5: 0, sumOver5: 0, unmatched: 0 })
    expect(report.functions).toHaveLength(7)
    expect(report.unmatched).toEqual([])
    expect(logs).toEqual(['CRAP measure: functions=7 over5=0 sumOver5=0.0 unmatched=0'])
  })
})

describe('runMeasure: several coverage files', () => {
  const CDK_MESSAGE = {
    ruleId: 'complexity',
    message: "Method 'build' has a complexity of 3. Maximum allowed is 0.",
    line: 3,
    column: 3,
  }
  const cdkSpan = { start: { line: 3, column: 2 }, end: { line: 9, column: 3 } }
  const cdkCoverage = (root: string) => ({
    [`${root}/cdk/lib/stack.ts`]: {
      path: `${root}/cdk/lib/stack.ts`,
      statementMap: {},
      s: {},
      fnMap: { '0': { name: 'build', decl: cdkSpan, loc: cdkSpan } },
      f: { '0': 1 },
      branchMap: {},
      b: {},
    },
  })
  const withCdk = (box: Sandbox): string => {
    const eslint = JSON.parse(withRoot(readFixture('eslint.json'), box.root))
    eslint.push({ filePath: `${box.root}/cdk/lib/stack.ts`, messages: [CDK_MESSAGE] })
    mkdirSync(path.join(box.root, 'cdk/lib'), { recursive: true })
    mkdirSync(path.join(box.root, 'cdk/coverage'), { recursive: true })
    writeFileSync(box.opts.eslintPath, withPointSpansText(JSON.stringify(eslint)))
    const cdkCoveragePath = path.join(box.root, 'cdk/coverage/coverage-final.json')
    writeFileSync(cdkCoveragePath, JSON.stringify(cdkCoverage(box.root)))
    return cdkCoveragePath
  }

  it('merges the coverage of every file, so root and cdk functions are all measured', () => {
    const box = makeSandbox()
    writeInputs(box)
    const cdkCoveragePath = withCdk(box)
    const { io, errors } = makeIo()
    const code = runMeasure({ ...box.opts, coveragePaths: [...box.opts.coveragePaths, cdkCoveragePath] }, io)
    expect(errors).toEqual([])
    expect(code).toBe(0)
    const report = JSON.parse(readFileSync(box.opts.outPath, 'utf8'))
    expect(report.functions).toHaveLength(8)
    expect(report.functions.filter((f: FunctionScore) => f.file === 'cdk/lib/stack.ts')).toHaveLength(1)
  })

  it('fails closed, naming the file, when any one coverage file is missing', () => {
    const box = makeSandbox()
    writeInputs(box)
    const missing = path.join(box.root, 'cdk/coverage/coverage-final.json')
    const { io, errors } = makeIo()
    expect(runMeasure({ ...box.opts, coveragePaths: [...box.opts.coveragePaths, missing] }, io)).toBe(1)
    expect(errors.join('\n')).toContain(missing)
    expect(existsSync(box.opts.outPath)).toBe(false)
  })

  it('fails closed when two coverage files carry the same source file', () => {
    const box = makeSandbox()
    writeInputs(box)
    const { io, errors } = makeIo()
    const twice = [...box.opts.coveragePaths, ...box.opts.coveragePaths]
    expect(runMeasure({ ...box.opts, coveragePaths: twice }, io)).toBe(1)
    expect(errors.join('\n')).toMatch(/more than one coverage file/i)
  })

  it('fails closed when no coverage file is given', () => {
    const box = makeSandbox()
    writeInputs(box)
    const { io, errors } = makeIo()
    expect(runMeasure({ ...box.opts, coveragePaths: [] }, io)).toBe(1)
    expect(errors.join('\n')).toMatch(/no coverage/i)
  })
})

describe('runMeasure: the known unmatched list', () => {
  const GHOST = {
    ruleId: 'complexity',
    message: "Function 'ghost' has a complexity of 3. Maximum allowed is 0.",
    line: 99,
    column: 1,
  }
  const withGhost = (box: Sandbox): void => {
    const eslint = JSON.parse(readFixture('eslint.json'))
    eslint[0].messages.push(GHOST)
    writeInputs(box, JSON.stringify(eslint))
  }
  const writeList = (box: Sandbox, ...rows: string[]): void => {
    mkdirSync(path.dirname(box.opts.unmatchedListPath), { recursive: true })
    writeFileSync(box.opts.unmatchedListPath, `# list\n${rows.map((r) => `${r}\n`).join('')}`)
  }
  const readReport = (box: Sandbox) => JSON.parse(readFileSync(box.opts.outPath, 'utf8'))

  it('scores a listed unmatched function at coverage 0 and passes', () => {
    const box = makeSandbox()
    withGhost(box)
    writeList(box, 'src/sample.ts\tghost')
    const { io, errors, logs } = makeIo()
    expect(runMeasure(box.opts, io)).toBe(0)
    expect(errors).toEqual([])
    const report = readReport(box)
    const ghost = report.functions.find((f: FunctionScore) => f.symbol === 'ghost')
    expect(ghost).toEqual({
      file: 'src/sample.ts', symbol: 'ghost', kind: 'Function', line: 99, cc: 3, cov: 0, covKind: 'unmatched', crap: 12,
    })
    expect(report.summary).toEqual({ functions: 8, over5: 1, sumOver5: 12, unmatched: 0 })
    expect(report.unmatched).toEqual([])
    expect(report.listedUnmatched).toHaveLength(1)
    expect(logs).toEqual(['CRAP measure: functions=8 over5=1 sumOver5=12.0 unmatched=0'])
  })

  it('fails an unmatched function that is not on the list, and keeps it out of the scored functions', () => {
    const box = makeSandbox()
    withGhost(box)
    writeList(box, 'src/sample.ts\tsomeone-else')
    const { io, errors } = makeIo()
    expect(runMeasure(box.opts, io)).toBe(1)
    expect(errors.some((e) => e.startsWith('Unmatched function: src/sample.ts:99 ghost'))).toBe(true)
    const report = readReport(box)
    expect(report.unmatched.map((u: { symbol: string }) => u.symbol)).toEqual(['ghost'])
    expect(report.functions.some((f: FunctionScore) => f.symbol === 'ghost')).toBe(false)
  })

  it('fails a listed entry that now matches, as stale', () => {
    const box = makeSandbox()
    writeInputs(box)
    writeList(box, 'src/sample.ts\tnamedFunction')
    const { io, errors } = makeIo()
    expect(runMeasure(box.opts, io)).toBe(1)
    expect(errors.some((e) => e.startsWith('Stale unmatched entry: src/sample.ts#namedFunction'))).toBe(true)
    expect(readReport(box).staleUnmatched).toEqual([{ file: 'src/sample.ts', symbol: 'namedFunction' }])
  })

  it('records a stale entry in the report so a later standalone check cannot pass it', () => {
    const box = makeSandbox()
    writeInputs(box)
    writeList(box, 'src/sample.ts\tnamedFunction')
    runMeasure(box.opts, makeIo().io)
    const out = makeIo()
    const baselinePath = path.join(box.root, 'baseline.tsv')
    writeFileSync(baselinePath, '')
    const code = runCheck({ reportPath: box.opts.outPath, baselinePath, githubActions: false }, out.io)
    expect(code).toBe(1)
    expect(out.errors.join('\n')).toContain('Stale unmatched entry')
  })

  it('fails when the list is missing, treating every unmatched function as unlisted', () => {
    const box = makeSandbox()
    withGhost(box)
    const { io, errors } = makeIo()
    expect(runMeasure(box.opts, io)).toBe(1)
    expect(errors.some((e) => e.startsWith('Unmatched function'))).toBe(true)
  })

  it('fails naming the list file when it is malformed', () => {
    const box = makeSandbox()
    withGhost(box)
    writeList(box, 'not-a-row')
    const { io, errors } = makeIo()
    expect(runMeasure(box.opts, io)).toBe(1)
    expect(errors.join('\n')).toContain('unmatched.tsv')
  })

  it('records acceptedUnmatched in the report only when acceptUnmatched was used', () => {
    const box = makeSandbox()
    withGhost(box)
    writeList(box, 'src/sample.ts\tghost')
    runMeasure(box.opts, makeIo().io)
    expect(readReport(box).acceptedUnmatched).toBe(false)
    runMeasure({ ...box.opts, acceptUnmatched: true }, makeIo().io)
    expect(readReport(box).acceptedUnmatched).toBe(true)
  })

  it('makes a standalone check refuse a report produced with acceptUnmatched', () => {
    const box = makeSandbox()
    withGhost(box)
    runMeasure({ ...box.opts, acceptUnmatched: true }, makeIo().io)
    const baselinePath = path.join(box.root, 'baseline.tsv')
    writeFileSync(baselinePath, '')
    const out = makeIo()
    expect(runCheck({ reportPath: box.opts.outPath, baselinePath, githubActions: false }, out.io)).toBe(1)
    expect(out.errors.join('\n')).toMatch(/accept-unmatched/)
  })

  it('still lets baseline read a report produced with acceptUnmatched', () => {
    const box = makeSandbox()
    withGhost(box)
    runMeasure({ ...box.opts, acceptUnmatched: true }, makeIo().io)
    const baselinePath = path.join(box.root, 'baseline.tsv')
    const unmatchedListPath = path.join(box.root, 'unmatched.tsv')
    const out = makeIo()
    expect(runBaseline({ reportPath: box.opts.outPath, baselinePath, unmatchedListPath, allowGrowth: false }, out.io)).toBe(0)
  })

  it('with acceptUnmatched, scores every unmatched function as listed and never reports stale', () => {
    const box = makeSandbox()
    withGhost(box)
    writeList(box, 'src/sample.ts\tnamedFunction')
    const { io, errors } = makeIo()
    expect(runMeasure({ ...box.opts, acceptUnmatched: true }, io)).toBe(0)
    expect(errors).toEqual([])
    const report = readReport(box)
    expect(report.unmatched).toEqual([])
    expect(report.staleUnmatched).toEqual([])
    expect(report.listedUnmatched.map((u: { symbol: string }) => u.symbol)).toEqual(['ghost'])
  })
})

describe('summarise', () => {
  const fn = (crap: number): FunctionScore => ({
    file: 'src/a.ts', symbol: 'f', kind: 'Function', line: 1, cc: 1, cov: 1, covKind: 'stmt', crap,
  })

  it('rounds sumOver5 half to even at the exact tie 18.25', () => {
    const m = { functions: [fn(9.125), fn(9.125)], unmatched: [], problems: [] }
    expect(summarise(m).sumOver5).toBe(18.2)
  })

  it('treats a CRAP of exactly 8 as not over the threshold', () => {
    const m = { functions: [fn(8), fn(8.001)], unmatched: [], problems: [] }
    expect(summarise(m)).toMatchObject({ over5: 1, sumOver5: 8 })
  })
})

const fn = (file: string, symbol: string, crap: number, line = 1): FunctionScore => ({
  file,
  symbol,
  kind: 'function',
  line,
  cc: 1,
  cov: 1,
  covKind: 'stmt',
  crap,
})

interface RatchetBox {
  reportPath: string
  baselinePath: string
  unmatchedListPath: string
}

const makeRatchetBox = (functions: FunctionScore[] | null, baseline: string | null): RatchetBox => {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'crap-ratchet-')))
  const box = {
    reportPath: path.join(dir, 'crap-report.json'),
    baselinePath: path.join(dir, 'baseline.tsv'),
    unmatchedListPath: path.join(dir, 'unmatched.tsv'),
  }
  if (functions) writeFileSync(box.reportPath, JSON.stringify({ summary: {}, functions, unmatched: [] }))
  if (baseline !== null) writeFileSync(box.baselinePath, baseline)
  return box
}

const makeRawBox = (report: unknown, baseline: string | null): RatchetBox => {
  const box = makeRatchetBox(null, baseline)
  writeFileSync(box.reportPath, JSON.stringify(report))
  return box
}

const row = (file: string, symbol: string, score: string): string => `${file}\t${symbol}\t${score}\n`

describe('runCheck', () => {
  const check = (box: RatchetBox, githubActions = false) => {
    const out = makeIo()
    return { code: runCheck({ ...box, githubActions }, out.io), ...out }
  }

  it('returns 1 naming the baseline file when it is missing', () => {
    const box = makeRatchetBox([fn('src/a.ts', 'f', 1)], null)
    const { code, errors } = check(box)
    expect(code).toBe(1)
    expect(errors.join('\n')).toContain('baseline.tsv')
  })

  it('returns 1 naming the report file when it is missing', () => {
    const box = makeRatchetBox(null, '')
    const { code, errors } = check(box)
    expect(code).toBe(1)
    expect(errors.join('\n')).toContain('crap-report.json')
  })

  it('returns 1 naming the baseline file when it is malformed', () => {
    const box = makeRatchetBox([fn('src/a.ts', 'f', 1)], 'not a row\n')
    const { code, errors } = check(box)
    expect(code).toBe(1)
    expect(errors.join('\n')).toContain('baseline.tsv')
  })

  it('passes and reports frozen and measured counts', () => {
    const box = makeRatchetBox(
      [fn('src/a.ts', 'f', 20), fn('src/a.ts', 'g', 20), fn('src/b.ts', 'h', 1)],
      row('src/a.ts', 'f', '20.000') + row('src/a.ts', 'g', '20.000'),
    )
    const { code, logs } = check(box)
    expect(code).toBe(0)
    expect(logs).toContain('CRAP ratchet: pass (2 frozen, 3 functions measured)')
  })

  it('reports a new offender', () => {
    const box = makeRatchetBox([fn('src/x.ts', 'foo', 72)], '')
    const { code, errors } = check(box)
    expect(code).toBe(1)
    expect(errors).toContain(
      'CRAP ratchet: NEW OFFENDER src/x.ts#foo scores 72.0, above the threshold of 8, and is not in crap/baseline.tsv',
    )
  })

  it('reports a regression', () => {
    const box = makeRatchetBox([fn('src/x.ts', 'foo', 25)], row('src/x.ts', 'foo', '20.000'))
    const { code, errors } = check(box)
    expect(code).toBe(1)
    expect(errors).toContain('CRAP ratchet: REGRESSION src/x.ts#foo was frozen at 20.0 but now scores 25.0')
  })

  it('reports a stale entry with the deletion advice', () => {
    const box = makeRatchetBox([fn('src/x.ts', 'foo', 2)], row('src/x.ts', 'foo', '20.000'))
    const { code, errors } = check(box)
    expect(code).toBe(1)
    expect(errors).toContain(
      'CRAP ratchet: STALE ENTRY src/x.ts#foo was frozen at 20.0 but now scores 2.0, at or below the threshold of 8; delete this line from crap/baseline.tsv, or run npm run crap:baseline',
    )
  })

  it('prints the moved or renamed hint when a new offender and a stale entry differ in key', () => {
    const box = makeRatchetBox([fn('src/x.ts', 'renamed', 30)], row('src/x.ts', 'foo', '30.000'))
    const { errors } = check(box)
    expect(errors).toContain(
      'If a frozen function was moved or renamed, run npm run crap:baseline -- --allow-growth and say why in the PR body.',
    )
  })

  it('omits the hint when there is no new offender', () => {
    const box = makeRatchetBox([fn('src/x.ts', 'foo', 2)], row('src/x.ts', 'foo', '20.000'))
    expect(check(box).errors.join('\n')).not.toContain('moved or renamed')
  })

  it('emits GitHub annotations with the current line for new and regression, none for stale', () => {
    const box = makeRatchetBox(
      [fn('src/n.ts', 'n', 72, 7), fn('src/r.ts', 'r', 25, 11), fn('src/s.ts', 's', 2, 3)],
      row('src/r.ts', 'r', '20.000') + row('src/s.ts', 's', '20.000'),
    )
    const { errors } = check(box, true)
    const annotations = errors.filter((e) => e.startsWith('::error'))
    expect(annotations).toHaveLength(3)
    expect(annotations.some((a) => a.startsWith('::error file=src/n.ts,line=7::CRAP ratchet: NEW OFFENDER'))).toBe(true)
    expect(annotations.some((a) => a.startsWith('::error file=src/r.ts,line=11::CRAP ratchet: REGRESSION'))).toBe(true)
    expect(annotations.some((a) => a.startsWith('::error file=src/s.ts::CRAP ratchet: STALE ENTRY'))).toBe(true)
  })

  it('rejects a report row with a non-finite crap, naming the file and the row', () => {
    const bad = { file: 'src/x.ts', symbol: 'foo', crap: null }
    const box = makeRawBox({ functions: [fn('src/a.ts', 'f', 1), bad], unmatched: [] }, '')
    const { code, errors } = check(box)
    expect(code).toBe(1)
    expect(errors.join('\n')).toContain('crap-report.json')
    expect(errors.join('\n')).toContain('"symbol":"foo"')
  })

  it.each([
    ['NaN', { file: 'a', symbol: 'f', crap: 'NaN' }],
    ['a string crap', { file: 'a', symbol: 'f', crap: '9' }],
    ['a missing crap', { file: 'a', symbol: 'f' }],
    ['a non-string file', { file: 3, symbol: 'f', crap: 9 }],
    ['a non-string symbol', { file: 'a', symbol: null, crap: 9 }],
    ['a null row', null],
  ])('rejects %s', (_name, bad) => {
    const box = makeRawBox({ functions: [bad], unmatched: [] }, '')
    expect(check(box).code).toBe(1)
  })

  it('fails when the report holds zero functions, even with a header-only baseline', () => {
    const box = makeRatchetBox([], '# header only\n')
    const { code, errors } = check(box)
    expect(code).toBe(1)
    expect(errors.join('\n')).toMatch(/no functions/i)
  })

  it('fails when the report lists unmatched functions, naming them', () => {
    const unmatched = [{ file: 'src/u.ts', line: 4, symbol: 'ghost', cc: 3 }]
    const box = makeRawBox({ functions: [fn('src/a.ts', 'f', 1)], unmatched }, '')
    const { code, errors } = check(box)
    expect(code).toBe(1)
    expect(errors.join('\n')).toContain('ghost')
  })

  it('fails when the report carries problems, naming them', () => {
    const problems = [{ file: 'src/p.ts', message: 'Parsing error: nope' }]
    const box = makeRawBox({ functions: [fn('src/a.ts', 'f', 1)], unmatched: [], problems }, '')
    const { code, errors } = check(box)
    expect(code).toBe(1)
    expect(errors.join('\n')).toContain('Parsing error: nope')
  })

  it.each([['an empty object', {}], ['a non-array functions', { functions: 'x' }]])(
    'fails on a report that is %s',
    (_name, report) => {
      expect(check(makeRawBox(report, '')).code).toBe(1)
    },
  )

  it('passes a frozen 72.000 against a current 72.0004', () => {
    const box = makeRatchetBox([fn('src/x.ts', 'foo', 72.0004)], row('src/x.ts', 'foo', '72.000'))
    expect(check(box).code).toBe(0)
  })

  it('reports one STALE when a same-named function was removed, through the baseline text', () => {
    const box = makeRatchetBox(
      [fn('src/x.ts', 'foo', 72), fn('src/y.ts', 'ok', 1)],
      row('src/x.ts', 'foo', '10.000') + row('src/x.ts', 'foo', '72.000'),
    )
    const { code, errors } = check(box)
    expect(code).toBe(1)
    expect(errors.filter((e) => e.includes('STALE ENTRY'))).toHaveLength(1)
    expect(errors.filter((e) => e.includes('NEW OFFENDER'))).toHaveLength(0)
  })

  it('reports one NEW when a same-named function was added, through the baseline text', () => {
    const box = makeRatchetBox(
      [fn('src/x.ts', 'foo', 10), fn('src/x.ts', 'foo', 72)],
      row('src/x.ts', 'foo', '72.000'),
    )
    const { code, errors } = check(box)
    expect(code).toBe(1)
    expect(errors.filter((e) => e.includes('NEW OFFENDER'))).toHaveLength(1)
  })

  it('prints the hint once with a REGRESSION alongside NEW and STALE on different keys', () => {
    const box = makeRatchetBox(
      [fn('src/r.ts', 'r', 25), fn('src/x.ts', 'renamed', 30)],
      row('src/r.ts', 'r', '20.000') + row('src/x.ts', 'foo', '30.000'),
    )
    const { errors } = check(box)
    expect(errors.some((e) => e.includes('REGRESSION'))).toBe(true)
    expect(errors.filter((e) => e.startsWith('If a frozen function was moved or renamed'))).toHaveLength(1)
  })

  it('accepts an empty baseline file and a header-only baseline', () => {
    expect(check(makeRatchetBox([fn('src/a.ts', 'f', 1)], '')).code).toBe(0)
    expect(check(makeRatchetBox([fn('src/a.ts', 'f', 1)], '# header\n\n')).code).toBe(0)
  })

  it('escapes annotation properties and data per the workflow command rules', () => {
    const box = makeRatchetBox([fn('src/a,b:c.ts', 'sym,100%', 72, 5)], '')
    const annotations = check(box, true).errors.filter((e) => e.startsWith('::error'))
    expect(annotations).toHaveLength(1)
    expect(annotations[0]).toContain('::error file=src/a%2Cb%3Ac.ts,line=5::CRAP ratchet: NEW OFFENDER')
    expect(annotations[0]).toContain('sym,100%25')
  })

  it('gives same-named anonymous functions at different lines their own annotation lines', () => {
    const box = makeRatchetBox(
      [fn('src/x.ts', 'map callback', 72, 10), fn('src/x.ts', 'map callback', 30, 20)],
      '',
    )
    const annotations = check(box, true).errors.filter((e) => e.startsWith('::error'))
    expect(annotations.some((a) => a.includes('line=10::') && a.includes('scores 72.0'))).toBe(true)
    expect(annotations.some((a) => a.includes('line=20::') && a.includes('scores 30.0'))).toBe(true)
  })

  it('emits no annotations when githubActions is false', () => {
    const box = makeRatchetBox([fn('src/n.ts', 'n', 72, 7)], '')
    expect(check(box).errors.some((e) => e.startsWith('::error'))).toBe(false)
  })
})

describe('runBaseline', () => {
  const baseline = (box: RatchetBox, allowGrowth = false) => {
    const out = makeIo()
    return { code: runBaseline({ ...box, allowGrowth }, out.io), ...out }
  }

  it('writes every current violator when no baseline exists', () => {
    const box = makeRatchetBox([fn('src/a.ts', 'f', 20), fn('src/b.ts', 'g', 1)], null)
    expect(baseline(box).code).toBe(0)
    const text = readFileSync(box.baselinePath, 'utf8')
    expect(text).toContain('src/a.ts\tf\t20.000')
    expect(text).not.toContain('src/b.ts')
  })

  it('returns 1, lists refused entries and leaves the file byte-identical on growth without the flag', () => {
    const original = row('src/a.ts', 'f', '20.000')
    const box = makeRatchetBox([fn('src/a.ts', 'f', 25), fn('src/n.ts', 'n', 72)], original)
    const { code, errors } = baseline(box)
    expect(code).toBe(1)
    expect(readFileSync(box.baselinePath, 'utf8')).toBe(original)
    expect(errors.join('\n')).toContain('src/a.ts#f')
    expect(errors.join('\n')).toContain('src/n.ts#n')
  })

  it('writes the grown file with allowGrowth', () => {
    const box = makeRatchetBox([fn('src/a.ts', 'f', 25), fn('src/n.ts', 'n', 72)], row('src/a.ts', 'f', '20.000'))
    expect(baseline(box, true).code).toBe(0)
    const text = readFileSync(box.baselinePath, 'utf8')
    expect(text).toContain('src/a.ts\tf\t25.000')
    expect(text).toContain('src/n.ts\tn\t72.000')
  })

  it('shrinks the baseline without the flag', () => {
    const box = makeRatchetBox([fn('src/a.ts', 'f', 2)], row('src/a.ts', 'f', '20.000'))
    expect(baseline(box).code).toBe(0)
    expect(readFileSync(box.baselinePath, 'utf8')).not.toContain('src/a.ts')
  })

  it.each([['tab', 'a\tb.ts'], ['line feed', 'a\nb.ts'], ['carriage return', 'a\rb.ts']])(
    'rejects a file containing a %s and leaves the baseline untouched',
    (_name, file) => {
      const original = row('src/a.ts', 'f', '20.000')
      const box = makeRatchetBox([fn(file, 'f', 20)], original)
      expect(baseline(box, true).code).toBe(1)
      expect(readFileSync(box.baselinePath, 'utf8')).toBe(original)
    },
  )

  it('rejects a symbol containing a tab and does not create a baseline', () => {
    const box = makeRatchetBox([fn('src/a.ts', 'f\tg', 20)], null)
    expect(baseline(box).code).toBe(1)
    expect(existsSync(box.baselinePath)).toBe(false)
  })

  it('refuses a report with zero functions or a bad row, leaving the baseline untouched', () => {
    const original = row('src/a.ts', 'f', '20.000')
    const empty = makeRatchetBox([], original)
    expect(baseline(empty, true).code).toBe(1)
    expect(readFileSync(empty.baselinePath, 'utf8')).toBe(original)
    const bad = makeRawBox({ functions: [{ file: 'a', symbol: 'f', crap: null }], unmatched: [] }, original)
    expect(baseline(bad, true).code).toBe(1)
  })

  it('prints the same text for a refused violation as the check does', () => {
    const functions = [fn('src/a.ts', 'f', 25), fn('src/n.ts', 'n', 72)]
    const box = makeRatchetBox(functions, row('src/a.ts', 'f', '20.000'))
    const refused = baseline(box).errors.join('\n')
    const checked = makeIo()
    runCheck({ ...box, githubActions: false }, checked.io)
    for (const text of [
      'src/a.ts#f was frozen at 20.0 but now scores 25.0',
      'src/n.ts#n scores 72.0, above the threshold of 8, and is not in crap/baseline.tsv',
    ]) {
      expect(refused).toContain(text)
      expect(checked.errors.join('\n')).toContain(text)
    }
  })

  it('returns 1 naming the report when it is missing', () => {
    const box = makeRatchetBox(null, null)
    const { code, errors } = baseline(box)
    expect(code).toBe(1)
    expect(errors.join('\n')).toContain('crap-report.json')
  })
})

describe('runBaseline: the known unmatched list', () => {
  const um = (symbol: string) => ({ file: 'src/a.ts', symbol, line: 1, cc: 5, kind: 'Function' })
  const boxWith = (listed: ReturnType<typeof um>[], functions: FunctionScore[], baseline: string | null, list: string | null) => {
    const box = makeRawBox({ summary: {}, functions, unmatched: [], listedUnmatched: listed }, baseline)
    if (list !== null) writeFileSync(box.unmatchedListPath, list)
    return box
  }
  const baseline = (box: RatchetBox, allowGrowth = false) => {
    const out = makeIo()
    return { code: runBaseline({ ...box, allowGrowth }, out.io), ...out }
  }
  const rowsOf = (file: string): string[] =>
    readFileSync(file, 'utf8').split('\n').filter((l) => l !== '' && !l.startsWith('#'))

  it('freezes the listed unmatched functions when no list exists, beside the baseline', () => {
    const box = boxWith([um('f'), um('g')], [fn('src/a.ts', 'f', 30)], null, null)
    expect(baseline(box).code).toBe(0)
    expect(rowsOf(box.unmatchedListPath)).toEqual(['src/a.ts\tf', 'src/a.ts\tg'])
    expect(rowsOf(box.baselinePath)).toEqual(['src/a.ts\tf\t30.000'])
  })

  it('writes a header-only list when nothing is unmatched', () => {
    const box = boxWith([], [fn('src/a.ts', 'f', 30)], null, null)
    expect(baseline(box).code).toBe(0)
    expect(rowsOf(box.unmatchedListPath)).toEqual([])
  })

  it('refuses list growth, writing neither file', () => {
    const list = 'src/a.ts\tf\n'
    const original = row('src/a.ts', 'f', '30.000')
    const box = boxWith([um('f'), um('new')], [fn('src/a.ts', 'f', 30)], original, list)
    const { code, errors } = baseline(box)
    expect(code).toBe(1)
    expect(readFileSync(box.unmatchedListPath, 'utf8')).toBe(list)
    expect(readFileSync(box.baselinePath, 'utf8')).toBe(original)
    expect(errors.join('\n')).toContain('src/a.ts#new')
    expect(errors.join('\n')).toMatch(/unmatched/i)
  })

  it('takes list growth with allowGrowth', () => {
    const box = boxWith([um('f'), um('new')], [fn('src/a.ts', 'f', 30)], row('src/a.ts', 'f', '30.000'), 'src/a.ts\tf\n')
    expect(baseline(box, true).code).toBe(0)
    expect(rowsOf(box.unmatchedListPath)).toEqual(['src/a.ts\tf', 'src/a.ts\tnew'])
  })

  it('drops a listed entry that no longer occurs', () => {
    const box = boxWith([um('f')], [fn('src/a.ts', 'f', 30)], row('src/a.ts', 'f', '30.000'), 'src/a.ts\tf\nsrc/a.ts\tgone\n')
    expect(baseline(box).code).toBe(0)
    expect(rowsOf(box.unmatchedListPath)).toEqual(['src/a.ts\tf'])
  })

  it('fails naming the list when it is malformed', () => {
    const box = boxWith([um('f')], [fn('src/a.ts', 'f', 30)], null, 'not-a-row\n')
    const { code, errors } = baseline(box)
    expect(code).toBe(1)
    expect(errors.join('\n')).toContain('unmatched.tsv')
  })
})

describe('parseArgs', () => {
  it('parses measure', () => {
    expect(parseArgs(['measure'], {})).toEqual({
      command: 'measure',
      coveragePaths: ['coverage/coverage-final.json', 'cdk/coverage/coverage-final.json'],
      acceptUnmatched: false,
    })
  })
  it('takes a repeatable --coverage that replaces the default coverage files', () => {
    expect(parseArgs(['measure', '--coverage', 'a.json', '--coverage', 'b.json'], {})).toEqual({
      command: 'measure',
      coveragePaths: ['a.json', 'b.json'],
      acceptUnmatched: false,
    })
  })
  it('parses --accept-unmatched on measure', () => {
    expect(parseArgs(['measure', '--accept-unmatched'], {})).toMatchObject({ command: 'measure', acceptUnmatched: true })
  })
  it('returns usage for a --coverage with no value, or a value that is a flag', () => {
    expect(parseArgs(['measure', '--coverage'], {})).toMatchObject({ command: 'usage' })
    expect(parseArgs(['measure', '--coverage', '--accept-unmatched'], {})).toMatchObject({ command: 'usage' })
  })
  it('rejects --coverage and --accept-unmatched on the other subcommands', () => {
    expect(parseArgs(['check', '--coverage', 'a.json'], {})).toMatchObject({ command: 'usage' })
    expect(parseArgs(['baseline', '--accept-unmatched'], {})).toMatchObject({ command: 'usage' })
  })
  it('parses check and reads GITHUB_ACTIONS from the environment', () => {
    expect(parseArgs(['check'], {})).toEqual({ command: 'check', githubActions: false })
    expect(parseArgs(['check'], { GITHUB_ACTIONS: 'true' })).toEqual({ command: 'check', githubActions: true })
    expect(parseArgs(['check'], { GITHUB_ACTIONS: 'false' })).toEqual({ command: 'check', githubActions: false })
  })
  it('parses baseline with and without --allow-growth', () => {
    expect(parseArgs(['baseline'], {})).toEqual({ command: 'baseline', allowGrowth: false })
    expect(parseArgs(['baseline', '--allow-growth'], {})).toEqual({ command: 'baseline', allowGrowth: true })
  })
  it('returns a usage error for an unknown or missing subcommand', () => {
    expect(parseArgs(['nope'], {})).toMatchObject({ command: 'usage' })
    expect(parseArgs([], {})).toMatchObject({ command: 'usage' })
  })
  it('returns a usage error for an unknown flag', () => {
    expect(parseArgs(['baseline', '--allow-grow'], {})).toMatchObject({ command: 'usage' })
    expect(parseArgs(['check', '--allow-growth'], {})).toMatchObject({ command: 'usage' })
    expect(parseArgs(['measure', '--x'], {})).toMatchObject({ command: 'usage' })
  })
})

describe('isMoveSuspect', () => {
  const v = (kind: 'new' | 'stale', symbol: string): Violation =>
    kind === 'new'
      ? { kind, file: 'a.ts', symbol, message: '', current: 9 }
      : { kind, file: 'a.ts', symbol, message: '' }

  it('is true for a NEW and a STALE on different keys', () => {
    expect(isMoveSuspect([v('new', 'a'), v('stale', 'b')])).toBe(true)
  })
  it('is false for a NEW and a STALE on the same key', () => {
    expect(isMoveSuspect([v('new', 'a'), v('stale', 'a')])).toBe(false)
  })
  it('is false without both a NEW and a STALE', () => {
    expect(isMoveSuspect([v('new', 'a')])).toBe(false)
    expect(isMoveSuspect([v('stale', 'a')])).toBe(false)
  })
})

describe('annotation escaping', () => {
  it('escapes data: percent, CR and LF only', () => {
    expect(escapeData('100%\r\nx: y, z')).toBe('100%25%0D%0Ax: y, z')
  })
  it('escapes properties: data escapes plus colon and comma', () => {
    expect(escapeProperty('a:b,c%d\ne')).toBe('a%3Ab%2Cc%25d%0Ae')
  })
})

describe('parseArgs diff', () => {
  it('parses diff with a base path, defaulting the head', () => {
    expect(parseArgs(['diff', '--base', 'b.tsv', '--base-unmatched', 'bu.tsv'], {})).toEqual({
      command: 'diff',
      basePath: 'b.tsv',
      headPath: 'crap/baseline.tsv',
      baseUnmatchedPath: 'bu.tsv',
      headUnmatchedPath: 'crap/unmatched.tsv',
      baseAbsent: false,
      baseUnmatchedAbsent: false,
      githubActions: false,
    })
  })
  it('honours GITHUB_ACTIONS and an explicit head', () => {
    const argv = ['diff', '--base', 'b.tsv', '--head', 'h.tsv', '--base-unmatched', 'bu.tsv', '--head-unmatched', 'hu.tsv']
    expect(parseArgs(argv, { GITHUB_ACTIONS: 'true' })).toEqual({
      command: 'diff',
      basePath: 'b.tsv',
      headPath: 'h.tsv',
      baseUnmatchedPath: 'bu.tsv',
      headUnmatchedPath: 'hu.tsv',
      baseAbsent: false,
      baseUnmatchedAbsent: false,
      githubActions: true,
    })
  })
  it('returns usage when --base is missing or has no value', () => {
    expect(parseArgs(['diff'], {})).toMatchObject({ command: 'usage' })
    expect(parseArgs(['diff', '--base'], {})).toMatchObject({ command: 'usage' })
  })
  it('parses the two explicit base-absent flags, which take no value', () => {
    const argv = ['diff', '--base', 'b', '--base-unmatched', 'u', '--base-absent', '--base-unmatched-absent']
    expect(parseArgs(argv, {})).toMatchObject({ command: 'diff', baseAbsent: true, baseUnmatchedAbsent: true })
    const one = ['diff', '--base-absent', '--base', 'b', '--base-unmatched', 'u']
    expect(parseArgs(one, {})).toMatchObject({ baseAbsent: true, baseUnmatchedAbsent: false })
  })
  it('returns usage for a repeated base-absent flag', () => {
    const argv = ['diff', '--base', 'b', '--base-unmatched', 'u', '--base-absent', '--base-absent']
    expect(parseArgs(argv, {})).toMatchObject({ command: 'usage' })
  })
  it('returns usage when --base-unmatched is missing, so the list can never be skipped by omission', () => {
    expect(parseArgs(['diff', '--base', 'b.tsv'], {})).toMatchObject({ command: 'usage' })
  })
  it('returns usage when a flag value starts with --', () => {
    expect(parseArgs(['diff', '--base', '--head', 'x', '--base-unmatched', 'u'], {})).toMatchObject({ command: 'usage' })
  })
  it('returns usage for a duplicate flag', () => {
    expect(parseArgs(['diff', '--base', 'a', '--base', 'b', '--base-unmatched', 'u'], {})).toMatchObject({ command: 'usage' })
    expect(parseArgs(['diff', '--base', 'a', '--head', 'x', '--head', 'y', '--base-unmatched', 'u'], {})).toMatchObject({ command: 'usage' })
  })
  it('returns usage for an unknown flag on diff', () => {
    expect(parseArgs(['diff', '--base', 'b.tsv', '--base-unmatched', 'u', '--x', 'y'], {})).toMatchObject({ command: 'usage' })
  })
})

describe('runBaselineDiff', () => {
  const ROW = (file: string, symbol: string, score: string) => `${file}\t${symbol}\t${score}\n`
  const setup = (base: string | null, head: string | null) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'crap-diff-'))
    const basePath = path.join(dir, 'base.tsv')
    const headPath = path.join(dir, 'head.tsv')
    if (base !== null) writeFileSync(basePath, base)
    if (head !== null) writeFileSync(headPath, head)
    return {
      basePath,
      headPath,
      baseUnmatchedPath: path.join(dir, 'base-unmatched.tsv'),
      headUnmatchedPath: path.join(dir, 'head-unmatched.tsv'),
      baseAbsent: base === null,
      baseUnmatchedAbsent: true,
    }
  }
  type Paths = ReturnType<typeof setup>
  const run = (paths: Paths, githubActions = false) => {
    const out = makeIo()
    return { code: runBaselineDiff({ ...paths, githubActions }, out.io), ...out }
  }

  it('passes when the head equals the base', () => {
    const text = ROW('src/a.ts', 'f', '12.000')
    const { code, logs, errors } = run(setup(text, text))
    expect(code).toBe(0)
    expect(errors).toEqual([])
    expect(logs.join('\n')).toContain('CRAP baseline diff: pass')
  })

  it('passes when the head shrinks', () => {
    const { code } = run(setup(ROW('src/a.ts', 'f', '12.000') + ROW('src/b.ts', 'g', '9.000'), ROW('src/a.ts', 'f', '11.000')))
    expect(code).toBe(0)
  })

  it('passes with a nothing-to-compare message when the base file is absent', () => {
    const { code, logs } = run(setup(null, ROW('src/a.ts', 'f', '12.000')))
    expect(code).toBe(0)
    expect(logs.join('\n')).toContain('nothing to compare')
  })

  it('fails naming the path when the base file is missing and was not declared absent', () => {
    const paths = setup(null, ROW('src/a.ts', 'f', '12.000'))
    const { code, errors } = run({ ...paths, baseAbsent: false })
    expect(code).toBe(1)
    expect(errors.join('\n')).toContain(paths.basePath)
  })

  it('fails when the base file is missing and only the other file was declared absent', () => {
    const paths = setup(null, ROW('src/a.ts', 'f', '12.000'))
    expect(run({ ...paths, baseAbsent: false, baseUnmatchedAbsent: true }).code).toBe(1)
  })

  it('fails when the head is missing even though the base is absent', () => {
    const paths = setup(null, null)
    const { code, errors } = run(paths)
    expect(code).toBe(1)
    expect(errors.join('\n')).toContain(paths.headPath)
  })

  it('fails when the head is malformed even though the base is absent', () => {
    const paths = setup(null, 'not a row\n')
    const { code, errors } = run(paths)
    expect(code).toBe(1)
    expect(errors.join('\n')).toContain(paths.headPath)
  })

  it('reads the head from the given path', () => {
    const paths = setup(ROW('src/a.ts', 'f', '12.000'), ROW('src/a.ts', 'f', '12.000'))
    const other = path.join(path.dirname(paths.headPath), 'other.tsv')
    writeFileSync(other, ROW('src/a.ts', 'f', '20.000'))
    expect(run({ ...paths, headPath: other }).code).toBe(1)
    expect(run(paths).code).toBe(0)
  })

  it('uses the singular for one grown row and the plural for two', () => {
    const one = run(setup('', ROW('src/a.ts', 'f', '8.000'))).errors.join('\n')
    expect(one).toContain('1 row grew')
    const two = run(setup('', ROW('src/a.ts', 'f', '8.000') + ROW('src/b.ts', 'g', '9.000'))).errors.join('\n')
    expect(two).toContain('2 rows grew')
  })

  it('fails naming a grown row and the baseline path', () => {
    const { code, errors } = run(setup(ROW('src/a.ts', 'f', '12.000'), ROW('src/a.ts', 'f', '13.000')))
    expect(code).toBe(1)
    const text = errors.join('\n')
    expect(text).toContain('src/a.ts#f')
    expect(text).toContain('12.0')
    expect(text).toContain('13.0')
    expect(text).toContain('CRAP baseline diff: fail')
  })

  it('fails naming a new row', () => {
    const { code, errors } = run(setup(ROW('src/a.ts', 'f', '12.000'), ROW('src/a.ts', 'f', '12.000') + ROW('src/b.ts', 'g', '8.000')))
    expect(code).toBe(1)
    expect(errors.join('\n')).toContain('src/b.ts#g')
  })

  it('names every grown row', () => {
    const { errors } = run(setup('', ROW('src/a.ts', 'f', '8.000') + ROW('src/b.ts', 'g', '9.000')))
    const text = errors.join('\n')
    expect(text).toContain('src/a.ts#f')
    expect(text).toContain('src/b.ts#g')
  })

  it('emits ::error annotations on the baseline file under GitHub Actions only', () => {
    const paths = setup(ROW('src/a.ts', 'f', '12.000'), ROW('src/a.ts', 'f', '13.000'))
    expect(run(paths, false).errors.some((e) => e.startsWith('::error'))).toBe(false)
    const annotated = run(paths, true).errors.filter((e) => e.startsWith('::error'))
    expect(annotated).toHaveLength(1)
    expect(annotated[0]).toContain('file=crap/baseline.tsv')
  })

  it('fails closed on a malformed base, naming the file', () => {
    const paths = setup('not a row\n', ROW('src/a.ts', 'f', '12.000'))
    const { code, errors } = run(paths)
    expect(code).toBe(1)
    expect(errors.join('\n')).toContain(paths.basePath)
  })

  it('fails closed on a malformed head, naming the file', () => {
    const paths = setup(ROW('src/a.ts', 'f', '12.000'), 'not a row\n')
    const { code, errors } = run(paths)
    expect(code).toBe(1)
    expect(errors.join('\n')).toContain(paths.headPath)
  })

  it('fails when the head file is missing', () => {
    const paths = setup(ROW('src/a.ts', 'f', '12.000'), null)
    const { code, errors } = run(paths)
    expect(code).toBe(1)
    expect(errors.join('\n')).toContain(paths.headPath)
  })
})

describe('runBaselineDiff: the known unmatched list', () => {
  const dir = () => mkdtempSync(path.join(os.tmpdir(), 'crap-diff-unmatched-'))
  const setup = (base: string | null, head: string | null) => {
    const d = dir()
    const paths = {
      basePath: path.join(d, 'base.tsv'),
      headPath: path.join(d, 'head.tsv'),
      baseUnmatchedPath: path.join(d, 'base-unmatched.tsv'),
      headUnmatchedPath: path.join(d, 'head-unmatched.tsv'),
      baseAbsent: false,
      baseUnmatchedAbsent: base === null,
    }
    writeFileSync(paths.basePath, '')
    writeFileSync(paths.headPath, '')
    if (base !== null) writeFileSync(paths.baseUnmatchedPath, base)
    if (head !== null) writeFileSync(paths.headUnmatchedPath, head)
    return paths
  }
  const run = (paths: ReturnType<typeof setup>, githubActions = false) => {
    const out = makeIo()
    return { code: runBaselineDiff({ ...paths, githubActions }, out.io), ...out }
  }

  it('passes when the list is unchanged or shrinks', () => {
    expect(run(setup('src/a.ts\tf\n', 'src/a.ts\tf\n')).code).toBe(0)
    expect(run(setup('src/a.ts\tf\nsrc/b.ts\tg\n', 'src/a.ts\tf\n')).code).toBe(0)
  })

  it('fails naming an entry added to the list, so a new unmatched function cannot be waved through', () => {
    const { code, errors } = run(setup('src/a.ts\tf\n', 'src/a.ts\tf\nsrc/z.ts\tnew\n'))
    expect(code).toBe(1)
    expect(errors.join('\n')).toContain('src/z.ts#new')
    expect(errors.join('\n')).toMatch(/unmatched/i)
  })

  it('fails a second occurrence of a listed symbol', () => {
    expect(run(setup('src/a.ts\tf\n', 'src/a.ts\tf\nsrc/a.ts\tf\n')).code).toBe(1)
  })

  it('fails naming the path when the base list is missing and was not declared absent', () => {
    const paths = setup(null, 'src/a.ts\tf\n')
    const { code, errors } = run({ ...paths, baseUnmatchedAbsent: false })
    expect(code).toBe(1)
    expect(errors.join('\n')).toContain(paths.baseUnmatchedPath)
  })

  it('passes with nothing to compare when the base has no list, the initial freeze', () => {
    const { code, logs } = run(setup(null, 'src/a.ts\tf\n'))
    expect(code).toBe(0)
    expect(logs.join('\n')).toContain('nothing to compare')
  })

  it('treats a missing head list as empty when the base has one', () => {
    expect(run(setup('src/a.ts\tf\n', null)).code).toBe(0)
  })

  it('fails closed on a malformed head list, naming the file', () => {
    const paths = setup('src/a.ts\tf\n', 'garbage\n')
    const { code, errors } = run(paths)
    expect(code).toBe(1)
    expect(errors.join('\n')).toContain(paths.headUnmatchedPath)
  })

  it('fails closed on a malformed base list, naming the file', () => {
    const paths = setup('garbage\n', 'src/a.ts\tf\n')
    const { code, errors } = run(paths)
    expect(code).toBe(1)
    expect(errors.join('\n')).toContain(paths.baseUnmatchedPath)
  })

  it('reports baseline growth and list growth together', () => {
    const paths = setup('', 'src/z.ts\tnew\n')
    writeFileSync(paths.headPath, 'src/a.ts\tf\t9.000\n')
    writeFileSync(paths.basePath, '')
    const { code, errors } = run(paths)
    expect(code).toBe(1)
    expect(errors.join('\n')).toContain('src/a.ts#f')
    expect(errors.join('\n')).toContain('src/z.ts#new')
  })

  it('emits ::error annotations on the list file under GitHub Actions only', () => {
    const paths = setup('', 'src/z.ts\tnew\n')
    expect(run(paths, false).errors.some((e) => e.startsWith('::error'))).toBe(false)
    const annotated = run(paths, true).errors.filter((e) => e.startsWith('::error'))
    expect(annotated).toHaveLength(1)
    expect(annotated[0]).toContain('file=crap/unmatched.tsv')
  })
})
