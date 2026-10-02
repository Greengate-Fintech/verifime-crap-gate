import { crapScore } from './score'
import type { FunctionScore, StaleUnmatched, UnmatchedFunction } from './types'

// The known-unmatched list: functions the coverage provider gives no fnMap entry for. Each is
// scored at coverage 0 and joins the normal ratchet, instead of failing the measure forever.
// The list only shrinks, by the same rule as the baseline. An unmatched function that is not on
// it fails (a join break must never pass silently), and a listed entry that now matches is stale.
// Keys carry no line number, like the baseline, so an unrelated edit above a function is not churn.

/** Occurrence counts keyed by `${file}\t${symbol}`. */
export type UnmatchedGroups = Map<string, number>

export const UNMATCHED_DISPLAY = 'crap/unmatched.tsv'

const FORBIDDEN = /[\t\r\n]/

const keyOf = (u: StaleUnmatched): string => `${u.file}\t${u.symbol}`

const splitKey = (key: string): StaleUnmatched => {
  const at = key.indexOf('\t')
  return { file: key.slice(0, at), symbol: key.slice(at + 1) }
}

const assertKeyable = (u: StaleUnmatched): void => {
  if (FORBIDDEN.test(u.file) || FORBIDDEN.test(u.symbol)) {
    throw new Error(
      `Cannot list an unmatched function whose file or symbol contains a tab or line break: ${JSON.stringify(`${u.file}#${u.symbol}`)}`,
    )
  }
}

const bump = (groups: UnmatchedGroups, key: string): void => {
  groups.set(key, (groups.get(key) ?? 0) + 1)
}

export const groupUnmatched = (found: StaleUnmatched[]): UnmatchedGroups => {
  const groups: UnmatchedGroups = new Map()
  for (const u of found) {
    assertKeyable(u)
    bump(groups, keyOf(u))
  }
  return groups
}

const HEADER = [
  '# Functions the coverage provider gives no entry for, scored at coverage 0 and ratcheted like the baseline.',
  '# See the README "CRAP gate" section.',
  '# Format: file<TAB>symbol, one row per occurrence.',
  '# The list only shrinks. Regenerate with: npm run crap:baseline',
  '# Growth (a new unmatched function) needs: npm run crap:baseline -- --allow-growth',
]

export const renderUnmatchedList = (groups: UnmatchedGroups): string => {
  const rows = [...groups.keys()].sort().flatMap((key) => Array<string>(groups.get(key) ?? 0).fill(key))
  return [...HEADER, '', ...rows].join('\n') + '\n'
}

const parseRow = (line: string, lineNo: number): string => {
  const fields = line.split('\t')
  if (fields.length !== 2 || fields.some((f) => f.trim() === '')) {
    throw new Error(`Malformed unmatched list line ${lineNo}: expected file<TAB>symbol, got "${line}"`)
  }
  return line
}

export const parseUnmatchedList = (text: string): UnmatchedGroups => {
  const groups: UnmatchedGroups = new Map()
  text.split('\n').forEach((line, i) => {
    if (line.trim() === '' || line.startsWith('#')) return
    bump(groups, parseRow(line, i + 1))
  })
  return groups
}

export interface UnmatchedSplit {
  listed: UnmatchedFunction[]
  failing: UnmatchedFunction[]
  stale: StaleUnmatched[]
}

/** The first occurrences of each key, up to its listed count, are covered; the rest fail. */
export const splitUnmatched = (found: UnmatchedFunction[], list: UnmatchedGroups): UnmatchedSplit => {
  const remaining = new Map(list)
  const listed: UnmatchedFunction[] = []
  const failing: UnmatchedFunction[] = []
  for (const u of found) {
    const left = remaining.get(keyOf(u)) ?? 0
    remaining.set(keyOf(u), left - 1)
    if (left > 0) listed.push(u)
    else failing.push(u)
  }
  const stale = [...remaining.keys()]
    .sort()
    .flatMap((key) => Array<StaleUnmatched>(Math.max(0, remaining.get(key) ?? 0)).fill(splitKey(key)))
  return { listed, failing, stale }
}

/** Coverage 0 by definition: CRAP = cc^2 + cc. */
export const scoreListedUnmatched = (u: UnmatchedFunction): FunctionScore => ({
  file: u.file,
  symbol: u.symbol,
  kind: u.kind,
  line: u.line,
  cc: u.cc,
  cov: 0,
  covKind: 'unmatched',
  crap: crapScore(u.cc, 0),
})

const surplus = (key: string, have: UnmatchedGroups, over: UnmatchedGroups): StaleUnmatched[] =>
  Array<StaleUnmatched>(Math.max(0, (have.get(key) ?? 0) - (over.get(key) ?? 0))).fill(splitKey(key))

/** Entries in `head` beyond what `base` holds, one per added row. */
export const findUnmatchedGrowth = (base: UnmatchedGroups, head: UnmatchedGroups): StaleUnmatched[] =>
  [...head.keys()].sort().flatMap((key) => surplus(key, head, base))

const keep = (key: string, existing: UnmatchedGroups, current: UnmatchedGroups): number =>
  Math.min(existing.get(key) ?? 0, current.get(key) ?? 0)

const shrunk = (existing: UnmatchedGroups, current: UnmatchedGroups): UnmatchedGroups =>
  new Map(
    [...current.keys()]
      .map((key): [string, number] => [key, keep(key, existing, current)])
      .filter(([, count]) => count > 0),
  )

/**
 * Shrink-only update of the list. With no existing list every current entry is frozen, and
 * allowGrowth blesses new entries; otherwise growth is refused and the existing entries kept.
 */
export const planUnmatchedUpdate = (
  existing: UnmatchedGroups | null,
  current: UnmatchedGroups,
  allowGrowth: boolean,
): { list: UnmatchedGroups; refused: StaleUnmatched[] } => {
  if (existing === null) return { list: current, refused: [] }
  const refused = findUnmatchedGrowth(existing, current)
  return allowGrowth ? { list: current, refused: [] } : { list: shrunk(existing, current), refused }
}
