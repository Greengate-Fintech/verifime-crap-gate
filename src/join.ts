import type { EslintMessage, FunctionSpan, IstanbulFileCoverage, IstanbulLocation, SourcePoint } from './types'

// Joins the functions ESLint reports (as FunctionSpans, from the lint pass) to Istanbul fnMap
// entries. An entry belongs to the innermost function whose declaration span, from its
// declaration start to its node end, contains the entry's start:
//
// 1. Exact: an entry that starts on one of a function's five known start points (its
//    declaration start, its key, its node start, its reported position, its body start) is
//    paired first, innermost function first, conflicts resolved with augmenting paths in fnMap
//    order. Coverage converters start entries on these points: Vitest 1 to 3 at the head
//    (`export`, `async`, the key, the arrow head), Vitest 4 and 5 at the body.
// 2. Fallback: an entry that starts on no known point goes to the innermost free function whose
//    head (FunctionSpan.declStart to FunctionSpan.headEnd) contains it. The head ends at the
//    body's first token after any opening parentheses, so `(e) => (e as Error).message` reaches
//    an entry at `e`, and at an inner function's start, so it never reaches into that function's
//    parameters. A body is never searched, so a stray entry inside a callback is not given to it.
//
// An entry that neither pass gives to a function is left unowned (unownedEntries): the measure
// lists it as a notice and never scores it.
// A function owns at most one entry. A function left without one is unmatched: it never borrows.
// Only a converter's initialiser entry (`<instance_members_initializer>`, `<static_initializer>`)
// can belong to a class field initialiser or static block, and never to a real function.

const compare = (a: SourcePoint, b: SourcePoint): number => a[0] - b[0] || a[1] - b[1]

const INITIALISER_ENTRY = /^<(instance_members|static)_initializer>$/

/** The one entry v8-to-istanbul writes for a file no test loaded: not a function. */
const PLACEHOLDER_ENTRY = '(empty-report)'

// ---------------------------------------------------------------------------------------
// Merging the coverage of one source file from several coverage files
// ---------------------------------------------------------------------------------------

interface Part<T, C> {
  items: Record<string, T>
  counts: Record<string, C>
}

const locKey = (l: IstanbulLocation): string => `${l.start.line}:${l.start.column}-${l.end.line}:${l.end.column}`

/**
 * Items with the same key merge across parts and their counts add up. Within one part, items
 * with the same key stay apart (the n-th of them merges with the n-th in another part).
 */
const mergeParts = <T, C>(parts: Part<T, C>[], keyOf: (item: T) => string, add: (a: C | undefined, b: C | undefined) => C): Part<T, C> => {
  const merged: Part<T, C> = { items: {}, counts: {} }
  const ids = new Map<string, string>()
  for (const part of parts) {
    const seen = new Map<string, number>()
    for (const [id, item] of Object.entries(part.items)) {
      const nth = seen.get(keyOf(item)) ?? 0
      seen.set(keyOf(item), nth + 1)
      const key = `${keyOf(item)}#${nth}`
      const into = ids.get(key) ?? String(ids.size)
      if (!ids.has(key)) {
        ids.set(key, into)
        merged.items[into] = item
      }
      merged.counts[into] = add(merged.counts[into], part.counts[id])
    }
  }
  return merged
}

const addHits = (a: number | undefined, b: number | undefined): number => (a ?? 0) + (b ?? 0)

const addBranchHits = (a: number[] | undefined, b: number[] | undefined): number[] => {
  const x = a ?? []
  const y = b ?? []
  return Array.from({ length: Math.max(x.length, y.length) }, (_, i) => (x[i] ?? 0) + (y[i] ?? 0))
}

/**
 * One coverage object for a source file that several coverage files cover (one per package that
 * loads it). Functions and statements with an identical span, and branches with identical
 * locations, merge with their hit counts summed; any with a different span stay separate.
 */
export const mergeCoverage = (files: readonly IstanbulFileCoverage[]): IstanbulFileCoverage | null => {
  if (files.length <= 1) return files[0] ?? null
  const fns = mergeParts(files.map((f) => ({ items: f.fnMap, counts: f.f })), (fn) => locKey(fn.loc), addHits)
  const statements = mergeParts(files.map((f) => ({ items: f.statementMap, counts: f.s })), locKey, addHits)
  const branches = mergeParts(files.map((f) => ({ items: f.branchMap, counts: f.b })), (br) => JSON.stringify(br.locations), addBranchHits)
  return {
    path: files[0].path,
    fnMap: fns.items,
    f: fns.counts,
    statementMap: statements.items,
    s: statements.counts,
    branchMap: branches.items,
    b: branches.counts,
  }
}

// ---------------------------------------------------------------------------------------
// Assigning entries to spans
// ---------------------------------------------------------------------------------------

export interface EntryStart {
  id: string
  name: string
  start: SourcePoint
}

/** Innermost first: the latest node start, then the earliest end; on one range a function before an initialiser. */
const innermostFirst = (a: FunctionSpan, b: FunctionSpan): number =>
  compare(b.start, a.start) || compare(a.end, b.end) || Number(a.origin !== 'function') - Number(b.origin !== 'function')

const accepts = (span: FunctionSpan, entry: EntryStart): boolean =>
  INITIALISER_ENTRY.test(entry.name) === (span.origin !== 'function')

const startsOnAnchor = (span: FunctionSpan, p: SourcePoint): boolean => span.anchors.some((a) => compare(a, p) === 0)

const inHead = (span: FunctionSpan, p: SourcePoint): boolean =>
  compare(span.declStart, p) <= 0 && compare(p, span.headEnd) <= 0

const entryStarts = (file: IstanbulFileCoverage | null): EntryStart[] =>
  Object.entries(file?.fnMap ?? {})
    .filter(([, fn]) => fn.name !== PLACEHOLDER_ENTRY)
    .map(([id, fn]) => ({ id, name: fn.name, start: [fn.loc.start.line, fn.loc.start.column ?? 0] }))

/** Maximum matching of entries to the spans they start exactly on, by augmenting paths. */
const matchExact = (exact: ReadonlyMap<string, number[]>): Map<number, string> => {
  const owner = new Map<number, string>()
  const augment = (id: string, seen: Set<number>): boolean =>
    (exact.get(id) ?? []).some((si) => {
      if (seen.has(si)) return false
      seen.add(si)
      const held = owner.get(si)
      if (held !== undefined && !augment(held, seen)) return false
      owner.set(si, id)
      return true
    })
  for (const id of exact.keys()) augment(id, new Set())
  return owner
}

/** Span index to fnMap id, for every span that owns an entry of `file`. */
export const assignEntries = (spans: readonly FunctionSpan[], file: IstanbulFileCoverage | null): Map<number, string> => {
  const order = spans.map((_, i) => i).sort((x, y) => innermostFirst(spans[x], spans[y]))
  const fitting = (entry: EntryStart, where: (span: FunctionSpan, p: SourcePoint) => boolean): number[] =>
    order.filter((si) => accepts(spans[si], entry) && where(spans[si], entry.start))
  const entries = entryStarts(file)
  const exact = new Map(entries.map((e) => [e.id, fitting(e, startsOnAnchor)] as const).filter(([, hits]) => hits.length > 0))
  const owner = matchExact(exact)
  for (const entry of entries.filter((e) => !exact.has(e.id))) {
    const free = fitting(entry, inHead).find((si) => !owner.has(si))
    if (free !== undefined) owner.set(free, entry.id)
  }
  return owner
}

/**
 * Entries no function owns, in fnMap order. Left out: unloaded-file placeholders, and initialiser
 * entries, which a converter also emits for code ESLint reports no function for (a constructor's
 * parameter properties). What is left is a function entry that started in no function head.
 */
export const unownedEntries = (file: IstanbulFileCoverage | null, owned: ReadonlyMap<number, string>): EntryStart[] => {
  const taken = new Set(owned.values())
  return entryStarts(file).filter((e) => !taken.has(e.id) && !INITIALISER_ENTRY.test(e.name))
}

// ---------------------------------------------------------------------------------------
// Pairing complexity messages with spans
// ---------------------------------------------------------------------------------------

const pairKey = (line: number, column: number, message: string): string => `${line}:${column}:${message}`

/**
 * Pairs each complexity message with the span reported at its position with its text. Spans
 * with the same key pair in report order. Returns null for a message with no span left.
 */
export const spanPairer = (spans: readonly FunctionSpan[]): ((m: EslintMessage) => number | null) => {
  const queues = new Map<string, number[]>()
  spans.forEach((s, i) => {
    const key = pairKey(s.line, s.column, s.message)
    queues.set(key, [...(queues.get(key) ?? []), i])
  })
  return (m) => queues.get(pairKey(m.line, m.column, m.message))?.shift() ?? null
}
