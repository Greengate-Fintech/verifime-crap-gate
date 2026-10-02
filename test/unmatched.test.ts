import { describe, expect, it } from 'vitest'
import {
  findUnmatchedGrowth,
  groupUnmatched,
  parseUnmatchedList,
  planUnmatchedUpdate,
  renderUnmatchedList,
  scoreListedUnmatched,
  splitUnmatched,
} from '../src/unmatched'
import type { UnmatchedFunction } from '../src/types'

const um = (file: string, symbol: string, line = 1, cc = 3, kind = 'Function'): UnmatchedFunction => ({
  file,
  symbol,
  line,
  cc,
  kind,
})

const listOf = (...pairs: [string, string][]) => groupUnmatched(pairs.map(([file, symbol]) => um(file, symbol)))

describe('render and parse of the unmatched list', () => {
  it('round-trips, one row per occurrence, sorted', () => {
    const groups = groupUnmatched([um('src/b.ts', 'f'), um('src/a.ts', 'g'), um('src/a.ts', 'g')])
    const text = renderUnmatchedList(groups)
    const rows = text.split('\n').filter((l) => l !== '' && !l.startsWith('#'))
    expect(rows).toEqual(['src/a.ts\tg', 'src/a.ts\tg', 'src/b.ts\tf'])
    expect(parseUnmatchedList(text)).toEqual(groups)
  })

  it('renders a header and no rows for an empty list, and parses it back to empty', () => {
    const text = renderUnmatchedList(new Map())
    expect(text.startsWith('#')).toBe(true)
    expect(parseUnmatchedList(text).size).toBe(0)
  })

  it.each(['src/a.ts', 'src/a.ts\tf\textra', '\tf', 'src/a.ts\t '])('rejects the malformed row %j', (row) => {
    expect(() => parseUnmatchedList(`${row}\n`)).toThrow(/Malformed unmatched list line 1/)
  })

  it('refuses a file or symbol containing a tab or line break', () => {
    expect(() => groupUnmatched([um('src/a.ts', 'bad\tname')])).toThrow(/tab or line break/)
  })
})

describe('splitUnmatched', () => {
  it('lists the occurrences that the list covers and fails the rest', () => {
    const found = [um('src/a.ts', 'f', 10), um('src/a.ts', 'f', 20), um('src/b.ts', 'g', 5)]
    const { listed, failing, stale } = splitUnmatched(found, listOf(['src/a.ts', 'f']))
    expect(listed.map((u) => u.line)).toEqual([10])
    expect(failing.map((u) => `${u.file}:${u.line}`)).toEqual(['src/a.ts:20', 'src/b.ts:5'])
    expect(stale).toEqual([])
  })

  it('reports a listed entry with no unmatched occurrence as stale, once per surplus row', () => {
    const found = [um('src/a.ts', 'f')]
    const list = groupUnmatched([um('src/a.ts', 'f'), um('src/a.ts', 'f'), um('src/gone.ts', 'h')])
    const { listed, failing, stale } = splitUnmatched(found, list)
    expect(listed).toHaveLength(1)
    expect(failing).toEqual([])
    expect(stale).toEqual([
      { file: 'src/a.ts', symbol: 'f' },
      { file: 'src/gone.ts', symbol: 'h' },
    ])
  })

  it('fails everything against an empty list', () => {
    const { listed, failing } = splitUnmatched([um('src/a.ts', 'f')], new Map())
    expect(listed).toEqual([])
    expect(failing).toHaveLength(1)
  })
})

describe('scoreListedUnmatched', () => {
  it('scores at coverage 0 with the unmatched coverage kind', () => {
    expect(scoreListedUnmatched(um('src/a.ts', 'f', 152, 5, 'Function'))).toEqual({
      file: 'src/a.ts',
      symbol: 'f',
      kind: 'Function',
      line: 152,
      cc: 5,
      cov: 0,
      covKind: 'unmatched',
      crap: 30,
    })
  })

  it.each([
    [2, 6],
    [4, 20],
  ])('scores cc %i as %i', (cc, crap) => {
    expect(scoreListedUnmatched(um('src/a.ts', 'f', 1, cc)).crap).toBe(crap)
  })
})

describe('planUnmatchedUpdate', () => {
  const one = listOf(['src/a.ts', 'f'])

  it('freezes every current entry when there is no existing list', () => {
    const plan = planUnmatchedUpdate(null, one, false)
    expect(plan.refused).toEqual([])
    expect(plan.list).toEqual(one)
  })

  it('keeps an unchanged list', () => {
    expect(planUnmatchedUpdate(one, one, false)).toEqual({ list: one, refused: [] })
  })

  it('drops an entry that no longer occurs', () => {
    const existing = listOf(['src/a.ts', 'f'], ['src/b.ts', 'g'])
    expect(planUnmatchedUpdate(existing, one, false).list).toEqual(one)
  })

  it('refuses growth, naming it, and keeps the existing entries', () => {
    const current = listOf(['src/a.ts', 'f'], ['src/c.ts', 'new'])
    const plan = planUnmatchedUpdate(one, current, false)
    expect(plan.refused).toEqual([{ file: 'src/c.ts', symbol: 'new' }])
    expect(plan.list).toEqual(one)
  })

  it('takes growth with allowGrowth', () => {
    const current = listOf(['src/a.ts', 'f'], ['src/c.ts', 'new'])
    const plan = planUnmatchedUpdate(one, current, true)
    expect(plan.refused).toEqual([])
    expect(plan.list).toEqual(current)
  })

  it('treats a second occurrence of a listed symbol as growth', () => {
    const current = groupUnmatched([um('src/a.ts', 'f'), um('src/a.ts', 'f')])
    expect(planUnmatchedUpdate(one, current, false).refused).toEqual([{ file: 'src/a.ts', symbol: 'f' }])
  })
})

describe('findUnmatchedGrowth', () => {
  const base = listOf(['src/a.ts', 'f'])

  it('finds no growth when the head is the same, smaller or empty', () => {
    expect(findUnmatchedGrowth(base, base)).toEqual([])
    expect(findUnmatchedGrowth(base, new Map())).toEqual([])
  })

  it('names each added row', () => {
    const head = groupUnmatched([um('src/a.ts', 'f'), um('src/a.ts', 'f'), um('src/z.ts', 'k')])
    expect(findUnmatchedGrowth(base, head)).toEqual([
      { file: 'src/a.ts', symbol: 'f' },
      { file: 'src/z.ts', symbol: 'k' },
    ])
  })
})
