import { existsSync, readFileSync } from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { parseInputs, runAction, toArgv } from '../src/action'
import { cc3Coverage, CC3_SOURCE, commitAll, initRepo, makeIo, tempRoot, writeFileIn } from './helpers/sandbox'

const ONE_COVERAGE = JSON.stringify({ coverage: ['coverage/coverage-final.json'] })
const MEASURE_LINE = 'CRAP measure: functions=1 over5=1 sumOver5=12.0 unmatched=0'

/** A fixture project under `root`/`sub`, with coverage keyed by a foreign absolute root. */
const projectAt = (root: string, sub = '.'): string => {
  const dir = path.join(root, sub)
  writeFileIn(dir, 'crap/config.json', ONE_COVERAGE)
  writeFileIn(dir, 'src/busy.ts', CC3_SOURCE)
  writeFileIn(dir, 'coverage/coverage-final.json', cc3Coverage(path.join(dir, 'src/busy.ts')))
  return dir
}

const env = (root: string, inputs: Record<string, string>): Record<string, string> => ({
  GITHUB_OUTPUT: path.join(root, 'gh-output'),
  GITHUB_STEP_SUMMARY: path.join(root, 'gh-summary.md'),
  ...Object.fromEntries(Object.entries(inputs).map(([k, v]) => [`INPUT_${k.toUpperCase()}`, v])),
})

const act = async (root: string, inputs: Record<string, string>, extra: Record<string, string> = {}) => {
  const out = makeIo()
  const result = await runAction({ ...env(root, inputs), ...extra }, root, out.io)
  return { ...result, logs: out.logs, errors: out.errors }
}

const read = (root: string, rel: string): string => readFileSync(path.join(root, rel), 'utf8')

describe('parseInputs', () => {
  it('requires a mode', () => {
    expect(parseInputs({})).toEqual({ error: 'Input "mode" is required: one of measure, check, baseline, diff' })
  })

  it('rejects an unknown mode, naming it', () => {
    expect(parseInputs({ INPUT_MODE: 'fix' })).toEqual({ error: 'Invalid mode "fix": use one of measure, check, baseline, diff' })
  })

  it('applies the defaults', () => {
    expect(parseInputs({ INPUT_MODE: 'check' })).toEqual({
      inputs: { mode: 'check', config: 'crap/config.json', base: 'HEAD^1', outputDir: '', workingDirectory: '.' },
    })
  })

  it('reads every input, trimmed, with the hyphenated names the runner sets', () => {
    const parsed = parseInputs({
      INPUT_MODE: ' baseline ',
      INPUT_CONFIG: 'conf/x.json',
      INPUT_BASE: 'origin/main',
      'INPUT_OUTPUT-DIR': ' out ',
      'INPUT_WORKING-DIRECTORY': 'pkg',
    })
    expect(parsed).toEqual({
      inputs: { mode: 'baseline', config: 'conf/x.json', base: 'origin/main', outputDir: 'out', workingDirectory: 'pkg' },
    })
  })

  it('treats an empty input as its default', () => {
    expect(parseInputs({ INPUT_MODE: 'diff', INPUT_BASE: '', INPUT_CONFIG: '' })).toMatchObject({
      inputs: { base: 'HEAD^1', config: 'crap/config.json' },
    })
  })
})

describe('toArgv', () => {
  const inputs = { config: 'conf/x.json', base: 'abc', outputDir: '', workingDirectory: '.' }

  it('passes the config to every mode', () => {
    expect(toArgv({ ...inputs, mode: 'measure' })).toEqual(['measure', '--config', 'conf/x.json'])
    expect(toArgv({ ...inputs, mode: 'check' })).toEqual(['check', '--config', 'conf/x.json'])
  })

  it('passes the base to diff only', () => {
    expect(toArgv({ ...inputs, mode: 'diff' })).toEqual(['diff', '--config', 'conf/x.json', '--base-ref', 'abc'])
  })

  it('passes output-dir to baseline only', () => {
    expect(toArgv({ ...inputs, mode: 'baseline', outputDir: 'out' })).toEqual(['baseline', '--config', 'conf/x.json', '--output-dir', 'out'])
    expect(toArgv({ ...inputs, mode: 'baseline' })).toEqual(['baseline', '--config', 'conf/x.json'])
    expect(toArgv({ ...inputs, mode: 'check', outputDir: 'out' })).toEqual(['check', '--config', 'conf/x.json'])
  })
})

describe('runAction', () => {
  it('runs the mode, forwards its lines, and exposes the summary line', async () => {
    const root = tempRoot('crap-action')
    projectAt(root)
    const r = await act(root, { mode: 'measure' })
    expect(r).toMatchObject({ code: 0, summary: MEASURE_LINE, logs: [MEASURE_LINE], errors: [] })
    expect(read(root, 'gh-output')).toBe(`summary=${MEASURE_LINE}\n`)
  })

  it('writes a job summary with the mode, result and summary line', async () => {
    const root = tempRoot('crap-action')
    projectAt(root)
    await act(root, { mode: 'measure' })
    expect(read(root, 'gh-summary.md')).toBe(`### CRAP gate: measure\n\nResult: pass\n\n\`${MEASURE_LINE}\`\n`)
  })

  it('runs in the working directory, resolved against the caller, and restores the cwd', async () => {
    const root = tempRoot('crap-action')
    projectAt(root, 'pkg')
    const before = process.cwd()
    const r = await act(root, { mode: 'measure', 'working-directory': 'pkg' })
    expect(r.code).toBe(0)
    expect(existsSync(path.join(root, 'pkg/coverage/crap-report.json'))).toBe(true)
    expect(process.cwd()).toBe(before)
  })

  it('fails on a working directory that does not exist, naming it', async () => {
    const root = tempRoot('crap-action')
    const r = await act(root, { mode: 'measure', 'working-directory': 'nope' })
    expect(r).toMatchObject({ code: 1, errors: ['Working directory not found: nope'] })
  })

  it('fails on an invalid mode without touching the project', async () => {
    const root = tempRoot('crap-action')
    const r = await act(root, { mode: 'fix' })
    expect(r).toMatchObject({ code: 1, errors: ['Invalid mode "fix": use one of measure, check, baseline, diff'] })
    expect(read(root, 'gh-summary.md')).toContain('Result: fail')
  })

  it('check passes against a matching baseline', async () => {
    const root = tempRoot('crap-action')
    projectAt(root)
    writeFileIn(root, 'crap/baseline.tsv', '# h\nsrc/busy.ts\tbusy\t12.000\n')
    const r = await act(root, { mode: 'check' })
    expect(r).toMatchObject({ code: 0, summary: 'CRAP ratchet: pass (1 frozen, 1 functions measured)' })
  })

  it('check fails with the CLI messages and annotations, and records the failure', async () => {
    const root = tempRoot('crap-action')
    projectAt(root)
    writeFileIn(root, 'crap/baseline.tsv', '# empty\n')
    const r = await act(root, { mode: 'check' }, { GITHUB_ACTIONS: 'true' })
    expect(r.code).toBe(1)
    expect(r.errors[0]).toMatch(/^CRAP ratchet: NEW OFFENDER src\/busy\.ts#busy /)
    expect(r.errors[1]).toMatch(/^::error file=src\/busy\.ts,line=1::CRAP ratchet: NEW OFFENDER src\/busy\.ts#busy /)
    const summary = read(root, 'gh-summary.md')
    expect(summary).toContain('Result: fail')
    expect(summary).toContain('NEW OFFENDER src/busy.ts#busy')
    expect(summary).not.toContain('::error')
  })

  it('baseline writes to output-dir and leaves crap/ alone', async () => {
    const root = tempRoot('crap-action')
    projectAt(root)
    const r = await act(root, { mode: 'baseline', 'output-dir': 'regen' })
    expect(r.code).toBe(0)
    expect(read(root, 'regen/baseline.tsv')).toContain('src/busy.ts\tbusy\t12.000\n')
    expect(existsSync(path.join(root, 'crap/baseline.tsv'))).toBe(false)
  })

  it('diff compares against the base input', async () => {
    const root = tempRoot('crap-action')
    initRepo(root)
    projectAt(root)
    writeFileIn(root, 'crap/baseline.tsv', '# h\nsrc/busy.ts\tbusy\t12.000\n')
    writeFileIn(root, 'crap/unmatched.tsv', '# h\n')
    commitAll(root, 'base')
    writeFileIn(root, 'README.md', 'y\n')
    commitAll(root, 'head')
    const r = await act(root, { mode: 'diff', base: 'HEAD~1' })
    expect(r.code).toBe(0)
    expect(r.summary).toBe('CRAP baseline diff: pass (no baseline growth against the base; no unmatched list growth against the base)')
  })

  it('exposes the last error line when nothing was logged', async () => {
    const root = tempRoot('crap-action')
    initRepo(root)
    writeFileIn(root, 'crap/baseline.tsv', '# h\nsrc/busy.ts\tbusy\t12.000\n')
    writeFileIn(root, 'crap/unmatched.tsv', '# h\n')
    commitAll(root, 'only')
    const r = await act(root, { mode: 'diff', base: 'no-such-rev' })
    expect(r.code).toBe(1)
    expect(r.summary).toContain('Cannot resolve base revision no-such-rev')
  })

  it('writes no files when the runner sets no output paths', async () => {
    const root = tempRoot('crap-action')
    projectAt(root)
    const out = makeIo()
    const r = await runAction({ INPUT_MODE: 'measure' }, root, out.io)
    expect(r.code).toBe(0)
    expect(existsSync(path.join(root, 'gh-output'))).toBe(false)
  })
})
