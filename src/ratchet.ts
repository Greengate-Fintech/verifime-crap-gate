import { roundTo } from './score'
import type { FunctionScore } from './types'

/**
 * Scores keyed by `${file}\t${symbol}`, each list ascending.
 * Current groups (from `groupScores`) hold ALL measured scores, including those at or below
 * the threshold: that is what lets a frozen function that has improved be detected as stale.
 * Baseline groups (from `parseBaseline`) hold offenders only.
 */
export type ScoreGroups = Map<string, number[]>

interface ViolationBase {
  file: string
  symbol: string
  message: string
}

/** A baseline row that is new, or worse than its base partner beyond the tolerance. `base` is null for a row with no partner. */
export interface GrowthRow {
  file: string
  symbol: string
  score: number
  base: number | null
}

export type Violation =
  | (ViolationBase & { kind: 'new'; current: number })
  | (ViolationBase & { kind: 'regression'; current: number; frozen: number })
  | (ViolationBase & { kind: 'stale' })

export const CRAP_THRESHOLD = 8
export const REGRESSION_TOLERANCE = 0.05
export const BASELINE_DISPLAY = 'crap/baseline.tsv'

const ascending = (a: number, b: number): number => a - b
export const fmt1 = (x: number): string => x.toFixed(1)
const splitKey = (key: string): [string, string] => {
  const at = key.indexOf('\t')
  return [key.slice(0, at), key.slice(at + 1)]
}

const FORBIDDEN = /[\t\r\n]/

/** A tab, CR or LF would corrupt the TSV baseline and make group keys ambiguous. */
const assertKeyable = (fn: FunctionScore): void => {
  if (FORBIDDEN.test(fn.file) || FORBIDDEN.test(fn.symbol)) {
    throw new Error(
      `Cannot baseline a function whose file or symbol contains a tab or line break: ${JSON.stringify(`${fn.file}#${fn.symbol}`)}`,
    )
  }
}

export const groupScores = (functions: FunctionScore[]): ScoreGroups => {
  const groups: ScoreGroups = new Map()
  for (const fn of functions) {
    assertKeyable(fn)
    const key = `${fn.file}\t${fn.symbol}`
    groups.set(key, [...(groups.get(key) ?? []), fn.crap].sort(ascending))
  }
  return groups
}

const HEADER = [
  '# CRAP ratchet baseline: the lowest recorded score of every function above the threshold.',
  '# See the README "CRAP gate" section for how to respond to a failing check.',
  '# Format: file<TAB>symbol<TAB>score, one row per scored occurrence.',
  '# The baseline only shrinks. Regenerate with: npm run crap:baseline',
  '# Growth (new offenders or worse scores) needs: npm run crap:baseline -- --allow-growth',
]

export const renderBaseline = (groups: ScoreGroups): string => {
  const rows: string[] = []
  for (const key of [...groups.keys()].sort()) {
    for (const score of groups.get(key) ?? []) rows.push(`${key}\t${score.toFixed(3)}`)
  }
  return [...HEADER, '', ...rows].join('\n') + '\n'
}

const hasThreeFilledFields = (fields: string[]): boolean =>
  fields.length === 3 && fields.every((f) => f.trim() !== '')

const PLAIN_DECIMAL = /^\d+(\.\d+)?$/

const parseRow = (line: string, lineNo: number): [string, number] => {
  const fields = line.split('\t')
  if (!hasThreeFilledFields(fields) || !PLAIN_DECIMAL.test(fields[2])) {
    throw new Error(`Malformed baseline line ${lineNo}: expected file<TAB>symbol<TAB>score, got "${line}"`)
  }
  return [`${fields[0]}\t${fields[1]}`, Number(fields[2])]
}

export const parseBaseline = (text: string): ScoreGroups => {
  const groups: ScoreGroups = new Map()
  text.split('\n').forEach((line, i) => {
    if (line.trim() === '' || line.startsWith('#')) return
    const [key, score] = parseRow(line, i + 1)
    groups.set(key, [...(groups.get(key) ?? []), score].sort(ascending))
  })
  return groups
}

interface Pairing {
  unmatchedFrozen: number[]
  unmatchedCurrent: number[]
  pairs: [number, number][]
}

/**
 * The rule: the k largest of
 * each list are paired (k is the shorter length); surplus lower frozen scores are stale;
 * surplus lower current scores are new only when above the threshold.
 * Inputs are sorted defensively (on copies) so an unsorted list cannot mispair.
 */
const pair = (frozenIn: number[], currentIn: number[]): Pairing => {
  const frozen = [...frozenIn].sort(ascending)
  const current = [...currentIn].sort(ascending)
  const k = Math.min(frozen.length, current.length)
  const topFrozen = frozen.slice(frozen.length - k)
  const topCurrent = current.slice(current.length - k)
  return {
    unmatchedFrozen: frozen.slice(0, frozen.length - k),
    unmatchedCurrent: current.slice(0, current.length - k),
    pairs: topFrozen.map((f, i): [number, number] => [f, topCurrent[i]]),
  }
}

const staleViolation = (key: string, message: string): Violation => {
  const [file, symbol] = splitKey(key)
  return { kind: 'stale', file, symbol, message }
}

const newText = (score: number, threshold: number): string =>
  `scores ${fmt1(score)}, above the threshold of ${threshold}, and is not in ${BASELINE_DISPLAY}`

const newViolation = (key: string, current: number, threshold: number): Violation => {
  const [file, symbol] = splitKey(key)
  return { kind: 'new', file, symbol, message: newText(current, threshold), current }
}

const regressionViolation = (key: string, frozen: number, current: number): Violation => {
  const [file, symbol] = splitKey(key)
  const message = `was frozen at ${fmt1(frozen)} but now scores ${fmt1(current)}`
  return { kind: 'regression', file, symbol, message, current, frozen }
}

const isRegression = (frozen: number, current: number, tolerance: number): boolean =>
  roundTo(current - frozen, 3) > tolerance

const pairViolation = (
  key: string,
  [frozen, current]: [number, number],
  threshold: number,
  tolerance: number,
): Violation | null => {
  if (isRegression(frozen, current, tolerance)) {
    return regressionViolation(key, frozen, current)
  }
  if (current <= threshold) {
    return staleViolation(
      key,
      `was frozen at ${fmt1(frozen)} but now scores ${fmt1(current)}, at or below the threshold of ${threshold}`,
    )
  }
  return null
}

const keyViolations = (
  key: string,
  frozen: number[],
  current: number[],
  threshold: number,
  tolerance: number,
): Violation[] => {
  const { unmatchedFrozen, unmatchedCurrent, pairs } = pair(frozen, current)
  const stale = unmatchedFrozen.map((f) =>
    staleViolation(
      key,
      `was frozen at ${fmt1(f)} but there are fewer scored occurrences now than frozen rows: removed, renamed, or merged`,
    ),
  )
  const added = unmatchedCurrent
    .filter((c) => c > threshold)
    .map((c) => newViolation(key, c, threshold))
  const paired = pairs
    .map((p) => pairViolation(key, p, threshold, tolerance))
    .filter((v): v is Violation => v !== null)
  return [...stale, ...added, ...paired]
}

export const evaluateRatchet = (
  baseline: ScoreGroups,
  current: ScoreGroups,
  threshold: number = CRAP_THRESHOLD,
  tolerance: number = REGRESSION_TOLERANCE,
): Violation[] => {
  const keys = [...new Set([...baseline.keys(), ...current.keys()])].sort()
  return keys.flatMap((key) =>
    keyViolations(key, baseline.get(key) ?? [], current.get(key) ?? [], threshold, tolerance),
  )
}

interface KeyPlan {
  kept: number[]
  refused: Violation[]
}

const planPair = (
  key: string,
  [frozen, current]: [number, number],
  allowGrowth: boolean,
  threshold: number,
): { kept: number | null; refused: Violation | null } => {
  if (!isRegression(frozen, current, REGRESSION_TOLERANCE)) {
    const kept = Math.min(frozen, current)
    return { kept: current > threshold ? kept : null, refused: null }
  }
  if (allowGrowth) return { kept: current, refused: null }
  return { kept: frozen, refused: regressionViolation(key, frozen, current) }
}

const planKey = (
  key: string,
  frozen: number[],
  current: number[],
  allowGrowth: boolean,
  threshold: number,
): KeyPlan => {
  const { unmatchedCurrent, pairs } = pair(frozen, current)
  const planned = pairs.map((p) => planPair(key, p, allowGrowth, threshold))
  const growth = unmatchedCurrent.filter((c) => c > threshold)
  const kept = [
    ...planned.map((p) => p.kept).filter((s): s is number => s !== null),
    ...(allowGrowth ? growth : []),
  ]
  const refused = [
    ...planned.map((p) => p.refused).filter((v): v is Violation => v !== null),
    ...(allowGrowth ? [] : growth.map((c) => newViolation(key, c, threshold))),
  ]
  return { kept: kept.sort(ascending), refused }
}

const applyPlans = (
  keys: string[],
  frozen: ScoreGroups,
  current: ScoreGroups,
  allowGrowth: boolean,
  threshold: number,
): { baseline: ScoreGroups; refused: Violation[] } => {
  const plans = keys.map((key) => ({
    key,
    plan: planKey(key, frozen.get(key) ?? [], current.get(key) ?? [], allowGrowth, threshold),
  }))
  const kept = plans.filter(({ plan }) => plan.kept.length > 0)
  return {
    baseline: new Map(kept.map(({ key, plan }): [string, number[]] => [key, plan.kept])),
    refused: plans.flatMap(({ plan }) => plan.refused),
  }
}

export const planBaselineUpdate = (
  existing: ScoreGroups | null,
  current: ScoreGroups,
  allowGrowth: boolean,
  threshold: number = CRAP_THRESHOLD,
): { baseline: ScoreGroups; refused: Violation[] } => {
  // With no existing baseline there is nothing to ratchet against: freeze every offender.
  const permit = allowGrowth || existing === null
  return applyPlans([...current.keys()].sort(), existing ?? new Map(), current, permit, threshold)
}

const growthOf = (key: string, base: number[], head: number[], tolerance: number): GrowthRow[] => {
  const [file, symbol] = splitKey(key)
  const { unmatchedCurrent, pairs } = pair(base, head)
  const added = unmatchedCurrent.map((score): GrowthRow => ({ file, symbol, score, base: null }))
  const worse = pairs
    .filter(([b, h]) => isRegression(b, h, tolerance))
    .map(([b, h]): GrowthRow => ({ file, symbol, score: h, base: b }))
  return [...added, ...worse]
}

/**
 * Rows in `head` that grew against `base`: a row with no base partner, or a paired score above
 * base plus the tolerance. Uses the ratchet's top-down pairing per (file, symbol), so a reorder
 * or a removed row is never growth. Both inputs are baselines (offenders only).
 */
export const findGrowth = (
  base: ScoreGroups,
  head: ScoreGroups,
  tolerance: number = REGRESSION_TOLERANCE,
): GrowthRow[] =>
  [...head.keys()].sort().flatMap((key) => growthOf(key, base.get(key) ?? [], head.get(key) ?? [], tolerance))
