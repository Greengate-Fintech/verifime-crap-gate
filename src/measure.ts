import { readFileSync, realpathSync } from 'fs'
import path from 'path'
import { DEFAULT_CONFIG } from './config'
import type { CrapConfig } from './config'
import { assignEntries, mergeCoverage, spanPairer, unownedEntries } from './join'
import { crapScore, functionCoverage, rawFunctionCoverage } from './score'
import type {
  EslintFileResult,
  EslintMessage,
  FunctionScore,
  FunctionSpan,
  IstanbulFileCoverage,
  SourcePoint,
  MeasureProblem,
  Measurement,
} from './types'

// Scores each ESLint complexity message from the Istanbul fnMap entry that belongs to its
// function (the join is in join.ts). The naming rules and patterns are load-bearing: changing
// any of them shifts symbols.
//
// Fails closed: an ESLint message that is not a parseable complexity message, a complexity
// message with no function span, or coverage for an in-scope file that ESLint never reported on,
// is a problem rather than something skipped.

type ReadSource = (absPath: string) => string
type LineAt = (lineNumber: number) => string

const ANONYMOUS = '(anonymous)'
const NAME_LOOK_BACK_LINES = 8

const EXCLUDE =
  /(^|\/)(__tests__|__mocks__|__fixtures__|test|tests|e2e|fixtures|mocks|node_modules|generated|\.storybook|coverage|dist|build|cdk\.out|\.next)\/|\.(test|spec|stories|mock|d)\.[cm]?[tj]sx?$|(^|\/)[^/]*\.config\.[cm]?[tj]s$|(^|\/)(test-utils|testUtils|setupTests)\./

const NAME_RE =
  /^(?:(Async |Generator )?(Function|Arrow function|Method|Class static block|Constructor|Getter|Setter|Static method|Async method|Async arrow function|Async function|Generator function|Async generator function|Class field initializer)\s*(?:'([^']*)')?)/
const CC_RE = /complexity of (\d+)/

/**
 * A template containing '{}' has it replaced by the first capture group; a template without
 * '{}' is used verbatim. Order matters: first hit wins.
 */
const GUESS_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:function\b|\(|[A-Za-z_$][\w$]*\s*=>|<)/, '{}'],
  [/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:React\.)?(?:useCallback|useMemo|memo|forwardRef)\s*\(/, '{}'],
  [/\b(use[A-Z]\w*|useEffect|useLayoutEffect)\s*\(\s*(?:async\s*)?\(/, '{} callback'],
  [/\b(on[A-Z]\w*)\s*=\s*\{\s*(?:async\s*)?\(/, '{} handler'],
  [/^\s*(?:(?:public|private|protected|static|readonly|async)\s+)*([A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s*)?(?:function\b|\()/, '{}'],
  [/\.([A-Za-z_$][\w$]*)\s*\(\s*(?:async\s*)?(?:function\b|\(|[A-Za-z_$][\w$]*\s*=>)/, '{} callback'],
  [/\b([A-Za-z_$][\w$]*)\s*\(\s*(?:async\s*)?(?:function\b|\(|[A-Za-z_$][\w$]*\s*=>)/, '{} callback'],
  [/\breturn\s*(?:async\s*)?\(/, 'returned fn'],
]

// ---------------------------------------------------------------------------------------
// Scope and path mapping
// ---------------------------------------------------------------------------------------

/** The scope, extension, exclude and anchor rules compiled from a config. */
export interface ScopeRules {
  inScope: (relPath: string) => boolean
  anchors: ReadonlySet<string>
}

type ScopeConfig = Pick<CrapConfig, 'scope' | 'anchors' | 'extensions' | 'exclude'>

const isExcluded = (relPath: string, extra: readonly RegExp[]): boolean =>
  EXCLUDE.test(relPath) || extra.some((re) => re.test(relPath))

// The default config measures `.ts` only: cdk has no tsc outDir, so a compiled `.js` twin can
// sit beside every source. The built-in exclude always applies; configured patterns add to it.
export const compileScope = (config: ScopeConfig): ScopeRules => {
  const extra = config.exclude.map((source) => new RegExp(source))
  const inDirectory = (rel: string): boolean => config.scope.some((dir) => rel.startsWith(`${dir}/`))
  const hasExtension = (rel: string): boolean => config.extensions.some((ext) => rel.endsWith(ext))
  return {
    inScope: (rel) => inDirectory(rel) && hasExtension(rel) && !isExcluded(rel, extra),
    anchors: new Set(config.anchors),
  }
}

const DEFAULT_RULES = compileScope(DEFAULT_CONFIG)

// The rules default only because the copied tests call this without them.
export const isInScope = (relPath: string, rules: ScopeRules = DEFAULT_RULES): boolean =>
  rules.inScope(relPath)

const toPosix = (p: string): string => p.split(path.sep).join('/')

const isInside = (rel: string): boolean =>
  rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)

/** Suffixes start at each anchor segment, tried from the last such segment backwards. */
const matchMeasuredSuffix = (
  key: string,
  measured: ReadonlySet<string>,
  anchors: ReadonlySet<string>,
): string | null => {
  const segments = key.split(/[\\/]/)
  for (let i = segments.length - 1; i >= 0; i--) {
    if (!anchors.has(segments[i])) continue
    const suffix = segments.slice(i).join('/')
    if (measured.has(suffix)) return suffix
  }
  return null
}

const hasNodeModulesSegment = (key: string): boolean =>
  key.split(/[\\/]/).includes('node_modules')

export const toRepoRelative = (
  coverageKey: string,
  repoRoot: string,
  measured: ReadonlySet<string>,
  // Defaults only because the copied tests call this without anchors.
  anchors: ReadonlySet<string> = DEFAULT_RULES.anchors,
): string | null => {
  const rel = path.relative(repoRoot, path.resolve(repoRoot, coverageKey))
  if (isInside(rel)) return toPosix(rel)
  // A dependency's own src/lib/bin folder must never be mistaken for the repo's.
  return hasNodeModulesSegment(coverageKey) ? null : matchMeasuredSuffix(coverageKey, measured, anchors)
}

const groupCoverageByFile = (
  coverage: Record<string, IstanbulFileCoverage>,
  repoRoot: string,
  measured: ReadonlySet<string>,
  anchors: ReadonlySet<string>,
): Map<string, IstanbulFileCoverage[]> => {
  const byFile = new Map<string, IstanbulFileCoverage[]>()
  for (const [key, entry] of Object.entries(coverage)) {
    const rel = toRepoRelative(key, repoRoot, measured, anchors)
    if (rel === null) continue
    byFile.set(rel, [...(byFile.get(rel) ?? []), entry])
  }
  return byFile
}

/** A function's own fnMap entry: an id in the (merged) coverage of its file. */
interface Joined {
  entry: IstanbulFileCoverage
  id: string
}

// ---------------------------------------------------------------------------------------
// Message parsing and naming
// ---------------------------------------------------------------------------------------

interface ParsedMessage {
  cc: number
  line: number
  quotedName: string | undefined
  kind: string
}

const parseName = (message: string): { quotedName: string | undefined; kind: string } => {
  const name = NAME_RE.exec(message)
  return { quotedName: name?.[3] || undefined, kind: name?.[2] ?? '?' }
}

type Classified = { parsed: ParsedMessage } | { problem: string } | { skip: true }

/** A complexity message the lint pass recorded no function span for: it cannot be joined. */
const NO_SPAN = 'Complexity message with no function span: was the file linted by the gate?'

const problemText = (m: EslintMessage): string =>
  m.ruleId === null || m.ruleId === 'complexity' ? m.message : `[${m.ruleId}] ${m.message}`

// The one message the measure skips. With `noInlineConfig` on, ESLint 9 warns once per inline
// config comment (linter.js, `addWarning`): `ruleId` null, severity 1, not fatal, and this text.
// The text was taken from ESLint 9.39.1; re-check it when ESLint is bumped.
// The built-in config is unnamed, so ESLint names it "your config".
const INLINE_CONFIG_NOTICE = /^'[\s\S]+' has no effect because you have 'noInlineConfig' setting in your config\.$/

const isInlineConfigNotice = (m: EslintMessage): boolean =>
  m.ruleId === null && m.severity === 1 && !m.fatal && INLINE_CONFIG_NOTICE.test(m.message)

/** Anything but a parseable complexity message is a problem, never skipped. */
const classify = (m: EslintMessage): Classified => {
  if (isInlineConfigNotice(m)) return { skip: true }
  const complexity = m.ruleId === 'complexity' && !m.fatal ? CC_RE.exec(m.message) : null
  if (!complexity) return { problem: problemText(m) }
  const parsed = { cc: Number(complexity[1]), line: m.line, ...parseName(m.message) }
  return { parsed }
}

const readSourceSafely: ReadSource = (absPath) => {
  try {
    return readFileSync(absPath, 'utf8')
  } catch {
    // An unreadable file is treated as having no lines; naming then degrades
    // to '(anonymous)' rather than failing the whole measurement.
    return ''
  }
}

const lazyLineReader = (readSource: ReadSource, absPath: string): LineAt => {
  let lines: string[] | undefined
  return (lineNumber) => {
    lines ??= readSource(absPath).split('\n')
    return lineNumber > 0 && lineNumber <= lines.length ? lines[lineNumber - 1] : ''
  }
}

const searchText = (lineAt: LineAt, line: number, back: number): string => {
  if (back === 0) return lineAt(line)
  const parts: string[] = []
  for (let k = Math.max(1, line - back); k <= line; k++) parts.push(lineAt(k))
  return parts.join(' ')
}

const firstPatternHit = (text: string): string | null => {
  for (const [pattern, template] of GUESS_PATTERNS) {
    const hit = pattern.exec(text)
    if (hit) return template.replace('{}', () => hit[1] ?? '')
  }
  return null
}

const guessName = (lineAt: LineAt, line: number): string => {
  for (let back = 0; back < NAME_LOOK_BACK_LINES; back++) {
    const guess = firstPatternHit(searchText(lineAt, line, back))
    if (guess !== null) return guess
  }
  return ANONYMOUS
}

const istanbulName = (kind: string, fn: Joined | null): string | null => {
  const name = fn?.entry.fnMap[fn.id].name
  return name && !name.startsWith('(') ? name + (kind === 'Constructor' ? '.constructor' : '') : null
}

const resolveSymbol = (parsed: ParsedMessage, fn: Joined | null, lineAt: LineAt): string => {
  const quoted = parsed.quotedName || ANONYMOUS
  const named = quoted === ANONYMOUS ? (istanbulName(parsed.kind, fn) ?? ANONYMOUS) : quoted
  return named === ANONYMOUS ? guessName(lineAt, parsed.line) : named
}

// ---------------------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------------------

const scoreMatched = (
  file: string,
  symbol: string,
  parsed: ParsedMessage,
  fn: Joined,
): FunctionScore => {
  const { cov, covKind } = functionCoverage(fn.entry, fn.id)
  // CRAP uses the unrounded coverage; only the report rounds.
  const raw = rawFunctionCoverage(fn.entry, fn.id)
  return {
    file,
    symbol,
    kind: parsed.kind,
    line: parsed.line,
    cc: parsed.cc,
    cov,
    covKind,
    crap: crapScore(parsed.cc, raw.cov),
  }
}

interface FileInput {
  rel: string
  abs: string
  messages: EslintMessage[]
  spans: FunctionSpan[]
  declarations: SourcePoint[]
}

const recordFunction = (
  input: FileInput,
  parsed: ParsedMessage,
  fn: Joined | null,
  symbol: string,
  out: Measurement,
): void => {
  if (fn) out.functions.push(scoreMatched(input.rel, symbol, parsed, fn))
  else out.unmatched.push({ file: input.rel, symbol, line: parsed.line, cc: parsed.cc, kind: parsed.kind })
}

/** A complexity message with the index of its span, a problem, or null for a message to skip. */
const prepare = (
  message: EslintMessage,
  pair: (m: EslintMessage) => number | null,
): { parsed: ParsedMessage; span: number } | { problem: string } | null => {
  const classified = classify(message)
  if ('skip' in classified) return null
  if ('problem' in classified) return classified
  const span = pair(message)
  return span === null ? { problem: NO_SPAN } : { parsed: classified.parsed, span }
}

const measureFile = (
  input: FileInput,
  entries: IstanbulFileCoverage[],
  readSource: ReadSource,
  out: Measurement,
): void => {
  const entry = mergeCoverage(entries)
  const owned = assignEntries(input.spans, entry)
  for (const e of unownedEntries(entry, owned, input.declarations)) {
    out.unjoined?.push({ file: input.rel, line: e.start[0], column: e.start[1] + 1, name: e.name })
  }
  const pair = spanPairer(input.spans)
  const lineAt = lazyLineReader(readSource, input.abs)
  for (const message of input.messages) {
    const prepared = prepare(message, pair)
    if (prepared === null) continue
    if ('problem' in prepared) {
      out.problems.push({ file: input.rel, line: message.line, message: prepared.problem })
      continue
    }
    const { parsed, span } = prepared
    const id = owned.get(span)
    const fn = entry && id !== undefined ? { entry, id } : null
    recordFunction(input, parsed, fn, resolveSymbol(parsed, fn, lineAt), out)
  }
}

const realPathOf = (abs: string): string => {
  try {
    return realpathSync(abs)
  } catch {
    return abs
  }
}

const inScopeFiles = (eslint: EslintFileResult[], repoRoot: string, rules: ScopeRules): FileInput[] =>
  eslint
    .map((f) => {
      const abs = realPathOf(path.resolve(repoRoot, f.filePath))
      return { rel: toPosix(path.relative(repoRoot, abs)), abs, messages: f.messages, spans: f.spans ?? [], declarations: f.declarations ?? [] }
    })
    .filter((f) => rules.inScope(f.rel))

const uncoveredByEslint = (
  byFile: ReadonlyMap<string, IstanbulFileCoverage[]>,
  files: FileInput[],
  rules: ScopeRules,
): MeasureProblem[] => {
  const linted = new Set(files.map((f) => f.rel))
  return [...byFile.keys()]
    .filter((rel) => rules.inScope(rel) && !linted.has(rel))
    .map((file) => ({ file, message: 'Has coverage but no ESLint result: was it linted?' }))
}

export const measure = (
  eslint: EslintFileResult[],
  coverage: Record<string, IstanbulFileCoverage>,
  repoRoot: string,
  readSource: ReadSource = readSourceSafely,
  // Defaults only because the copied tests call this without a config; `compute` always passes it.
  config: ScopeConfig = DEFAULT_CONFIG,
): Measurement => {
  const rules = compileScope(config)
  const files = inScopeFiles(eslint, repoRoot, rules)
  const byFile = groupCoverageByFile(coverage, repoRoot, new Set(files.map((f) => f.rel)), rules.anchors)
  const out: Measurement = { functions: [], unmatched: [], problems: uncoveredByEslint(byFile, files, rules), unjoined: [] }
  for (const file of files) measureFile(file, byFile.get(file.rel) ?? [], readSource, out)
  return out
}
