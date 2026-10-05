import path from 'path'
import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../src/config'
import type { CrapConfig } from '../src/config'
import { lintScope } from '../src/eslint'
import type { EslintFileResult } from '../src/types'
import { readFixture, tempRoot, writeFileIn } from './helpers/sandbox'

// The companion rule wraps ESLint's own `complexity` rule, so each span is reported at the
// position, and with the text, of the complexity message it belongs to. It reads the rule from
// `eslint/use-at-your-own-risk`, which ESLint may change in any release: re-check this file when
// ESLint is bumped.

const VERSIONS_PACKAGE = path.join(__dirname, 'fixtures', 'vitest-versions')

const keyOf = (p: { line: number; column: number; message: string }): string => `${p.line}:${p.column} ${p.message}`

/** For each file: its complexity messages and its spans, as sorted comparable keys. */
const pairsOf = (results: readonly EslintFileResult[]) =>
  results.map((r) => ({
    messages: r.messages.filter((m) => m.ruleId === 'complexity').map(keyOf).sort(),
    spans: (r.spans ?? []).map(keyOf).sort(),
  }))

describe('function spans from the lint pass', () => {
  it('runs on the bundled ESLint the companion rule was checked against', () => {
    expect(ESLint.version).toBe('9.39.1')
  })

  it('gives every complexity message exactly one span, at its position and with its text', async () => {
    const root = tempRoot('crap-spans')
    writeFileIn(root, 'src/sample.ts', readFixture('sample.ts'))
    const config: CrapConfig = { ...DEFAULT_CONFIG, extensions: ['.ts', '.tsx'] }
    for (const results of [await lintScope(root, DEFAULT_CONFIG), await lintScope(VERSIONS_PACKAGE, config)]) {
      for (const { messages, spans } of pairsOf(results)) {
        expect(spans).toEqual(messages)
      }
      expect(results.flatMap((r) => r.spans ?? [])).not.toHaveLength(0)
    }
  })

  it('adds no message of its own to the lint results', async () => {
    const root = tempRoot('crap-spans')
    writeFileIn(root, 'src/sample.ts', readFixture('sample.ts'))
    const [result] = await lintScope(root, DEFAULT_CONFIG)
    expect(new Set(result.messages.map((m) => m.ruleId))).toEqual(new Set(['complexity']))
  })
})
