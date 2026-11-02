import { existsSync, readFileSync, statSync } from 'fs'
import path from 'path'
import { XMLParser, XMLValidator } from 'fast-xml-parser'
import type { CrapConfig } from './config'
import { crapScore, roundTo } from './score'
import type { CovKind, FunctionScore, MeasureProblem, Measurement } from './types'

// Scores Java methods from JaCoCo XML reports. JaCoCo lists every method with its complexity and
// its line and branch counters, so no source is parsed. The source files are only looked up, to
// turn a package and a source file name into a repo-relative path.
//
// Fails closed: a report that cannot be read or parsed, a method that lacks a counter the score
// needs, an ambiguous source path and a method reported twice are problems, never skipped.

export interface JavaFileSystem {
  readFile: (absPath: string) => string
  fileExists: (absPath: string) => boolean
}

export interface JavaMeasurement {
  measurement: Measurement
  /** Classes skipped because their source is not a configured extension, root or non-excluded path. */
  outOfScope: number
}

const REAL_FS: JavaFileSystem = {
  readFile: (absPath) => readFileSync(absPath, 'utf8'),
  fileExists: (absPath) => existsSync(absPath) && statSync(absPath).isFile(),
}

// ---------------------------------------------------------------------------------------
// The report, as the XML parser returns it
// ---------------------------------------------------------------------------------------

interface XmlCounter {
  '@_type'?: string
  '@_missed'?: string
  '@_covered'?: string
}
interface XmlMethod {
  '@_name'?: string
  '@_desc'?: string
  '@_line'?: string
  counter?: XmlCounter[]
}
interface XmlClass {
  '@_name'?: string
  '@_sourcefilename'?: string
  method?: XmlMethod[]
}
interface XmlPackage {
  '@_name'?: string
  class?: XmlClass[]
}
interface XmlGroup {
  group?: XmlGroup[]
  package?: XmlPackage[]
}

const ARRAY_TAGS = new Set(['group', 'package', 'class', 'method', 'counter'])

// Attribute values stay strings (a method named "1" must not become a number). Entity references
// to the standard five are decoded (`&lt;init&gt;`). The parser never fetches an external DTD or
// entity: it reads the JaCoCo DOCTYPE as text, and it throws on an external entity declaration.
const PARSER = new XMLParser({
  ignoreAttributes: false,
  parseAttributeValue: false,
  parseTagValue: false,
  processEntities: true,
  isArray: (tagName) => ARRAY_TAGS.has(tagName),
})

/** The parsed `<report>` element, or the problem text. */
const parseReport = (xml: string): XmlGroup | string => {
  const valid = XMLValidator.validate(xml)
  if (valid !== true) return `Cannot parse the JaCoCo report: ${valid.err.msg} (line ${valid.err.line})`
  let root: { report?: XmlGroup }
  try {
    root = PARSER.parse(xml) as { report?: XmlGroup }
  } catch (cause) {
    return `Cannot parse the JaCoCo report: ${(cause as Error).message}`
  }
  return root.report ?? 'Not a JaCoCo report: the root element is not <report>'
}

const packagesOf = (node: XmlGroup): XmlPackage[] => [
  ...(node.package ?? []),
  ...(node.group ?? []).flatMap(packagesOf),
]

// ---------------------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------------------

const PRIMITIVES: Record<string, string> = {
  Z: 'boolean',
  B: 'byte',
  C: 'char',
  S: 'short',
  I: 'int',
  J: 'long',
  F: 'float',
  D: 'double',
}

const TYPE = String.raw`\[*(?:[ZBCSIJFD]|L[^;]+;)`
const DESCRIPTOR = new RegExp(String.raw`^\(((?:${TYPE})*)\)(?:V|${TYPE})$`)
// A Map, not an object: a method named `toString` or `constructor` must not find a prototype member.
const SPECIAL_KINDS: ReadonlyMap<string, string> = new Map([
  ['<init>', 'Constructor'],
  ['<clinit>', 'Static initializer'],
])
const LAMBDA = /^lambda\$(.+)\$\d+$/

const simpleClass = (internalName: string): string =>
  internalName.slice(internalName.lastIndexOf('/') + 1).replaceAll('$', '.')

const simpleType = (type: string): string => {
  const dims = type.length - type.replaceAll('[', '').length
  const base = type.slice(dims)
  const name = base.length === 1 ? PRIMITIVES[base] : simpleClass(base.slice(1, -1))
  return name + '[]'.repeat(dims)
}

/** The simple parameter types of a JVM method descriptor, or null when it is not one. */
const parameterTypes = (desc: string): string[] | null => {
  const params = DESCRIPTOR.exec(desc)
  return params === null ? null : (params[1].match(new RegExp(TYPE, 'g')) ?? []).map(simpleType)
}

interface MethodName {
  kind: string
  symbol: string
}

/** The kind and the symbol of a method, or null when a lambda's name has no enclosing method. */
const methodName = (cls: string, name: string, params: string[]): MethodName | null => {
  if (name.startsWith('lambda$')) {
    const enclosing = LAMBDA.exec(name)?.[1]
    return enclosing === undefined ? null : { kind: 'Lambda', symbol: `${cls}#${enclosing}$lambda` }
  }
  return { kind: SPECIAL_KINDS.get(name) ?? 'Method', symbol: `${cls}#${name}(${params.join(',')})` }
}

// ---------------------------------------------------------------------------------------
// Counters and scores
// ---------------------------------------------------------------------------------------

interface Tally {
  missed: number
  covered: number
}

const COUNT = /^\d+$/

const tallyOf = (c: XmlCounter): [string, Tally] | null => {
  const [type, missed, covered] = [c['@_type'], c['@_missed'], c['@_covered']]
  const valid = type !== undefined && COUNT.test(missed ?? '') && COUNT.test(covered ?? '')
  return valid ? [type, { missed: Number(missed), covered: Number(covered) }] : null
}

/** The method's counters by type, or null when one is invalid or a type repeats. */
const countersOf = (list: readonly XmlCounter[]): Map<string, Tally> | null => {
  const byType = new Map<string, Tally>()
  for (const c of list) {
    const entry = tallyOf(c)
    if (entry === null || byType.has(entry[0])) return null
    byType.set(entry[0], entry[1])
  }
  return byType
}

const total = (t: Tally | undefined): number => (t === undefined ? 0 : t.missed + t.covered)
const ratio = (t: Tally): number => t.covered / total(t)

/** Unrounded coverage and its kind: the lower of line and branch, or line alone without branches. */
const coverageOf = (line: Tally, branch: Tally | undefined): { cov: number; covKind: CovKind } =>
  total(branch) > 0
    ? { cov: Math.min(ratio(line), ratio(branch as Tally)), covKind: 'min(line,branch)' }
    : { cov: ratio(line), covKind: 'line' }

// ---------------------------------------------------------------------------------------
// Source paths
// ---------------------------------------------------------------------------------------

type Resolved = { rel: string } | { outOfScope: true } | { conflict: true }

interface Run {
  config: CrapConfig
  repoRoot: string
  fs: JavaFileSystem
  excludes: RegExp[]
  out: Measurement
  outOfScope: number
  /** A source file seen once is resolved once, so one ambiguity is one problem. */
  resolved: Map<string, Resolved>
  /** The report that first produced each file, symbol and line. */
  seen: Map<string, string>
}

const problem = (run: Run, p: MeasureProblem): void => {
  run.out.problems.push(p)
}

const malformed = (run: Run, report: string, detail: string): void =>
  problem(run, { file: report, message: `Malformed JaCoCo report: ${detail}` })

const resolveSource = (run: Run, report: string, pkg: string, sourceFile: string): Resolved => {
  const matches = [...new Set(run.config.scope.map((root) => path.posix.join(root, pkg, sourceFile)))].filter(
    (rel) => run.fs.fileExists(path.join(run.repoRoot, rel)),
  )
  if (matches.length > 1) {
    problem(run, {
      file: report,
      message: `Source file is ambiguous: ${path.posix.join(pkg, sourceFile)} exists under more than one scope root: ${matches.join(', ')}`,
    })
    return { conflict: true }
  }
  const excluded = matches.length === 1 && run.excludes.some((re) => re.test(matches[0]))
  return matches.length === 1 && !excluded ? { rel: matches[0] } : { outOfScope: true }
}

const sourceOf = (run: Run, report: string, pkg: string, sourceFile: string | undefined): Resolved => {
  if (sourceFile === undefined || !run.config.extensions.some((ext) => sourceFile.endsWith(ext))) {
    return { outOfScope: true }
  }
  const key = path.posix.join(pkg, sourceFile)
  const known = run.resolved.get(key) ?? resolveSource(run, report, pkg, sourceFile)
  run.resolved.set(key, known)
  return known
}

// ---------------------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------------------

interface Located {
  report: string
  file: string
  cls: string
  classPath: string
}

interface MethodAttributes {
  name: string
  params: string[]
  line: number
}

/** The method's name, parameter types and line, or why they are not usable. */
const readAttributes = (m: XmlMethod): MethodAttributes | string => {
  const [name, desc, lineText] = [m['@_name'], m['@_desc'], m['@_line'] ?? '0']
  if (name === undefined || desc === undefined) return 'has no name or desc'
  const params = parameterTypes(desc)
  if (params === null) return 'has an invalid desc'
  return COUNT.test(lineText) ? { name, params, line: Number(lineText) } : 'has an invalid line'
}

interface MethodCounters {
  complexity: Tally
  lines: Tally
  branch: Tally | undefined
}

/** The counters a score needs, or why the method has none. */
const readCounters = (m: XmlMethod): MethodCounters | string => {
  const counters = countersOf(m.counter ?? [])
  if (counters === null) return 'has an invalid or repeated counter'
  const [complexity, lines] = [counters.get('COMPLEXITY'), counters.get('LINE')]
  if (complexity === undefined || total(complexity) === 0) return 'has no COMPLEXITY counter'
  if (lines === undefined || total(lines) === 0) return 'has no LINE counter'
  return { complexity, lines, branch: counters.get('BRANCH') }
}

/** Why a method cannot be scored, or the score. */
const scoreMethod = (where: Located, m: XmlMethod): FunctionScore | string => {
  const attributes = readAttributes(m)
  if (typeof attributes === 'string') return attributes
  const named = methodName(where.cls, attributes.name, attributes.params)
  if (named === null) return 'has an unrecognised lambda name'
  const counters = readCounters(m)
  if (typeof counters === 'string') return counters
  const cc = total(counters.complexity)
  const { cov, covKind } = coverageOf(counters.lines, counters.branch)
  // CRAP uses the unrounded coverage; only the report rounds.
  return { file: where.file, ...named, line: attributes.line, cc, cov: roundTo(cov, 4), covKind, crap: crapScore(cc, cov) }
}

const record = (run: Run, where: Located, score: FunctionScore): void => {
  const key = `${score.file}\t${score.symbol}\t${score.line}`
  const first = run.seen.get(key)
  if (first === undefined || first === where.report) {
    run.seen.set(key, where.report)
    run.out.functions.push(score)
    return
  }
  problem(run, {
    file: score.file,
    line: score.line,
    message: `Reported twice: ${score.symbol} is in ${first} and in ${where.report}`,
  })
}

const measureMethods = (run: Run, where: Located, cls: XmlClass): void => {
  for (const m of cls.method ?? []) {
    const scored = scoreMethod(where, m)
    if (typeof scored === 'string') malformed(run, where.report, `a method of ${where.classPath} ${scored}`)
    else record(run, where, scored)
  }
}

const measureClass = (run: Run, report: string, pkg: string, cls: XmlClass): void => {
  const classPath = cls['@_name']
  if (classPath === undefined) return malformed(run, report, 'a class has no name')
  const source = sourceOf(run, report, pkg, cls['@_sourcefilename'])
  if ('outOfScope' in source) run.outOfScope += 1
  if (!('rel' in source)) return
  measureMethods(run, { report, file: source.rel, cls: simpleClass(classPath), classPath }, cls)
}

const measurePackage = (run: Run, report: string, pkg: XmlPackage): void => {
  const name = pkg['@_name']
  if (name === undefined) return malformed(run, report, 'a package has no name')
  for (const cls of pkg.class ?? []) measureClass(run, report, name, cls)
}

const measureReport = (run: Run, reportPath: string): void => {
  let xml: string
  try {
    xml = run.fs.readFile(path.resolve(run.repoRoot, reportPath))
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code ?? 'unknown error'
    return problem(run, { file: reportPath, message: `Cannot read the JaCoCo report (${code})` })
  }
  const parsed = parseReport(xml)
  if (typeof parsed === 'string') return problem(run, { file: reportPath, message: parsed })
  for (const pkg of packagesOf(parsed)) measurePackage(run, reportPath, pkg)
}

/**
 * Scores every method in the given JaCoCo XML reports (paths relative to `repoRoot`, or absolute).
 * `cc` is the method's COMPLEXITY counter; coverage is the lower of its line and branch ratios,
 * or its line ratio when it has no branches. `unmatched` is always empty: JaCoCo lists every method.
 */
export const measureJava = (
  config: CrapConfig,
  repoRoot: string,
  reports: readonly string[],
  fs: JavaFileSystem = REAL_FS,
): JavaMeasurement => {
  const out: Measurement = { functions: [], unmatched: [], problems: [] }
  const run: Run = {
    config,
    repoRoot,
    fs,
    excludes: config.exclude.map((source) => new RegExp(source)),
    out,
    outOfScope: 0,
    resolved: new Map(),
    seen: new Map(),
  }
  for (const report of reports) measureReport(run, report)
  return { measurement: out, outOfScope: run.outOfScope }
}
