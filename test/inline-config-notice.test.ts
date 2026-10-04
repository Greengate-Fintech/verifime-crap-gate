import path from 'path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../src/config'
import { lintScope } from '../src/eslint'
import { measure } from '../src/measure'
import type { EslintFileResult, IstanbulFileCoverage } from '../src/types'
import { tempRoot, writeFileIn } from './helpers/sandbox'

// ESLint 9 reports one warning for every inline config comment when `noInlineConfig` is on
// (node_modules/eslint/lib/linter/linter.js, `addWarning` in `runRules`). The measure must
// ignore exactly that warning and nothing else.

const NOTICE = (comment: string) => `'${comment}' has no effect because you have 'noInlineConfig' setting in your config.`

const message = (text: string, over: Partial<EslintFileResult['messages'][number]> = {}) => ({
  ruleId: null as string | null,
  message: text,
  line: 1,
  column: 1,
  severity: 1,
  ...over,
})

const BODY = 'export function busy(a: number, b: number): number {\n  if (a > 1) {\n    return a\n  }\n  if (b > 1) {\n    return b\n  }\n  return 0\n}\n'

/** Istanbul coverage for `busy`, which starts on `startLine` and spans nine lines, never called. */
const coverageAt = (abs: string, startLine: number): Record<string, IstanbulFileCoverage> => {
  const span = { start: { line: startLine, column: 0 }, end: { line: startLine + 8, column: 1 } }
  const entry = {
    path: abs,
    statementMap: {},
    s: {},
    fnMap: { '0': { name: 'busy', decl: span, loc: span } },
    f: { '0': 0 },
    branchMap: {},
    b: {},
  }
  return { [abs]: entry } as unknown as Record<string, IstanbulFileCoverage>
}

const measureSource = async (source: string, startLine: number) => {
  const root = tempRoot('crap-notice')
  writeFileIn(root, 'src/busy.ts', source)
  const abs = path.join(root, 'src/busy.ts')
  const results = await lintScope(root, DEFAULT_CONFIG)
  return measure(results, coverageAt(abs, startLine), root, () => source)
}

describe('inline config notice', () => {
  it('is ignored: a file with an eslint-disable comment measures cleanly', async () => {
    const result = await measureSource(`/* eslint-disable */\n${BODY}`, 2)
    expect(result.problems).toEqual([])
    expect(result.functions.map((f) => f.cc)).toEqual([3])
  })

  it.each([
    ['a next-line disable for complexity', `// eslint-disable-next-line complexity\n${BODY}`],
    ['a file-level disable', `/* eslint-disable */\n${BODY}`],
    ['a file-level complexity off', `/* eslint complexity: off */\n${BODY}`],
    ['a directive for another rule', `// eslint-disable-next-line react-hooks/exhaustive-deps\n${BODY}`],
  ])('still measures the real complexity under %s', async (_name, source) => {
    const result = await measureSource(source, 2)
    expect(result.problems).toEqual([])
    expect(result.functions.map((f) => f.cc)).toEqual([3])
  })

  it('still fails closed on a parse error', async () => {
    const result = await measureSource(`/* eslint-disable */\nexport const = (\n`, 1)
    expect(result.problems).toHaveLength(1)
    expect(result.problems[0].message).toContain('Parsing error')
  })

  const problemsOf = (m: ReturnType<typeof message>) =>
    measure([{ filePath: '/fake/repo/src/a.ts', messages: [m] }], {}, '/fake/repo', () => '').problems.length

  it('ignores the notice as ESLint emits it', () => {
    expect(problemsOf(message(NOTICE('/* eslint-disable */')))).toBe(0)
    expect(problemsOf(message(NOTICE('// eslint-disable-next-line a/b')))).toBe(0)
    expect(problemsOf(message(NOTICE('/* eslint a: off,\n b: off */')))).toBe(0)
  })

  it.each([
    ['a fatal message with the notice text', message(NOTICE('/* eslint-disable */'), { fatal: true, severity: 2 })],
    ['an error severity', message(NOTICE('/* eslint-disable */'), { severity: 2 })],
    ['a rule id', message(NOTICE('/* eslint-disable */'), { ruleId: 'no-unused-vars' })],
    ['a prefix before the notice', message(`Parsing error: ${NOTICE('/* eslint-disable */')}`)],
    ['a suffix after the notice', message(`${NOTICE('/* eslint-disable */')} Extra.`)],
    ['another config name', message(NOTICE('/* eslint-disable */').replace('your config', 'my-config.js'))],
    ['a different setting', message("'/* eslint-disable */' has no effect because you have 'other' setting in your config.")],
    ['an unused directive report', message("Unused eslint-disable directive (no problems were reported from 'complexity').")],
    ['another null rule id message', message('Definition for rule "x" not found.')],
    ['a non-complexity rule', message("'x' is assigned a value but never used.", { ruleId: 'no-unused-vars' })],
  ])('still fails closed on %s', (_name, m) => {
    expect(problemsOf(m)).toBe(1)
  })
})
