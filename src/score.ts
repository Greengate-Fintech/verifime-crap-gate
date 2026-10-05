import type { CovKind, IstanbulFileCoverage, IstanbulLocation } from './types'

export type Position = readonly [number, number]
export type Span = readonly [Position, Position]
interface Tally {
  total: number
  covered: number
}

// toFixed(100) yields the exact binary expansion for the magnitudes rounded here (coverage
// ratios and CRAP scores, all well under 1e21 with short expansions), not for every double.
const EXACT_DIGITS = 100
const TIE_TAIL = /^50*$/

/** Cut an exact decimal expansion after `dp` fractional digits, and return the discarded tail. */
const splitExact = (x: number, dp: number): [string, string] => {
  const exact = x.toFixed(EXACT_DIGITS)
  const cut = exact.indexOf('.') + 1 + dp
  return [exact.slice(0, cut).replace(/\.$/, ''), exact.slice(cut)]
}

/**
 * Round half to even on the exact decimal value of the double.
 * toFixed alone rounds an exact tie away from zero.
 */
export const roundTo = (x: number, dp: number): number => {
  const [head, tail] = splitExact(x, dp)
  const lastDigit = Number(head[head.length - 1])
  const evenTie = TIE_TAIL.test(tail) && lastDigit % 2 === 0
  return Number(evenTie ? head : x.toFixed(dp))
}

export const toSpan = (loc: IstanbulLocation): Span => [
  [loc.start.line, loc.start.column ?? 0],
  [loc.end.line, loc.end.column ?? Number.POSITIVE_INFINITY],
]

const positionLte = (a: Position, b: Position): boolean =>
  a[0] < b[0] || (a[0] === b[0] && a[1] <= b[1])

const within = (inner: Span, outer: Span): boolean =>
  positionLte(outer[0], inner[0]) && positionLte(inner[1], outer[1])

const ratio = (t: Tally): number | undefined => (t.total > 0 ? t.covered / t.total : undefined)

const statementTally = (file: IstanbulFileCoverage, fnSpan: Span): Tally => {
  const tally: Tally = { total: 0, covered: 0 }
  for (const [id, loc] of Object.entries(file.statementMap)) {
    if (!within(toSpan(loc), fnSpan)) continue
    tally.total += 1
    if ((file.s[id] ?? 0) > 0) tally.covered += 1
  }
  return tally
}

const hasStart = (loc: IstanbulLocation | undefined): loc is IstanbulLocation =>
  loc?.start?.line != null

/**
 * Istanbul records an `if` without an `else` as two locations: the consequent, and an implicit
 * `else` whose position is empty. The hits for the path that did not take the `if` sit in that
 * slot. An empty location has no position of its own, so it belongs to the function that holds
 * its branch (the branch's own `loc`) and counts with its own hit count.
 */
const branchTally = (file: IstanbulFileCoverage, fnSpan: Span): Tally => {
  const tally: Tally = { total: 0, covered: 0 }
  for (const [id, branch] of Object.entries(file.branchMap)) {
    const counts = file.b[id] ?? []
    branch.locations.forEach((loc, i) => {
      const owner = hasStart(loc) ? loc : branch.loc
      if (!hasStart(owner) || !within(toSpan(owner), fnSpan)) return
      tally.total += 1
      if (i < counts.length && counts[i] > 0) tally.covered += 1
    })
  }
  return tally
}

const combine = (
  stmt: number | undefined,
  branch: number | undefined,
  called: boolean,
): { cov: number; covKind: CovKind } => {
  if (stmt !== undefined && branch !== undefined) {
    return { cov: Math.min(stmt, branch), covKind: 'min(stmt,branch)' }
  }
  if (stmt !== undefined) return { cov: stmt, covKind: 'stmt' }
  if (branch !== undefined) return { cov: branch, covKind: 'branch' }
  return { cov: Number(called), covKind: 'called' }
}

/** Unrounded coverage, for the CRAP computation (only the report rounds). */
export const rawFunctionCoverage = (
  file: IstanbulFileCoverage,
  fnId: string,
): { cov: number; covKind: CovKind } => {
  const fnSpan = toSpan(file.fnMap[fnId].loc)
  return combine(
    ratio(statementTally(file, fnSpan)),
    ratio(branchTally(file, fnSpan)),
    (file.f[fnId] ?? 0) > 0,
  )
}

/** Coverage for reporting, rounded to 4 dp. */
export const functionCoverage = (
  file: IstanbulFileCoverage,
  fnId: string,
): { cov: number; covKind: CovKind } => {
  const { cov, covKind } = rawFunctionCoverage(file, fnId)
  return { cov: roundTo(cov, 4), covKind }
}

/** CRAP = cc^2 * (1 - cov)^3 + cc, rounded to 3 dp. Pass unrounded coverage. */
export const crapScore = (cc: number, cov: number): number =>
  roundTo(cc * cc * (1 - cov) ** 3 + cc, 3)
