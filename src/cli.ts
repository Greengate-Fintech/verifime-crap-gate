import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
import path from 'path'
import { DEFAULT_CONFIG, loadConfig } from './config'
import type { CrapConfig } from './config'
import { lintScope } from './eslint'
import { readBaseFile } from './git'
import { measure } from './measure'
import {
  BASELINE_DISPLAY,
  CRAP_THRESHOLD,
  evaluateRatchet,
  findGrowth,
  fmt1,
  type GrowthRow,
  groupScores,
  parseBaseline,
  planBaselineUpdate,
  renderBaseline,
  type ScoreGroups,
  type Violation,
} from './ratchet'
import { roundTo } from './score'
import type {
  CrapReport,
  CrapSummary,
  EslintFileResult,
  FunctionScore,
  IstanbulFileCoverage,
  Measurement,
  StaleUnmatched,
  UnmatchedFunction,
} from './types'
import {
  findUnmatchedGrowth,
  groupUnmatched,
  parseUnmatchedList,
  planUnmatchedUpdate,
  renderUnmatchedList,
  scoreListedUnmatched,
  splitUnmatched,
  UNMATCHED_DISPLAY,
  type UnmatchedGroups,
} from './unmatched'

export interface MeasureOptions {
  /** A saved ESLint JSON report, for callers and tests that supply a file. Read only when `eslintResults` is absent. */
  eslintPath: string
  /** Lint results already in hand (the in-process run). They take precedence over `eslintPath`. */
  eslintResults?: readonly EslintFileResult[]
  /** Every coverage file to merge (one per package); a missing one fails the measure. */
  coveragePaths: readonly string[]
  unmatchedListPath: string
  /** Treat every unmatched function as listed: only for regenerating the baseline. */
  acceptUnmatched: boolean
  outPath: string
  repoRoot: string
  /** Scope, anchors, extensions, exclude and threshold. Optional only because the copied tests omit it; `run` always sets it. */
  config?: CrapConfig
}

export interface Io {
  log(s: string): void
  error(s: string): void
}

/** Re-exported from ratchet.ts, where the threshold is defined. */
export { CRAP_THRESHOLD }

const readJson = <T>(file: string, what: string): T => {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    throw new Error(`Missing ${what} input: ${file}`)
  }
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(`Unreadable ${what} input (not valid JSON): ${file}`)
  }
}

// The threshold defaults only because the copied tests call this without one.
export const summarise = (m: Measurement, threshold: number = CRAP_THRESHOLD): CrapSummary => {
  const over = m.functions.filter((f) => f.crap > threshold)
  return {
    functions: m.functions.length,
    over5: over.length,
    sumOver5: roundTo(over.reduce((sum, f) => sum + f.crap, 0), 1),
    unmatched: m.unmatched.length,
  }
}

const failures = (m: Measurement, stale: StaleUnmatched[]): string[] => {
  const problems = m.problems.map(
    (p) => `Problem: ${p.file}${p.line === undefined ? '' : `:${p.line}`} ${p.message}`,
  )
  const unmatched = m.unmatched.map(
    (u) => `Unmatched function: ${u.file}:${u.line} ${u.symbol} (cc ${u.cc})`,
  )
  const staleLines = stale.map(
    (s) => `Stale unmatched entry: ${s.file}#${s.symbol}; ${STALE_UNMATCHED_ADVICE}`,
  )
  const none = m.functions.length === 0 ? ['No functions were measured'] : []
  return [...none, ...problems, ...unmatched, ...staleLines]
}

/** Informational: a coverage entry no function took. It never changes the exit code. */
const unjoinedLines = (m: Measurement): string[] =>
  (m.unjoined ?? []).map((e) => `Coverage entry joined to no function: ${e.file}:${e.line}:${e.column} ${e.name}`)

const summaryLine = (s: CrapSummary): string =>
  `CRAP measure: functions=${s.functions} over5=${s.over5} sumOver5=${s.sumOver5.toFixed(1)} unmatched=${s.unmatched}`

const writeReport = (outPath: string, outcome: Outcome, summary: CrapSummary): void => {
  mkdirSync(path.dirname(outPath), { recursive: true })
  const report: CrapReport = {
    summary,
    functions: outcome.measurement.functions,
    unmatched: outcome.measurement.unmatched,
    listedUnmatched: outcome.listed,
    staleUnmatched: outcome.stale,
    acceptedUnmatched: outcome.accepted,
  }
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`)
}

/** Merges the per-package coverage files. Keys are absolute paths, so a repeat is a mistake, not a merge. */
const readCoverage = (paths: readonly string[]): Record<string, IstanbulFileCoverage> => {
  if (paths.length === 0) throw new Error('No coverage input given')
  const merged: Record<string, IstanbulFileCoverage> = {}
  for (const file of paths) {
    for (const [key, entry] of Object.entries(readJson<Record<string, IstanbulFileCoverage>>(file, 'coverage'))) {
      if (key in merged) throw new Error(`${key} appears in more than one coverage file (again in ${file})`)
      merged[key] = entry
    }
  }
  return merged
}

const parseListText = (text: string, where: string): UnmatchedGroups => {
  try {
    return parseUnmatchedList(text)
  } catch (e) {
    throw new Error(`${e instanceof Error ? e.message : String(e)} (${where})`)
  }
}

/** A missing list is an empty one: every unmatched function then fails, so it can only be stricter. */
const readUnmatchedList = (listPath: string): UnmatchedGroups => {
  if (!existsSync(listPath)) return new Map()
  return parseListText(readFileSync(listPath, 'utf8'), listPath)
}

interface Outcome {
  measurement: Measurement
  listed: UnmatchedFunction[]
  stale: StaleUnmatched[]
  accepted: boolean
}

/** Listed unmatched functions join the scored functions at coverage 0; the rest stay unmatched and fail. */
const resolveUnmatched = (m: Measurement, opts: MeasureOptions): Outcome => {
  const list = opts.acceptUnmatched ? groupUnmatched(m.unmatched) : readUnmatchedList(opts.unmatchedListPath)
  const { listed, failing, stale } = splitUnmatched(m.unmatched, list)
  const functions = [...m.functions, ...listed.map(scoreListedUnmatched)]
  return { measurement: { functions, unmatched: failing, problems: m.problems, unjoined: m.unjoined }, listed, stale, accepted: opts.acceptUnmatched }
}

const eslintInput = (opts: MeasureOptions): EslintFileResult[] => {
  if (opts.eslintResults !== undefined) return [...opts.eslintResults]
  return readJson<EslintFileResult[]>(opts.eslintPath, 'ESLint')
}

const compute = (opts: MeasureOptions, config: CrapConfig): Outcome => {
  const eslint = eslintInput(opts)
  const coverage = readCoverage(opts.coveragePaths)
  // ESLint and Istanbul report real paths, so a symlinked root (macOS /tmp -> /private/tmp)
  // must be resolved before joining, or every path would fall outside the root.
  return resolveUnmatched(measure(eslint, coverage, realpathSync(opts.repoRoot), undefined, config), opts)
}

/** Returns the process exit code. Fails closed: missing input, nothing measured, any problem or any unmatched function is 1. */
export const runMeasure = (opts: MeasureOptions, io: Io): number => {
  try {
    // A failed run must never leave a previous run's report behind for a later step to trust.
    rmSync(opts.outPath, { force: true })
    const config = opts.config ?? DEFAULT_CONFIG
    const outcome = compute(opts, config)
    const summary = summarise(outcome.measurement, config.threshold)
    writeReport(opts.outPath, outcome, summary)
    // Failure detail first so the summary line is the last thing printed, as in a passing run.
    const problems = failures(outcome.measurement, outcome.stale)
    problems.forEach((p) => io.error(p))
    unjoinedLines(outcome.measurement).forEach((line) => io.log(line))
    io.log(summaryLine(summary))
    return problems.length === 0 ? 0 : 1
  } catch (e) {
    io.error(e instanceof Error ? e.message : String(e))
    return 1
  }
}

export type LintedMeasureOptions = Omit<MeasureOptions, 'eslintPath' | 'eslintResults' | 'config'>

/**
 * Lints the configured scope in-process, then measures. Returns the process exit code.
 * The earlier report is deleted first, so a run that fails while linting leaves none behind.
 */
export const runMeasureLinted = async (opts: LintedMeasureOptions, config: CrapConfig, io: Io): Promise<number> => {
  try {
    rmSync(opts.outPath, { force: true })
    // ESLint reports real paths, so the root it works from must be the resolved one.
    const eslintResults = await lintScope(realpathSync(opts.repoRoot), config)
    // `eslintPath` is read only when there are no `eslintResults`, so it is unused here.
    return runMeasure({ ...opts, eslintPath: '', eslintResults, config }, io)
  } catch (e) {
    io.error(e instanceof Error ? e.message : String(e))
    return 1
  }
}

export interface CheckOptions {
  reportPath: string
  baselinePath: string
  githubActions: boolean
  /** Optional only because the copied tests omit it; `run` always sets it. */
  threshold?: number
}

export interface BaselineOptions {
  reportPath: string
  baselinePath: string
  unmatchedListPath: string
  allowGrowth: boolean
  /** Write the regenerated files into this directory instead of over `baselinePath` and `unmatchedListPath`. The existing files are still read for the growth check. */
  outputDir?: string
  /** Optional only because the copied tests omit it; `run` always sets it. */
  threshold?: number
}

const STALE_UNMATCHED_ADVICE = `delete this line from ${UNMATCHED_DISPLAY}, or run npm run crap:baseline`
const STALE_ADVICE = `delete this line from ${BASELINE_DISPLAY}, or run npm run crap:baseline`
const MOVED_HINT =
  'If a frozen function was moved or renamed, run npm run crap:baseline -- --allow-growth and say why in the PR body.'

type RawRow = Record<string, unknown>

const isObject = (x: unknown): x is RawRow => typeof x === 'object' && x !== null

const isScoredRow = (row: unknown): row is FunctionScore =>
  isObject(row) &&
  typeof row.file === 'string' &&
  typeof row.symbol === 'string' &&
  typeof row.crap === 'number' &&
  Number.isFinite(row.crap)

const listOf = (x: unknown): unknown[] => (Array.isArray(x) ? x : [])

/** Describes a report that records a failed measure, so it can never pass a later standalone check. */
const measureFailures = (report: RawRow): string[] => [
  ...listOf(report.unmatched).map((u) => `Unmatched function: ${JSON.stringify(u)}`),
  ...listOf(report.staleUnmatched).map((s) => `Stale unmatched entry: ${JSON.stringify(s)}`),
  ...listOf(report.problems).map((p) => `Problem: ${JSON.stringify(p)}`),
]

const assertScoredRows = (functions: unknown[], reportPath: string): void => {
  const at = functions.findIndex((row) => !isScoredRow(row))
  if (at !== -1) {
    throw new Error(`Unreadable CRAP report input (bad function row ${JSON.stringify(functions[at])}): ${reportPath}`)
  }
}

const assertNoMeasureFailures = (report: RawRow, reportPath: string): void => {
  const failed = measureFailures(report)
  if (failed.length > 0) {
    throw new Error([`CRAP report records a failed measure: ${reportPath}`, ...failed].join('\n'))
  }
}

const assertUsableReport = (report: unknown, reportPath: string): FunctionScore[] => {
  if (!isObject(report) || !Array.isArray(report.functions)) {
    throw new Error(`Unreadable CRAP report input (no functions array): ${reportPath}`)
  }
  assertScoredRows(report.functions, reportPath)
  assertNoMeasureFailures(report, reportPath)
  if (report.functions.length === 0) throw new Error(`CRAP report has no functions: ${reportPath}`)
  return report.functions as FunctionScore[]
}

const readFunctions = (reportPath: string): FunctionScore[] =>
  assertUsableReport(readJson<unknown>(reportPath, 'CRAP report'), reportPath)

const isKeyRow = (row: unknown): row is UnmatchedFunction =>
  isObject(row) && typeof row.file === 'string' && typeof row.symbol === 'string'

/** The unmatched functions the measure scored as listed; the baseline command freezes them. */
const readListedUnmatched = (reportPath: string): UnmatchedFunction[] => {
  const report = readJson<RawRow>(reportPath, 'CRAP report')
  const listed = listOf(report.listedUnmatched)
  if (!listed.every(isKeyRow)) throw new Error(`Unreadable CRAP report input (bad listedUnmatched row): ${reportPath}`)
  return listed
}

/** An accept-unmatched report scored unlisted unmatched functions as listed, so it must never pass a check. */
const refuseAcceptedReport = (reportPath: string): void => {
  if (readJson<RawRow>(reportPath, 'CRAP report').acceptedUnmatched === true) {
    throw new Error(
      `CRAP report was produced with --accept-unmatched, which is only for npm run crap:baseline; run npm run crap:measure first: ${reportPath}`,
    )
  }
}

const parseBaselineText = (text: string, where: string): ScoreGroups => {
  try {
    return parseBaseline(text)
  } catch (e) {
    throw new Error(`${e instanceof Error ? e.message : String(e)} (${where})`)
  }
}

const readBaseline = (baselinePath: string): ScoreGroups => {
  let text: string
  try {
    text = readFileSync(baselinePath, 'utf8')
  } catch {
    throw new Error(`Missing baseline input: ${baselinePath}`)
  }
  return parseBaselineText(text, baselinePath)
}

const violationText = (v: Violation): string =>
  v.kind === 'stale' ? `${v.message}; ${STALE_ADVICE}` : v.message

export const escapeData = (s: string): string => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')

export const escapeProperty = (s: string): string => escapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C')

const LABELS = { new: 'NEW OFFENDER', regression: 'REGRESSION', stale: 'STALE ENTRY' }

const describeViolation = (v: Violation): string =>
  `CRAP ratchet: ${LABELS[v.kind]} ${v.file}#${v.symbol} ${violationText(v)}`

/**
 * The line of the current occurrence the violation is about; stale entries have none.
 * Best effort: the first function with the same file, symbol and exact score. Two same-named
 * functions with an identical score share a line, which only affects annotation placement.
 */
const lineOf = (v: Violation, functions: FunctionScore[]): number | undefined =>
  v.kind === 'stale'
    ? undefined
    : functions.find((f) => f.file === v.file && f.symbol === v.symbol && f.crap === v.current)?.line

const annotation = (v: Violation, functions: FunctionScore[]): string => {
  const line = lineOf(v, functions)
  const file = escapeProperty(v.file)
  const where = line === undefined ? `file=${file}` : `file=${file},line=${line}`
  return `::error ${where}::${escapeData(describeViolation(v))}`
}

export const isMoveSuspect = (violations: Violation[]): boolean => {
  const added = new Set(violations.filter((v) => v.kind === 'new').map((v) => `${v.file}#${v.symbol}`))
  const stale = violations.filter((v) => v.kind === 'stale').map((v) => `${v.file}#${v.symbol}`)
  return added.size > 0 && stale.some((k) => !added.has(k))
}

const reportViolations = (
  violations: Violation[],
  functions: FunctionScore[],
  githubActions: boolean,
  io: Io,
): void => {
  violations.forEach((v) => {
    io.error(describeViolation(v))
    if (githubActions) io.error(annotation(v, functions))
  })
  if (isMoveSuspect(violations)) io.error(MOVED_HINT)
}

const countRows = (groups: ScoreGroups): number =>
  [...groups.values()].reduce((sum, scores) => sum + scores.length, 0)

const countCounts = (groups: UnmatchedGroups): number => [...groups.values()].reduce((sum, n) => sum + n, 0)

/** Returns the process exit code: 0 only when no function is new, worse, or stale against the baseline. */
export const runCheck = (opts: CheckOptions, io: Io): number => {
  try {
    refuseAcceptedReport(opts.reportPath)
    const functions = readFunctions(opts.reportPath)
    const baseline = readBaseline(opts.baselinePath)
    const violations = evaluateRatchet(baseline, groupScores(functions), opts.threshold)
    if (violations.length > 0) {
      reportViolations(violations, functions, opts.githubActions, io)
      return 1
    }
    io.log(`CRAP ratchet: pass (${countRows(baseline)} frozen, ${functions.length} functions measured)`)
    return 0
  } catch (e) {
    io.error(e instanceof Error ? e.message : String(e))
    return 1
  }
}

const readExistingBaseline = (baselinePath: string): ScoreGroups | null =>
  existsSync(baselinePath) ? readBaseline(baselinePath) : null

const readExistingList = (listPath: string): UnmatchedGroups | null =>
  existsSync(listPath) ? readUnmatchedList(listPath) : null

const refuse = (baselineRefused: Violation[], listRefused: StaleUnmatched[], io: Io): void => {
  io.error('CRAP baseline: refusing to grow the baseline; nothing was written.')
  baselineRefused.forEach((v) => io.error(`  ${v.kind.toUpperCase()} ${v.file}#${v.symbol} ${v.message}`))
  listRefused.forEach((u) =>
    io.error(`  UNMATCHED ${u.file}#${u.symbol} is a new unmatched function, not in ${UNMATCHED_DISPLAY}`),
  )
  io.error('Fix the code, or re-run with: npm run crap:baseline -- --allow-growth')
}

interface WriteTargets {
  baseline: string
  unmatched: string
}

/** Where the regenerated files go: the `outputDir` when set, otherwise over the files that were read. */
const writeTargets = (opts: BaselineOptions): WriteTargets =>
  opts.outputDir === undefined
    ? { baseline: opts.baselinePath, unmatched: opts.unmatchedListPath }
    : {
        baseline: path.join(opts.outputDir, path.basename(opts.baselinePath)),
        unmatched: path.join(opts.outputDir, path.basename(opts.unmatchedListPath)),
      }

/** Returns the process exit code. Refuses (1, both files untouched) any growth unless allowGrowth is set. */
export const runBaseline = (opts: BaselineOptions, io: Io): number => {
  try {
    const current = groupScores(readFunctions(opts.reportPath))
    const plan = planBaselineUpdate(readExistingBaseline(opts.baselinePath), current, opts.allowGrowth, opts.threshold)
    const listed = groupUnmatched(readListedUnmatched(opts.reportPath))
    const listPlan = planUnmatchedUpdate(readExistingList(opts.unmatchedListPath), listed, opts.allowGrowth)
    if (plan.refused.length > 0 || listPlan.refused.length > 0) {
      refuse(plan.refused, listPlan.refused, io)
      return 1
    }
    const to = writeTargets(opts)
    mkdirSync(path.dirname(to.baseline), { recursive: true })
    writeFileSync(to.baseline, renderBaseline(plan.baseline))
    mkdirSync(path.dirname(to.unmatched), { recursive: true })
    writeFileSync(to.unmatched, renderUnmatchedList(listPlan.list))
    io.log(`CRAP baseline: wrote ${countRows(plan.baseline)} rows to ${to.baseline}`)
    io.log(`CRAP baseline: wrote ${countCounts(listPlan.list)} unmatched rows to ${to.unmatched}`)
    return 0
  } catch (e) {
    io.error(e instanceof Error ? e.message : String(e))
    return 1
  }
}

export interface DiffOptions {
  basePath: string
  headPath: string
  baseUnmatchedPath: string
  headUnmatchedPath: string
  /** The base commit has no baseline file (initial freeze); without this a missing base path fails. */
  baseAbsent: boolean
  baseUnmatchedAbsent: boolean
  githubActions: boolean
}

const growthText = (g: GrowthRow): string =>
  g.base === null
    ? `is new in ${BASELINE_DISPLAY} at ${fmt1(g.score)}, with no row in the base`
    : `grew from ${fmt1(g.base)} in the base to ${fmt1(g.score)}`

const describeGrowth = (g: GrowthRow): string => `CRAP baseline diff: GROWN ${g.file}#${g.symbol} ${growthText(g)}`

const describeListGrowth = (u: StaleUnmatched): string =>
  `CRAP baseline diff: GROWN ${u.file}#${u.symbol} is a new unmatched entry in ${UNMATCHED_DISPLAY}, with no row in the base`

const annotate = (file: string, text: string): string => `::error file=${escapeProperty(file)}::${escapeData(text)}`

const reportGrowth = (grown: GrowthRow[], listGrown: StaleUnmatched[], githubActions: boolean, io: Io): void => {
  const lines = [
    ...grown.map((g) => ({ file: BASELINE_DISPLAY, text: describeGrowth(g) })),
    ...listGrown.map((u) => ({ file: UNMATCHED_DISPLAY, text: describeListGrowth(u) })),
  ]
  lines.forEach(({ file, text }) => {
    io.error(text)
    if (githubActions) io.error(annotate(file, text))
  })
  const total = lines.length
  io.error(`CRAP baseline diff: fail (${total} ${total === 1 ? 'row' : 'rows'} grew compared with the base; the reviewer decides)`)
}

interface DiffFindings {
  grown: GrowthRow[]
  listGrown: StaleUnmatched[]
  /** One phrase per file: either compared, or absent on the base. */
  notes: string[]
}

const note = (baseHas: boolean, what: string, basePath: string): string =>
  baseHas ? `no ${what} growth against the base` : `no ${what} on the base, nothing to compare: ${basePath}`

/** One base file: its text and where it came from, or null when the base does not have it. */
interface BaseFile {
  text: string
  where: string
}

interface BaseFiles {
  baseline: BaseFile | null
  unmatched: BaseFile | null
  /** What the pass note names for an absent file. */
  baselineLabel: string
  unmatchedLabel: string
}

/** A missing base file is the initial freeze only when the caller declared it absent; otherwise it is an error. */
const baseFileFromPath = (basePath: string, declaredAbsent: boolean): BaseFile | null => {
  if (existsSync(basePath)) return { text: readFileSync(basePath, 'utf8'), where: basePath }
  if (declaredAbsent) return null
  throw new Error(`Missing base input: ${basePath} (pass the matching absent flag only if the base commit has no such file)`)
}

const baseFilesFromPaths = (opts: DiffOptions): BaseFiles => ({
  baseline: baseFileFromPath(opts.basePath, opts.baseAbsent),
  unmatched: baseFileFromPath(opts.baseUnmatchedPath, opts.baseUnmatchedAbsent),
  baselineLabel: opts.basePath,
  unmatchedLabel: opts.baseUnmatchedPath,
})

/** Reads both base files from the revision; a path the revision lacks is absent, any git error throws. */
const baseFilesFromRef = (repoRoot: string, rev: string): BaseFiles => {
  const at = (display: string): BaseFile | null => {
    const text = readBaseFile(repoRoot, rev, display)
    return text === null ? null : { text, where: `${rev}:${display}` }
  }
  return {
    baseline: at(BASELINE_DISPLAY),
    unmatched: at(UNMATCHED_DISPLAY),
    baselineLabel: `${rev}:${BASELINE_DISPLAY}`,
    unmatchedLabel: `${rev}:${UNMATCHED_DISPLAY}`,
  }
}

interface HeadPaths {
  headPath: string
  headUnmatchedPath: string
  githubActions: boolean
}

/** A file the base does not have is the initial freeze: nothing to compare against, so no growth. */
const diffFindings = (opts: HeadPaths, loadBase: () => BaseFiles): DiffFindings => {
  const head = readBaseline(opts.headPath)
  const headList = readUnmatchedList(opts.headUnmatchedPath)
  const base = loadBase()
  return {
    grown: base.baseline ? findGrowth(parseBaselineText(base.baseline.text, base.baseline.where), head) : [],
    listGrown: base.unmatched
      ? findUnmatchedGrowth(parseListText(base.unmatched.text, base.unmatched.where), headList)
      : [],
    notes: [note(base.baseline !== null, 'baseline', base.baselineLabel), note(base.unmatched !== null, 'unmatched list', base.unmatchedLabel)],
  }
}

const finishDiff = (findings: DiffFindings, githubActions: boolean, io: Io): number => {
  const { grown, listGrown, notes } = findings
  if (grown.length + listGrown.length > 0) {
    reportGrowth(grown, listGrown, githubActions, io)
    return 1
  }
  io.log(`CRAP baseline diff: pass (${notes.join('; ')})`)
  return 0
}

const failWith = (e: unknown, io: Io): number => {
  io.error(e instanceof Error ? e.message : String(e))
  return 1
}

/**
 * Returns the process exit code: 0 when neither head file has grown against the base, or the
 * base has nothing to compare (the initial freeze); 1 on growth or any input error.
 */
export const runBaselineDiff = (opts: DiffOptions, io: Io): number => {
  try {
    return finishDiff(diffFindings(opts, () => baseFilesFromPaths(opts)), opts.githubActions, io)
  } catch (e) {
    return failWith(e, io)
  }
}

export interface DiffRefOptions {
  repoRoot: string
  /** The revision whose `crap/` files are the base, for example `HEAD^1`. */
  baseRef: string
  headPath: string
  headUnmatchedPath: string
  githubActions: boolean
}

/** As `runBaselineDiff`, but the base files are read from a git revision, never from the working tree. */
export const runBaselineDiffAtRef = (opts: DiffRefOptions, io: Io): number => {
  try {
    return finishDiff(diffFindings(opts, () => baseFilesFromRef(opts.repoRoot, opts.baseRef)), opts.githubActions, io)
  } catch (e) {
    return failWith(e, io)
  }
}

const REPORT_PATH = 'coverage/crap-report.json'
const BASELINE_PATH = 'crap/baseline.tsv'
const UNMATCHED_PATH = 'crap/unmatched.tsv'

export type ParsedArgs =
  | { command: 'measure'; coveragePaths: readonly string[]; acceptUnmatched: boolean }
  | { command: 'check'; githubActions: boolean }
  | { command: 'baseline'; allowGrowth: boolean; outputDir?: string }
  | {
      command: 'diff'
      basePath: string
      headPath: string
      baseUnmatchedPath: string
      headUnmatchedPath: string
      baseAbsent: boolean
      baseUnmatchedAbsent: boolean
      githubActions: boolean
    }
  | { command: 'diff-ref'; baseRef: string; githubActions: boolean }
  | { command: 'usage'; message: string }

const USAGE =
  'Usage: cli.ts measure [--coverage <path>]... [--accept-unmatched] | check | baseline [--allow-growth] [--output-dir <dir>] | diff [--base-ref <rev>] | diff --base <path> --base-unmatched <path> [--base-absent] [--base-unmatched-absent] [--head <path>] [--head-unmatched <path>]. Every command also takes [--config <path>]'
const usage = (detail: string): ParsedArgs => ({ command: 'usage', message: `${detail}\n${USAGE}` })

const COMMANDS = ['measure', 'check', 'baseline', 'diff']
const DIFF_FLAGS = ['--base', '--head', '--base-unmatched', '--head-unmatched']

type Env = Record<string, string | undefined>

interface MeasureFlags {
  coveragePaths: string[]
  acceptUnmatched: boolean
}

/** Returns an error text when the flag is unknown or `--coverage` has no value. */
const applyMeasureFlag = (found: MeasureFlags, name: string, value: string | undefined): string | null => {
  if (name === '--accept-unmatched') {
    found.acceptUnmatched = true
    return null
  }
  if (name !== '--coverage') return `Unknown flag for measure: ${name}`
  if (value === undefined || value.startsWith('--')) return 'Missing value for --coverage'
  found.coveragePaths.push(value)
  return null
}

const readMeasureFlags = (flags: string[]): MeasureFlags | string => {
  const found: MeasureFlags = { coveragePaths: [], acceptUnmatched: false }
  for (let i = 0; i < flags.length; i++) {
    const error = applyMeasureFlag(found, flags[i], flags[i + 1])
    if (error !== null) return error
    if (flags[i] === '--coverage') i++
  }
  return found
}

const parseMeasure = (flags: string[], config: CrapConfig): ParsedArgs => {
  const found = readMeasureFlags(flags)
  if (typeof found === 'string') return usage(found)
  const coveragePaths = found.coveragePaths.length > 0 ? found.coveragePaths : config.coverage
  return { command: 'measure', coveragePaths, acceptUnmatched: found.acceptUnmatched }
}

const DIFF_SWITCHES = ['--base-absent', '--base-unmatched-absent']

const diffSwitchError = (name: string, found: Record<string, string>): string | null =>
  name in found ? `Duplicate flag for diff: ${name}` : null

const diffFlagError = (name: string, value: string | undefined, found: Record<string, string>): string | null => {
  if (!DIFF_FLAGS.includes(name)) return `Unknown flag for diff: ${name}`
  if (name in found) return `Duplicate flag for diff: ${name}`
  return value === undefined || value.startsWith('--') ? `Missing value for ${name}` : null
}

/** Reads `--flag value` pairs; returns the error text when a flag is unknown, repeated, or has no value. */
const readDiffFlags = (flags: string[]): Record<string, string> | string => {
  const found: Record<string, string> = {}
  for (let i = 0; i < flags.length; i++) {
    const isSwitch = DIFF_SWITCHES.includes(flags[i])
    const error = isSwitch ? diffSwitchError(flags[i], found) : diffFlagError(flags[i], flags[i + 1], found)
    if (error !== null) return error
    found[flags[i]] = isSwitch ? 'true' : flags[++i]
  }
  return found
}

const REQUIRED_DIFF_FLAGS = ['--base', '--base-unmatched']

const parseDiff = (flags: string[], env: Env): ParsedArgs => {
  const found = readDiffFlags(flags)
  if (typeof found === 'string') return usage(found)
  const missing = REQUIRED_DIFF_FLAGS.find((name) => found[name] === undefined)
  if (missing !== undefined) return usage(`Missing required flag for diff: ${missing}`)
  return {
    command: 'diff',
    basePath: found['--base'],
    headPath: found['--head'] ?? BASELINE_PATH,
    baseUnmatchedPath: found['--base-unmatched'],
    headUnmatchedPath: found['--head-unmatched'] ?? UNMATCHED_PATH,
    baseAbsent: '--base-absent' in found,
    baseUnmatchedAbsent: '--base-unmatched-absent' in found,
    githubActions: env.GITHUB_ACTIONS === 'true',
  }
}

const parseCheck = (flags: string[], env: Env): ParsedArgs =>
  flags.length === 0
    ? { command: 'check', githubActions: env.GITHUB_ACTIONS === 'true' }
    : usage(`Unknown flag for check: ${flags[0]}`)

/** The value after a `--flag value` pair, or null when it is absent or is itself a flag. */
const valueAfter = (flags: string[], i: number): string | null => {
  const value = flags[i + 1]
  return value === undefined || value.startsWith('--') ? null : value
}

const parseBaselineArgs = (flags: string[]): ParsedArgs => {
  let allowGrowth = false
  let outputDir: string | undefined
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === '--allow-growth') {
      allowGrowth = true
    } else if (flags[i] === '--output-dir') {
      const value = valueAfter(flags, i++)
      if (value === null) return usage('Missing value for --output-dir')
      outputDir = value
    } else {
      return usage(`Unknown flag for baseline: ${flags[i]}`)
    }
  }
  return outputDir === undefined ? { command: 'baseline', allowGrowth } : { command: 'baseline', allowGrowth, outputDir }
}

const parseKnown = (command: string, flags: string[], env: Env, config: CrapConfig): ParsedArgs => {
  if (command === 'diff') return parseDiff(flags, env)
  if (command === 'measure') return parseMeasure(flags, config)
  return command === 'baseline' ? parseBaselineArgs(flags) : parseCheck(flags, env)
}

/**
 * A `--coverage` flag overrides the config's coverage files, which override the defaults.
 * The config defaults only because the copied tests call this without one; `runCli` always passes it.
 */
export const parseArgs = (argv: string[], env: Env, config: CrapConfig = DEFAULT_CONFIG): ParsedArgs => {
  const [command = '', ...flags] = argv
  if (!COMMANDS.includes(command)) return usage(`Unknown or missing subcommand: ${command || '(none)'}`)
  return parseKnown(command, flags, env, config)
}

const DEFAULT_BASE_REF = 'HEAD^1'
const FILE_DIFF_FLAGS = [...DIFF_FLAGS, ...DIFF_SWITCHES]

/** `diff` with no file-path flag reads the base from a git revision; with any of them it is the file form. */
const isRefDiff = (flags: string[]): boolean => !flags.some((f) => FILE_DIFF_FLAGS.includes(f))

const parseDiffRef = (flags: string[], env: Env): ParsedArgs => {
  if (flags.length === 0) return { command: 'diff-ref', baseRef: DEFAULT_BASE_REF, githubActions: env.GITHUB_ACTIONS === 'true' }
  if (flags[0] !== '--base-ref') return usage(`Unknown flag for diff: ${flags[0]}`)
  if (flags.length === 1 || flags[1].startsWith('--')) return usage('Missing value for --base-ref')
  if (flags.length > 2) return usage(`Unexpected argument for diff: ${flags[2]}`)
  return { command: 'diff-ref', baseRef: flags[1], githubActions: env.GITHUB_ACTIONS === 'true' }
}

const mixesBaseRef = (flags: string[]): boolean => flags.includes('--base-ref') && !isRefDiff(flags)

/**
 * The CLI's parser. `diff` without a file-path flag takes `--base-ref <rev>` (default `HEAD^1`);
 * everything else is `parseArgs`, which keeps the file-path form of `diff`.
 */
export const parseCommand = (argv: string[], env: Env, config: CrapConfig): ParsedArgs => {
  const [command = '', ...flags] = argv
  if (command !== 'diff') return parseArgs(argv, env, config)
  if (mixesBaseRef(flags)) return usage('--base-ref cannot be combined with the file-path flags of diff')
  return isRefDiff(flags) ? parseDiffRef(flags, env) : parseArgs(argv, env, config)
}

const lintedOptions = (coveragePaths: readonly string[], acceptUnmatched: boolean, repoRoot: string): LintedMeasureOptions => ({
  coveragePaths,
  unmatchedListPath: UNMATCHED_PATH,
  acceptUnmatched,
  outPath: REPORT_PATH,
  repoRoot,
})

const checkOptions = (githubActions: boolean, config: CrapConfig): CheckOptions => ({
  reportPath: REPORT_PATH,
  baselinePath: BASELINE_PATH,
  githubActions,
  threshold: config.threshold,
})

const baselineOptions = (allowGrowth: boolean, outputDir: string | undefined, config: CrapConfig): BaselineOptions => ({
  reportPath: REPORT_PATH,
  baselinePath: BASELINE_PATH,
  unmatchedListPath: UNMATCHED_PATH,
  allowGrowth,
  outputDir,
  threshold: config.threshold,
})

/** Measure first; the ratchet runs only when the measure passed. */
const measureThen = async (
  opts: LintedMeasureOptions,
  config: CrapConfig,
  io: Io,
  next: () => number,
): Promise<number> => {
  const code = await runMeasureLinted(opts, config, io)
  return code === 0 ? next() : code
}

const run = async (args: ParsedArgs, config: CrapConfig, repoRoot: string, io: Io): Promise<number> => {
  switch (args.command) {
    case 'measure':
      return runMeasureLinted(lintedOptions(args.coveragePaths, args.acceptUnmatched, repoRoot), config, io)
    case 'check':
      return measureThen(lintedOptions(config.coverage, false, repoRoot), config, io, () =>
        runCheck(checkOptions(args.githubActions, config), io),
      )
    case 'baseline':
      return measureThen(lintedOptions(config.coverage, true, repoRoot), config, io, () =>
        runBaseline(baselineOptions(args.allowGrowth, args.outputDir, config), io),
      )
    case 'diff':
      return runBaselineDiff(args, io)
    case 'diff-ref':
      return runBaselineDiffAtRef(
        { repoRoot, baseRef: args.baseRef, headPath: BASELINE_PATH, headUnmatchedPath: UNMATCHED_PATH, githubActions: args.githubActions },
        io,
      )
    default:
      io.error(args.message)
      return 1
  }
}

interface SplitArgs {
  /** The arguments without the `--config` pair. */
  argv: string[]
  configPath: string | undefined
}

/** Takes the `--config <path>` pair out of the arguments, wherever it sits; returns the error text for a repeat or a missing value. */
const splitConfigFlag = (argv: string[]): SplitArgs | string => {
  const rest: string[] = []
  let configPath: string | undefined
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--config') {
      rest.push(argv[i])
      continue
    }
    const value = valueAfter(argv, i++)
    if (value === null) return 'Missing value for --config'
    if (configPath !== undefined) return 'Duplicate flag: --config'
    configPath = value
  }
  return { argv: rest, configPath }
}

/** Loads the config (`--config`, else `crap/config.json`) from `cwd` first: an invalid config is exit 1 before any command runs. */
export const runCli = async (argv: string[], env: Env, cwd: string, io: Io): Promise<number> => {
  const split = splitConfigFlag(argv)
  if (typeof split === 'string') {
    io.error(`${split}\n${USAGE}`)
    return 1
  }
  let config: CrapConfig
  try {
    config = loadConfig(cwd, split.configPath)
  } catch (e) {
    io.error(e instanceof Error ? e.message : String(e))
    return 1
  }
  return run(parseCommand(split.argv, env, config), config, cwd, io)
}

if (require.main === module) {
  void runCli(process.argv.slice(2), process.env, process.cwd(), console).then((code) => {
    process.exitCode = code
  }).catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e))
    process.exitCode = 1
  })
}
