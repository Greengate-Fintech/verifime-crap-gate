import { readFileSync } from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { crapScore, functionCoverage } from '../src/score'
import type { IstanbulFileCoverage } from '../src/types'

// Functions that ran down their default path only, covered by real Vitest 1.6, 3.2, 4.1 and 5.0
// runs of test/fixtures/implicit-else (guards.ts). Vitest 4 and 5 record an `if` without an `else`
// as two branch locations, the second with an empty position (the implicit else) and the hits for
// the path that skips the `if`. Vitest 1.6 and 3.2 record no such location, so their scores must not change.

const PACKAGE = path.join(__dirname, 'fixtures', 'implicit-else')
const FUNCTIONS = ['retryDelay', 'describeLevel', 'listOrEmpty', 'countOrEmpty', 'fallbackLabel', 'signOf', 'guardedConstructorLike']
// Scores on Vitest 1.6 and 3.2, which this change must leave as they were.
const OLD_VERSION_COVERAGE = {
  '1.6.1': { retryDelay: 0.5, describeLevel: 0.3333, listOrEmpty: 1, countOrEmpty: 1, fallbackLabel: 0.5, signOf: 0.5, guardedConstructorLike: 0.25 },
  '3.2.4': { retryDelay: 0.5, describeLevel: 0.3333, listOrEmpty: 1, countOrEmpty: 1, fallbackLabel: 0.5, signOf: 0.5, guardedConstructorLike: 0.25 },
}
const IMPLICIT_ELSE_VERSIONS = ['4.1.11', '5.0.3'] as const

const coverageFor = (version: string): IstanbulFileCoverage =>
  (JSON.parse(readFileSync(path.join(PACKAGE, 'coverage', `${version}.json`), 'utf8')) as Record<string, IstanbulFileCoverage>)['src/guards.ts']

const coverageOf = (file: IstanbulFileCoverage, name: string) => {
  const id = Object.keys(file.fnMap).find((k) => file.fnMap[k].name === name)
  if (id === undefined) throw new Error(`No entry for ${name}`)
  return functionCoverage(file, id)
}

describe('an if without an else counts its implicit else as a branch of the function', () => {
  it.each(IMPLICIT_ELSE_VERSIONS)('Vitest %s: a guard that never fires, the function ran', (version) => {
    // 2 of 3 statements; branches: consequent 0 hits, implicit else 1 hit -> 1 of 2.
    const { cov, covKind } = coverageOf(coverageFor(version), 'retryDelay')
    expect({ cov, covKind }).toEqual({ cov: 0.5, covKind: 'min(stmt,branch)' })
    expect(crapScore(2, cov)).toBe(2.5)
  })

  it.each(IMPLICIT_ELSE_VERSIONS)('Vitest %s: nested guards', (version) => {
    // 3 of 6 statements. Branches: outer if (0, 1), inner if never reached (0, 0), second if (0, 1) -> 2 of 6.
    expect(coverageOf(coverageFor(version), 'describeLevel')).toEqual({ cov: 0.3333, covKind: 'min(stmt,branch)' })
  })

  it.each(IMPLICIT_ELSE_VERSIONS)('Vitest %s: three guards in a function that ran (5 of 8 statements)', (version) => {
    // Branches: three ifs, each (0, 1) -> 3 of 6.
    expect(coverageOf(coverageFor(version), 'guardedConstructorLike')).toEqual({ cov: 0.5, covKind: 'min(stmt,branch)' })
  })

  it.each(IMPLICIT_ELSE_VERSIONS)('Vitest %s: ??, || and ?: keep their two located branches', (version) => {
    const file = coverageFor(version)
    expect(coverageOf(file, 'listOrEmpty')).toEqual({ cov: 1, covKind: 'min(stmt,branch)' })
    expect(coverageOf(file, 'countOrEmpty')).toEqual({ cov: 1, covKind: 'min(stmt,branch)' })
    expect(coverageOf(file, 'fallbackLabel')).toEqual({ cov: 0.5, covKind: 'min(stmt,branch)' })
    expect(coverageOf(file, 'signOf')).toEqual({ cov: 0.5, covKind: 'min(stmt,branch)' })
  })

  it.each(['1.6.1', '3.2.4'] as const)('Vitest %s records no implicit else, so nothing changes', (version) => {
    const file = coverageFor(version)
    expect(Object.values(file.branchMap).flatMap((b) => b.locations).every((l) => l.start.line != null)).toBe(true)
    expect(Object.fromEntries(FUNCTIONS.map((name) => [name, coverageOf(file, name).cov]))).toEqual(OLD_VERSION_COVERAGE[version])
  })
})
