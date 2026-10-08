import { parse } from 'yaml'

// Checkers for the dependency policy. Each returns one actionable message per problem.

export const MAJOR = 'version-update:semver-major'
export const IGNORED_MAJORS = ['@types/node', 'typescript', 'eslint', 'typescript-eslint']

type IgnoreRule = { 'dependency-name'?: string; 'update-types'?: string[] }
type Group = { patterns?: string[]; 'update-types'?: string[] }
type NpmEntry = {
  'package-ecosystem'?: string
  directory?: string
  directories?: string[]
  ignore?: IgnoreRule[]
  groups?: Record<string, Group>
}
type Doc = { updates?: NpmEntry[] }

const FILE = '.github/dependabot.yml'
const NO_NPM = [`${FILE} has no npm entry under updates`]

const npmEntries = (dependabotYaml: string): NpmEntry[] =>
  ((parse(dependabotYaml) as Doc).updates ?? []).filter((u) => u['package-ecosystem'] === 'npm')

const labelOf = (entry: NpmEntry): string => `npm entry "${entry.directory ?? (entry.directories ?? []).join(', ')}"`

const ignoresMajor = (rules: IgnoreRule[], name: string): boolean =>
  rules.some((r) => r['dependency-name'] === name && (r['update-types'] ?? []).includes(MAJOR))

// A dependency-group pattern is an exact name or a glob where * matches any run of characters.
const covers = (patterns: string[], name: string): boolean =>
  patterns.some((p) => new RegExp(`^${p.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\/]/g, '\\$&')).join('.*')}$`).test(name))

export const missingMajorIgnores = (dependabotYaml: string): string[] => {
  const entries = npmEntries(dependabotYaml)
  if (entries.length === 0) return NO_NPM
  return entries.flatMap((entry) =>
    IGNORED_MAJORS.filter((name) => !ignoresMajor(entry.ignore ?? [], name)).map(
      (name) =>
        `${FILE} ${labelOf(entry)} must ignore ${MAJOR} for "${name}". Add under ignore: - dependency-name: "${name}" with update-types: ["${MAJOR}"].`,
    ),
  )
}

const ENGINE = ['eslint', 'typescript-eslint', 'typescript']
const MINOR_PATCH = ['minor', 'patch']

const engineProblem = (entry: NpmEntry): string[] => {
  const label = labelOf(entry)
  const groups = Object.entries(entry.groups ?? {}).filter(([, g]) => ENGINE.every((n) => covers(g.patterns ?? [], n)))
  if (groups.length === 0) {
    return [`${FILE} ${label} needs a group whose patterns cover ${ENGINE.map((n) => `"${n}"`).join(', ')} so they update together. Add groups: measure-engine: patterns: [${ENGINE.map((n) => `"${n}"`).join(', ')}].`]
  }
  const limited = groups.some(([, g]) => (g['update-types'] ?? []).length > 0 && (g['update-types'] ?? []).every((t) => MINOR_PATCH.includes(t)))
  return limited ? [] : [`${FILE} ${label} measure-engine group must limit update-types to minor and patch. Add update-types: ["minor", "patch"].`]
}

const vitestProblem = (entry: NpmEntry): string[] => {
  const ok = Object.values(entry.groups ?? {}).some((g) => covers(g.patterns ?? [], 'vitest') && covers(g.patterns ?? [], '@vitest/coverage-v8'))
  return ok ? [] : [`${FILE} ${labelOf(entry)} needs a group whose patterns cover "vitest" and "@vitest/*" so the paired packages update together.`]
}

export const groupProblems = (dependabotYaml: string): string[] => {
  const entries = npmEntries(dependabotYaml)
  if (entries.length === 0) return NO_NPM
  return entries.flatMap((entry) => [...engineProblem(entry), ...vitestProblem(entry)])
}

const majorOf = (version: string, label: string, expected: string): number => {
  const match = /(\d+)/.exec(version)
  if (match === null) throw new Error(`${label} has no major version (got "${version}"). Set it to ${expected}.`)
  return Number(match[1])
}

export const runtimeMismatches = (packageJson: string, actionYaml: string): string[] => {
  const pkg = JSON.parse(packageJson) as { devDependencies?: Record<string, string>; engines?: { node?: string } }
  const action = parse(actionYaml) as { runs?: { using?: string } }
  const types = majorOf(pkg.devDependencies?.['@types/node'] ?? '', 'package.json devDependencies @types/node', 'an exact version such as 24.19.0')
  const runtime = majorOf(/^node(\d+)$/.exec(action.runs?.using ?? '')?.[0] ?? '', 'action.yml runs.using', 'nodeNN, for example node24')
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
