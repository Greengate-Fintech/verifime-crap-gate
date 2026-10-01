import { statSync } from 'fs'
import path from 'path'
import { ESLint } from 'eslint'
import type { Linter } from 'eslint'
import tseslint from 'typescript-eslint'
import type { CrapConfig } from './config'

// Runs ESLint in-process, with the flat config the gate was extracted from (commit 8d9c205):
// the same ignores, the typescript-eslint parser, inline directives off, and `complexity` at
// max 0 so that every function is reported with its cyclomatic complexity. The consumer's own
// ESLint config is never read. The measure's scope filter stays authoritative; the ignores here
// only save time.

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

/** Lints the scope directories that exist. With none, it lints nothing, and the measure then fails closed. */
export const lintScope = async (repoRoot: string, config: CrapConfig): Promise<ESLint.LintResult[]> => {
  const targets = lintTargets(repoRoot, config.scope)
  if (targets.length === 0) return []
  const eslint = new ESLint({
    cwd: repoRoot,
    overrideConfigFile: true,
    overrideConfig: buildEslintConfig(config.extensions),
    errorOnUnmatchedPattern: false,
  })
  return eslint.lintFiles(targets)
}
