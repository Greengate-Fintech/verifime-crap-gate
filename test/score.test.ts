import { describe, it, expect } from 'vitest'
import { crapScore, functionCoverage, rawFunctionCoverage, roundTo } from '../src/score'
import type { IstanbulFileCoverage, IstanbulLocation } from '../src/types'

const loc = (
  sl: number,
  sc: number | null,
  el: number,
  ec: number | null,
): IstanbulLocation => ({
  start: { line: sl, column: sc },
  end: { line: el, column: ec },
})

const makeFile = (overrides: Partial<IstanbulFileCoverage> = {}): IstanbulFileCoverage => ({
  path: 'src/example.ts',
  statementMap: {
    '0': loc(11, 2, 11, 10),
    '1': loc(12, 2, 12, 10),
    '2': loc(13, 2, 13, 10),
    '3': loc(14, 2, 14, 10),
    '4': loc(25, 2, 25, 10),
  },
  s: { '0': 1, '1': 1, '2': 1, '3': 0, '4': 0 },
  fnMap: { '0': { name: 'fn', loc: loc(10, 0, 20, 1) } },
  f: { '0': 3 },
  branchMap: {
    '0': { locations: [loc(15, 4, 15, 20), loc(16, 4, 16, 20)] },
  },
  b: { '0': [1, 0] },
  ...overrides,
})

const noBranches = { branchMap: {}, b: {} }

describe('crapScore', () => {
  it.each([
    [8, 0, 72],
    [4, 0, 20],
    [12, 0.75, 14.25],
    [5, 2 / 3, 5.926],
    [5, 1, 5],
    [1, 1, 1],
  ])('cc %d, cov %d -> %d', (cc, cov, expected) => {
    expect(crapScore(cc, cov)).toBe(expected)
  })
})

describe('functionCoverage', () => {
  it('takes the min of statement and branch coverage', () => {
    expect(functionCoverage(makeFile(), '0')).toEqual({ cov: 0.5, covKind: 'min(stmt,branch)' })
  })

  it('uses statement coverage alone when the span has no branches', () => {
    expect(functionCoverage(makeFile(noBranches), '0')).toEqual({ cov: 0.75, covKind: 'stmt' })
  })

  it('uses branch coverage alone when the span has no statements', () => {
    const file = makeFile({ statementMap: {}, s: {} })
    expect(functionCoverage(file, '0')).toEqual({ cov: 0.5, covKind: 'branch' })
  })

  it('ignores a branch location with a null start line', () => {
    const file = makeFile({
      branchMap: { '0': { locations: [loc(15, 4, 15, 20), { start: { line: null as unknown as number, column: null }, end: { line: 0, column: 0 } }] } },
      b: { '0': [1, 0] },
    })
    // Only the first location counts (1 of 1 covered); had the null one counted it would be 1 of 2.
    expect(functionCoverage(file, '0')).toEqual({ cov: 0.75, covKind: 'min(stmt,branch)' })
  })

  it('ignores a branch location with no start', () => {
    const file = makeFile({
      branchMap: { '0': { locations: [loc(15, 4, 15, 20), {} as IstanbulLocation] } },
      b: { '0': [0, 0] },
    })
    expect(functionCoverage(file, '0')).toEqual({ cov: 0, covKind: 'min(stmt,branch)' })
  })

  it('counts a branch counter beyond the counts array as uncovered', () => {
    const file = makeFile({ b: { '0': [1] } })
    expect(functionCoverage(file, '0')).toEqual({ cov: 0.5, covKind: 'min(stmt,branch)' })
  })

  it('reports called when the span has no statements or branches', () => {
    const base = { statementMap: {}, s: {}, ...noBranches }
    expect(functionCoverage(makeFile({ ...base, f: { '0': 3 } }), '0')).toEqual({ cov: 1, covKind: 'called' })
    expect(functionCoverage(makeFile({ ...base, f: { '0': 0 } }), '0')).toEqual({ cov: 0, covKind: 'called' })
  })

  it('excludes a statement starting before the span start on the same line', () => {
    const file = makeFile({
      ...noBranches,
      fnMap: { '0': { name: 'fn', loc: loc(10, 4, 20, 1) } },
      statementMap: { '0': loc(10, 2, 10, 8), '1': loc(11, 0, 11, 5) },
      s: { '0': 0, '1': 1 },
    })
    expect(functionCoverage(file, '0').cov).toBe(1)
  })

  it('excludes a statement ending after the span end on the same line', () => {
    const file = makeFile({
      ...noBranches,
      fnMap: { '0': { name: 'fn', loc: loc(10, 0, 20, 5) } },
      statementMap: { '0': loc(20, 0, 20, 5), '1': loc(20, 0, 20, 9) },
      s: { '0': 1, '1': 0 },
    })
    expect(functionCoverage(file, '0').cov).toBe(1)
  })

  it('treats a null statement end column as end of line, so it is outside a bounded span end', () => {
    const file = makeFile({
      ...noBranches,
      statementMap: { '0': loc(20, 0, 20, null), '1': loc(11, 0, 11, 5) },
      s: { '0': 0, '1': 1 },
    })
    expect(functionCoverage(file, '0').cov).toBe(1)
  })

  it('treats a null span start column as 0', () => {
    const file = makeFile({
      ...noBranches,
      fnMap: { '0': { name: 'fn', loc: loc(10, null, 20, 1) } },
      statementMap: { '0': loc(10, 0, 10, 4) },
      s: { '0': 1 },
    })
    expect(functionCoverage(file, '0').cov).toBe(1)
  })

  it('rounds cov to 4 dp', () => {
    const file = makeFile({
      ...noBranches,
      statementMap: { '0': loc(11, 0, 11, 1), '1': loc(12, 0, 12, 1), '2': loc(13, 0, 13, 1) },
      s: { '0': 1, '1': 0, '2': 0 },
    })
    expect(functionCoverage(file, '0').cov).toBe(0.3333)
  })
})

describe('rawFunctionCoverage', () => {
  it('returns the unrounded coverage', () => {
    const file = makeFile({
      ...noBranches,
      statementMap: { '0': loc(11, 0, 11, 1), '1': loc(12, 0, 12, 1), '2': loc(13, 0, 13, 1) },
      s: { '0': 1, '1': 0, '2': 0 },
    })
    expect(rawFunctionCoverage(file, '0')).toEqual({ cov: 1 / 3, covKind: 'stmt' })
  })
})

describe('roundTo (round half to even on the exact double)', () => {
  it('rounds an exact tie down to the even neighbour', () => {
    expect(roundTo(0.125, 2)).toBe(0.12)
    expect(crapScore(2, 0.75)).toBe(2.062)
  })

  it('rounds an exact tie up to the even neighbour', () => {
    expect(roundTo(0.375, 2)).toBe(0.38)
  })

  it('rounds a non-tie to nearest', () => {
    expect(roundTo(1 / 3, 4)).toBe(0.3333)
  })

  it('rounds a value a hair above a tie up', () => {
    expect(roundTo(0.12500000000000003, 2)).toBe(0.13)
    expect(roundTo(2 / 3, 4)).toBe(0.6667)
  })
})
