import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
import path from 'path'
import { DEFAULT_CONFIG, loadConfig } from './config'
import type { CrapConfig } from './config'
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
  eslintPath: string
  /** Every coverage file to merge (one per package); a missing one fails the measure. */
  coveragePaths: string[]
  unmatchedListPath: string
  /** Treat every unmatched function as listed: only for regenerating the baseline. */
  acceptUnmatched: boolean
  outPath: string
  repoRoot: string
  /** Scope, anchors, extensions, exclude and threshold; the defaults when absent. */
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
const readCoverage = (paths: string[]): Record<string, IstanbulFileCoverage> => {
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

/** A missing list is an empty one: every unmatched function then fails, so it can only be stricter. */
const readUnmatchedList = (listPath: string): UnmatchedGroups => {
  if (!existsSync(listPath)) return new Map()
  try {
    return parseUnmatchedList(readFileSync(listPath, 'utf8'))
  } catch (e) {
    throw new Error(`${e instanceof Error ? e.message : String(e)} (${listPath})`)
  }
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
  return { measurement: { functions, unmatched: failing, problems: m.problems }, listed, stale, accepted: opts.acceptUnmatched }
}

const compute = (opts: MeasureOptions, config: CrapConfig): Outcome => {
  const eslint = readJson<EslintFileResult[]>(opts.eslintPath, 'ESLint')
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
    io.log(summaryLine(summary))
    return problems.length === 0 ? 0 : 1
  } catch (e) {
    io.error(e instanceof Error ? e.message : String(e))
    return 1
  }
}

export interface CheckOptions {
  reportPath: string
  baselinePath: string
  githubActions: boolean
  /** The offender threshold; the default when absent. */
  threshold?: number
}

export interface BaselineOptions {
  reportPath: string
  baselinePath: string
  unmatchedListPath: string
  allowGrowth: boolean
  /** The offender threshold; the default when absent. */
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

const readBaseline = (baselinePath: string): ScoreGroups => {
  let text: string
  try {
    text = readFileSync(baselinePath, 'utf8')
  } catch {
    throw new Error(`Missing baseline input: ${baselinePath}`)
  }
  try {
    return parseBaseline(text)
  } catch (e) {
    throw new Error(`${e instanceof Error ? e.message : String(e)} (${baselinePath})`)
  }
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
    mkdirSync(path.dirname(opts.baselinePath), { recursive: true })
    writeFileSync(opts.baselinePath, renderBaseline(plan.baseline))
    mkdirSync(path.dirname(opts.unmatchedListPath), { recursive: true })
    writeFileSync(opts.unmatchedListPath, renderUnmatchedList(listPlan.list))
    io.log(`CRAP baseline: wrote ${countRows(plan.baseline)} rows to ${opts.baselinePath}`)
    io.log(`CRAP baseline: wrote ${countCounts(listPlan.list)} unmatched rows to ${opts.unmatchedListPath}`)
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

/** A missing base file is the initial freeze only when the caller declared it absent; otherwise it is an error. */
const baseExists = (basePath: string, declaredAbsent: boolean): boolean => {
  if (existsSync(basePath)) return true
  if (declaredAbsent) return false
  throw new Error(`Missing base input: ${basePath} (pass the matching absent flag only if the base commit has no such file)`)
}

/** A file the base does not have is the initial freeze: nothing to compare against, so no growth. */
const diffFindings = (opts: DiffOptions): DiffFindings => {
  const head = readBaseline(opts.headPath)
  const headList = readUnmatchedList(opts.headUnmatchedPath)
  const baseHas = baseExists(opts.basePath, opts.baseAbsent)
  const baseListHas = baseExists(opts.baseUnmatchedPath, opts.baseUnmatchedAbsent)
  return {
    grown: baseHas ? findGrowth(readBaseline(opts.basePath), head) : [],
    listGrown: baseListHas ? findUnmatchedGrowth(readUnmatchedList(opts.baseUnmatchedPath), headList) : [],
    notes: [note(baseHas, 'baseline', opts.basePath), note(baseListHas, 'unmatched list', opts.baseUnmatchedPath)],
  }
}

/**
 * Returns the process exit code: 0 when neither head file has grown against the base, or the
 * base has nothing to compare (the initial freeze); 1 on growth or any input error.
 */
export const runBaselineDiff = (opts: DiffOptions, io: Io): number => {
  try {
    const { grown, listGrown, notes } = diffFindings(opts)
    if (grown.length + listGrown.length > 0) {
      reportGrowth(grown, listGrown, opts.githubActions, io)
      return 1
    }
    io.log(`CRAP baseline diff: pass (${notes.join('; ')})`)
    return 0
  } catch (e) {
    io.error(e instanceof Error ? e.message : String(e))
    return 1
  }
}

const REPORT_PATH = 'coverage/crap-report.json'
const BASELINE_PATH = 'crap/baseline.tsv'
const UNMATCHED_PATH = 'crap/unmatched.tsv'

export type ParsedArgs =
  | { command: 'measure'; coveragePaths: string[]; acceptUnmatched: boolean }
  | { command: 'check'; githubActions: boolean }
  | { command: 'baseline'; allowGrowth: boolean }
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
  | { command: 'usage'; message: string }

const USAGE =
  'Usage: cli.ts measure [--coverage <path>]... [--accept-unmatched] | check | baseline [--allow-growth] | diff --base <path> --base-unmatched <path> [--base-absent] [--base-unmatched-absent] [--head <path>] [--head-unmatched <path>]'
const usage = (detail: string): ParsedArgs => ({ command: 'usage', message: `${detail}\n${USAGE}` })

const allowedFlags = (command: string): string[] => (command === 'baseline' ? ['--allow-growth'] : [])

const COMMANDS = ['measure', 'check', 'baseline', 'diff']
const DIFF_FLAGS = ['--base', '--head', '--base-unmatched', '--head-unmatched']

type Env = Record<string, string | undefined>

const build = (command: string, flags: string[], env: Env): ParsedArgs =>
  command === 'check'
    ? { command, githubActions: env.GITHUB_ACTIONS === 'true' }
    : { command: 'baseline', allowGrowth: flags.includes('--allow-growth') }

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

const parseBoolFlags = (command: string, flags: string[], env: Env): ParsedArgs => {
  const unknown = flags.find((f) => !allowedFlags(command).includes(f))
  return unknown === undefined ? build(command, flags, env) : usage(`Unknown flag for ${command}: ${unknown}`)
}

const parseKnown = (command: string, flags: string[], env: Env, config: CrapConfig): ParsedArgs => {
  if (command === 'diff') return parseDiff(flags, env)
  return command === 'measure' ? parseMeasure(flags, config) : parseBoolFlags(command, flags, env)
}

/** A `--coverage` flag overrides the config's coverage files, which override the defaults. */
export const parseArgs = (argv: string[], env: Env, config: CrapConfig = DEFAULT_CONFIG): ParsedArgs => {
  const [command = '', ...flags] = argv
  if (!COMMANDS.includes(command)) return usage(`Unknown or missing subcommand: ${command || '(none)'}`)
  return parseKnown(command, flags, env, config)
}

const measureOptions = (
  args: { coveragePaths: string[]; acceptUnmatched: boolean },
  config: CrapConfig,
  repoRoot: string,
): MeasureOptions => ({
  eslintPath: 'coverage/crap-eslint.json',
  coveragePaths: args.coveragePaths,
  unmatchedListPath: UNMATCHED_PATH,
  acceptUnmatched: args.acceptUnmatched,
  outPath: REPORT_PATH,
  repoRoot,
  config,
})

const run = (args: ParsedArgs, config: CrapConfig, repoRoot: string, io: Io): number => {
  switch (args.command) {
    case 'measure':
      return runMeasure(measureOptions(args, config, repoRoot), io)
    case 'check':
      return runCheck(
        { reportPath: REPORT_PATH, baselinePath: BASELINE_PATH, githubActions: args.githubActions, threshold: config.threshold },
        io,
      )
    case 'baseline':
      return runBaseline(
        {
          reportPath: REPORT_PATH,
          baselinePath: BASELINE_PATH,
          unmatchedListPath: UNMATCHED_PATH,
          allowGrowth: args.allowGrowth,
          threshold: config.threshold,
        },
        io,
      )
    case 'diff':
      return runBaselineDiff(args, io)
    default:
      io.error(args.message)
      return 1
  }
}

/** Loads `crap/config.json` from `cwd` first: an invalid config is exit 1 before any command runs. */
export const runCli = (argv: string[], env: Env, cwd: string, io: Io): number => {
  let config: CrapConfig
  try {
    config = loadConfig(cwd)
  } catch (e) {
    io.error(e instanceof Error ? e.message : String(e))
    return 1
  }
  return run(parseArgs(argv, env, config), config, cwd, io)
}

if (require.main === module) process.exit(runCli(process.argv.slice(2), process.env, process.cwd(), console))
