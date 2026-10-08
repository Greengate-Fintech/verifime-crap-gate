import { readFileSync } from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

// Mechanical enforcement of the dependency policy. The measure engine (eslint, typescript-eslint,
// typescript) sets every consumer's scores, so its major versions ship as a deliberate gate release,
// never as a Dependabot bump. @types/node tracks the runtime the action declares.

const ROOT = path.join(__dirname, '..')
const MAJOR = 'version-update:semver-major'
const IGNORED_MAJORS = ['@types/node', 'typescript', 'eslint', 'typescript-eslint']

const read = (file: string): string => readFileSync(path.join(ROOT, file), 'utf8')

type IgnoreRule = { 'dependency-name'?: string; 'update-types'?: string[] }
type Doc = { updates?: { 'package-ecosystem'?: string; ignore?: IgnoreRule[] }[] }

// Returns one message per dependency whose semver-major updates the npm entry does not ignore.
export const missingMajorIgnores = (dependabotYaml: string): string[] => {
  const npm = ((parse(dependabotYaml) as Doc).updates ?? []).find((u) => u['package-ecosystem'] === 'npm')
  if (npm === undefined) return ['.github/dependabot.yml has no npm entry under updates']
  const rules = npm.ignore ?? []
  return IGNORED_MAJORS.filter(
    (name) => !rules.some((r) => r['dependency-name'] === name && (r['update-types'] ?? []).includes(MAJOR)),
  ).map(
    (name) =>
      `.github/dependabot.yml npm entry must ignore ${MAJOR} for "${name}". Add under ignore: - dependency-name: "${name}" with update-types: ["${MAJOR}"].`,
  )
}

const majorOf = (version: string): number => {
  const match = /(\d+)/.exec(version)
  if (match === null) throw new Error(`no major version in "${version}"`)
  return Number(match[1])
}

// Returns one message per disagreement between the @types/node major, the action runtime and engines.node.
export const runtimeMismatches = (packageJson: string, actionYaml: string): string[] => {
  const pkg = JSON.parse(packageJson) as { devDependencies?: Record<string, string>; engines?: { node?: string } }
  const action = parse(actionYaml) as { runs?: { using?: string } }
  const types = majorOf(pkg.devDependencies?.['@types/node'] ?? '')
  const runtime = majorOf(/^node(\d+)$/.exec(action.runs?.using ?? '')?.[0] ?? '')
  const engines = majorOf(pkg.engines?.node ?? '')
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

describe('dependabot policy', () => {
  it('ignores semver-major updates for the measure engine and @types/node', () => {
    expect(missingMajorIgnores(read('.github/dependabot.yml'))).toEqual([])
  })

  it('reports each dependency whose major updates are not ignored', () => {
    const yaml = [
      'version: 2',
      'updates:',
      '  - package-ecosystem: npm',
      '    ignore:',
      '      - dependency-name: eslint',
      `        update-types: ["${MAJOR}"]`,
      '      - dependency-name: typescript',
      '        update-types: ["version-update:semver-minor"]',
    ].join('\n')
    expect(missingMajorIgnores(yaml).map((m) => /"([^"]+)"/.exec(m)?.[1])).toEqual([
      '@types/node',
      'typescript',
      'typescript-eslint',
    ])
  })

  it('reports a missing npm entry', () => {
    expect(missingMajorIgnores('version: 2\nupdates:\n  - package-ecosystem: github-actions\n')).toHaveLength(1)
  })
})

describe('runtime tracking', () => {
  it('keeps @types/node, action.yml runs.using and engines.node on one major', () => {
    expect(runtimeMismatches(read('package.json'), read('action.yml'))).toEqual([])
  })

  it('reports a @types/node major that differs from the action runtime and engines', () => {
    const pkg = JSON.stringify({ devDependencies: { '@types/node': '25.0.0' }, engines: { node: '>=24' } })
    const problems = runtimeMismatches(pkg, 'runs:\n  using: node24\n')
    expect(problems).toHaveLength(2)
    expect(problems[0]).toContain('Change @types/node to 24.x')
    expect(problems[1]).toContain('engines.node')
  })

  it('reports an action runtime that differs from engines', () => {
    const pkg = JSON.stringify({ devDependencies: { '@types/node': '24.1.0' }, engines: { node: '>=24' } })
    expect(runtimeMismatches(pkg, 'runs:\n  using: node22\n')).toHaveLength(1)
  })
})
