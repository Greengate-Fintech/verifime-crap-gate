import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../src/config'
import type { CrapConfig } from '../src/config'
import { compileScope, isInScope, measure } from '../src/measure'
import type { IstanbulFileCoverage } from '../src/types'
import { withPointSpans } from './helpers/spans'

const ROOT = '/fake/repo'
const SPAN = { start: { line: 1, column: 0 }, end: { line: 5, column: 1 } }

const coverageEntry = (key: string): IstanbulFileCoverage => ({
  path: key,
  statementMap: {},
  s: {},
  fnMap: { '0': { name: 'f', decl: SPAN, loc: SPAN } },
  f: { '0': 1 },
  branchMap: {},
  b: {},
})

const oneFile = (rel: string, coverageKey = `${ROOT}/${rel}`) => ({
  eslint: [
    {
      filePath: `${ROOT}/${rel}`,
      messages: [{ ruleId: 'complexity', message: "Function 'f' has a complexity of 3. Maximum allowed is 0.", line: 1, column: 1 }],
    },
  ],
  coverage: { [coverageKey]: coverageEntry(coverageKey) },
})

const config = (changes: Partial<CrapConfig>): CrapConfig => ({ ...DEFAULT_CONFIG, ...changes })

const run = (rel: string, changes: Partial<CrapConfig>, coverageKey?: string) => {
  const { eslint, coverage } = oneFile(rel, coverageKey)
  const result = measure(withPointSpans(eslint), coverage, ROOT, () => '', config(changes))
  return { files: result.functions.map((f) => f.file), unmatched: result.unmatched.length, problems: result.problems.length }
}

describe('measure with config: scope', () => {
  it('measures a nested package only when its directory is in scope', () => {
    expect(run('packages/api/src/a.ts', {}).files).toEqual([])
    expect(run('packages/api/src/a.ts', { scope: ['packages/api/src'] }).files).toEqual(['packages/api/src/a.ts'])
  })

  it('drops a directory that the configured scope leaves out', () => {
    expect(run('src/a.ts', { scope: ['lib'] }).files).toEqual([])
  })

  it('matches a whole directory name, not a prefix of one', () => {
    expect(run('srcs/a.ts', { scope: ['src'] }).files).toEqual([])
  })
})

describe('measure with config: anchors', () => {
  const foreign = '/ci/build/app/a.ts'

  it('does not join a foreign coverage path on a segment that is not an anchor', () => {
    const result = run('app/a.ts', { scope: ['app'] }, foreign)
    expect(result.files).toEqual([])
    expect(result.unmatched).toBe(1)
  })

  it('joins a foreign coverage path on a configured anchor', () => {
    const result = run('app/a.ts', { scope: ['app'], anchors: ['app'] }, foreign)
    expect(result.files).toEqual(['app/a.ts'])
    expect(result.unmatched).toBe(0)
  })
})

describe('measure with config: extensions', () => {
  it('excludes .tsx by default', () => {
    expect(run('src/view.tsx', {}).files).toEqual([])
  })

  it('includes .tsx when configured', () => {
    expect(run('src/view.tsx', { extensions: ['.ts', '.tsx'] }).files).toEqual(['src/view.tsx'])
  })

  it('stops measuring .ts when it is not listed', () => {
    expect(run('src/a.ts', { extensions: ['.tsx'] }).files).toEqual([])
  })

  it('still excludes a configured extension that the built-in exclude covers', () => {
    expect(run('src/view.test.tsx', { extensions: ['.tsx'] }).files).toEqual([])
  })
})

describe('measure with config: exclude', () => {
  it('adds a pattern to the built-in exclude', () => {
    expect(run('src/legacy/a.ts', {}).files).toEqual(['src/legacy/a.ts'])
    expect(run('src/legacy/a.ts', { exclude: ['^src/legacy/'] }).files).toEqual([])
  })

  it('keeps the built-in exclude when patterns are configured', () => {
    expect(run('src/a.test.ts', { exclude: ['^nothing$'] }).files).toEqual([])
    expect(run('src/fixtures/a.ts', { exclude: ['^nothing$'] }).files).toEqual([])
  })

  it('applies any one of several patterns', () => {
    expect(run('src/b.gen.ts', { exclude: ['^x$', '\\.gen\\.ts$'] }).files).toEqual([])
  })
})

describe('isInScope with compiled rules', () => {
  it('defaults to the default config', () => {
    expect(isInScope('cdk/lib/stack.ts')).toBe(isInScope('cdk/lib/stack.ts', compileScope(DEFAULT_CONFIG)))
  })

  it('agrees with the original filter for the default config over tricky paths', () => {
    const original = (p: string): boolean => /^(?:cdk\/)?(?:src|lib|bin)\/.*\.ts$/.test(p)
    const rules = compileScope(DEFAULT_CONFIG)
    const paths = ['src/.ts', 'src/a.ts', 'src/a/b/c.ts', 'cdk/src/a.ts', 'cdk/cdk/src/a.ts', 'src.ts', 'src/a.tsx', 'lib/x.mts', 'bin/a.ts', 'cdk/a.ts', 'xsrc/a.ts', 'src/a.ts.map', 'cdk/bin/', 'cdk/lib/a.js']
    for (const p of paths) expect(isInScope(p, rules), p).toBe(original(p) && isInScope(p))
  })
})
