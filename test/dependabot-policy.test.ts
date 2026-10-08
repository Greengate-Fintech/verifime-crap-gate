import { readFileSync } from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { MAJOR, groupProblems, missingMajorIgnores, runtimeMismatches } from './helpers/dependabot-policy'

// Mechanical enforcement of the dependency policy. The measure engine (eslint, typescript-eslint,
// typescript) sets every consumer's scores, so its major versions ship as a deliberate gate release,
// never as a Dependabot bump. @types/node tracks the runtime the action declares.

const ROOT = path.join(__dirname, '..')
const read = (file: string): string => readFileSync(path.join(ROOT, file), 'utf8')

const IGNORED = ['@types/node', 'typescript', 'eslint', 'typescript-eslint']

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
          ? ['    ignore:', ...IGNORED.flatMap((n) => [`      - dependency-name: "${n}"`, `        update-types: ["${MAJOR}"]`])]
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
  it('groups the measure engine (minor and patch) and the vitest packages', () => {
    expect(groupProblems(read('.github/dependabot.yml'))).toEqual([])
  })

  const npm = (groups: string): string => `version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n${groups}`

  it('reports no groups at all', () => {
    expect(groupProblems(npm(''))).toHaveLength(2)
  })

  it('reports a measure-engine group that misses a package', () => {
    const groups = [
      '    groups:',
      '      engine:',
      '        patterns: ["eslint", "typescript"]',
      '      vitest:',
      '        patterns: ["vitest", "@vitest/*"]',
    ].join('\n')
    const problems = groupProblems(npm(groups))
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('typescript-eslint')
  })

  it('reports a measure-engine group that allows major updates', () => {
    const groups = [
      '    groups:',
      '      engine:',
      '        patterns: ["eslint", "typescript", "typescript-eslint"]',
      '        update-types: ["minor", "major"]',
      '      v:',
      '        patterns: ["vitest", "@vitest/*"]',
    ].join('\n')
    expect(groupProblems(npm(groups)).join('\n')).toContain('minor and patch')
  })

  it('reports a vitest group that misses @vitest/*', () => {
    const groups = [
      '    groups:',
      '      engine:',
      '        patterns: ["eslint", "typescript", "typescript-eslint"]',
      '        update-types: ["minor", "patch"]',
      '      v:',
      '        patterns: ["vitest"]',
    ].join('\n')
    expect(groupProblems(npm(groups)).join('\n')).toContain('@vitest/*')
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
