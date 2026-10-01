import { statSync } from 'fs'
import path from 'path'
import { ESLint } from 'eslint'
import type { Linter } from 'eslint'
import tseslint from 'typescript-eslint'
import type { CrapConfig } from './config'

// Runs ESLint in-process with a built-in flat config: ignores for dependency, build, coverage,
// declaration and cdk output paths, the typescript-eslint parser, inline directives off, and
// `complexity` at max 0 so that every function is reported with its cyclomatic complexity.
// The consumer's own ESLint config is never read. The measure's scope filter stays
// authoritative; the ignores here only save time.

const IGNORES = ['**/node_modules/**', '**/dist/**', '**/coverage/**', '**/*.d.ts', '**/cdk.out/**']

/** `files` globs from extensions: `.ts` becomes `**\/*.ts`, so a compiled `.js` twin is never linted. */
const globsOf = (extensions: readonly string[]): string[] => extensions.map((ext) => `**/*${ext}`)

export const buildEslintConfig = (extensions: readonly string[]): Linter.Config[] => [
  { ignores: IGNORES },
  {
    files: globsOf(extensions),
    languageOptions: { parser: tseslint.parser },
    linterOptions: { reportUnusedDisableDirectives: 'off', noInlineConfig: true },
    rules: { complexity: ['warn', { max: 0 }] },
  },
]

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
 * as the ESLint CLI sorts them before it formats a report.
 */
export const lintScope = async (repoRoot: string, config: CrapConfig): Promise<ESLint.LintResult[]> => {
  assertScopeExists(repoRoot, config)
  const targets = lintTargets(repoRoot, config.scope)
  if (targets.length === 0) return []
  const eslint = new ESLint({
    cwd: repoRoot,
    overrideConfigFile: true,
    overrideConfig: buildEslintConfig(config.extensions),
    errorOnUnmatchedPattern: false,
  })
  return (await eslint.lintFiles(targets)).sort(byFilePath)
}
