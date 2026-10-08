import { readFileSync } from 'fs'
import path from 'path'
import { stringify } from 'yaml'
import { describe, expect, it } from 'vitest'
import { IGNORED_MAJORS, MAJOR, groupProblems, missingMajorIgnores, runtimeMismatches } from './helpers/dependabot-policy'

// Mechanical enforcement of the dependency policy. The measure engine (eslint, typescript-eslint,
// typescript) sets every consumer's scores, so its major versions ship as a deliberate gate release,
// never as a Dependabot bump. @types/node tracks the runtime the action declares.

const ROOT = path.join(__dirname, '..')
const read = (file: string): string => readFileSync(path.join(ROOT, file), 'utf8')

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
    expect(missingMajorIgnores(yaml).map((m) => /for "([^"]+)"/.exec(m)?.[1])).toEqual([
      '@types/node',
      'typescript',
      'typescript-eslint',
    ])
  })

  it('checks every npm entry and names each by its directory', () => {
    const entry = (dir: string, withIgnores: boolean): string =>
      [
        '  - package-ecosystem: npm',
        `    directory: ${dir}`,
        ...(withIgnores
          ? ['    ignore:', ...IGNORED_MAJORS.flatMap((n) => [`      - dependency-name: "${n}"`, `        update-types: ["${MAJOR}"]`])]
          : []),
      ].join('\n')
    const problems = missingMajorIgnores(['version: 2', 'updates:', entry('/', true), entry('/tools', false)].join('\n'))
    expect(problems).toHaveLength(4)
    expect(problems.every((m) => m.includes('"/tools"'))).toBe(true)
  })

  it('reports a missing npm entry', () => {
    expect(missingMajorIgnores('version: 2\nupdates:\n  - package-ecosystem: github-actions\n')).toHaveLength(1)
  })
})

describe('dependabot groups', () => {
  const ENGINE = { patterns: ['eslint', 'typescript-eslint', 'typescript'], 'update-types': ['minor', 'patch'] }
  const VITEST = { patterns: ['vitest', '@vitest/*'] }
  type Groups = Record<string, Record<string, unknown>>
  const npm = (groups?: Groups): string =>
    stringify({ version: 2, updates: [{ 'package-ecosystem': 'npm', directory: '/', ...(groups ? { groups } : {}) }] })
  const GOOD: Groups = { 'measure-engine': ENGINE, vitest: VITEST }

  it('groups the measure engine (minor and patch) and the vitest packages', () => {
    expect(groupProblems(read('.github/dependabot.yml'))).toEqual([])
    expect(groupProblems(npm(GOOD))).toEqual([])
  })

  it('accepts the patterns in any order', () => {
    const groups = { 'measure-engine': { ...ENGINE, patterns: ['typescript', 'eslint', 'typescript-eslint'] }, vitest: { patterns: ['@vitest/*', 'vitest'] } }
    expect(groupProblems(npm(groups))).toEqual([])
  })

  it('reports no groups at all', () => {
    expect(groupProblems(npm())).toHaveLength(2)
  })

  it('reports a measure-engine group that misses a package', () => {
    const problems = groupProblems(npm({ ...GOOD, 'measure-engine': { ...ENGINE, patterns: ['eslint', 'typescript'] } }))
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('measure-engine')
    expect(problems[0]).toContain('typescript-eslint')
  })

  it('reports a measure-engine group that allows major updates', () => {
    const problems = groupProblems(npm({ ...GOOD, 'measure-engine': { ...ENGINE, 'update-types': ['minor', 'major'] } }))
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('minor and patch')
  })

  it('reports a vitest group that misses @vitest/*', () => {
    const problems = groupProblems(npm({ ...GOOD, vitest: { patterns: ['vitest'] } }))
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('@vitest/*')
  })

  it('reports a subset group listed before the measure-engine group', () => {
    const problems = groupProblems(npm({ first: { patterns: ['eslint'] }, ...GOOD }))
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('"first"')
  })

  it('reports a stray catch-all group', () => {
    const problems = groupProblems(npm({ ...GOOD, everything: { patterns: ['*'] } }))
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('"everything"')
  })

  it.each(['exclude-patterns', 'dependency-type', 'applies-to'])('reports %s on the measure-engine group', (key) => {
    const problems = groupProblems(npm({ ...GOOD, 'measure-engine': { ...ENGINE, [key]: ['x'] } }))
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain(key)
  })

  it.each(['exclude-patterns', 'dependency-type', 'applies-to', 'update-types'])('reports %s on the vitest group', (key) => {
    const problems = groupProblems(npm({ ...GOOD, vitest: { ...VITEST, [key]: ['x'] } }))
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain(key)
  })

  it('reports patterns that are not a list', () => {
    const problems = groupProblems(npm({ ...GOOD, vitest: { patterns: 'vitest' } }))
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('list')
  })
})

describe('malformed input', () => {
  it('reports an empty dependabot.yml', () => {
    expect(missingMajorIgnores('')).toEqual(['.github/dependabot.yml has no npm entry under updates'])
    expect(groupProblems('')).toEqual(['.github/dependabot.yml has no npm entry under updates'])
  })

  it('reports an ignore that is not a list', () => {
    const yaml = stringify({ version: 2, updates: [{ 'package-ecosystem': 'npm', directory: '/', ignore: 'eslint' }] })
    expect(missingMajorIgnores(yaml).join('\n')).toContain('list')
  })

  it('reports update-types that are not a list', () => {
    const rule = { 'dependency-name': 'eslint', 'update-types': MAJOR }
    const yaml = stringify({ version: 2, updates: [{ 'package-ecosystem': 'npm', directory: '/', ignore: [rule] }] })
    expect(missingMajorIgnores(yaml).join('\n')).toContain('"eslint"')
  })

  it('shows the real runs.using value when it is not nodeNN', () => {
    const pkg = JSON.stringify({ devDependencies: { '@types/node': '24.1.0' }, engines: { node: '>=24' } })
    expect(() => runtimeMismatches(pkg, 'runs:\n  using: composite\n')).toThrow('got "composite"')
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

  it('reports a runs.using moved without @types/node', () => {
    const pkg = JSON.stringify({ devDependencies: { '@types/node': '24.1.0' }, engines: { node: '>=24' } })
    expect(runtimeMismatches(pkg, 'runs:\n  using: node22\n')).toHaveLength(1)
  })
})
