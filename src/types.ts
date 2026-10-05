/** 'unmatched' is a function the coverage provider has no entry for, scored at coverage 0. */
export type CovKind = 'min(stmt,branch)' | 'stmt' | 'branch' | 'called' | 'unmatched'

export interface IstanbulLocation {
  start: { line: number; column: number | null }
  end: { line: number; column: number | null }
}

export interface IstanbulFileCoverage {
  path: string
  statementMap: Record<string, IstanbulLocation>
  s: Record<string, number>
  fnMap: Record<string, { name: string; decl?: IstanbulLocation; loc: IstanbulLocation }>
  f: Record<string, number>
  branchMap: Record<string, { locations: IstanbulLocation[] }>
  b: Record<string, number[]>
}

export interface FunctionScore {
  file: string
  symbol: string
  kind: string
  line: number
  cc: number
  cov: number
  covKind: CovKind
  crap: number
}

export interface UnmatchedFunction {
  file: string
  symbol: string
  line: number
  cc: number
  kind: string
}

/** A known-unmatched list entry with no unmatched occurrence left to cover. */
export interface StaleUnmatched {
  file: string
  symbol: string
}

/** Something that makes the measurement untrustworthy; any entry fails the run. */
export interface MeasureProblem {
  file: string
  /** Absent for a file-level problem. */
  line?: number
  message: string
}

/** A coverage entry the join gave to no function: informational, it never fails a run. */
export interface UnjoinedEntry {
  file: string
  /** The entry's start: 1-based line, 1-based column. */
  line: number
  column: number
  name: string
}

export interface Measurement {
  functions: FunctionScore[]
  unmatched: UnmatchedFunction[]
  problems: MeasureProblem[]
  /** Coverage entries joined to no function. Absent when the measurement did not record them. */
  unjoined?: UnjoinedEntry[]
}

export interface EslintMessage {
  ruleId: string | null
  message: string
  line: number
  column: number
  fatal?: boolean
  severity?: number
}

/** A source position: 1-based line, 0-based column (the Istanbul convention). */
export type SourcePoint = readonly [number, number]

/**
 * What a complexity report is for: a function, or one of the two implicit functions ESLint
 * counts in a class (a field initialiser, a static block).
 */
export type SpanOrigin = 'function' | 'field-initialiser' | 'static-block'

/** One function the `complexity` rule reported, with the positions the coverage join needs. */
export interface FunctionSpan {
  /** The complexity message this span belongs to: its 1-based line and column, and its text. */
  line: number
  column: number
  message: string
  origin: SpanOrigin
  /** The reported node's range. */
  start: SourcePoint
  end: SourcePoint
  /**
   * Start of the declaration the function heads: its `export`, its method, property or field
   * (modifiers and key included), or its variable statement when that declares only this one
   * (the declarator itself when it declares several). Never after `start`.
   */
  declStart: SourcePoint
  /**
   * End of the head (from `declStart`): the body's first token after any parentheses that open
   * it, or the body's start when the body is itself a function. The node end for a field
   * initialiser and an empty static block, which have no body.
   */
  headEnd: SourcePoint
  /**
   * Where a coverage converter can start this function's entry: the declaration start, the key,
   * the node start, the reported position and the body start.
   */
  anchors: readonly SourcePoint[]
}

export interface EslintFileResult {
  filePath: string
  messages: EslintMessage[]
  /** One per complexity message, from the gate's lint pass. Without them every complexity message is a problem. */
  spans?: FunctionSpan[]
}

export interface CrapSummary {
  functions: number
  over5: number
  sumOver5: number
  unmatched: number
}

export interface CrapReport {
  summary: CrapSummary
  /** Every scored function, including the listed unmatched ones (covKind 'unmatched'). */
  functions: FunctionScore[]
  /** Unmatched functions that are NOT on the known list: each one fails the measure. */
  unmatched: UnmatchedFunction[]
  /** Unmatched functions covered by the known list (or accepted), already scored in `functions`. */
  listedUnmatched: UnmatchedFunction[]
  /** Known-list entries that no longer occur as unmatched: each one fails the measure. */
  staleUnmatched: StaleUnmatched[]
  /** True when measure ran with --accept-unmatched: fit only for regenerating the baseline, never for `check`. */
  acceptedUnmatched: boolean
}
