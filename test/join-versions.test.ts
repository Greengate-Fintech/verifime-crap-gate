import { readFileSync } from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../src/config'
import type { CrapConfig } from '../src/config'
import { lintScope } from '../src/eslint'
import { measure } from '../src/measure'
import { functionCoverage } from '../src/score'
import type { IstanbulFileCoverage } from '../src/types'

// The join on a synthetic package covered by real Vitest 1.6, 3.2, 4.1 and 5.0 runs. Where each
// version starts an entry, and which functions get none, differs (see expected.json). Every
// function with its own entry must be scored from that entry, and every other function must be
// unmatched, under every version.

const PACKAGE = path.join(__dirname, 'fixtures', 'vitest-versions')
const VERSIONS = ['1.6.1', '3.2.4', '4.1.11', '5.0.3'] as const
const CONFIG: CrapConfig = { ...DEFAULT_CONFIG, extensions: ['.ts', '.tsx'] }

interface ExpectedFunction {
  file: string
  line: number
  column: number
  kind: string
  label: string
  entry: Record<(typeof VERSIONS)[number], string | null>
}

const expected = (JSON.parse(readFileSync(path.join(PACKAGE, 'expected.json'), 'utf8')) as { functions: ExpectedFunction[] }).functions

const coverageFor = (version: string): Record<string, IstanbulFileCoverage> =>
  JSON.parse(readFileSync(path.join(PACKAGE, 'coverage', `${version}.json`), 'utf8')) as Record<string, IstanbulFileCoverage>

/** The fnMap id of `name@line:column` in a file's coverage. */
const idOf = (file: IstanbulFileCoverage, ref: string): string => {
  const [, name, line, column] = /^(.*)@(\d+):(\d+)$/.exec(ref) ?? []
  const hit = Object.entries(file.fnMap).find(
    ([, fn]) => fn.name === name && fn.loc.start.line === Number(line) && fn.loc.start.column === Number(column),
  )
  if (!hit) throw new Error(`No entry ${ref} in ${file.path}`)
  return hit[0]
}

const byPosition = (a: ExpectedFunction, b: ExpectedFunction): number =>
  (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) || a.line - b.line || a.column - b.column

describe.each(VERSIONS)('join on Vitest %s coverage', (version) => {
  it('scores every function from its own entry and leaves the rest unmatched', async () => {
    const coverage = coverageFor(version)
    const rows = [...expected].sort(byPosition)
    const want = {
      joined: rows.flatMap((r) => {
        const ref = r.entry[version]
        if (ref === null) return []
        const file = coverage[r.file]
        const { cov, covKind } = functionCoverage(file, idOf(file, ref))
        return [`${r.file}:${r.line} ${r.kind} ${cov} ${covKind}`]
      }),
      unmatched: rows.filter((r) => r.entry[version] === null).map((r) => `${r.file}:${r.line} ${r.kind}`),
    }
    const m = measure(await lintScope(PACKAGE, CONFIG), coverage, PACKAGE, undefined, CONFIG)
    expect(m.problems).toEqual([])
    // Every entry is a function's, or comes from code ESLint reports no function for (enums, namespaces).
    expect(m.unjoined).toEqual([])
    expect({
      joined: m.functions.map((f) => `${f.file}:${f.line} ${f.kind} ${f.cov} ${f.covKind}`),
      unmatched: m.unmatched.map((u) => `${u.file}:${u.line} ${u.kind}`),
    }).toEqual(want)
  })
})
