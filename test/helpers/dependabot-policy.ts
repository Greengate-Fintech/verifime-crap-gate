import { parse } from 'yaml'

// Checkers for the dependency policy. Each returns one actionable message per problem.

export const MAJOR = 'version-update:semver-major'
const MINOR_PATCH = ['minor', 'patch']
export const IGNORED_MAJORS = ['@types/node', 'typescript', 'eslint', 'typescript-eslint']

type NpmEntry = {
  'package-ecosystem'?: string
  directory?: string
  directories?: string[]
  ignore?: unknown
  groups?: unknown
}

const FILE = '.github/dependabot.yml'
const NO_NPM = [`${FILE} has no npm entry under updates`]

const npmEntries = (dependabotYaml: string): NpmEntry[] => {
  const updates = (parse(dependabotYaml) as { updates?: unknown } | null)?.updates
  if (!Array.isArray(updates)) return []
  return (updates as NpmEntry[]).filter((u) => u?.['package-ecosystem'] === 'npm')
}

const labelOf = (entry: NpmEntry): string => `npm entry "${entry.directory ?? (entry.directories ?? []).join(', ')}"`

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

// A list of strings, or undefined when the value is not one.
const stringList = (v: unknown): string[] | undefined =>
  Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined

// A dependency-group pattern is an exact name or a glob where * matches any run of characters.
const covers = (patterns: string[], name: string): boolean =>
  patterns.some((p) => new RegExp(`^${p.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\/]/g, '\\$&')).join('.*')}$`).test(name))

const ignoreProblems = (entry: NpmEntry): string[] => {
  const label = labelOf(entry)
  if (entry.ignore !== undefined && !Array.isArray(entry.ignore)) {
    return [`${FILE} ${label} ignore must be a list of rules.`]
  }
  const rules = (entry.ignore ?? []) as unknown[]
  return IGNORED_MAJORS.filter(
    (name) =>
      !rules.some(
        (r) => isRecord(r) && r['dependency-name'] === name && (stringList(r['update-types']) ?? []).includes(MAJOR),
      ),
  ).map(
    (name) =>
      `${FILE} ${label} must ignore ${MAJOR} for "${name}" (update-types must be a list). Add under ignore: - dependency-name: "${name}" with update-types: ["${MAJOR}"].`,
  )
}

export const missingMajorIgnores = (dependabotYaml: string): string[] => {
  const entries = npmEntries(dependabotYaml)
  if (entries.length === 0) return NO_NPM
  return entries.flatMap(ignoreProblems)
}

const ENGINE = ['eslint', 'typescript-eslint', 'typescript']
const VITEST = ['vitest', '@vitest/*']
// Names the other groups must not match. @vitest/coverage-v8 stands for @vitest/*.
const PROTECTED = [...ENGINE, 'vitest', '@vitest/coverage-v8']

const sameSet = (a: string[], b: string[]): boolean => a.length === b.length && b.every((x) => a.includes(x))

const quoted = (names: string[]): string => names.map((n) => `"${n}"`).join(', ')

// One exact-shape check per group. Dependabot gives each dependency to the first group that
// matches it, so any extra key or any other group that matches these names could split the set.
const shapeProblems = (
  label: string,
  groups: Record<string, unknown>,
  name: string,
  patterns: string[],
  updateTypes: string[] | undefined,
): string[] => {
  const at = `${FILE} ${label} group "${name}"`
  const group = groups[name]
  if (!isRecord(group)) return [`${at} is missing. Add groups: ${name}: patterns: [${quoted(patterns)}].`]
  const found = stringList(group.patterns)
  if (found === undefined) return [`${at} patterns must be a list of strings.`]
  const problems: string[] = []
  if (!sameSet(found, patterns)) problems.push(`${at} patterns must be exactly ${quoted(patterns)}.`)
  const allowed = new Set(['patterns', ...(updateTypes ? ['update-types'] : [])])
  for (const key of Object.keys(group).filter((k) => !allowed.has(k))) {
    problems.push(`${at} must not set ${key}: it can split the packages across groups. Remove ${key}.`)
  }
  if (updateTypes && !sameSet(stringList(group['update-types']) ?? [], updateTypes)) {
    problems.push(`${at} must limit update-types to minor and patch. Set update-types: ["minor", "patch"].`)
  }
  return problems
}

const strayProblems = (label: string, groups: Record<string, unknown>): string[] =>
  Object.entries(groups)
    .filter(([name]) => name !== 'measure-engine' && name !== 'vitest')
    .filter(([, g]) => isRecord(g) && PROTECTED.some((n) => covers(stringList(g.patterns) ?? [], n)))
    .map(
      ([name]) =>
        `${FILE} ${label} group "${name}" has a pattern that matches a measure-engine or vitest package, so it could split them. Narrow or remove it.`,
    )

export const groupProblems = (dependabotYaml: string): string[] => {
  const entries = npmEntries(dependabotYaml)
  if (entries.length === 0) return NO_NPM
  return entries.flatMap((entry) => {
    const label = labelOf(entry)
    const groups = isRecord(entry.groups) ? entry.groups : {}
    return [
      ...shapeProblems(label, groups, 'measure-engine', ENGINE, MINOR_PATCH),
      ...shapeProblems(label, groups, 'vitest', VITEST, undefined),
      ...strayProblems(label, groups),
    ]
  })
}

const majorOf = (version: string, label: string, expected: string, got: string = version): number => {
  const match = /(\d+)/.exec(version)
  if (match === null) throw new Error(`${label} has no major version (got "${got}"). Set it to ${expected}.`)
  return Number(match[1])
}

export const runtimeMismatches = (packageJson: string, actionYaml: string): string[] => {
  const pkg = JSON.parse(packageJson) as { devDependencies?: Record<string, string>; engines?: { node?: string } }
  const action = parse(actionYaml) as { runs?: { using?: string } }
  const types = majorOf(pkg.devDependencies?.['@types/node'] ?? '', 'package.json devDependencies @types/node', 'an exact version such as 24.19.0')
  const using = String(action.runs?.using ?? '')
  const runtime = majorOf(/^node(\d+)$/.exec(using)?.[0] ?? '', 'action.yml runs.using', 'nodeNN, for example node24', using)
  const engines = majorOf(pkg.engines?.node ?? '', 'package.json engines.node', 'a range such as ">=24"')
  const problems: string[] = []
  if (types !== runtime) {
    problems.push(
      `@types/node major (${types}) in package.json must equal the Node major in action.yml runs.using (node${runtime}). Change @types/node to ${runtime}.x, or runs.using to node${types}.`,
    )
  }
  if (types !== engines) {
    problems.push(
      `@types/node major (${types}) in package.json must equal the minimum major in engines.node (${engines}). Change @types/node to ${engines}.x, or engines.node to ">=${types}".`,
    )
  }
  return problems
}
