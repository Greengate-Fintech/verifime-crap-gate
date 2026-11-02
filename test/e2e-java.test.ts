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
//   Pricing#discount(int)    cc 4, cov 0.5  -> 6.000   frozen
//   Pricing#total(int[])     cc 3, cov 0    -> 12.000  frozen
//   Router#route(String)     cc 2, cov 0    -> 6.000   frozen
//   Pricing#<init>(), Router#<init>(), Router#ok()  cc 1, covered -> 1.000 each

const FIXTURE = path.join(__dirname, 'e2e', 'java-project')
const CLI = path.join(__dirname, '..', 'dist', 'cli.cjs')
const CORE = 'core/build/reports/jacoco/test/jacocoTestReport.xml'
const WEB = 'web/build/reports/jacoco/test/jacocoTestReport.xml'
const PRICING = 'core/src/main/java/com/example/core/Pricing.java'
const ROUTER = 'web/src/main/java/com/example/web/Router.java'
const MEASURE_LINE = 'CRAP measure: functions=6 over5=3 sumOver5=24.0 unmatched=0'

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

/** Replaces one piece of text in a report (each piece used is unique in its file), to change what the report says. */
const edit = (root: string, rel: string, from: string, to: string): void => {
  const text = read(root, rel)
  expect(text).toContain(from)
  writeFileIn(root, rel, text.replace(from, to))
}

describe('Java e2e: the committed project', () => {
  it('measure scores the six methods and reports the skipped generated class', async () => {
    const r = await run(copyProject(), 'measure')
    expect(r.code).toBe(0)
    expect(r.logs.at(-1)).toBe(MEASURE_LINE)
    expect(r.logs.at(-2)).toMatch(/^Classes skipped: 1 \(.*1 source not found under any scope root/)
  })

  it('check passes against the committed baseline', async () => {
    const r = await run(copyProject(), 'check')
    expect(r.errors).toEqual([])
    expect(r.logs.at(-1)).toBe('CRAP ratchet: pass (3 frozen, 6 functions measured)')
    expect(r.code).toBe(0)
  })

  it('baseline regenerates the committed files byte for byte', async () => {
    const root = copyProject()
    expect((await run(root, 'baseline', '--output-dir', path.join(root, 'regen'))).code).toBe(0)
    for (const file of ['baseline.tsv', 'unmatched.tsv']) {
      expect(read(root, `regen/${file}`)).toBe(readFileSync(path.join(FIXTURE, 'crap', file), 'utf8'))
    }
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
    // discount: line 1 of 4 covered -> cov = min(0.25, 0.5) = 0.25; CRAP = 16 * 0.75^3 + 4 = 10.750 (was 6.000).
    edit(root, CORE, '<counter type="LINE" missed="2" covered="2"/>', '<counter type="LINE" missed="3" covered="1"/>')
    const r = await run(root, 'check')
    expect(r.code).toBe(1)
    expect(r.errors.join('\n')).toContain(`CRAP ratchet: REGRESSION ${PRICING}#Pricing#discount(int)`)
    expect(r.errors.join('\n')).toContain('was frozen at 6.0 but now scores 10.8')
  })

  it('an improved method that drops to the threshold or below is stale, and fails check', async () => {
    const root = copyProject()
    // route: fully covered -> cc 2, cov 1 -> CRAP = 2.000, at or below 5, so its frozen row is stale.
    edit(root, WEB, '<counter type="BRANCH" missed="2" covered="0"/>', '<counter type="BRANCH" missed="0" covered="2"/>')
    edit(root, WEB, '<counter type="LINE" missed="3" covered="0"/>', '<counter type="LINE" missed="0" covered="3"/>')
    const r = await run(root, 'check')
    expect(r.code).toBe(1)
    expect(r.errors.join('\n')).toContain(`CRAP ratchet: STALE ENTRY ${ROUTER}#Router#route(String)`)
    expect(r.errors.join('\n')).toContain('delete this line from crap/baseline.tsv, or run npm run crap:baseline')
  })
})

describe('Java e2e: baseline and diff', () => {
  it('baseline refuses a new offender without --allow-growth, and writes nothing', async () => {
    const root = copyProject()
    edit(root, CORE, '<counter type="LINE" missed="2" covered="2"/>', '<counter type="LINE" missed="3" covered="1"/>')
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
    edit(root, CORE, '<counter type="LINE" missed="2" covered="2"/>', '<counter type="LINE" missed="3" covered="1"/>')
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
    expect(result.summary).toBe('CRAP ratchet: pass (3 frozen, 6 functions measured)')
    expect(summary).toContain(`\`${SKIPPED}\``)
  })

  it('adds nothing when no class was skipped', async () => {
    const root = copyProject()
    writeFileIn(root, WEB, read(root, WEB).replace(/<class name="com\/example\/web\/GeneratedClient"[\s\S]*?<\/class>/, ''))
    const { summary } = await act(root, { INPUT_MODE: 'measure' })
    expect(summary).not.toContain('Classes skipped')
  })
})
