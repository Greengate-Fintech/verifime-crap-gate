import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'
import { describe, it, expect } from 'vitest'
import { isInScope, measure as measureWithSpans, toRepoRelative } from '../src/measure'
import type {
  EslintFileResult,
  IstanbulFileCoverage,
  IstanbulLocation,
} from '../src/types'
import { withPointSpans } from './helpers/spans'

// These hand-written messages get a point span each (see helpers/spans.ts): an entry joins its
// function only when it starts exactly at the message. The join itself is tested in join.test.ts.
const measure = (eslint: EslintFileResult[], ...rest: Parameters<typeof measureWithSpans> extends [unknown, ...infer R] ? R : never) =>
  measureWithSpans(withPointSpans(eslint), ...rest)

const FAKE_ROOT = '/fake/repo'
const SAMPLE_REL = 'src/sample.ts'
const SAMPLE_ABS = `${FAKE_ROOT}/${SAMPLE_REL}`
const FIXTURES = path.join(__dirname, 'fixtures')

const readJson = <T>(name: string): T =>
  JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8')) as T

const eslintFixture = (): EslintFileResult[] => readJson<EslintFileResult[]>('eslint.json')
const coverageFixture = (): Record<string, IstanbulFileCoverage> =>
  readJson<Record<string, IstanbulFileCoverage>>('coverage-final.json')

const sampleSource = readFileSync(path.join(FIXTURES, 'sample.ts'), 'utf8')
const readSource = (abs: string): string => (abs === SAMPLE_ABS ? sampleSource : '')

const msg = (
  message: string,
  line: number,
  column: number,
  ruleId: string | null = 'complexity',
  extra: { fatal?: boolean; severity?: number } = {},
) => ({ ruleId, message, line, column, ...extra })

const loc = (sl: number, sc: number, el: number, ec: number): IstanbulLocation => ({
  start: { line: sl, column: sc },
  end: { line: el, column: ec },
})

const oneFnCoverage = (
  name: string,
  span: IstanbulLocation,
): Record<string, IstanbulFileCoverage> => ({
  [SAMPLE_ABS]: {
    path: SAMPLE_ABS,
    statementMap: {},
    s: {},
    fnMap: { '0': { name, decl: span, loc: span } },
    f: { '0': 1 },
    branchMap: {},
    b: {},
  },
})

const sampleMessages = (...messages: ReturnType<typeof msg>[]): EslintFileResult[] => [
  { filePath: SAMPLE_ABS, messages },
]

describe('measure: fixture join', () => {
  it('reproduces symbol, cc, cov, covKind and crap for every function', () => {
    const result = measure(eslintFixture(), coverageFixture(), FAKE_ROOT, readSource)
    expect(result.unmatched).toEqual([])
    expect(result.functions).toEqual([
      { file: SAMPLE_REL, symbol: 'namedFunction', kind: 'Function', line: 6, cc: 2, cov: 0.5, covKind: 'min(stmt,branch)', crap: 2.5 },
      { file: SAMPLE_REL, symbol: 'run', kind: 'Method', line: 14, cc: 2, cov: 0, covKind: 'min(stmt,branch)', crap: 6 },
      { file: SAMPLE_REL, symbol: 'handler', kind: 'Async arrow function', line: 19, cc: 1, cov: 1, covKind: 'stmt', crap: 1 },
      { file: SAMPLE_REL, symbol: 'use callback', kind: 'Arrow function', line: 23, cc: 2, cov: 0.6667, covKind: 'min(stmt,branch)', crap: 2.148 },
      { file: SAMPLE_REL, symbol: 'Promise callback', kind: 'Arrow function', line: 30, cc: 1, cov: 1, covKind: 'stmt', crap: 1 },
      { file: SAMPLE_REL, symbol: 'register callback', kind: 'Arrow function', line: 34, cc: 1, cov: 0, covKind: 'stmt', crap: 2 },
      { file: SAMPLE_REL, symbol: 'register callback', kind: 'Arrow function', line: 34, cc: 2, cov: 0.5, covKind: 'min(stmt,branch)', crap: 2.5 },
    ])
  })

  it('matches coverage keys written for another machine', () => {
    const otherMachine = '/home/runner/work/some-repo/some-repo'
    const remapped = Object.fromEntries(
      Object.entries(coverageFixture()).map(([key, value]) => [
        key.replace(FAKE_ROOT, otherMachine),
        value,
      ]),
    )
    const result = measure(eslintFixture(), remapped, FAKE_ROOT, readSource)
    expect(result.unmatched).toEqual([])
    expect(result.functions.map((f) => f.crap)).toEqual([2.5, 6, 1, 2.148, 1, 2, 2.5])
  })

  it('matches the two same-line arrows to different fnMap entries by column', () => {
    const result = measure(eslintFixture(), coverageFixture(), FAKE_ROOT, readSource)
    const [first, second] = result.functions.filter((f) => f.line === 34)
    expect([first.cc, first.cov]).toEqual([1, 0])
    expect([second.cc, second.cov]).toEqual([2, 0.5])
  })
})

describe('measure: filtering', () => {
  it('excludes test files and declaration files', () => {
    const complexity = [msg('Function has a complexity of 9. Maximum allowed is 0.', 1, 1)]
    const eslint = [
      ...eslintFixture(),
      { filePath: `${FAKE_ROOT}/test/foo.test.ts`, messages: complexity },
      { filePath: `${FAKE_ROOT}/src/x.d.ts`, messages: complexity },
    ]
    const result = measure(eslint, coverageFixture(), FAKE_ROOT, readSource)
    expect(result.functions).toHaveLength(7)
    expect(new Set(result.functions.map((f) => f.file))).toEqual(new Set([SAMPLE_REL]))
    expect(result.unmatched).toEqual([])
  })

  it('fails closed on a fatal parse error message', () => {
    const eslint = sampleMessages(
      msg('Parsing error: Unexpected token', 3, 5, null, { fatal: true, severity: 2 }),
    )
    const result = measure(eslint, coverageFixture(), FAKE_ROOT, readSource)
    expect(result.functions).toEqual([])
    expect(result.problems).toEqual([
      { file: SAMPLE_REL, line: 3, message: 'Parsing error: Unexpected token' },
    ])
  })

  it('fails closed on a message for another rule (config was not applied)', () => {
    const eslint = sampleMessages(
      msg("'x' is assigned a value but never used.", 6, 8, 'no-unused-vars'),
    )
    const result = measure(eslint, coverageFixture(), FAKE_ROOT, readSource)
    expect(result.problems).toHaveLength(1)
    expect(result.problems[0]).toMatchObject({ file: SAMPLE_REL, line: 6 })
    expect(result.problems[0].message).toContain('no-unused-vars')
  })

  it('fails closed on a null ruleId that is not fatal', () => {
    const eslint = sampleMessages(msg('Something odd', 6, 8, null))
    expect(measure(eslint, coverageFixture(), FAKE_ROOT, readSource).problems).toHaveLength(1)
  })

  it('fails closed on a reworded complexity message with no figure', () => {
    const eslint = sampleMessages(msg("Function 'c' is too twisty", 6, 8))
    const result = measure(eslint, coverageFixture(), FAKE_ROOT, readSource)
    expect(result.functions).toEqual([])
    expect(result.problems).toEqual([
      { file: SAMPLE_REL, line: 6, message: "Function 'c' is too twisty" },
    ])
  })

  it('does not report problems for messages in out-of-scope files', () => {
    const eslint = [
      ...eslintFixture(),
      {
        filePath: `${FAKE_ROOT}/test/broken.test.ts`,
        messages: [msg('Parsing error: x', 1, 1, null, { fatal: true })],
      },
    ]
    expect(measure(eslint, coverageFixture(), FAKE_ROOT, readSource).problems).toEqual([])
  })

  it('gives no functions for results with zero complexity messages', () => {
    const result = measure(sampleMessages(), coverageFixture(), FAKE_ROOT, readSource)
    expect(result.functions).toHaveLength(0)
  })
})

describe('measure: coverage without an ESLint result', () => {
  it('fails when an in-scope coverage file has no ESLint result', () => {
    const coverage = {
      ...coverageFixture(),
      ...Object.fromEntries(
        Object.entries(oneFnCoverage('o', loc(1, 0, 2, 1))).map(([, v]) => [
          `${FAKE_ROOT}/src/other.ts`,
          v,
        ]),
      ),
    }
    const result = measure(eslintFixture(), coverage, FAKE_ROOT, readSource)
    expect(result.problems).toHaveLength(1)
    expect(result.problems[0].file).toBe('src/other.ts')
  })

  it('ignores an out-of-scope coverage file with no ESLint result', () => {
    const [entry] = Object.values(coverageFixture())
    const coverage = { ...coverageFixture(), [`${FAKE_ROOT}/scripts/x.ts`]: entry }
    expect(measure(eslintFixture(), coverage, FAKE_ROOT, readSource).problems).toEqual([])
  })
})

describe('measure: real paths', () => {
  it('maps an ESLint path reached through a symlinked directory to its real path', () => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'crap-measure-')))
    mkdirSync(path.join(root, 'real/src'), { recursive: true })
    symlinkSync(path.join(root, 'real'), path.join(root, 'link'))
    writeFileSync(path.join(root, 'real/src/a.ts'), 'export const a = () => 1\n')
    const real = path.join(root, 'real')
    const eslint = [
      {
        filePath: path.join(root, 'link/src/a.ts'),
        messages: [msg("Arrow function 'a' has a complexity of 1.", 1, 18)],
      },
    ]
    const cov = oneFnCoverage('a', loc(1, 17, 1, 25))
    const coverage = { [path.join(real, 'src/a.ts')]: Object.values(cov)[0] }
    const result = measure(eslint, coverage, real)
    expect(result.unmatched).toEqual([])
    expect(result.functions.map((f) => f.file)).toEqual(['src/a.ts'])
  })
})

describe('measure: unmatched functions', () => {
  it('lands a function with no fnMap entry in unmatched, not functions', () => {
    const eslint = sampleMessages(
      msg('Arrow function has a complexity of 3. Maximum allowed is 0.', 60, 1),
    )
    const result = measure(eslint, coverageFixture(), FAKE_ROOT, readSource)
    expect(result.functions).toEqual([])
    expect(result.unmatched).toEqual([
      { file: SAMPLE_REL, symbol: '(anonymous)', line: 60, cc: 3, kind: 'Arrow function' },
    ])
  })

  it('treats every function of a file with no coverage entry as unmatched', () => {
    const result = measure(eslintFixture(), {}, FAKE_ROOT, readSource)
    expect(result.functions).toEqual([])
    expect(result.unmatched.map((u) => u.symbol)).toEqual([
      'namedFunction',
      'run',
      'handler',
      'use callback',
      'Promise callback',
      'register callback',
      'register callback',
    ])
  })

  it('uses each fnMap entry once per file', () => {
    const eslint = sampleMessages(
      msg("Function 'a' has a complexity of 2. Maximum allowed is 0.", 5, 1),
      msg("Function 'b' has a complexity of 2. Maximum allowed is 0.", 5, 1),
    )
    const result = measure(eslint, oneFnCoverage('a', loc(5, 0, 9, 1)), FAKE_ROOT, readSource)
    expect(result.functions.map((f) => f.symbol)).toEqual(['a'])
    expect(result.unmatched.map((u) => u.symbol)).toEqual(['b'])
  })
})

describe('measure: no borrowed entries', () => {
  it('leaves a function unmatched when the only free entry starts after it', () => {
    const eslint = sampleMessages(
      msg('Arrow function has a complexity of 1. Maximum allowed is 0.', 29, 1),
    )
    const result = measure(eslint, coverageFixture(), FAKE_ROOT, readSource)
    expect(result.functions).toEqual([])
    expect(result.unmatched.map((u) => [u.line, u.kind])).toEqual([[29, 'Arrow function']])
  })

  it('leaves a function unmatched when the only entry encloses it', () => {
    const eslint = sampleMessages(
      msg('Function has a complexity of 3. Maximum allowed is 0.', 10, 1),
    )
    const coverage = oneFnCoverage('outer', loc(1, 0, 20, 1))
    const result = measure(eslint, coverage, FAKE_ROOT, readSource)
    expect(result.functions).toEqual([])
    expect(result.unmatched.map((u) => u.line)).toEqual([10])
  })
})

describe('measure: function spans', () => {
  it('fails closed on a complexity message the lint pass recorded no span for', () => {
    const eslint = sampleMessages(msg("Function 'a' has a complexity of 2. Maximum allowed is 0.", 6, 8))
    const result = measureWithSpans(eslint, coverageFixture(), FAKE_ROOT, readSource)
    expect(result.functions).toEqual([])
    expect(result.unmatched).toEqual([])
    expect(result.problems).toEqual([
      { file: SAMPLE_REL, line: 6, message: 'Complexity message with no function span: was the file linted by the gate?' },
    ])
  })

  it('fails closed on a complexity message whose span was already paired', () => {
    const message = msg("Function 'a' has a complexity of 2. Maximum allowed is 0.", 6, 8)
    const [withOne] = withPointSpans(sampleMessages(message))
    const result = measureWithSpans([{ ...withOne, messages: [message, message] }], coverageFixture(), FAKE_ROOT, readSource)
    expect(result.functions.map((f) => f.line)).toEqual([6])
    expect(result.problems.map((p) => p.line)).toEqual([6])
  })
})

describe('measure: naming', () => {
  const coverage = coverageFixture()

  it('falls back to the Istanbul fnMap name for an unnamed method', () => {
    const eslint = sampleMessages(msg('Method has a complexity of 2. Maximum allowed is 0.', 14, 3))
    expect(measure(eslint, coverage, FAKE_ROOT, readSource).functions[0].symbol).toBe('run')
  })

  it('appends .constructor for a Constructor', () => {
    const eslint = sampleMessages(
      msg('Constructor has a complexity of 2. Maximum allowed is 0.', 14, 3),
    )
    expect(measure(eslint, coverage, FAKE_ROOT, readSource).functions[0].symbol).toBe(
      'run.constructor',
    )
  })

  it('guesses from source when the Istanbul name starts with a parenthesis', () => {
    const eslint = sampleMessages(
      msg('Async arrow function has a complexity of 1. Maximum allowed is 0.', 19, 24),
    )
    expect(measure(eslint, coverage, FAKE_ROOT, readSource).functions[0].symbol).toBe('handler')
  })

  it('reports kind ? when the message does not start with a known function kind', () => {
    const eslint = sampleMessages(
      msg('Weird thing has a complexity of 1. Maximum allowed is 0.', 19, 24),
    )
    expect(measure(eslint, coverage, FAKE_ROOT, readSource).functions[0].kind).toBe('?')
  })

  it('does not throw when the source file cannot be read', () => {
    const eslint = sampleMessages(
      msg('Arrow function has a complexity of 1. Maximum allowed is 0.', 40, 1),
    )
    const result = measure(eslint, coverage, FAKE_ROOT)
    expect(result.unmatched).toEqual([
      { file: SAMPLE_REL, symbol: '(anonymous)', line: 40, cc: 1, kind: 'Arrow function' },
    ])
  })
})

describe('measure: unrounded coverage', () => {
  it('computes crap from unrounded coverage while reporting cov at 4 dp', () => {
    const span = loc(5, 0, 9, 1)
    const statement = (line: number) => loc(line, 2, line, 10)
    const coverage = oneFnCoverage('big', span)
    Object.assign(coverage[SAMPLE_ABS], {
      statementMap: { '0': statement(6), '1': statement(7), '2': statement(8) },
      s: { '0': 1, '1': 0, '2': 0 },
    })
    const eslint = sampleMessages(
      msg("Function 'big' has a complexity of 20. Maximum allowed is 0.", 5, 1),
    )
    const [fn] = measure(eslint, coverage, FAKE_ROOT, readSource).functions
    expect(fn.cov).toBe(0.3333)
    // 400 * (2/3)^3 + 20 = 138.519; from cov rounded to 0.3333 it would be 138.53
    expect(fn.crap).toBe(138.519)
  })
})

describe('measure: boundaries and duplicates', () => {
  it('scores cc 5 and cc 6 at full coverage as exactly 5 and 6', () => {
    // cc 5 at full coverage is exactly 5; cc 6 at full coverage is 6
    const five = measure(
      sampleMessages(msg("Function 'a' has a complexity of 5.", 5, 1)),
      oneFnCoverage('a', loc(5, 0, 9, 1)),
      FAKE_ROOT,
      readSource,
    )
    expect(five.functions[0].crap).toBe(5)
    const six = measure(
      sampleMessages(msg("Function 'a' has a complexity of 6.", 5, 1)),
      oneFnCoverage('a', loc(5, 0, 9, 1)),
      FAKE_ROOT,
      readSource,
    )
    expect(six.functions[0].crap).toBe(6)
  })

  it('gives four same-named anonymous arrows across two lines their own coverage', () => {
    const arrow = (line: number, column: number) =>
      msg('Arrow function has a complexity of 1. Maximum allowed is 0.', line, column)
    const fn = (name: string, span: IstanbulLocation) => ({ name, decl: span, loc: span })
    const coverage = {
      [SAMPLE_ABS]: {
        path: SAMPLE_ABS,
        statementMap: {},
        s: {},
        fnMap: {
          '0': fn('(anonymous_0)', loc(1, 0, 1, 5)),
          '1': fn('(anonymous_1)', loc(1, 10, 1, 15)),
          '2': fn('(anonymous_2)', loc(2, 0, 2, 5)),
          '3': fn('(anonymous_3)', loc(2, 10, 2, 15)),
        },
        f: { '0': 1, '1': 0, '2': 3, '3': 0 },
        branchMap: {},
        b: {},
      },
    }
    const eslint = sampleMessages(arrow(1, 1), arrow(1, 11), arrow(2, 1), arrow(2, 11))
    const result = measure(eslint, coverage, FAKE_ROOT, readSource)
    expect(result.unmatched).toEqual([])
    expect(result.functions.map((f) => [f.line, f.cov])).toEqual([
      [1, 1],
      [1, 0],
      [2, 1],
      [2, 0],
    ])
  })

  it('leaves every function unmatched when coverage has only foreign keys', () => {
    const [entry] = Object.values(coverageFixture())
    const foreign = { '/elsewhere/other/thing.ts': entry }
    const result = measure(eslintFixture(), foreign, FAKE_ROOT, readSource)
    expect(result.functions).toEqual([])
    expect(result.unmatched).toHaveLength(7)
  })
})

describe('toRepoRelative', () => {
  const measured = new Set(['src/lib/foo.ts'])

  it('maps a key under the repo root by path.relative', () => {
    expect(toRepoRelative('/r/src/a.ts', '/r', measured)).toBe('src/a.ts')
  })

  it('resolves a relative key against the repo root', () => {
    expect(toRepoRelative('src/a.ts', '/r', measured)).toBe('src/a.ts')
  })

  it('finds a measured suffix from the last src, lib or bin segment backwards', () => {
    expect(toRepoRelative('/x/src/lib/foo.ts', '/r', measured)).toBe('src/lib/foo.ts')
    expect(toRepoRelative('/x/src/lib/foo.ts', '/r', new Set(['lib/foo.ts']))).toBe('lib/foo.ts')
  })

  it('tries the last anchor segment first', () => {
    const both = new Set(['lib/foo.ts', 'src/y/lib/foo.ts'])
    expect(toRepoRelative('/x/src/y/lib/foo.ts', '/r', both)).toBe('lib/foo.ts')
  })

  it('never maps a node_modules key through the suffix fallback', () => {
    const inModules = new Set(['src/index.js'])
    expect(toRepoRelative('/x/node_modules/pkg/src/index.js', '/r', inModules)).toBeNull()
  })

  it('returns null when nothing matches', () => {
    expect(toRepoRelative('/x/src/other.ts', '/r', measured)).toBeNull()
    expect(toRepoRelative('/x/misc/foo.ts', '/r', measured)).toBeNull()
  })
})

describe('isInScope', () => {
  it.each(['src/a.ts', 'lib/x.ts', 'bin/app.ts', 'src/handlers/y.ts', 'cdk/lib/stack.ts', 'cdk/bin/app.ts'])('includes %s', (p) => {
    expect(isInScope(p)).toBe(true)
  })

  it.each([
    'test/a.ts',
    'scripts/a.ts',
    'src/a.test.ts',
    'src/x.d.ts',
    'src/__mocks__/a.ts',
    'src/fixtures/a.ts',
    'src/foo.config.ts',
    'cdk/test/a.ts',
    'cdk/vitest.config.ts',
    'cdk/cdk.out/asset/a.ts',
    'cdk/node_modules/x/lib/a.ts',
    'cdk/lib/stack.js',
    'cdk/lib/stack.d.ts',
    'src/a.js',
  ])('excludes %s', (p) => {
    expect(isInScope(p)).toBe(false)
  })
})

describe('measure: cdk sources', () => {
  const CDK_REL = 'cdk/lib/stack.ts'
  const CDK_ABS = `${FAKE_ROOT}/${CDK_REL}`
  const cdkMessages: EslintFileResult[] = [
    {
      filePath: CDK_ABS,
      messages: [msg("Method 'build' has a complexity of 3. Maximum allowed is 0.", 3, 3)],
    },
  ]
  const span = loc(3, 2, 9, 3)
  const cdkCoverage = (key: string): Record<string, IstanbulFileCoverage> => ({
    [key]: {
      path: key,
      statementMap: {},
      s: {},
      fnMap: { '0': { name: 'build', decl: span, loc: span } },
      f: { '0': 1 },
      branchMap: {},
      b: {},
    },
  })

  it('scores a cdk function under its repo-relative cdk/ path', () => {
    const result = measure(cdkMessages, cdkCoverage(CDK_ABS), FAKE_ROOT, () => '')
    expect(result.unmatched).toEqual([])
    expect(result.functions.map((f) => [f.file, f.symbol, f.cc])).toEqual([[CDK_REL, 'build', 3]])
  })

  it('matches a cdk coverage key written for another machine', () => {
    const key = '/home/runner/work/some-repo/some-repo/cdk/lib/stack.ts'
    const result = measure(cdkMessages, cdkCoverage(key), FAKE_ROOT, () => '')
    expect(result.unmatched).toEqual([])
    expect(result.functions.map((f) => f.file)).toEqual([CDK_REL])
  })

  it('anchors a foreign cdk key on the cdk segment', () => {
    expect(toRepoRelative('/elsewhere/cdk/lib/stack.ts', FAKE_ROOT, new Set([CDK_REL]))).toBe(CDK_REL)
  })

  it('never measures a compiled .js twin beside a cdk source', () => {
    const twin: EslintFileResult[] = [{ filePath: `${FAKE_ROOT}/cdk/lib/stack.js`, messages: cdkMessages[0].messages }]
    const result = measure([...cdkMessages, ...twin], cdkCoverage(CDK_ABS), FAKE_ROOT, () => '')
    expect(result.functions).toHaveLength(1)
    expect(result.unmatched).toEqual([])
  })
})
