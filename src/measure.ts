import { readFileSync, realpathSync } from 'fs'
import path from 'path'
import { DEFAULT_CONFIG } from './config'
import type { CrapConfig } from './config'
import { crapScore, functionCoverage, rawFunctionCoverage, toSpan } from './score'
import type { Position, Span } from './score'
import type {
  EslintFileResult,
  EslintMessage,
  FunctionScore,
  IstanbulFileCoverage,
  MeasureProblem,
  Measurement,
} from './types'

// Joins ESLint complexity messages to Istanbul fnMap entries. The matching order, naming rules
// and patterns are load-bearing: changing any of them shifts scores. Where several candidates
// tie on a distance or position, the first minimum in fnMap order wins.
//
// Fails closed: an ESLint message that is not a parseable complexity message, or coverage for
// an in-scope file that ESLint never reported on, is a problem rather than something skipped.

type ReadSource = (absPath: string) => string
type LineAt = (lineNumber: number) => string

const ANONYMOUS = '(anonymous)'
const MATCH_LOOK_AHEAD_LINES = 8
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

// ---------------------------------------------------------------------------------------
// Matching an ESLint message to an Istanbul fnMap entry
// ---------------------------------------------------------------------------------------

interface Candidate {
  id: string
  entry: IstanbulFileCoverage
  name: string
  span: Span
}

// Object.entries orders integer-like fnMap keys numerically, which equals Istanbul's ascending
// ids and the insertion order for real output.
const candidatesOf = (entries: IstanbulFileCoverage[]): Candidate[] =>
  entries.flatMap((entry) =>
    Object.entries(entry.fnMap).map(([id, fn]) => ({
      id,
      entry,
      name: fn.name,
      span: toSpan(fn.loc),
    })),
  )

const comparePositions = (a: Position, b: Position): number => a[0] - b[0] || a[1] - b[1]

/** First minimum wins on ties. */
const firstMin = (indices: number[], compare: (a: number, b: number) => number): number =>
  indices.reduce((best, i) => (compare(i, best) < 0 ? i : best))

const matchExact = (fns: Candidate[], free: number[], point: Position): number | null => {
  const onLine = free.filter((i) => fns[i].span[0][0] === point[0])
  const columnGap = (i: number): number => Math.abs(fns[i].span[0][1] - point[1])
  return onLine.length > 0 ? firstMin(onLine, (a, b) => columnGap(a) - columnGap(b)) : null
}

const matchBody = (fns: Candidate[], free: number[], point: Position): number | null => {
  const after = free.filter(
    (i) =>
      comparePositions(fns[i].span[0], point) >= 0 &&
      fns[i].span[0][0] - point[0] <= MATCH_LOOK_AHEAD_LINES,
  )
  return after.length > 0
    ? firstMin(after, (a, b) => comparePositions(fns[a].span[0], fns[b].span[0]))
    : null
}

const matchContain = (fns: Candidate[], free: number[], point: Position): number | null => {
  const lineSpan = (i: number): number => fns[i].span[1][0] - fns[i].span[0][0]
  const enclosing = free.filter(
    (i) =>
      comparePositions(fns[i].span[0], point) <= 0 && comparePositions(point, fns[i].span[1]) <= 0,
  )
  return enclosing.length > 0 ? firstMin(enclosing, (a, b) => lineSpan(a) - lineSpan(b)) : null
}

const findMatch = (fns: Candidate[], used: ReadonlySet<number>, point: Position): number | null => {
  const free = fns.map((_, i) => i).filter((i) => !used.has(i))
  return (
    matchExact(fns, free, point) ?? matchBody(fns, free, point) ?? matchContain(fns, free, point)
  )
}

// ---------------------------------------------------------------------------------------
// Message parsing and naming
// ---------------------------------------------------------------------------------------

interface ParsedMessage {
  cc: number
  line: number
  point: Position
  quotedName: string | undefined
  kind: string
}

const parseName = (message: string): { quotedName: string | undefined; kind: string } => {
  const name = NAME_RE.exec(message)
  return { quotedName: name?.[3] || undefined, kind: name?.[2] ?? '?' }
}

const pointOf = (m: EslintMessage): Position => [m.line, (m.column || 1) - 1]

type Classified = { parsed: ParsedMessage } | { problem: string }

const problemText = (m: EslintMessage): string =>
  m.ruleId === null || m.ruleId === 'complexity' ? m.message : `[${m.ruleId}] ${m.message}`

/** Anything but a parseable complexity message is a problem, never skipped. */
const classify = (m: EslintMessage): Classified => {
  const complexity = m.ruleId === 'complexity' && !m.fatal ? CC_RE.exec(m.message) : null
  if (!complexity) return { problem: problemText(m) }
  const parsed = { cc: Number(complexity[1]), line: m.line, point: pointOf(m), ...parseName(m.message) }
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

const istanbulName = (kind: string, fn: Candidate | null): string | null =>
  fn?.name && !fn.name.startsWith('(')
    ? fn.name + (kind === 'Constructor' ? '.constructor' : '')
    : null

const resolveSymbol = (parsed: ParsedMessage, fn: Candidate | null, lineAt: LineAt): string => {
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
  fn: Candidate,
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
}

const recordFunction = (
  input: FileInput,
  parsed: ParsedMessage,
  fn: Candidate | null,
  symbol: string,
  out: Measurement,
): void => {
  if (fn) out.functions.push(scoreMatched(input.rel, symbol, parsed, fn))
  else out.unmatched.push({ file: input.rel, symbol, line: parsed.line, cc: parsed.cc, kind: parsed.kind })
}

const measureFile = (
  input: FileInput,
  entries: IstanbulFileCoverage[],
  readSource: ReadSource,
  out: Measurement,
): void => {
  const fns = candidatesOf(entries)
  const used = new Set<number>()
  const lineAt = lazyLineReader(readSource, input.abs)
  for (const message of input.messages) {
    const classified = classify(message)
    if ('problem' in classified) {
      out.problems.push({ file: input.rel, line: message.line, message: classified.problem })
      continue
    }
    const { parsed } = classified
    const index = findMatch(fns, used, parsed.point)
    if (index !== null) used.add(index)
    const fn = index === null ? null : fns[index]
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
      return { rel: toPosix(path.relative(repoRoot, abs)), abs, messages: f.messages }
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
  const out: Measurement = { functions: [], unmatched: [], problems: uncoveredByEslint(byFile, files, rules) }
  for (const file of files) measureFile(file, byFile.get(file.rel) ?? [], readSource, out)
  return out
}
