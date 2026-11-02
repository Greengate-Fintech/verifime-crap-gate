import { spawnSync } from 'child_process'
import { cpSync, readFileSync } from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { runAction } from '../src/action'
import { runCli } from '../src/cli'
import { inDirectory, makeIo, tempRoot, writeFileIn } from './helpers/sandbox'

// A synthetic two-module Java project (threshold 5) run through every command, as the TypeScript
// e2e project is. Scores are CRAP = cc^2 * (1 - cov)^3 + cc, with cov = min(line, branch).
//
//   Pricing#discount(int)             cc 4, cov 0.5  -> 6.000   frozen
//   Pricing#total(int[])              cc 3, cov 0    -> 12.000  frozen
//   Pricing#names$lambda              cc 3, cov 0    -> 12.000  frozen (a lambda: one key per enclosing method)
//   Pricing.Tier#rate(String,int[])   cc 3, cov 0    -> 12.000  frozen (a nested class, a comma, an array parameter)
//   Router#<init>(String,int)         cc 2, cov 0    -> 6.000   frozen (a constructor)
//   Router#route(String)              cc 2, cov 0    -> 6.000   frozen
//   Pricing#<init>(), Pricing#names(List), Pricing.Tier#<init>(), Router#ok()  cc 1, covered -> 1.000 each
// Totals: functions = 10, over5 = 6, sumOver5 = 6 + 12 + 12 + 12 + 6 + 6 = 54.

const FIXTURE = path.join(__dirname, 'e2e', 'java-project')
const CLI = path.join(__dirname, '..', 'dist', 'cli.cjs')
const CORE = 'core/build/reports/jacoco/test/jacocoTestReport.xml'
const WEB = 'web/build/reports/jacoco/test/jacocoTestReport.xml'
const PRICING = 'core/src/main/java/com/example/core/Pricing.java'
const ROUTER = 'web/src/main/java/com/example/web/Router.java'
const MEASURE_LINE = 'CRAP measure: functions=10 over5=6 sumOver5=54.0 unmatched=0'

const copyProject = (): string => {
  const root = tempRoot('crap-java-e2e')
  cpSync(FIXTURE, root, { recursive: true })
  return root
}

const read = (root: string, rel: string): string => readFileSync(path.join(root, rel), 'utf8')

const run = async (root: string, ...argv: string[]) => {
  const out = makeIo()
  const code = await inDirectory(root, () => runCli(argv, {}, root, out.io))
  return { code, logs: out.logs, errors: out.errors }
}

/** The text of the one `<method name=...>` element, so an edit cannot reach another method with the same counters. */
const editMethod = (root: string, rel: string, name: string, from: string, to: string): void => {
  const text = read(root, rel)
  const start = text.indexOf(`<method name="${name}"`)
  const end = text.indexOf('</method>', start)
  expect(start).toBeGreaterThan(-1)
  const method = text.slice(start, end)
  expect(method).toContain(from)
  writeFileIn(root, rel, text.slice(0, start) + method.replace(from, to) + text.slice(end))
}

/** Replaces one piece of text in a report (each piece used is unique in its file), to change what the report says. */
const edit = (root: string, rel: string, from: string, to: string): void => {
  const text = read(root, rel)
  expect(text).toContain(from)
  writeFileIn(root, rel, text.replace(from, to))
}

const raiseDiscount = (root: string): void =>
  editMethod(root, CORE, 'discount', '<counter type="LINE" missed="4" covered="4"/>', '<counter type="LINE" missed="6" covered="2"/>')

describe('Java e2e: the committed project', () => {
  it('measure scores the ten methods and reports the skipped generated class', async () => {
    const r = await run(copyProject(), 'measure')
    expect(r.code).toBe(0)
    expect(r.logs.at(-1)).toBe(MEASURE_LINE)
    expect(r.logs.at(-2)).toMatch(/^Classes skipped: 1 \(.*1 source not found under any scope root/)
  })

  it('check passes against the committed baseline', async () => {
    const r = await run(copyProject(), 'check')
    expect(r.errors).toEqual([])
    expect(r.logs.at(-1)).toBe('CRAP ratchet: pass (6 frozen, 10 functions measured)')
    expect(r.code).toBe(0)
  })

  it('baseline regenerates the committed files byte for byte', async () => {
    const root = copyProject()
    expect((await run(root, 'baseline', '--output-dir', path.join(root, 'regen'))).code).toBe(0)
    for (const file of ['baseline.tsv', 'unmatched.tsv']) {
      expect(read(root, `regen/${file}`)).toBe(readFileSync(path.join(FIXTURE, 'crap', file), 'utf8'))
    }
  })

  it.each([
    [PRICING, 'Pricing#names$lambda', '12.000'],
    [PRICING, 'Pricing.Tier#rate(String,int[])', '12.000'],
    [ROUTER, 'Router#<init>(String,int)', '6.000'],
  ])('freezes %s %s, and the row survives the write and the read back', async (file, symbol, score) => {
    const root = copyProject()
    const out = path.join(root, 'regen')
    expect((await run(root, 'baseline', '--output-dir', out)).code).toBe(0)
    expect(read(root, 'regen/baseline.tsv')).toContain(`${file}\t${symbol}\t${score}\n`)
    // The committed file holds the same row, `check` reads it back, and `diff` sees no change.
    expect(read(root, 'crap/baseline.tsv')).toContain(`${file}\t${symbol}\t${score}\n`)
    expect((await run(root, 'check')).code).toBe(0)
    const diff = await run(root, 'diff', '--base', 'regen/baseline.tsv', '--base-unmatched', 'regen/unmatched.tsv')
    expect(diff.code).toBe(0)
  })

  it('diff passes when the head files equal the base files', async () => {
    const root = copyProject()
    const r = await run(root, 'diff', '--base', 'crap/baseline.tsv', '--base-unmatched', 'crap/unmatched.tsv')
    expect(r.code).toBe(0)
    expect(r.logs).toEqual(['CRAP baseline diff: pass (no baseline growth against the base; no unmatched list growth against the base)'])
  })
})

describe('Java e2e: the ratchet', () => {
  it('a new offender fails check', async () => {
    const root = copyProject()
    // audit(): cc 3, nothing covered -> 3^2 * 1 + 3 = 12.000, not in the baseline.
    edit(
      root,
      WEB,
      '<method name="ok"',
      `<method name="audit" desc="()V" line="20">
        <counter type="BRANCH" missed="4" covered="0"/>
        <counter type="LINE" missed="4" covered="0"/>
        <counter type="COMPLEXITY" missed="3" covered="0"/>
      </method>
      <method name="ok"`,
    )
    const r = await run(root, 'check')
    expect(r.code).toBe(1)
    expect(r.errors.join('\n')).toContain(`CRAP ratchet: NEW OFFENDER ${ROUTER}#Router#audit() `)
  })

  it('a raised score fails check', async () => {
    const root = copyProject()
    // discount: 2 of 8 lines covered -> cov = min(0.25, 0.5) = 0.25; CRAP = 16 * 0.75^3 + 4 = 10.750 (was 6.000).
    raiseDiscount(root)
    const r = await run(root, 'check')
    expect(r.code).toBe(1)
    expect(r.errors.join('\n')).toContain(`CRAP ratchet: REGRESSION ${PRICING}#Pricing#discount(int)`)
    expect(r.errors.join('\n')).toContain('was frozen at 6.0 but now scores 10.8')
  })

  it('an improved method that drops to the threshold or below is stale, and fails check', async () => {
    const root = copyProject()
    // route: fully covered -> cc 2, cov 1 -> CRAP = 2.000, at or below 5, so its frozen row is stale.
    editMethod(root, WEB, 'route', '<counter type="BRANCH" missed="2" covered="0"/>', '<counter type="BRANCH" missed="0" covered="2"/>')
    editMethod(root, WEB, 'route', '<counter type="LINE" missed="3" covered="0"/>', '<counter type="LINE" missed="0" covered="3"/>')
    const r = await run(root, 'check')
    expect(r.code).toBe(1)
    expect(r.errors.join('\n')).toContain(`CRAP ratchet: STALE ENTRY ${ROUTER}#Router#route(String)`)
    expect(r.errors.join('\n')).toContain('delete this line from crap/baseline.tsv, or run npm run crap:baseline')
  })
})

describe('Java e2e: baseline and diff', () => {
  it('baseline refuses a new offender without --allow-growth, and writes nothing', async () => {
    const root = copyProject()
    raiseDiscount(root)
    const before = read(root, 'crap/baseline.tsv')
    const r = await run(root, 'baseline')
    expect(r.code).toBe(1)
    expect(r.errors.join('\n')).toContain('refusing to grow the baseline')
    expect(read(root, 'crap/baseline.tsv')).toBe(before)
  })

  it('baseline --allow-growth freezes the raised score, and diff then fails against the old baseline', async () => {
    const root = copyProject()
    writeFileIn(root, 'base/baseline.tsv', read(root, 'crap/baseline.tsv'))
    writeFileIn(root, 'base/unmatched.tsv', read(root, 'crap/unmatched.tsv'))
    raiseDiscount(root)
    expect((await run(root, 'baseline', '--allow-growth')).code).toBe(0)
    expect(read(root, 'crap/baseline.tsv')).toContain(`${PRICING}\tPricing#discount(int)\t10.750\n`)
    const r = await run(root, 'diff', '--base', 'base/baseline.tsv', '--base-unmatched', 'base/unmatched.tsv')
    expect(r.code).toBe(1)
    expect(r.errors.join('\n')).toContain(`CRAP baseline diff: GROWN ${PRICING}#Pricing#discount(int) grew from 6.0 in the base to 10.8`)
  })
})

describe('Java e2e: the bundle and the action', () => {
  it('dist/cli.cjs measures the project with only Node on the path', () => {
    const r = spawnSync(process.execPath, [CLI, 'measure'], { cwd: copyProject(), encoding: 'utf8', env: { PATH: '' } })
    expect(r.stdout.split('\n').slice(-2)[0]).toBe(MEASURE_LINE)
    expect(r.status).toBe(0)
  })

  it('the action reports the measure line as its summary, not the skipped line', async () => {
    const root = copyProject()
    const out = makeIo()
    const result = await runAction({ INPUT_MODE: 'measure' }, root, out.io)
    expect(result).toEqual({ code: 0, summary: MEASURE_LINE })
  })
})

describe('A2: the job summary shows the classes skipped', () => {
  const summaryFile = (root: string): string => path.join(root, 'gh-summary.md')
  const act = async (root: string, inputs: Record<string, string>) => {
    const out = makeIo()
    const result = await runAction({ GITHUB_STEP_SUMMARY: summaryFile(root), GITHUB_OUTPUT: path.join(root, 'gh-output'), ...inputs }, root, out.io)
    return { result, summary: read(root, 'gh-summary.md'), output: read(root, 'gh-output') }
  }
  const SKIPPED = 'Classes skipped: 1 (0 not-Java, 0 no source file name, 1 source not found under any scope root, 0 excluded)'

  it('adds the line on a green run, and the summary output stays the measure line', async () => {
    const { result, summary, output } = await act(copyProject(), { INPUT_MODE: 'measure' })
    expect(result.summary).toBe(MEASURE_LINE)
    expect(output).toBe(`summary=${MEASURE_LINE}\n`)
    expect(summary).toBe(`### CRAP gate: measure\n\nResult: pass\n\n\`${MEASURE_LINE}\`\n\n\`${SKIPPED}\`\n`)
  })

  it('adds the line on a green check, after the pass line', async () => {
    const { result, summary } = await act(copyProject(), { INPUT_MODE: 'check' })
    expect(result.summary).toBe('CRAP ratchet: pass (6 frozen, 10 functions measured)')
    expect(summary).toContain(`\`${SKIPPED}\``)
  })

  it('adds nothing when no class was skipped', async () => {
    const root = copyProject()
    writeFileIn(root, WEB, read(root, WEB).replace(/<class name="com\/example\/web\/GeneratedClient"[\s\S]*?<\/class>/, ''))
    const { summary } = await act(root, { INPUT_MODE: 'measure' })
    expect(summary).not.toContain('Classes skipped')
  })
})

describe('T5: a TypeScript run prints exactly what it printed before Java support', () => {
  const TS_FIXTURE = path.join(__dirname, 'e2e', 'project')
  const TS_MEASURE = 'CRAP measure: functions=4 over5=2 sumOver5=23.1 unmatched=0'

  it('measure prints the one summary line and nothing else', async () => {
    const root = tempRoot('crap-ts-e2e')
    cpSync(TS_FIXTURE, root, { recursive: true })
    expect(await run(root, 'measure')).toEqual({ code: 0, logs: [TS_MEASURE], errors: [] })
  })

  it('check prints the summary line and the pass line and nothing else', async () => {
    const root = tempRoot('crap-ts-e2e')
    cpSync(TS_FIXTURE, root, { recursive: true })
    expect(await run(root, 'check')).toEqual({
      code: 0,
      logs: [TS_MEASURE, 'CRAP ratchet: pass (2 frozen, 4 functions measured)'],
      errors: [],
    })
  })

  it('the action job summary for a TypeScript project has no note', async () => {
    const root = tempRoot('crap-ts-e2e')
    cpSync(TS_FIXTURE, root, { recursive: true })
    const gh = path.join(root, 'gh-summary.md')
    await runAction({ INPUT_MODE: 'measure', GITHUB_STEP_SUMMARY: gh }, root, makeIo().io)
    expect(readFileSync(gh, 'utf8')).toBe(`### CRAP gate: measure\n\nResult: pass\n\n\`${TS_MEASURE}\`\n`)
  })
})
