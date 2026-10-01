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

export interface Measurement {
  functions: FunctionScore[]
  unmatched: UnmatchedFunction[]
  problems: MeasureProblem[]
}

export interface EslintMessage {
  ruleId: string | null
  message: string
  line: number
  column: number
  fatal?: boolean
  severity?: number
}

export interface EslintFileResult {
  filePath: string
  messages: EslintMessage[]
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
