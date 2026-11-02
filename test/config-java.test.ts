import { describe, expect, it } from 'vitest'
import { CONFIG_DISPLAY, DEFAULT_CONFIG, parseConfig } from '../src/config'

// The v1.1.0 configuration, written out in full. Nothing may drift from it for a config with no
// `language` key: the TypeScript defaults are the contract of every existing consumer.
const V1_1_0_DEFAULTS = {
  scope: ['src', 'lib', 'bin', 'cdk/src', 'cdk/lib', 'cdk/bin'],
  anchors: ['src', 'lib', 'bin', 'cdk'],
  extensions: ['.ts'],
  exclude: [],
  coverage: ['coverage/coverage-final.json', 'cdk/coverage/coverage-final.json'],
  threshold: 8,
}

const failure = (text: string): string => {
  try {
    parseConfig(text)
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
  return ''
}

const JAVA = { language: 'java', scope: ['app/src/main/java'], coverage: ['app/build/jacoco.xml'] }
const javaWithout = (key: string): string =>
  JSON.stringify(Object.fromEntries(Object.entries(JAVA).filter(([k]) => k !== key)))

describe('a config with no language key is the v1.1.0 config (TypeScript)', () => {
  it('parses an empty object to exactly the v1.1.0 object, with no language key', () => {
    expect(parseConfig('{}')).toStrictEqual(V1_1_0_DEFAULTS)
    expect(Object.keys(parseConfig('{}'))).not.toContain('language')
  })

  it('leaves the default object without a language key', () => {
    expect(DEFAULT_CONFIG).toStrictEqual(V1_1_0_DEFAULTS)
  })

  it('changes only the keys the file sets', () => {
    expect(parseConfig('{"threshold": 3, "scope": ["packages/x/src/"]}')).toStrictEqual({
      ...V1_1_0_DEFAULTS,
      threshold: 3,
      scope: ['packages/x/src'],
      scopeFrom: CONFIG_DISPLAY,
    })
  })

  it('treats "typescript" as the same defaults, recording the key', () => {
    expect(parseConfig('{"language": "typescript"}')).toStrictEqual({ ...V1_1_0_DEFAULTS, language: 'typescript' })
  })
})

describe('language: invalid values', () => {
  it.each(['"kotlin"', '"Java"', '"JAVA"', '""', '1', 'true', 'null', '["java"]', '{}'])('rejects %s', (value) => {
    expect(failure(`{"language": ${value}}`)).toBe(`Invalid ${CONFIG_DISPLAY}: key "language" must be "typescript" or "java"`)
  })
})

describe('language: java', () => {
  it('defaults extensions to .java, and keeps the other TypeScript-independent defaults', () => {
    expect(parseConfig(JSON.stringify(JAVA))).toStrictEqual({
      language: 'java',
      scope: ['app/src/main/java'],
      scopeFrom: CONFIG_DISPLAY,
      coverage: ['app/build/jacoco.xml'],
      extensions: ['.java'],
      exclude: [],
      threshold: 8,
      anchors: V1_1_0_DEFAULTS.anchors,
    })
  })

  it('lets the file set extensions, exclude and threshold', () => {
    const config = parseConfig(JSON.stringify({ ...JAVA, extensions: ['.java', '.kt'], exclude: ['/generated/'], threshold: 5 }))
    expect(config).toMatchObject({ extensions: ['.java', '.kt'], exclude: ['/generated/'], threshold: 5 })
  })

  it('trims trailing slashes from scope, as for TypeScript', () => {
    expect(parseConfig(JSON.stringify({ ...JAVA, scope: ['a/src/main/java/', 'b/src/main/java//'] })).scope).toEqual([
      'a/src/main/java',
      'b/src/main/java',
    ])
  })

  it('has no default scope: it must be set', () => {
    expect(failure(javaWithout('scope'))).toBe(`Invalid ${CONFIG_DISPLAY}: key "scope" is required when "language" is "java"`)
  })

  it('has no default coverage: it must be set', () => {
    expect(failure(javaWithout('coverage'))).toBe(`Invalid ${CONFIG_DISPLAY}: key "coverage" is required when "language" is "java"`)
  })

  it('names scope first when both are missing', () => {
    expect(failure('{"language": "java"}')).toBe(`Invalid ${CONFIG_DISPLAY}: key "scope" is required when "language" is "java"`)
  })

  it('still applies the existing checks to the keys it requires', () => {
    expect(failure(JSON.stringify({ ...JAVA, scope: [] }))).toBe(`Invalid ${CONFIG_DISPLAY}: key "scope" must not be empty`)
    expect(failure(JSON.stringify({ ...JAVA, coverage: [''] }))).toBe(
      `Invalid ${CONFIG_DISPLAY}: key "coverage" entry "" must not be empty`,
    )
  })

  it('accepts anchors and ignores them', () => {
    expect(parseConfig(JSON.stringify({ ...JAVA, anchors: ['app'] })).anchors).toEqual(['app'])
  })

  it('does not require scope or coverage for TypeScript', () => {
    expect(() => parseConfig('{"language": "typescript", "threshold": 4}')).not.toThrow()
  })

  it('reports an invalid key before a missing required key', () => {
    expect(failure('{"language": "java", "threshold": -1}')).toBe(
      `Invalid ${CONFIG_DISPLAY}: key "threshold" must be a number greater than 0`,
    )
  })
})
