import { readFileSync } from 'fs'
import path from 'path'
import { CRAP_THRESHOLD } from './ratchet'

// Loads and validates `crap/config.json`. Pure validation lives in parseConfig; loadConfig only
// adds the file read. Every key is optional and the defaults reproduce the original gate exactly.

export interface CrapConfig {
  /** Repo-relative directories whose files are measured. */
  readonly scope: readonly string[]
  /** Path segment names that start a suffix when a coverage path is joined to a measured file. */
  readonly anchors: readonly string[]
  /** File extensions measured, each with its leading dot. */
  readonly extensions: readonly string[]
  /** Regular-expression sources added to the built-in exclude, which always applies. */
  readonly exclude: readonly string[]
  /** Coverage files, used when no `--coverage` flag is given. */
  readonly coverage: readonly string[]
  /** A function scoring above this is an offender. */
  readonly threshold: number
}

export const CONFIG_DISPLAY = 'crap/config.json'

export const DEFAULT_CONFIG: CrapConfig = {
  scope: ['src', 'lib', 'bin', 'cdk/src', 'cdk/lib', 'cdk/bin'],
  anchors: ['src', 'lib', 'bin', 'cdk'],
  extensions: ['.ts'],
  exclude: [],
  coverage: ['coverage/coverage-final.json', 'cdk/coverage/coverage-final.json'],
  threshold: CRAP_THRESHOLD,
}

/** Returns the problem with a value, or null when it is valid. */
type Check = (value: unknown) => string | null

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')

const quoted = (item: string): string => JSON.stringify(item)

const trimSlashes = (dir: string): string => dir.replace(/\/+$/, '')

const isDirectory = (dir: string): boolean => {
  const segments = trimSlashes(dir).split('/')
  return !dir.includes('\\') && segments.every((s) => s !== '' && s !== '.' && s !== '..')
}

const isRegex = (source: string): boolean => {
  try {
    new RegExp(source)
    return true
  } catch {
    return false
  }
}

const entryProblem = (key: string, item: string, rule: string): string =>
  `key "${key}" entry ${quoted(item)} ${rule}`

const listOf =
  (key: string, allowEmpty: boolean, valid: (item: string) => boolean, rule: string): Check =>
  (value) => {
    if (!isStringArray(value)) return `key "${key}" must be an array of strings`
    if (value.length === 0 && !allowEmpty) return `key "${key}" must not be empty`
    const bad = value.find((item) => !valid(item))
    return bad === undefined ? null : entryProblem(key, bad, rule)
  }

const thresholdCheck: Check = (value) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0
    ? null
    : 'key "threshold" must be a number greater than 0'

const CHECKS: Record<keyof CrapConfig, Check> = {
  scope: listOf('scope', false, isDirectory, 'must be a repo-relative directory'),
  anchors: listOf('anchors', false, (s) => s !== '' && !/[\\/]/.test(s), 'must be one path segment name'),
  extensions: listOf('extensions', false, (s) => /^\.[^./\\]+(\.[^./\\]+)*$/.test(s), 'must start with a dot, as in ".ts"'),
  exclude: listOf('exclude', true, isRegex, 'is not a valid regular expression'),
  coverage: listOf('coverage', false, (s) => s !== '', 'must not be empty'),
  threshold: thresholdCheck,
}

const isKey = (key: string): key is keyof CrapConfig => Object.hasOwn(CHECKS, key)

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const invalid = (problem: string): Error => new Error(`Invalid ${CONFIG_DISPLAY}: ${problem}`)

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    throw new Error(`Unreadable ${CONFIG_DISPLAY} (not valid JSON): ${detail}`, { cause })
  }
}

const problemWith = (key: string, value: unknown): string | null =>
  isKey(key) ? CHECKS[key](value) : `unknown key ${quoted(key)}`

const validate = (raw: Record<string, unknown>): void => {
  for (const [key, value] of Object.entries(raw)) {
    const problem = problemWith(key, value)
    if (problem !== null) throw invalid(problem)
  }
}

const withDefaults = (raw: Record<string, unknown>): CrapConfig => {
  const merged = { ...DEFAULT_CONFIG, ...raw } as CrapConfig
  return { ...merged, scope: merged.scope.map(trimSlashes) }
}

/** Throws an Error naming the file and the key when the text is not a valid config. */
export const parseConfig = (text: string): CrapConfig => {
  const raw = parseJson(text)
  if (!isPlainObject(raw)) throw invalid('must be a JSON object')
  validate(raw)
  return withDefaults(raw)
}

const isMissing = (e: unknown): boolean => (e as NodeJS.ErrnoException).code === 'ENOENT'

/** A missing file is all defaults; any other read failure is an error. */
export const loadConfig = (repoRoot: string): CrapConfig => {
  let text: string
  try {
    text = readFileSync(path.join(repoRoot, CONFIG_DISPLAY), 'utf8')
  } catch (cause) {
    if (isMissing(cause)) return parseConfig('{}')
    const code = (cause as NodeJS.ErrnoException).code ?? 'unknown error'
    throw new Error(`Cannot read ${CONFIG_DISPLAY} (${code})`, { cause })
  }
  return parseConfig(text)
}
