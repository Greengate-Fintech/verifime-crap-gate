import { describe, it, expect } from 'vitest'
import {
  evaluateRatchet,
  findGrowth,
  fmt1,
  groupScores,
  parseBaseline,
  planBaselineUpdate,
  renderBaseline,
  type ScoreGroups,
} from '../src/ratchet'
import type { FunctionScore } from '../src/types'

const K = 'src/a.ts\tfoo'
const groups = (entries: Record<string, number[]>): ScoreGroups =>
  new Map(Object.entries(entries).map(([k, v]) => [k, [...v].sort((a, b) => a - b)]))
const kinds = (v: { kind: string }[]) => v.map((x) => x.kind)

const fn = (file: string, symbol: string, crap: number): FunctionScore => ({
  file,
  symbol,
  kind: 'function',
  line: 1,
  cc: 1,
  cov: 1,
  covKind: 'stmt',
  crap,
})

describe('groupScores', () => {
  it('groups every score per file and symbol, ascending, including low scores', () => {
    const g = groupScores([fn('a.ts', 'f', 9), fn('a.ts', 'f', 2), fn('b.ts', 'map callback', 7)])
    expect(g.get('a.ts\tf')).toEqual([2, 9])
    expect(g.get('b.ts\tmap callback')).toEqual([7])
  })
  it('gives equal groups whatever order the functions arrive in', () => {
    const fns = [fn('a.ts', 'f', 9), fn('a.ts', 'f', 2), fn('a.ts', 'f', 30), fn('b.ts', 'g', 7)]
    expect(groupScores([...fns].reverse())).toEqual(groupScores(fns))
  })
  it.each([
    ['a\tb.ts', 'f'],
    ['a.ts', 'f\tg'],
    ['a.ts', 'f\ng'],
    ['a.ts', 'f\rg'],
    ['a\nb.ts', 'f'],
  ])('rejects a tab, CR or LF in file %j or symbol %j', (file, symbol) => {
    expect(() => groupScores([fn(file, symbol, 9)])).toThrow(/tab|line break|control/i)
  })
})

describe('fmt1', () => {
  it('formats to one decimal place', () => {
    expect(fmt1(72)).toBe('72.0')
    expect(fmt1(6.25)).toBe('6.3')
  })
})

describe('evaluateRatchet', () => {
  const run = (b: Record<string, number[]>, c: Record<string, number[]>) =>
    evaluateRatchet(groups(b), groups(c))

  it('passes unchanged and improved scores', () => {
    expect(run({ [K]: [72] }, { [K]: [72] })).toEqual([])
    expect(run({ [K]: [72] }, { [K]: [70] })).toEqual([])
  })
  it('applies the tolerance to regressions', () => {
    expect(run({ [K]: [72] }, { [K]: [72.04] })).toEqual([])
    const v = run({ [K]: [72] }, { [K]: [72.06] })
    expect(kinds(v)).toEqual(['regression'])
    expect(v[0].message).toBe('was frozen at 72.0 but now scores 72.1')
  })
  it('carries the numeric scores on new and regression violations', () => {
    const reg = run({ [K]: [72] }, { [K]: [72.06] })[0]
    expect(reg).toMatchObject({ kind: 'regression', current: 72.06, frozen: 72 })
    const added = run({}, { [K]: [9.25] })[0]
    expect(added).toMatchObject({ kind: 'new', current: 9.25 })
    expect(added).not.toHaveProperty('frozen')
    const stale = run({ [K]: [72] }, {})[0]
    expect(stale.kind).toBe('stale')
    expect(stale).not.toHaveProperty('current')
  })
  it('does not flag a regression at exactly frozen + tolerance', () => {
    expect(run({ [K]: [72] }, { [K]: [72.05] })).toEqual([])
  })
  it('flags stale when a paired score falls to the threshold or the entry vanishes', () => {
    expect(kinds(run({ [K]: [72] }, { [K]: [4] }))).toEqual(['stale'])
    expect(kinds(run({ [K]: [72] }, {}))).toEqual(['stale'])
  })
  it('flags new only above the threshold', () => {
    const v = run({}, { [K]: [9] })
    expect(kinds(v)).toEqual(['new'])
    expect(v[0].message).toContain('scores 9.0')
    expect(run({}, { [K]: [8] })).toEqual([])
  })
  it('is insensitive to build order of the multiset', () => {
    expect(evaluateRatchet(new Map([[K, [20, 72]]]), new Map([[K, [72, 20].sort((a, b) => a - b)]]))).toEqual([])
    expect(run({ [K]: [20, 72] }, { [K]: [72, 20] })).toEqual([])
  })
  it('pairs top down, leaving the lowest current unmatched', () => {
    const v = run({ [K]: [20, 72] }, { [K]: [20, 21, 72] })
    expect(kinds(v).sort()).toEqual(['new', 'regression'])
    expect(v.find((x) => x.kind === 'regression')?.message).toBe('was frozen at 20.0 but now scores 21.0')
  })
  it('flags stale when a paired current is exactly the threshold', () => {
    expect(kinds(run({ [K]: [72] }, { [K]: [8] }))).toEqual(['stale'])
  })
  it('passes a new function scoring 7.0, below the threshold', () => {
    expect(run({}, { [K]: [7] })).toEqual([])
  })
  it('flags a new function scoring 8.5, above the threshold, as a new offender', () => {
    const v = run({}, { [K]: [8.5] })
    expect(kinds(v)).toEqual(['new'])
    expect(v[0].message).toBe('scores 8.5, above the threshold of 8, and is not in crap/baseline.tsv')
  })
  it('flags a frozen row still scoring 7.0 as stale', () => {
    expect(kinds(run({ [K]: [7] }, { [K]: [7] }))).toEqual(['stale'])
  })
  it('does not flag a frozen row that improves to 8.5, just above the threshold', () => {
    expect(run({ [K]: [72] }, { [K]: [8.5] })).toEqual([])
  })
  it('flags one stale when there are fewer occurrences now than frozen rows', () => {
    const v = run({ [K]: [10, 72] }, { [K]: [72] })
    expect(kinds(v)).toEqual(['stale'])
    expect(v[0].message).toContain('fewer scored occurrences now than frozen rows')
    expect(v[0].message).toContain('10.0')
  })
  it('flags one new when there are more occurrences now than frozen rows', () => {
    expect(kinds(run({ [K]: [72] }, { [K]: [10, 72] }))).toEqual(['new'])
  })
  it('pairs by rank even when the inputs are not sorted', () => {
    const unsorted = evaluateRatchet(new Map([[K, [72, 20]]]), new Map([[K, [72, 20]]]))
    expect(unsorted).toEqual([])
    expect(kinds(evaluateRatchet(new Map([[K, [72, 20]]]), new Map([[K, [30, 3]]])))).toEqual(['stale'])
  })
  it('uses one message text for new and regression violations', () => {
    expect(run({}, { [K]: [72] })[0].message).toBe(
      'scores 72.0, above the threshold of 8, and is not in crap/baseline.tsv',
    )
    expect(planBaselineUpdate(groups({}), groups({ [K]: [72] }), false).refused[0].message).toBe(
      'scores 72.0, above the threshold of 8, and is not in crap/baseline.tsv',
    )
  })
  it('flags stale for a paired score dropping to the threshold among several', () => {
    expect(kinds(run({ [K]: [20, 72] }, { [K]: [3, 72] }))).toEqual(['stale'])
  })
})

describe('baseline text', () => {
  const canonical = renderBaseline(groups({ 'a.ts\tmap callback': [7.5, 20], 'b.ts\tf': [9] }))
  it('round-trips a canonical file', () => {
    expect(renderBaseline(parseBaseline(canonical))).toBe(canonical)
    expect(canonical.endsWith('\n')).toBe(true)
    expect(canonical).toContain('a.ts\tmap callback\t7.500')
  })
  it('header names the regenerate command and allow-growth', () => {
    expect(canonical).toContain('npm run crap:baseline')
    expect(canonical).toContain('--allow-growth')
  })
  it('sorts rows by file, symbol, score', () => {
    const text = renderBaseline(groups({ 'b.ts\tf': [9], 'a.ts\tz': [8], 'a.ts\ta': [30, 6] }))
    const rows = text.split('\n').filter((l) => l && !l.startsWith('#'))
    expect(rows).toEqual(['a.ts\ta\t6.000', 'a.ts\ta\t30.000', 'a.ts\tz\t8.000', 'b.ts\tf\t9.000'])
  })
  it('skips blank and comment lines', () => {
    expect(parseBaseline('# c\n\na.ts\tf\t9.0\n').get('a.ts\tf')).toEqual([9])
  })
  it('parses an empty file and a header-only file to empty groups', () => {
    expect(parseBaseline('').size).toBe(0)
    expect(parseBaseline(renderBaseline(new Map())).size).toBe(0)
  })
  it('keeps duplicate rows as a multiset', () => {
    expect(parseBaseline('a.ts\tf\t9.000\na.ts\tf\t9.000\n').get('a.ts\tf')).toEqual([9, 9])
  })
  it.each(['0x10', '1e2', '+9', '-9', '9.', '.5', ' 9', '9 ', '9\r', 'NaN'])('rejects the score %j', (score) => {
    expect(() => parseBaseline(`a.ts\tf\t${score}\n`)).toThrow(/line 1/)
  })
  it('header describes the lowest recorded score and points to the README', () => {
    expect(canonical).toContain('the lowest recorded score of every function above the threshold')
    expect(canonical).toContain('README "CRAP gate"')
  })
  it('throws naming the 1-based line number for a malformed line', () => {
    expect(() => parseBaseline('# c\na.ts\tf\t9\nbad\tline\n')).toThrow(/line 3/)
    expect(() => parseBaseline('a.ts\tf\tnope\n')).toThrow(/line 1/)
  })
  it('rejects non-finite scores and empty file or symbol fields, naming the line', () => {
    expect(() => parseBaseline('# c\na.ts\tf\tInfinity\n')).toThrow(/line 2/)
    expect(() => parseBaseline('a.ts\tf\t-Infinity\n')).toThrow(/line 1/)
    expect(() => parseBaseline('\tf\t9\n')).toThrow(/line 1/)
    expect(() => parseBaseline('a.ts\t\t9\n')).toThrow(/line 1/)
  })
})

describe('planBaselineUpdate', () => {
  it('writes every score above the threshold when there is no existing baseline', () => {
    const { baseline, refused } = planBaselineUpdate(null, groups({ a: [3, 72], b: [8] }), false)
    expect(baseline).toEqual(groups({ a: [72] }))
    expect(refused).toEqual([])
  })
  it('tightens on improvement and drops at or below the threshold', () => {
    expect(planBaselineUpdate(groups({ a: [72] }), groups({ a: [30] }), false).baseline).toEqual(groups({ a: [30] }))
    expect(planBaselineUpdate(groups({ a: [72] }), groups({ a: [4] }), false).baseline).toEqual(groups({}))
  })
  it('keeps the frozen score within tolerance', () => {
    expect(planBaselineUpdate(groups({ a: [20] }), groups({ a: [20.04] }), false).baseline).toEqual(groups({ a: [20] }))
  })
  it('drops a paired current of exactly the threshold', () => {
    expect(planBaselineUpdate(groups({ a: [72] }), groups({ a: [8] }), false).baseline).toEqual(groups({}))
  })
  it('keeps a paired current just above the threshold as the tightened score', () => {
    expect(planBaselineUpdate(groups({ a: [72] }), groups({ a: [8.5] }), false).baseline).toEqual(groups({ a: [8.5] }))
  })
  it('keeps frozen at +0.04 and refuses growth at +0.06', () => {
    const within = planBaselineUpdate(groups({ a: [20] }), groups({ a: [20.04] }), false)
    expect(within.baseline).toEqual(groups({ a: [20] }))
    expect(within.refused).toEqual([])
    const beyond = planBaselineUpdate(groups({ a: [20] }), groups({ a: [20.06] }), false)
    expect(kinds(beyond.refused)).toEqual(['regression'])
    expect(beyond.baseline).toEqual(groups({ a: [20] }))
  })
  it('drops unmatched frozen entries', () => {
    expect(planBaselineUpdate(groups({ a: [20] }), groups({}), false).baseline).toEqual(groups({}))
  })
  it('refuses new growth unless allowed', () => {
    const r = planBaselineUpdate(groups({}), groups({ a: [9] }), false)
    expect(r.baseline).toEqual(groups({}))
    expect(kinds(r.refused)).toEqual(['new'])
    expect(planBaselineUpdate(groups({}), groups({ a: [9] }), true).baseline).toEqual(groups({ a: [9] }))
  })
  it('ignores unmatched current at or below the threshold', () => {
    const r = planBaselineUpdate(groups({}), groups({ a: [8] }), false)
    expect(r.baseline).toEqual(groups({}))
    expect(r.refused).toEqual([])
  })
  it('refuses a paired regression, keeping the frozen score, unless allowed', () => {
    const r = planBaselineUpdate(groups({ a: [20] }), groups({ a: [25] }), false)
    expect(r.baseline).toEqual(groups({ a: [20] }))
    expect(kinds(r.refused)).toEqual(['regression'])
    expect(planBaselineUpdate(groups({ a: [20] }), groups({ a: [25] }), true).baseline).toEqual(groups({ a: [25] }))
  })
  it('with allowGrowth takes both a paired regression and an unmatched growth score', () => {
    const r = planBaselineUpdate(groups({ a: [20, 72] }), groups({ a: [20, 21, 72] }), true)
    expect(r.baseline).toEqual(groups({ a: [20, 21, 72] }))
    expect(r.refused).toEqual([])
  })
  it('pairs top down within a key', () => {
    const r = planBaselineUpdate(groups({ a: [20, 72] }), groups({ a: [20, 21, 72] }), false)
    expect(r.baseline).toEqual(groups({ a: [20, 72] }))
    expect(kinds(r.refused).sort()).toEqual(['new', 'regression'])
  })
})

describe('findGrowth', () => {
  it('reports nothing for identical baselines', () => {
    expect(findGrowth(groups({ [K]: [7, 9] }), groups({ [K]: [7, 9] }))).toEqual([])
  })

  it('reports a head row with no base partner, with a null base score', () => {
    const grown = findGrowth(groups({ [K]: [9] }), groups({ [K]: [9], 'src/b.ts\tbar': [6.5] }))
    expect(grown).toEqual([{ file: 'src/b.ts', symbol: 'bar', score: 6.5, base: null }])
  })

  it('reports a surplus same-named row, the lowest, as new', () => {
    const grown = findGrowth(groups({ [K]: [9] }), groups({ [K]: [6, 9] }))
    expect(grown).toEqual([{ file: 'src/a.ts', symbol: 'foo', score: 6, base: null }])
  })

  it('does not report a rise of exactly the tolerance', () => {
    expect(findGrowth(groups({ [K]: [10] }), groups({ [K]: [10.05] }))).toEqual([])
  })

  it('reports a rise beyond the tolerance with both scores', () => {
    const grown = findGrowth(groups({ [K]: [10] }), groups({ [K]: [10.06] }))
    expect(grown).toEqual([{ file: 'src/a.ts', symbol: 'foo', score: 10.06, base: 10 }])
  })

  it('does not report removed rows or lowered scores', () => {
    expect(findGrowth(groups({ [K]: [7, 9], 'src/b.ts\tbar': [8] }), groups({ [K]: [8] }))).toEqual([])
  })

  it('pairs same-named rows top-down so a reorder is not growth', () => {
    expect(findGrowth(groups({ [K]: [6, 12] }), groups({ [K]: [12, 6] }))).toEqual([])
  })

  it('pairs the largest with the largest when a same-named row is removed', () => {
    expect(findGrowth(groups({ [K]: [6, 12] }), groups({ [K]: [12] }))).toEqual([])
  })

  it('compares an empty base against every head row', () => {
    expect(findGrowth(new Map(), groups({ [K]: [7] }))).toHaveLength(1)
  })
})

describe('tolerance on rounded thousandths', () => {
  it('does not treat 10.1 to 10.15 as growth or regression', () => {
    expect(findGrowth(groups({ [K]: [10.1] }), groups({ [K]: [10.15] }))).toEqual([])
    expect(evaluateRatchet(groups({ [K]: [10.1] }), groups({ [K]: [10.15] }))).toEqual([])
  })
  it('treats 10.1 to 10.16 as growth and regression', () => {
    expect(findGrowth(groups({ [K]: [10.1] }), groups({ [K]: [10.16] }))).toHaveLength(1)
    expect(kinds(evaluateRatchet(groups({ [K]: [10.1] }), groups({ [K]: [10.16] })))).toEqual(['regression'])
  })
})

describe('parseBaseline empty input', () => {
  it('gives empty groups for an empty string', () => {
    expect(parseBaseline('').size).toBe(0)
  })
})
