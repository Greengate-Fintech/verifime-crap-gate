import { existsSync, readFileSync } from 'fs'
import http from 'http'
import https from 'https'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '../src/config'
import type { CrapConfig } from '../src/config'
import { measureJava } from '../src/java'
import type { JavaFileSystem, JavaMeasurement } from '../src/java'
import type { FunctionScore } from '../src/types'

const FIXTURES = path.join(__dirname, 'fixtures', 'java')
const CONFIG: CrapConfig = { ...DEFAULT_CONFIG, scope: ['src/main/java'], extensions: ['.java'] }
const PRICING = 'src/main/java/com/example/Pricing.java'

// Runs against the fixture tree on disk, with the real file system.
const run = (reports: string[], config: CrapConfig = CONFIG): JavaMeasurement =>
  measureJava(config, FIXTURES, reports)

const find = (m: JavaMeasurement, symbol: string): FunctionScore[] =>
  m.measurement.functions.filter((f) => f.symbol === symbol)

const one = (m: JavaMeasurement, symbol: string): FunctionScore => {
  const found = find(m, symbol)
  expect(found).toHaveLength(1)
  return found[0]
}

// ---- Synthetic reports, for the cases a fixture file would only obscure ----

const REPO = '/repo'
const SOURCE = 'src/main/java/com/example/Foo.java'

const counter = (type: string, missed: number, covered: number): string =>
  `<counter type="${type}" missed="${missed}" covered="${covered}"/>`
const GOOD_COUNTERS = counter('LINE', 0, 1) + counter('COMPLEXITY', 0, 1)
const method = (attrs: string, counters: string = GOOD_COUNTERS): string =>
  `<method ${attrs}>${counters}</method>`
const foo = (methods: string, attrs = 'name="com/example/Foo" sourcefilename="Foo.java"'): string =>
  `<class ${attrs}>${methods}</class>`
const report = (classes: string, pkg = 'com/example'): string =>
  `<?xml version="1.0" encoding="UTF-8"?><report name="t"><package name="${pkg}">${classes}</package></report>`

const synthetic = (
  xml: string,
  sources: string[] = [SOURCE],
  config: CrapConfig = CONFIG,
): JavaMeasurement => {
  const fs: JavaFileSystem = {
    readFile: () => xml,
    fileExists: (abs) => sources.some((s) => abs === `${REPO}/${s}`),
  }
  return measureJava(config, REPO, ['build/jacoco.xml'], fs)
}

const problemsOf = (m: JavaMeasurement): string[] =>
  m.measurement.problems.map((p) => `${p.file}${p.line === undefined ? '' : `:${p.line}`} ${p.message}`)

describe('symbols and kinds', () => {
  it('gives two overloads of one method two distinct symbols', () => {
    const m = run(['report.xml'])
    const small = one(m, 'Pricing#price(int)')
    const wide = one(m, 'Pricing#price(String,int)')
    expect([small.file, wide.file]).toEqual([PRICING, PRICING])
    expect([small.line, wide.line]).toEqual([10, 20])
    expect([small.cc, wide.cc]).toEqual([2, 1])
  })

  it('keys a nested class as Outer.Inner and an anonymous class as Outer.1', () => {
    const m = run(['report.xml'])
    expect(one(m, 'Pricing.Tier#rate()').file).toBe(PRICING)
    expect(one(m, 'Pricing.1#run()').file).toBe(PRICING)
  })

  it('names a constructor and a static initializer', () => {
    const m = run(['report.xml'])
    const ctor = one(m, 'Pricing#<init>(String)')
    const init = one(m, 'Pricing#<clinit>()')
    expect([ctor.kind, init.kind]).toEqual(['Constructor', 'Static initializer'])
    expect([ctor.line, init.line]).toEqual([9, 7])
  })

  it('keys a lambda without its index or parameters, one row per lambda', () => {
    const m = run(['report.xml'])
    const lambdas = find(m, 'Pricing#apply$lambda')
    expect(lambdas.map((f) => [f.kind, f.line, f.cc])).toEqual([
      ['Lambda', 31, 1],
      ['Lambda', 32, 1],
    ])
    expect(m.measurement.functions.filter((f) => f.symbol.includes('lambda$'))).toEqual([])
    expect(one(m, 'Pricing#apply(Map.Entry[])').kind).toBe('Method')
  })

  it('renders every primitive, object and array parameter as a simple name', () => {
    const m = run(['report.xml'])
    const all = one(m, 'Pricing#everything(boolean,byte,char,short,int,long,float,double,long[][])')
    expect(all.line).toBe(0)
  })
})

describe('scores', () => {
  it('uses the line ratio when the method has no BRANCH counter', () => {
    const wide = one(run(['report.xml']), 'Pricing#price(String,int)')
    expect(wide).toMatchObject({ cov: 1, covKind: 'line', crap: 1 })
  })

  it('uses the lower of the line and branch ratios when both exist', () => {
    // cc 2, line 3/3 = 1, branch 1/2 = 0.5 -> cov 0.5; CRAP = 4 * 0.125 + 2 = 2.5
    const small = one(run(['report.xml']), 'Pricing#price(int)')
    expect(small).toMatchObject({ cc: 2, cov: 0.5, covKind: 'min(line,branch)', crap: 2.5 })
  })

  it('scores a method with no coverage at 0 rather than skipping it', () => {
    // cc 3, cov 0; CRAP = 9 * 1 + 3 = 12
    const unused = one(run(['report.xml']), 'Pricing#unused()')
    expect(unused).toMatchObject({ cc: 3, cov: 0, covKind: 'min(line,branch)', crap: 12 })
  })

  it('scores every method of a module with no tests at coverage 0', () => {
    const m = run(['no-tests.xml'])
    expect(m.measurement.problems).toEqual([])
    // price(int): cc 2, cov 0, CRAP = 4 + 2 = 6. price(String,int): cc 1, cov 0, CRAP = 1 + 1 = 2.
    expect(m.measurement.functions.map((f) => [f.symbol, f.cc, f.cov, f.crap])).toEqual([
      ['Pricing#price(int)', 2, 0, 6],
      ['Pricing#price(String,int)', 1, 0, 2],
    ])
  })

  it('pins the formula: cc 4, line 6/8, branch 1/4', () => {
    // cc = 3 + 1 = 4. line ratio = 6 / (2 + 6) = 0.75. branch ratio = 1 / (3 + 1) = 0.25.
    // cov = min(0.75, 0.25) = 0.25. CRAP = 4^2 * (1 - 0.25)^3 + 4 = 16 * 0.421875 + 4 = 10.75
    const pin = one(run(['report.xml']), 'Pricing#pin()')
    expect(pin).toEqual({
      file: PRICING,
      symbol: 'Pricing#pin()',
      kind: 'Method',
      line: 50,
      cc: 4,
      cov: 0.25,
      covKind: 'min(line,branch)',
      crap: 10.75,
    })
  })

  it('computes CRAP on the unrounded coverage and reports coverage to 4 dp', () => {
    // cc = 20 + 10 = 30. line ratio = 2 / 3, no branch -> cov 0.66666..., reported as 0.6667.
    // CRAP = 30^2 * (1/3)^3 + 30 = 900 / 27 + 30 = 63.333
    // (the rounded 0.6667 would give 63.323)
    const heavy = one(run(['report.xml']), 'Pricing#heavy()')
    expect(heavy).toMatchObject({ cc: 30, cov: 0.6667, covKind: 'line', crap: 63.333 })
  })

  it('leaves unmatched empty', () => {
    expect(run(['report.xml']).measurement.unmatched).toEqual([])
  })

  it('scores the methods of several reports in the order given', () => {
    const m = run(['no-tests.xml', 'config-conflict.xml'], { ...CONFIG, scope: ['src/main/java', 'common/src/main/java'] })
    expect(m.measurement.functions.map((f) => f.symbol)).toEqual([
      'Pricing#price(int)',
      'Pricing#price(String,int)',
      'Config#load()',
      'Config.Holder#get()',
    ])
  })
})

describe('source path resolution', () => {
  it('measures a package path holding a segment named test or generated', () => {
    const m = run(['report.xml'])
    expect(one(m, 'Probe#ping()').file).toBe('src/main/java/com/example/test/Probe.java')
    expect(one(m, 'Stub#pong()').file).toBe('src/main/java/com/example/generated/Stub.java')
  })

  it('skips and counts a class whose sourcefilename is not a configured extension', () => {
    const m = run(['report.xml'])
    expect(find(m, 'KotlinHelper#help()')).toEqual([])
    expect(m.measurement.problems).toEqual([])
    expect(find(m, 'Pricing#price(int)')).toHaveLength(1)
  })

  it('skips and counts a class whose source sits under no scope root', () => {
    const m = run(['report.xml'])
    expect(find(m, 'ClientStub#call()')).toEqual([])
    expect(m.outOfScope).toBe(2)
  })

  it('counts each out-of-scope class, not each file', () => {
    // Three classes share Pricing.java; excluding it skips all three, plus the two classes above.
    const m = run(['report.xml'], { ...CONFIG, exclude: ['/Pricing\\.java$'] })
    expect(m.outOfScope).toBe(5)
    expect(find(m, 'Pricing#price(int)')).toEqual([])
    expect(one(m, 'Probe#ping()').file).toContain('Probe.java')
  })

  it('joins the one match when several scope roots are listed', () => {
    const m = run(['report.xml'], { ...CONFIG, scope: ['common/src/main/java', 'src/main/java'] })
    expect(one(m, 'Pricing#price(int)').file).toBe(PRICING)
  })

  it('reports one problem naming both paths when two scope roots hold the same file', () => {
    const m = run(['config-conflict.xml'], {
      ...CONFIG,
      scope: ['common/src/main/java', 'lambda/src/main/java'],
    })
    expect(m.measurement.functions).toEqual([])
    expect(m.measurement.problems).toHaveLength(1)
    const [problem] = m.measurement.problems
    expect(problem.file).toBe('config-conflict.xml')
    expect(problem.message).toContain('common/src/main/java/com/example/Config.java')
    expect(problem.message).toContain('lambda/src/main/java/com/example/Config.java')
    expect(m.outOfScope).toBe(0)
  })

  it('resolves a class in the default package directly under the scope root', () => {
    const xml = `<report name="t"><package name="">${foo(method('name="run" desc="()V" line="2"'), 'name="Foo" sourcefilename="Foo.java"')}</package></report>`
    const m = synthetic(xml, ['src/main/java/Foo.java'])
    expect(one(m, 'Foo#run()').file).toBe('src/main/java/Foo.java')
  })
})

describe('failing closed', () => {
  it('reports the same file, symbol and line coming from two reports', () => {
    // The same class in two modules' reports: both files hold the report text of no-tests.xml.
    const text = readFileSync(path.join(FIXTURES, 'no-tests.xml'), 'utf8')
    const fs: JavaFileSystem = { readFile: () => text, fileExists: existsSync }
    const m = measureJava(CONFIG, FIXTURES, ['a/jacoco.xml', 'b/jacoco.xml'], fs)
    expect(m.measurement.functions).toHaveLength(2)
    expect(m.measurement.problems).toEqual([
      {
        file: PRICING,
        line: 10,
        message: 'Reported twice: Pricing#price(int) is in a/jacoco.xml and in b/jacoco.xml',
      },
      {
        file: PRICING,
        line: 20,
        message: 'Reported twice: Pricing#price(String,int) is in a/jacoco.xml and in b/jacoco.xml',
      },
    ])
  })

  it('does not call two lambdas on one line in one report a duplicate', () => {
    const lambdas =
      method('name="lambda$run$0" desc="()V" line="5"') + method('name="lambda$run$1" desc="()V" line="5"')
    const m = synthetic(report(foo(lambdas)))
    expect(m.measurement.problems).toEqual([])
    expect(find(m, 'Foo#run$lambda')).toHaveLength(2)
  })

  it('names the file when a report cannot be read', () => {
    const fs: JavaFileSystem = {
      readFile: () => {
        throw Object.assign(new Error('no such file'), { code: 'ENOENT' })
      },
      fileExists: () => true,
    }
    const m = measureJava(CONFIG, REPO, ['build/missing.xml'], fs)
    expect(m.measurement.problems).toEqual([
      { file: 'build/missing.xml', message: 'Cannot read the JaCoCo report (ENOENT)' },
    ])
  })

  it('names the file when a report cannot be read and the error has no code', () => {
    const fs: JavaFileSystem = {
      readFile: () => {
        throw new Error('boom')
      },
      fileExists: () => true,
    }
    const m = measureJava(CONFIG, REPO, ['x.xml'], fs)
    expect(m.measurement.problems).toEqual([
      { file: 'x.xml', message: 'Cannot read the JaCoCo report (unknown error)' },
    ])
  })

  it('names the file when a report is not well-formed XML', () => {
    const m = synthetic('<report><package name="a"><class></package></report>')
    expect(m.measurement.functions).toEqual([])
    expect(m.measurement.problems).toHaveLength(1)
    expect(m.measurement.problems[0].file).toBe('build/jacoco.xml')
    expect(m.measurement.problems[0].message).toMatch(/^Cannot parse the JaCoCo report: /)
  })

  it('names the file when a report is empty', () => {
    const m = synthetic('')
    expect(problemsOf(m)).toHaveLength(1)
    expect(m.measurement.problems[0].file).toBe('build/jacoco.xml')
  })

  it('reports a well-formed document that is not a JaCoCo report', () => {
    const m = synthetic('<html><body/></html>')
    expect(m.measurement.problems).toEqual([
      { file: 'build/jacoco.xml', message: 'Not a JaCoCo report: the root element is not <report>' },
    ])
  })

  it('does not follow an external entity, and reads nothing but the report', () => {
    const reads: string[] = []
    const fs: JavaFileSystem = {
      readFile: (abs) => {
        reads.push(abs)
        return `<?xml version="1.0"?><!DOCTYPE report [<!ENTITY ext SYSTEM "file:///etc/hostname">]><report>${report(foo(method('name="&ext;" desc="()V" line="1"')))}</report>`
      },
      fileExists: () => true,
    }
    const m = measureJava(CONFIG, REPO, ['ext.xml'], fs)
    expect(m.measurement.functions).toEqual([])
    expect(m.measurement.problems).toHaveLength(1)
    expect(m.measurement.problems[0].file).toBe('ext.xml')
    expect(reads).toEqual([`${REPO}/ext.xml`])
  })

  it.each([
    ['a method with no COMPLEXITY counter', method('name="a" desc="()V" line="1"', counter('LINE', 0, 1)), 'has no COMPLEXITY counter'],
    ['a method with no LINE counter', method('name="a" desc="()V" line="1"', counter('COMPLEXITY', 0, 1)), 'has no LINE counter'],
    ['a LINE counter that counts nothing', method('name="a" desc="()V" line="1"', counter('LINE', 0, 0) + counter('COMPLEXITY', 0, 1)), 'has no LINE counter'],
    ['a method with no name', method('desc="()V" line="1"'), 'has no name or desc'],
    ['a method with no desc', method('name="a" line="1"'), 'has no name or desc'],
    ['a method with an invalid desc', method('name="a" desc="(I" line="1"'), 'has an invalid desc'],
    ['a method with an invalid line', method('name="a" desc="()V" line="x"'), 'has an invalid line'],
    ['a counter with a bad number', method('name="a" desc="()V" line="1"', '<counter type="LINE" missed="-1" covered="1"/>'), 'has an invalid or repeated counter'],
    ['a counter with no type', method('name="a" desc="()V" line="1"', '<counter missed="0" covered="1"/>'), 'has an invalid or repeated counter'],
    ['a repeated counter', method('name="a" desc="()V" line="1"', GOOD_COUNTERS + counter('LINE', 0, 1)), 'has an invalid or repeated counter'],
    ['a lambda with an unrecognised name', method('name="lambda$odd" desc="()V" line="1"'), 'has an unrecognised lambda name'],
  ])('names the report for %s', (_label, methods, reason) => {
    const m = synthetic(report(foo(methods)))
    expect(m.measurement.functions).toEqual([])
    expect(m.measurement.problems).toEqual([
      { file: 'build/jacoco.xml', message: `Malformed JaCoCo report: a method of com/example/Foo ${reason}` },
    ])
  })

  it('reports a package with no name', () => {
    const m = synthetic('<report name="t"><package><class name="a"/></package></report>')
    expect(m.measurement.problems).toEqual([
      { file: 'build/jacoco.xml', message: 'Malformed JaCoCo report: a package has no name' },
    ])
  })

  it('reports a class with no name', () => {
    const m = synthetic(report('<class sourcefilename="Foo.java"/>'))
    expect(m.measurement.problems).toEqual([
      { file: 'build/jacoco.xml', message: 'Malformed JaCoCo report: a class has no name' },
    ])
  })

  it('skips a class with no sourcefilename as out of scope', () => {
    const m = synthetic(report(foo(method('name="a" desc="()V" line="1"'), 'name="com/example/Foo"')))
    expect(m.measurement.functions).toEqual([])
    expect(m.measurement.problems).toEqual([])
    expect(m.outOfScope).toBe(1)
  })

  it('reports the problems of every report, not only the first', () => {
    const fs: JavaFileSystem = {
      readFile: (abs) => (abs.endsWith('a.xml') ? '' : report(foo(method('name="ok" desc="()V" line="1"')))),
      fileExists: () => true,
    }
    const m = measureJava(CONFIG, REPO, ['a.xml', 'b.xml'], fs)
    expect(m.measurement.problems.map((p) => p.file)).toEqual(['a.xml'])
    expect(m.measurement.functions.map((f) => f.symbol)).toEqual(['Foo#ok()'])
  })
})

describe('the JaCoCo DOCTYPE', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('parses with no network request and no read of the DTD', () => {
    const fetchStub = vi.fn()
    vi.stubGlobal('fetch', fetchStub)
    const transports = [
      vi.spyOn(http, 'request'),
      vi.spyOn(http, 'get'),
      vi.spyOn(https, 'request'),
      vi.spyOn(https, 'get'),
    ].map((spy) =>
      spy.mockImplementation(() => {
        throw new Error('network request attempted')
      }),
    )
    const reads: string[] = []
    const fs: JavaFileSystem = {
      readFile: (abs) => {
        reads.push(abs)
        return readFileSync(abs, 'utf8')
      },
      fileExists: existsSync,
    }

    const m = measureJava(CONFIG, FIXTURES, ['report.xml'], fs)

    expect(readFileSync(path.join(FIXTURES, 'report.xml'), 'utf8')).toContain('<!DOCTYPE report PUBLIC')
    expect(m.measurement.problems).toEqual([])
    expect(m.measurement.functions.length).toBeGreaterThan(10)
    expect(fetchStub).not.toHaveBeenCalled()
    transports.forEach((spy) => expect(spy).not.toHaveBeenCalled())
    expect(reads).toEqual([path.join(FIXTURES, 'report.xml')])
  })
})
