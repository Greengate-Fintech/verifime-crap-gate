import { execFileSync } from 'child_process'
import { pathToFileURL } from 'url'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { runCli } from '../src/cli'
import { DEFAULT_CONFIG, parseConfig } from '../src/config'
import { buildEslintConfig, lintScope, lintTargets } from '../src/eslint'
import { readFileSync } from 'fs'
import { cc3Coverage, CC3_SOURCE, inDirectory, makeIo, readFixture, tempRoot, writeFileIn } from './helpers/sandbox'

const SAMPLE = readFixture('sample.ts')
const TSESLINT_PATH = require.resolve('typescript-eslint')

/**
 * A config file for the real eslint binary, generated from `buildEslintConfig` so that the two
 * cannot drift. Only the parser, which is an object and not data, is written out by hand.
 */
const writeCliConfig = (dir: string, extensions: readonly string[]): string => {
  const marker = '__PARSER__'
  const config = buildEslintConfig(extensions)
  const json = JSON.stringify(config, (_key, value) => (_key === 'parser' ? marker : value), 2)
  const text = `import tseslint from ${JSON.stringify(pathToFileURL(TSESLINT_PATH).href)}\nexport default ${json.replace(JSON.stringify(marker), 'tseslint.parser')}\n`
  writeFileIn(dir, 'eslint.cli.config.mjs', text)
  return path.join(dir, 'eslint.cli.config.mjs')
}

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

  it('equals the real eslint binary run with the same config, -f json, on a scope with twins, directives and ignored folders', async () => {
    const root = sampleRoot()
    const source = 'export const twice = (n: number) => (n > 0 ? n * 2 : 0)\n'
    writeFileIn(root, 'src/second.ts', source)
    writeFileIn(root, 'src/second.js', 'exports.twice = (n) => (n > 0 ? n * 2 : 0)\n')
    writeFileIn(root, 'src/types.d.ts', 'export declare const x: number\n')
    writeFileIn(root, 'src/directive.ts', `/* eslint complexity: off */\n// eslint-disable-next-line complexity\n${source}`)
    for (const ignored of ['dist', 'coverage', 'cdk.out', 'node_modules']) writeFileIn(root, `src/${ignored}/x.ts`, source)
    const config = writeCliConfig(tempRoot('crap-cli-config'), DEFAULT_CONFIG.extensions)
    const stdout = execFileSync(process.execPath, [ESLINT_BIN, '--no-config-lookup', '-c', config, '-f', 'json', 'src'], {
      cwd: root,
      encoding: 'utf8',
    })
    const cli = JSON.parse(stdout) as Record<string, unknown>[]
    const inProcess = await lintScope(root, DEFAULT_CONFIG)
    const pick = (r: Record<string, unknown>) => ({
      filePath: r.filePath,
      messages: r.messages,
      errorCount: r.errorCount,
      warningCount: r.warningCount,
    })
    expect(inProcess.map((r) => pick(r as unknown as Record<string, unknown>))).toEqual(cli.map(pick))
    expect(cli.map((r) => path.basename(r.filePath as string))).toEqual(['directive.ts', 'sample.ts', 'second.js', 'second.ts'])
    // The directives are ignored by both, so the rule still reports: complexity message plus the two warnings.
    const directive = cli[0].messages as { ruleId: string | null }[]
    expect(directive.filter((m) => m.ruleId === 'complexity')).toHaveLength(1)
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

  it('skips a scope directory with no lintable file rather than failing', async () => {
    const root = tempRoot('crap-unmatched')
    writeFileIn(root, 'src/a.ts', 'export const f = (n: number) => (n ? 1 : 2)\n')
    writeFileIn(root, 'lib/x.txt', 'not source\n')
    expect(filesOf(await lintScope(root, DEFAULT_CONFIG), root)).toEqual(['src/a.ts'])
  })

  it('returns no result when the only scope directory has no lintable file', async () => {
    const root = tempRoot('crap-unmatched-only')
    writeFileIn(root, 'lib/x.txt', 'not source\n')
    expect(await lintScope(root, DEFAULT_CONFIG)).toEqual([])
  })

  it('lints nothing when no scope directory exists', async () => {
    expect(await lintScope(tempRoot('crap-none'), DEFAULT_CONFIG)).toEqual([])
  })
})

// ESLint's own CLI sorts results by file path before it formats them, so the original gate's
// report followed that order. The Node API returns them in pattern and walk order.
describe('result order equals the ESLint CLI order', () => {
  const FILES = ['src/a-b.ts', 'src/a/b.ts', 'src/Z.ts', 'cdk/lib/z.ts', 'cdk/lib/A.ts']

  const orderRoot = (): string => {
    const root = tempRoot('crap-order')
    for (const file of FILES) writeFileIn(root, file, CC3_SOURCE)
    return root
  }

  it('sorts by file path, as the live CLI does, for a scope whose walk order differs', async () => {
    const root = orderRoot()
    const config = { ...DEFAULT_CONFIG, scope: ['src', 'cdk/lib'] }
    const cliConfig = writeCliConfig(tempRoot('crap-cli-config'), config.extensions)
    const stdout = execFileSync(process.execPath, [ESLINT_BIN, '--no-config-lookup', '-c', cliConfig, '-f', 'json', 'src', 'cdk/lib'], {
      cwd: root,
      encoding: 'utf8',
    })
    const cliOrder = (JSON.parse(stdout) as { filePath: string }[]).map((r) => path.relative(root, r.filePath).split(path.sep).join('/'))
    const ours = (await lintScope(root, config)).map((r) => path.relative(root, r.filePath).split(path.sep).join('/'))
    expect(ours).toEqual(cliOrder)
    expect(cliOrder[0]).toBe('cdk/lib/A.ts')
  })

  it('writes the report functions in that order', async () => {
    const root = orderRoot()
    writeFileIn(root, 'crap/config.json', JSON.stringify({ scope: ['src', 'cdk/lib'], coverage: ['coverage/coverage-final.json'] }))
    const coverage = Object.assign({}, ...FILES.map((f) => JSON.parse(cc3Coverage(path.join(root, f)))))
    writeFileIn(root, 'coverage/coverage-final.json', JSON.stringify(coverage))
    const out = makeIo()
    expect(await inDirectory(root, () => runCli(['measure'], {}, root, out.io))).toBe(0)
    const report = JSON.parse(readFileSync(path.join(root, 'coverage/crap-report.json'), 'utf8')) as { functions: { file: string }[] }
    expect(report.functions.map((f) => f.file)).toEqual([...FILES].sort((a, b) => (path.join(root, a) < path.join(root, b) ? -1 : 1)))
  })
})

describe('an explicit scope must exist', () => {
  const run = async (root: string) => {
    const out = makeIo()
    const code = await inDirectory(root, () => runCli(['measure'], {}, root, out.io))
    return { code, errors: out.errors, logs: out.logs }
  }

  const project = (config: Record<string, unknown>): string => {
    const root = tempRoot('crap-explicit')
    writeFileIn(root, 'src/busy.ts', CC3_SOURCE)
    writeFileIn(root, 'coverage/coverage-final.json', cc3Coverage(path.join(root, 'src/busy.ts')))
    writeFileIn(root, 'crap/config.json', JSON.stringify({ coverage: ['coverage/coverage-final.json'], ...config }))
    return root
  }

  it('fails, naming the directory and the config file, when a configured scope directory is missing', async () => {
    const r = await run(project({ scope: ['src', 'packages/nope'] }))
    expect(r.code).toBe(1)
    expect(r.errors).toEqual(['Invalid crap/config.json: key "scope" entry "packages/nope" is not an existing directory'])
    expect(r.logs).toEqual([])
  })

  it('fails for a configured scope entry that is a file', async () => {
    const root = project({ scope: ['src', 'afile'] })
    writeFileIn(root, 'afile', 'x')
    expect((await run(root)).errors).toEqual(['Invalid crap/config.json: key "scope" entry "afile" is not an existing directory'])
  })

  it('still skips absent directories of the default scope', async () => {
    const r = await run(project({}))
    expect(r.code).toBe(0)
  })

  it('carries where an explicit scope came from, and nothing for the default', () => {
    expect(parseConfig('{"scope":["src"]}', 'conf/x.json').scopeFrom).toBe('conf/x.json')
    expect(parseConfig('{}').scopeFrom).toBeUndefined()
  })
})

