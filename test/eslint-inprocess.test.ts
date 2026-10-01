import { execFileSync } from 'child_process'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../src/config'
import { lintScope, lintTargets } from '../src/eslint'
import { FIXTURES, readFixture, tempRoot, writeFileIn } from './helpers/sandbox'

const SAMPLE = readFixture('sample.ts')
const ESLINT_BIN = path.join(__dirname, '..', 'node_modules', 'eslint', 'bin', 'eslint.js')

const sampleRoot = (): string => {
  const root = tempRoot('crap-eslint')
  writeFileIn(root, 'src/sample.ts', SAMPLE)
  return root
}

/** The files that carry a complexity message: the only files the measure can score. */
const filesOf = (results: { filePath: string; messages: { ruleId: string | null }[] }[], root: string): string[] =>
  results
    .filter((r) => r.messages.some((m) => m.ruleId === 'complexity'))
    .map((r) => path.relative(root, r.filePath).split(path.sep).join('/'))
    .sort()

type Recorded = { filePath: string; messages: Record<string, unknown>[] }[]

const complexityOf = (message: unknown): number => Number(/complexity of (\d+)/.exec(String(message))?.[1])

describe('in-process ESLint equals recorded ESLint JSON', () => {
  it('matches the output of the real eslint binary for the copied sample, every field of every message, in order', async () => {
    const results = await lintScope(sampleRoot(), DEFAULT_CONFIG)
    const recorded = JSON.parse(readFixture('eslint-cli-output.json')) as Recorded
    const normalised = results.map((r) => ({ filePath: recorded[0].filePath, messages: r.messages }))
    expect(normalised).toEqual(recorded)
  })

  // The copied eslint.json is hand-written: it carries four fields per message, and its names and
  // columns differ from what ESLint 9.39.1 reports (see the PR body). What it does share with the
  // real output is every message's rule, line and complexity, in the same order.
  it('agrees with the copied fixture on rule, line and complexity of every message, in order', async () => {
    const results = await lintScope(sampleRoot(), DEFAULT_CONFIG)
    const copied = JSON.parse(readFixture('eslint.json')) as Recorded
    const shape = (messages: Record<string, unknown>[]) =>
      messages.map((m) => ({ ruleId: m.ruleId, line: m.line, complexity: complexityOf(m.message) }))
    expect(shape(results[0].messages as unknown as Record<string, unknown>[])).toEqual(shape(copied[0].messages))
  })

  it('equals the real eslint binary run with an equivalent config file and -f json', async () => {
    const root = sampleRoot()
    writeFileIn(root, 'src/second.ts', 'export const twice = (n: number) => (n > 0 ? n * 2 : 0)\n')
    writeFileIn(root, 'src/second.js', 'exports.twice = (n) => (n > 0 ? n * 2 : 0)\n')
    writeFileIn(root, 'src/types.d.ts', 'export declare const x: number\n')
    const stdout = execFileSync(
      process.execPath,
      [ESLINT_BIN, '--no-config-lookup', '-c', path.join(FIXTURES, 'eslint.cli.config.mjs'), '-f', 'json', 'src'],
      { cwd: root, encoding: 'utf8' },
    )
    const cli = JSON.parse(stdout) as Record<string, unknown>[]
    const inProcess = await lintScope(root, DEFAULT_CONFIG)
    const pick = (r: Record<string, unknown>) => ({
      filePath: r.filePath,
      messages: r.messages,
      errorCount: r.errorCount,
      warningCount: r.warningCount,
    })
    expect(inProcess.map((r) => pick(r as unknown as Record<string, unknown>))).toEqual(cli.map(pick))
    expect(cli.map((r) => path.basename(r.filePath as string))).toEqual(['sample.ts', 'second.js', 'second.ts'])
  })
})

describe('what is linted', () => {
  it('reports complexity for .ts only by default, so a compiled .js twin yields no function', async () => {
    const root = tempRoot('crap-twin')
    writeFileIn(root, 'src/a.ts', 'export const f = (n: number) => (n ? 1 : 2)\n')
    writeFileIn(root, 'src/a.js', 'exports.f = (n) => (n ? 1 : 2)\n')
    writeFileIn(root, 'src/b.tsx', 'export const g = (n: number) => (n ? 1 : 2)\n')
    expect(filesOf(await lintScope(root, DEFAULT_CONFIG), root)).toEqual(['src/a.ts'])
  })

  it('lints .tsx only when it is configured', async () => {
    const root = tempRoot('crap-tsx')
    writeFileIn(root, 'src/a.ts', 'export const f = (n: number) => (n ? 1 : 2)\n')
    writeFileIn(root, 'src/b.tsx', 'export const g = (n: number) => <div>{n ? 1 : 2}</div>\n')
    const config = { ...DEFAULT_CONFIG, extensions: ['.ts', '.tsx'] }
    expect(filesOf(await lintScope(root, config), root)).toEqual(['src/a.ts', 'src/b.tsx'])
  })

  it('skips node_modules, dist, coverage, declaration files and cdk.out inside a scope directory', async () => {
    const root = tempRoot('crap-ignores')
    writeFileIn(root, 'src/keep.ts', 'export const f = (n: number) => (n ? 1 : 2)\n')
    for (const skipped of ['src/node_modules/x.ts', 'src/dist/x.ts', 'src/coverage/x.ts', 'src/types.d.ts', 'src/cdk.out/x.ts']) {
      writeFileIn(root, skipped, 'export const g = (n: number) => (n ? 1 : 2)\n')
    }
    expect(filesOf(await lintScope(root, DEFAULT_CONFIG), root)).toEqual(['src/keep.ts'])
  })

  it('ignores inline directives and unused-directive reporting', async () => {
    const root = tempRoot('crap-inline')
    writeFileIn(root, 'src/a.ts', '/* eslint complexity: off */\n// eslint-disable-next-line complexity\nexport const f = (n: number) => (n ? 1 : 2)\n')
    const [result] = await lintScope(root, DEFAULT_CONFIG)
    // The directives are ignored (ESLint says so with null-rule warnings) and the rule still reports.
    expect(result.messages.filter((m) => m.ruleId === 'complexity')).toHaveLength(1)
  })

  it('never applies the consumer eslint config', async () => {
    const root = sampleRoot()
    writeFileIn(root, 'eslint.config.mjs', 'export default [{ ignores: ["**"] }]\n')
    writeFileIn(root, 'src/eslint.config.mjs', 'this is not valid javascript(\n')
    expect(filesOf(await lintScope(root, DEFAULT_CONFIG), root)).toEqual(['src/sample.ts'])
  })

  it('reports a parse failure as a fatal message, never as a clean run', async () => {
    const root = tempRoot('crap-parse')
    writeFileIn(root, 'src/bad.ts', 'export const = (\n')
    const [result] = await lintScope(root, DEFAULT_CONFIG)
    expect(result.messages.some((m) => m.fatal === true)).toBe(true)
  })
})

describe('lintTargets', () => {
  it('keeps the scope directories that exist, in scope order', () => {
    const root = tempRoot('crap-targets')
    writeFileIn(root, 'lib/a.ts', '')
    writeFileIn(root, 'src/a.ts', '')
    writeFileIn(root, 'cdk/lib/a.ts', '')
    expect(lintTargets(root, DEFAULT_CONFIG.scope)).toEqual(['src', 'lib', 'cdk/lib'])
  })

  it('ignores a scope entry that is a file, not a directory', () => {
    const root = tempRoot('crap-targets-file')
    writeFileIn(root, 'src', 'not a directory')
    expect(lintTargets(root, ['src'])).toEqual([])
  })

  it('lints nothing when no scope directory exists', async () => {
    expect(await lintScope(tempRoot('crap-none'), DEFAULT_CONFIG)).toEqual([])
  })
})
