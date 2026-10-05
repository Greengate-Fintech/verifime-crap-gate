import path from 'path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../src/config'
import { lintScope } from '../src/eslint'
import { assignEntries, mergeCoverage, unownedEntries } from '../src/join'
import { measure } from '../src/measure'
import type { FunctionSpan, IstanbulFileCoverage } from '../src/types'
import { tempRoot, writeFileIn } from './helpers/sandbox'

// The coverage join on real ESLint output and hand-placed fnMap entries. Entries sit where each
// converter puts them: Vitest 1 to 3 (v8-to-istanbul) start an entry at the function head
// (`export`, `async`, the method key or the arrow head), have no entry for anonymous callbacks,
// and one `<instance_members_initializer>` entry for all instance fields; Vitest 4 and 5
// (ast-v8-to-istanbul) start an entry at the function body and have none for class field
// initialisers or static blocks.

type At = readonly [number, number]

interface Entry {
  name: string
  start: At
  end: At
  f: number
  /** Statements inside the function, each with its hit count. */
  statements?: { at: At; s: number }[]
}

/** The 0-based column of `needle` on a 1-based line, or of the character after it. */
const at = (src: string, line: number, needle: string, after = false): At => {
  const text = src.split('\n')[line - 1]
  const column = text.indexOf(needle)
  if (column < 0) throw new Error(`${needle} is not on line ${line}`)
  return [line, after ? column + needle.length : column]
}

const loc = (start: At, end: At) => ({ start: { line: start[0], column: start[1] }, end: { line: end[0], column: end[1] } })

const coverageOf = (key: string, entries: Entry[]): IstanbulFileCoverage => {
  const file: IstanbulFileCoverage = { path: key, statementMap: {}, s: {}, fnMap: {}, f: {}, branchMap: {}, b: {} }
  let statement = 0
  entries.forEach((e, i) => {
    file.fnMap[String(i)] = { name: e.name, decl: loc(e.start, e.end), loc: loc(e.start, e.end) }
    file.f[String(i)] = e.f
    for (const st of e.statements ?? []) {
      file.statementMap[String(statement)] = loc(st.at, [st.at[0], st.at[1] + 1])
      file.s[String(statement)] = st.s
      statement += 1
    }
  })
  return file
}

/**
 * Lints `src` as src/sample.ts and measures it against one coverage file per entry list. The
 * first list is keyed by the real path; later ones by foreign paths that join on the `src` anchor,
 * as a second package's coverage file would.
 */
const run = async (src: string, ...perFile: Entry[][]) => {
  const root = tempRoot('crap-join')
  writeFileIn(root, 'src/sample.ts', src)
  const abs = path.join(root, 'src/sample.ts')
  const keys = [abs, ...perFile.slice(1).map((_, i) => `/elsewhere/checkout-${i}/src/sample.ts`)]
  const coverage = Object.fromEntries(perFile.map((entries, i) => [keys[i], coverageOf(keys[i], entries)]))
  const m = measure(await lintScope(root, DEFAULT_CONFIG), coverage, root, undefined, DEFAULT_CONFIG)
  return {
    problems: m.problems,
    /** Each joined function as `line kind cov`, in report order. */
    joined: m.functions.map((f) => `${f.line} ${f.kind} ${f.cov}`),
    /** Each function with no entry as `line kind`, in report order. */
    unmatched: m.unmatched.map((u) => `${u.line} ${u.kind}`),
    /** Each entry no function took, as `line:column name` (1-based). */
    unjoined: (m.unjoined ?? []).map((e) => `${e.line}:${e.column} ${e.name}`),
  }
}

describe('join: the four reproductions of #13', () => {
  it('1. a function with no entry does not take the next function entry (Vitest 1 to 3)', async () => {
    const src = [
      'export function regionCodes(items: Item[]): Item[] {',
      "  return items.filter((i) => i.kind === 'region')",
      '}',
      '',
      'export function mapRegion(r: Item | null): string {',
      "  if (!r) return ''",
      '  return r.kind',
      '}',
      'type Item = { kind: string }',
      '',
    ].join('\n')
    // The filter callback is anonymous: v8-to-istanbul gives it no entry.
    const out = await run(src, [
      { name: 'regionCodes', start: [1, 0], end: [3, 1], f: 1, statements: [{ at: [2, 2], s: 1 }] },
      { name: 'mapRegion', start: [5, 0], end: [8, 1], f: 15, statements: [{ at: [6, 2], s: 15 }, { at: [7, 2], s: 15 }] },
    ])
    expect(out.problems).toEqual([])
    expect(out.joined).toEqual(['1 Function 1', '5 Function 1'])
    expect(out.unmatched).toEqual(['2 Arrow function'])
  })

  it('2. a signature longer than eight lines still joins (Vitest 4 and 5, entry at the body)', async () => {
    const props = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet']
    const src = [
      'type Props = Record<string, number>',
      'export function sideNav({',
      ...props.map((p) => `  ${p},`),
      '}: Props): number {',
      '  return alpha + juliet',
      '}',
      '',
    ].join('\n')
    const body = 3 + props.length
    const out = await run(src, [
      { name: 'sideNav', start: at(src, body, '{'), end: [body + 2, 1], f: 1, statements: [{ at: [body + 1, 2], s: 1 }] },
    ])
    expect(out.problems).toEqual([])
    expect(out.joined).toEqual(['2 Function 1'])
    expect(out.unmatched).toEqual([])
  })

  it('3. a class field initialiser does not shift later members (Vitest 4 and 5)', async () => {
    const src = [
      'export class Machine {',
      "  private current = 'IDLE'",
      '  constructor() {',
      "    this.current = 'READY'",
      '  }',
      '  get state(): string {',
      '    return this.current',
      '  }',
      '  transition(next: string): void {',
      '    this.current = next',
      '  }',
      '}',
      '',
    ].join('\n')
    const out = await run(src, [
      { name: 'constructor', start: at(src, 3, '{'), end: [5, 3], f: 1, statements: [{ at: [4, 4], s: 1 }] },
      { name: 'state', start: at(src, 6, '{'), end: [8, 3], f: 1, statements: [{ at: [7, 4], s: 1 }] },
      { name: 'transition', start: at(src, 9, '{'), end: [11, 3], f: 0, statements: [{ at: [10, 4], s: 0 }] },
    ])
    expect(out.problems).toEqual([])
    expect(out.joined).toEqual(['3 Constructor 1', '6 Getter 1', '9 Method 0'])
    expect(out.unmatched).toEqual(['2 Class field initializer'])
  })

  it('4. a source file in two coverage files: same-span entries merge, and no copy is left to take', async () => {
    const src = [
      'export function first(a: number): number {',
      '  return [a].map((x) => x + 1)[0]',
      '}',
      'export function second(b: number): number {',
      '  return b * 2',
      '}',
      '',
    ].join('\n')
    // Vitest 1 to 3: the map callback has no entry. One package ran `second`, the other `first`.
    const out = await run(
      src,
      [
        { name: 'first', start: [1, 0], end: [3, 1], f: 0, statements: [{ at: [2, 2], s: 0 }] },
        { name: 'second', start: [4, 0], end: [6, 1], f: 1, statements: [{ at: [5, 2], s: 1 }] },
      ],
      [
        { name: 'first', start: [1, 0], end: [3, 1], f: 1, statements: [{ at: [2, 2], s: 1 }] },
        { name: 'second', start: [4, 0], end: [6, 1], f: 0, statements: [{ at: [5, 2], s: 0 }] },
      ],
    )
    expect(out.problems).toEqual([])
    expect(out.joined).toEqual(['1 Function 1', '4 Function 1'])
    expect(out.unmatched).toEqual(['2 Arrow function'])
  })
})

describe('join: the prototype review cases', () => {
  const panel = ['export class Panel {', '  onOpen = (n: number): number => n + 1', "  label = 'panel'", '}', ''].join('\n')
  // Vitest 1 to 3: the arrow's own entry starts at its head; the one initialiser entry for all
  // instance fields starts at the first field.
  const arrow: Entry = { name: 'onOpen', start: at(panel, 2, '(n'), end: [2, 39], f: 0 }
  const fields: Entry = { name: '<instance_members_initializer>', start: [2, 2], end: [3, 17], f: 1 }

  it.each([
    ['arrow entry first', [arrow, fields]],
    ['initialiser entry first', [fields, arrow]],
  ])('an arrow-valued first field keeps its own entry, whatever the entry order (%s)', async (_order, entries) => {
    const out = await run(panel, entries)
    expect(out.problems).toEqual([])
    expect(out.joined).toEqual(['2 Method 0', '2 Class field initializer 1'])
    expect(out.unmatched).toEqual(['3 Class field initializer'])
  })

  it('an arrow-valued field with no entry of its own never takes the initialiser entry', async () => {
    const out = await run(panel, [fields])
    expect(out.problems).toEqual([])
    expect(out.joined).toEqual(['2 Class field initializer 1'])
    expect(out.unmatched).toEqual(['2 Method', '3 Class field initializer'])
  })

  it('a stray entry inside a callback body is not given to the callback', async () => {
    const src = [
      'export function bump(xs: number[]): number[] {',
      '  return xs.map((x) => {',
      '    return x + 1',
      '  })',
      '}',
      '',
    ].join('\n')
    // Vitest 1 to 3: no entry for the anonymous callback; one entry that starts at no function head.
    const out = await run(src, [
      { name: 'bump', start: [1, 0], end: [5, 1], f: 1, statements: [{ at: [2, 2], s: 1 }] },
      { name: '(anonymous_1)', start: at(src, 3, 'return'), end: [3, 16], f: 7 },
    ])
    expect(out.problems).toEqual([])
    expect(out.joined).toEqual(['1 Function 1'])
    expect(out.unmatched).toEqual(['2 Arrow function'])
    // The stray entry is reported, never scored.
    expect(out.unjoined).toEqual(['3:5 (anonymous_1)'])
  })
})

// Regression guards for the start conventions, added with the implementation (not part of the red run).
describe('join: where each converter starts an entry', () => {
  it.each([
    ['export async function, Vitest 1 to 3 (at `export`)', 'export async function load(id: string): Promise<string> {\n  return id\n}\n', [1, 0] as At],
    ['export async function, Vitest 4 and 5 (at the body)', 'export async function load(id: string): Promise<string> {\n  return id\n}\n', [1, 56] as At],
    ['export default function (at `export`)', 'export default function main(): number {\n  return 1\n}\n', [1, 0] as At],
    ['async function, not exported (at `async`)', 'async function work(): Promise<number> {\n  return 1\n}\nexport const use = work\n', [1, 0] as At],
  ])('%s', async (_name, src, start) => {
    const out = await run(src, [{ name: 'f', start, end: [3, 1], f: 1 }])
    expect(out.problems).toEqual([])
    expect(out.joined).toEqual([`1 ${src.startsWith('export default') ? 'Function' : 'Async function'} 1`])
    expect(out.unmatched).toEqual([])
  })

  it('methods: a constructor at its key, a private async method at `private`', async () => {
    const src = [
      'export class Store {',
      '  constructor(public size: number) {',
      '    this.size = size',
      '  }',
      '  private async load(key: string): Promise<string> {',
      '    return key',
      '  }',
      '}',
      '',
    ].join('\n')
    const out = await run(src, [
      { name: 'Store', start: at(src, 2, 'constructor'), end: [4, 3], f: 1 },
      { name: 'load', start: at(src, 5, 'private'), end: [7, 3], f: 0 },
    ])
    expect(out.problems).toEqual([])
    expect(out.joined).toEqual(['2 Constructor 1', '5 Async method 0'])
  })

  it('an arrow assigned to a const keeps its entry at its head, inside the enclosing arrow', async () => {
    const src = [
      'export const outer = (xs: string[]) => {',
      '  const validate = (',
      '    value: string,',
      '  ): boolean => {',
      '    return value.length > 0',
      '  }',
      '  return xs.every(validate)',
      '}',
      '',
    ].join('\n')
    const out = await run(src, [
      { name: 'outer', start: at(src, 1, '('), end: [8, 1], f: 1 },
      { name: 'validate', start: at(src, 2, '('), end: [6, 3], f: 0 },
    ])
    expect(out.joined).toEqual(['1 Arrow function 1', '4 Arrow function 0'])
    expect(out.unmatched).toEqual([])
  })

  const curried = 'export const add = (a: number) => (b: number) => a + b\n'

  it.each([
    ['Vitest 1 to 3: each entry at its own arrow head', [at(curried, 1, '(a'), at(curried, 1, '(b')]],
    ['Vitest 4 and 5: the outer entry at its body, which is the inner arrow', [at(curried, 1, '(b'), at(curried, 1, 'a + b')]],
    ['Vitest 4 and 5, inner entry first', [at(curried, 1, 'a + b'), at(curried, 1, '(b')], true],
  ])('curried arrows sharing an end (%s)', async (_name, [first, second], reversed = false) => {
    const entries: Entry[] = [
      { name: 'e0', start: first, end: [1, 54], f: reversed ? 0 : 1 },
      { name: 'e1', start: second, end: [1, 54], f: reversed ? 1 : 0 },
    ]
    const out = await run(curried, entries)
    expect(out.problems).toEqual([])
    // The outer arrow is reported at its `=>` (column 32), the inner one at column 47.
    expect(out.joined).toEqual(['1 Arrow function 1', '1 Arrow function 0'])
  })

  it('an expression body that opens with a parenthesis: Vitest 4 and 5 start the entry inside it', async () => {
    const src = "export const isMissing = (e: unknown): boolean => (e as Error).message === 'gone'\n"
    const out = await run(src, [{ name: '(anonymous_0)', start: at(src, 1, 'e as'), end: [1, 81], f: 1 }])
    expect(out.problems).toEqual([])
    expect(out.joined).toEqual(['1 Arrow function 1'])
  })

  it('an entry inside the parameters (a converter mapping artefact) still goes to its function', async () => {
    const out = await run(curried, [
      { name: 'e0', start: at(curried, 1, 'a:'), end: [1, 54], f: 1 },
      { name: 'e1', start: at(curried, 1, 'a + b'), end: [1, 54], f: 0 },
    ])
    expect(out.joined).toEqual(['1 Arrow function 1', '1 Arrow function 0'])
  })
})

describe('mergeCoverage', () => {
  const file = (over: Partial<IstanbulFileCoverage>): IstanbulFileCoverage => ({
    path: 'src/a.ts', statementMap: {}, s: {}, fnMap: {}, f: {}, branchMap: {}, b: {}, ...over,
  })
  const fn = (name: string, start: At, end: At) => ({ name, decl: loc(start, end), loc: loc(start, end) })

  it('returns the only coverage object as it is, and null for none', () => {
    const only = file({})
    expect(mergeCoverage([only])).toBe(only)
    expect(mergeCoverage([])).toBeNull()
  })

  it('sums functions and statements with an identical span and keeps different spans apart', () => {
    const a = file({
      fnMap: { '0': fn('f', [1, 0], [3, 1]), '1': fn('g', [5, 0], [7, 1]) },
      f: { '0': 1, '1': 0 },
      statementMap: { '0': loc([2, 2], [2, 9]) },
      s: { '0': 1 },
    })
    const b = file({
      fnMap: { '0': fn('f', [1, 0], [3, 1]), '1': fn('g', [5, 0], [8, 1]) },
      f: { '0': 2, '1': 4 },
      statementMap: { '0': loc([2, 2], [2, 9]), '1': loc([6, 2], [6, 9]) },
      s: { '0': 0, '1': 3 },
    })
    const merged = mergeCoverage([a, b])
    expect(Object.values(merged?.fnMap ?? {}).map((x) => `${x.name} ${x.loc.end.line}`)).toEqual(['f 3', 'g 7', 'g 8'])
    expect(merged?.f).toEqual({ '0': 3, '1': 0, '2': 4 })
    expect(merged?.s).toEqual({ '0': 1, '1': 3 })
  })

  it('keeps two identical spans within one coverage object apart, each merging with its counterpart', () => {
    const twice = (f0: number, f1: number) =>
      file({ fnMap: { '0': fn('a', [1, 0], [1, 9]), '1': fn('b', [1, 0], [1, 9]) }, f: { '0': f0, '1': f1 } })
    expect(mergeCoverage([twice(1, 0), twice(0, 2)])?.f).toEqual({ '0': 1, '1': 2 })
  })

  it('sums branch counts by location, location by location', () => {
    const branch = { locations: [loc([2, 2], [2, 9]), loc([3, 2], [3, 9])] }
    const a = file({ branchMap: { '0': branch }, b: { '0': [1, 0] } })
    const b = file({ branchMap: { '0': branch }, b: { '0': [0, 5, 2] } })
    expect(mergeCoverage([a, b])?.b).toEqual({ '0': [1, 5, 2] })
  })
})

describe('assignEntries', () => {
  const span = (over: Partial<FunctionSpan>): FunctionSpan => ({
    line: 1, column: 1, message: 'm', origin: 'function', start: [1, 0], end: [3, 1], declStart: [1, 0], headEnd: [1, 20], anchors: [[1, 0]], ...over,
  })
  const coverage = (...fns: { name: string; start: { line: number; column: number | null } }[]): IstanbulFileCoverage => ({
    path: 'src/a.ts', statementMap: {}, s: {}, branchMap: {}, b: {},
    fnMap: Object.fromEntries(fns.map((f, i) => [String(i), { name: f.name, loc: { start: f.start, end: { line: 3, column: null } } }])),
    f: Object.fromEntries(fns.map((_, i) => [String(i), 1])),
  })

  it('never gives a placeholder entry for an unloaded file to a function', () => {
    expect(assignEntries([span({})], coverage({ name: '(empty-report)', start: { line: 1, column: 0 } }))).toEqual(new Map())
  })

  it('reads a start with no column as column 0', () => {
    expect(assignEntries([span({})], coverage({ name: 'f', start: { line: 1, column: null } }))).toEqual(new Map([[0, '0']]))
  })

  it('gives an initialiser entry only to an initialiser, and a function entry only to a function', () => {
    const spans = [span({}), span({ origin: 'static-block' })]
    const entries = coverage({ name: '<static_initializer>', start: { line: 1, column: 0 } }, { name: 'f', start: { line: 1, column: 0 } })
    expect(assignEntries(spans, entries)).toEqual(new Map([[1, '0'], [0, '1']]))
  })

  it('assigns nothing without coverage', () => {
    expect(assignEntries([span({})], null)).toEqual(new Map())
  })
})

describe('join: curried chains and other shapes (fix round 1)', () => {
  const tri = 'export const tri = (a: number) => (b: number) => (c: number) => (a > b ? c : a)\n'

  // Real Vitest 4.1 and 5.0 output: an arrow whose body is an arrow starts its entry at its first
  // parameter, one token after the `(` that opens the inner arrow's own parameters.
  it('three curried arrows with typed parameters each keep their own entry (Vitest 4 and 5)', async () => {
    const out = await run(tri, [
      { name: '(anonymous_0)', start: at(tri, 1, 'a:'), end: [1, 80], f: 1 },
      { name: '(anonymous_1)', start: at(tri, 1, 'b:'), end: [1, 80], f: 2 },
      { name: '(anonymous_2)', start: at(tri, 1, 'a >'), end: [1, 79], f: 0 },
    ])
    expect(out.problems).toEqual([])
    expect(out.joined).toEqual(['1 Arrow function 1', '1 Arrow function 1', '1 Arrow function 0'])
    expect(out.unmatched).toEqual([])
  })

  it('a typed middleware chain keeps one entry per arrow (Vitest 4 and 5)', async () => {
    const src = [
      'type Action = { type: string }',
      'export const logger =',
      '  (log: string[]) =>',
      '  (next: (action: Action) => Action) =>',
      '  (action: Action): Action => {',
      '    log.push(action.type)',
      '    return next(action)',
      '  }',
      '',
    ].join('\n')
    const out = await run(src, [
      { name: '(anonymous_0)', start: at(src, 3, 'log'), end: [8, 3], f: 1 },
      { name: '(anonymous_1)', start: at(src, 4, 'next'), end: [8, 3], f: 1 },
      { name: '(anonymous_2)', start: at(src, 5, '{'), end: [8, 3], f: 0 },
    ])
    expect(out.problems).toEqual([])
    expect(out.joined).toEqual(['3 Arrow function 1', '4 Arrow function 1', '5 Arrow function 0'])
    expect(out.unmatched).toEqual([])
  })

  it('an empty static block has no entry and does not shift the next member (Vitest 4 and 5)', async () => {
    const src = ['export class Boot {', '  static {}', '  start(): number {', '    return 1', '  }', '}', ''].join('\n')
    const out = await run(src, [{ name: 'start', start: at(src, 3, '{'), end: [5, 3], f: 1 }])
    expect(out.problems).toEqual([])
    expect(out.joined).toEqual(['3 Method 1'])
    expect(out.unmatched).toEqual(['2 Class static block'])
  })

  it('overload signatures report nothing and the implementation keeps its entry (Vitest 1 to 3)', async () => {
    const src = [
      'export function parse(input: string): number',
      'export function parse(input: number): string',
      'export function parse(input: string | number): number | string {',
      "  return typeof input === 'string' ? Number(input) : String(input)",
      '}',
      '',
    ].join('\n')
    const out = await run(src, [{ name: 'parse', start: [3, 0], end: [5, 1], f: 1 }])
    expect(out.problems).toEqual([])
    expect(out.joined).toEqual(['3 Function 1'])
    expect(out.unmatched).toEqual([])
  })
})

describe('assignEntries: augmenting paths and unowned entries', () => {
  const at3 = (line: number): FunctionSpan => ({
    line, column: 1, message: `m${line}`, origin: 'function', start: [line, 0], end: [line, 9], declStart: [line, 0], headEnd: [line, 1], anchors: [],
  })
  const fns = (...starts: At[]): IstanbulFileCoverage => ({
    path: 'src/a.ts', statementMap: {}, s: {}, branchMap: {}, b: {},
    fnMap: Object.fromEntries(starts.map((p, i) => [String(i), { name: `e${i}`, loc: loc(p, p) }])),
    f: Object.fromEntries(starts.map((_, i) => [String(i), 1])),
  })

  it('moves earlier entries along a chain of two steps so that every entry finds a function', () => {
    // e0 starts on S1 and S2, e1 on S1 and S3, e2 on S2 only (spans in innermost order S1, S2, S3).
    const s1 = { ...at3(3), anchors: [[9, 0], [9, 1]] as At[] }
    const s2 = { ...at3(2), anchors: [[9, 0], [9, 2]] as At[] }
    const s3 = { ...at3(1), anchors: [[9, 1]] as At[] }
    const owned = assignEntries([s1, s2, s3], fns([9, 0], [9, 1], [9, 2]))
    expect(owned).toEqual(new Map([[0, '0'], [2, '1'], [1, '2']]))
  })

  it('lists an entry no function took, but not a placeholder or an initialiser entry', () => {
    const file: IstanbulFileCoverage = {
      ...fns([1, 0], [5, 0], [6, 0], [7, 0]),
      fnMap: {
        '0': { name: 'own', loc: loc([1, 0], [1, 0]) },
        '1': { name: 'stray', loc: loc([5, 0], [5, 0]) },
        '2': { name: '(empty-report)', loc: loc([6, 0], [6, 0]) },
        '3': { name: '<instance_members_initializer>', loc: loc([7, 0], [7, 0]) },
      },
    }
    const spans = [{ ...at3(1), anchors: [[1, 0]] as At[] }]
    expect(unownedEntries(file, assignEntries(spans, file)).map((e) => e.name)).toEqual(['stray'])
  })
})
