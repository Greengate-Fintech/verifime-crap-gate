import { statSync } from 'fs'
import path from 'path'
import { ESLint } from 'eslint'
import type { Linter, Rule } from 'eslint'
import tseslint from 'typescript-eslint'
import type { CrapConfig } from './config'
import { makeDeclarationRule, makeSpanRule } from './spans'
import type { FunctionSpan, SourcePoint } from './types'

// Runs ESLint in-process with a built-in flat config: ignores for dependency, build, coverage,
// declaration and cdk output paths, the typescript-eslint parser, inline directives off, and
// `complexity` at max 0 so that every function is reported with its cyclomatic complexity.
// The consumer's own ESLint config is never read. The measure's scope filter stays
// authoritative; the ignores here only save time. The same pass runs the companion rule
// (src/spans.ts), which records each reported function's span for the coverage join.

const IGNORES = ['**/node_modules/**', '**/dist/**', '**/coverage/**', '**/*.d.ts', '**/cdk.out/**']

/** `files` globs from extensions: `.ts` becomes `**\/*.ts`, so a compiled `.js` twin is never linted. */
const globsOf = (extensions: readonly string[]): string[] => extensions.map((ext) => `**/*${ext}`)

/** The companion rule must take exactly the options `complexity` takes, or the two would report different functions. */
const COMPLEXITY_OPTIONS = { max: 0 }

const SPAN_PLUGIN = 'crap-gate'
const SPAN_RULE = 'function-spans'
const DECLARATION_RULE = 'compiled-declarations'

export const buildEslintConfig = (extensions: readonly string[]): Linter.Config[] => [
  { ignores: IGNORES },
  {
    files: globsOf(extensions),
    languageOptions: { parser: tseslint.parser },
    linterOptions: { reportUnusedDisableDirectives: 'off', noInlineConfig: true },
    rules: { complexity: ['warn', COMPLEXITY_OPTIONS] },
  },
]

/**
 * The companion rules on the same files: the span rule with the same options as `complexity`, and
 * the declaration rule. Neither reports anything, so the lint results are unchanged.
 */
const spanConfig = (extensions: readonly string[], spanRule: Rule.RuleModule, declarationRule: Rule.RuleModule): Linter.Config => ({
  files: globsOf(extensions),
  plugins: { [SPAN_PLUGIN]: { rules: { [SPAN_RULE]: spanRule, [DECLARATION_RULE]: declarationRule } } },
  rules: { [`${SPAN_PLUGIN}/${SPAN_RULE}`]: ['warn', COMPLEXITY_OPTIONS], [`${SPAN_PLUGIN}/${DECLARATION_RULE}`]: 'warn' },
})

/** A lint result with the span of every function its complexity messages report, and the compiled declaration points. */
export type LintedFile = ESLint.LintResult & { spans: FunctionSpan[]; declarations: SourcePoint[] }

/** Appends to the list kept for a file name. */
const collect = <T>(byFile: Map<string, T[]>) => (filename: string, ...items: T[]): void => {
  byFile.set(filename, [...(byFile.get(filename) ?? []), ...items])
}

const isDirectory = (dir: string): boolean => {
  try {
    return statSync(dir).isDirectory()
  } catch {
    return false
  }
}

/** The scope directories that exist under the repo root, in scope order. */
export const lintTargets = (repoRoot: string, scope: readonly string[]): string[] =>
  scope.filter((dir) => isDirectory(path.join(repoRoot, dir)))

/** A scope the consumer set must exist: the ESLint CLI failed on a missing pattern, so a typo must not shrink the measure silently. */
const assertScopeExists = (repoRoot: string, config: CrapConfig): void => {
  if (config.scopeFrom === undefined) return
  const missing = config.scope.find((dir) => !isDirectory(path.join(repoRoot, dir)))
  if (missing !== undefined) {
    throw new Error(`Invalid ${config.scopeFrom}: key "scope" entry ${JSON.stringify(missing)} is not an existing directory`)
  }
}

/** The order the ESLint CLI gives its results (`compareResultsByFilePath`): plain `<` and `>` on the path. */
const byFilePath = (a: ESLint.LintResult, b: ESLint.LintResult): number => {
  if (a.filePath < b.filePath) return -1
  return a.filePath > b.filePath ? 1 : 0
}

/**
 * Lints the scope directories that exist (all of them must, for a scope the config set). With
 * none, it lints nothing, and the measure then fails closed. Results are sorted by file path,
 * as the ESLint CLI sorts them before it formats a report. Each result carries its spans.
 */
export const lintScope = async (repoRoot: string, config: CrapConfig): Promise<LintedFile[]> => {
  assertScopeExists(repoRoot, config)
  const targets = lintTargets(repoRoot, config.scope)
  if (targets.length === 0) return []
  const spans = new Map<string, FunctionSpan[]>()
  const declarations = new Map<string, SourcePoint[]>()
  const spanRule = makeSpanRule(collect(spans))
  const declarationRule = makeDeclarationRule((filename, points) => collect(declarations)(filename, ...points))
  const eslint = new ESLint({
    cwd: repoRoot,
    overrideConfigFile: true,
    overrideConfig: [...buildEslintConfig(config.extensions), spanConfig(config.extensions, spanRule, declarationRule)],
    errorOnUnmatchedPattern: false,
  })
  const results = (await eslint.lintFiles(targets)).sort(byFilePath)
  return results.map((result) => ({
    ...result,
    spans: spans.get(result.filePath) ?? [],
    declarations: declarations.get(result.filePath) ?? [],
  }))
}
