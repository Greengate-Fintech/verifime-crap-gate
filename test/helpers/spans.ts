import type { EslintFileResult, EslintMessage, FunctionSpan } from '../../src/types'

// Hand-written ESLint results carry no spans, and the measure fails closed without them. For
// tests of everything but the join itself (paths, scope, naming, scoring, the CLI), each
// complexity message gets a span with one start point, at the message's own position: an entry
// starting exactly there joins, any other does not. The join is tested on real spans from the
// lint pass (test/join.test.ts, test/join-versions.test.ts).

const isComplexity = (m: EslintMessage): boolean => m.ruleId === 'complexity' && !m.fatal

export const pointSpan = (m: Pick<EslintMessage, 'line' | 'column' | 'message'>): FunctionSpan => {
  const at = [m.line, m.column - 1] as const
  return { line: m.line, column: m.column, message: m.message, origin: 'function', start: at, end: at, declStart: at, bodyStart: null, anchors: [at] }
}

/** The results, each with a point span for every complexity message, unless it already has spans. */
export const withPointSpans = <T extends EslintFileResult>(results: readonly T[]): T[] =>
  results.map((r) => ({ ...r, spans: r.spans ?? r.messages.filter(isComplexity).map(pointSpan) }))

/** The same, for an ESLint JSON report held as text. */
export const withPointSpansText = (text: string): string =>
  JSON.stringify(withPointSpans(JSON.parse(text) as EslintFileResult[]), null, 2)
