import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { CONFIG_DISPLAY, DEFAULT_CONFIG, loadConfig, parseConfig } from '../src/config'

describe('DEFAULT_CONFIG', () => {
  it('holds the values of the original gate', () => {
    expect(DEFAULT_CONFIG).toEqual({
      scope: ['src', 'lib', 'bin', 'cdk/src', 'cdk/lib', 'cdk/bin'],
      anchors: ['src', 'lib', 'bin', 'cdk'],
      extensions: ['.ts'],
      exclude: [],
      coverage: ['coverage/coverage-final.json', 'cdk/coverage/coverage-final.json'],
      threshold: 8,
    })
  })
})

describe('parseConfig: defaults', () => {
  it('returns every default for an empty object', () => {
    expect(parseConfig('{}')).toEqual(DEFAULT_CONFIG)
  })

  it('returns a copy, so a caller cannot change the defaults', () => {
    parseConfig('{}').scope.push('extra')
    expect(DEFAULT_CONFIG.scope).toHaveLength(6)
  })
})

describe('parseConfig: valid values', () => {
  it.each([
    ['scope', ['packages/api/src'], ['packages/api/src']],
    ['scope', ['src/', 'lib//'], ['src', 'lib']],
    ['anchors', ['app'], ['app']],
    ['extensions', ['.ts', '.tsx'], ['.ts', '.tsx']],
    ['exclude', ['^src/legacy/', '\\.gen\\.ts$'], ['^src/legacy/', '\\.gen\\.ts$']],
    ['coverage', ['out/cov.json'], ['out/cov.json']],
    ['threshold', 12.5, 12.5],
  ])('accepts %s', (key, value, expected) => {
    expect(parseConfig(JSON.stringify({ [key]: value }))[key as keyof typeof DEFAULT_CONFIG]).toEqual(expected)
  })

  it('keeps the other keys at their defaults', () => {
    expect(parseConfig('{"threshold": 3}')).toEqual({ ...DEFAULT_CONFIG, threshold: 3 })
  })
})

describe('parseConfig: failures', () => {
  const failure = (text: string): string => {
    try {
      parseConfig(text)
    } catch (e) {
      return e instanceof Error ? e.message : String(e)
    }
    return ''
  }

  it('fails on malformed JSON, naming the file', () => {
    expect(failure('{')).toBe(`Unreadable ${CONFIG_DISPLAY} (not valid JSON)`)
  })

  it.each(['[]', '"x"', '3', 'null'])('fails when the top level is %s', (text) => {
    expect(failure(text)).toBe(`Invalid ${CONFIG_DISPLAY}: must be a JSON object`)
  })

  it('fails on an unknown key, naming it', () => {
    expect(failure('{"scop": ["src"]}')).toBe(`Invalid ${CONFIG_DISPLAY}: unknown key "scop"`)
  })

  it('does not treat an inherited property name as a known key', () => {
    expect(failure('{"toString": 1}')).toBe(`Invalid ${CONFIG_DISPLAY}: unknown key "toString"`)
  })

  it.each([
    ['scope', '"src"'],
    ['scope', '[1]'],
    ['anchors', '{}'],
    ['extensions', '[true]'],
    ['exclude', '"x"'],
    ['coverage', '[null]'],
  ])('fails when %s is %s', (key, value) => {
    expect(failure(`{"${key}": ${value}}`)).toBe(`Invalid ${CONFIG_DISPLAY}: key "${key}" must be an array of strings`)
  })

  it.each(['"8"', 'true', 'null', '[8]'])('fails when threshold is %s', (value) => {
    expect(failure(`{"threshold": ${value}}`)).toBe(
      `Invalid ${CONFIG_DISPLAY}: key "threshold" must be a number greater than 0`,
    )
  })

  it.each(['0', '-1'])('fails when threshold is %s', (value) => {
    expect(failure(`{"threshold": ${value}}`)).toContain('key "threshold" must be a number greater than 0')
  })

  it('fails on a threshold that is not finite', () => {
    expect(failure('{"threshold": 1e999}')).toContain('key "threshold" must be a number greater than 0')
  })

  it.each(['scope', 'anchors', 'extensions', 'coverage'])('rejects an empty %s', (key) => {
    expect(failure(`{"${key}": []}`)).toBe(`Invalid ${CONFIG_DISPLAY}: key "${key}" must not be empty`)
  })

  it('accepts an empty exclude', () => {
    expect(failure('{"exclude": []}')).toBe('')
  })

  it.each(['', '/abs', '..', 'a/../b', './src', 'a\\b', '.'])('rejects scope entry %j', (entry) => {
    expect(failure(JSON.stringify({ scope: [entry] }))).toBe(
      `Invalid ${CONFIG_DISPLAY}: key "scope" entry ${JSON.stringify(entry)} must be a repo-relative directory`,
    )
  })

  it.each(['', 'a/b', 'a\\b'])('rejects anchor %j', (entry) => {
    expect(failure(JSON.stringify({ anchors: [entry] }))).toBe(
      `Invalid ${CONFIG_DISPLAY}: key "anchors" entry ${JSON.stringify(entry)} must be one path segment name`,
    )
  })

  it.each(['ts', '.', 'a.ts', '.a/b'])('rejects extension %j', (entry) => {
    expect(failure(JSON.stringify({ extensions: [entry] }))).toBe(
      `Invalid ${CONFIG_DISPLAY}: key "extensions" entry ${JSON.stringify(entry)} must start with a dot, as in ".ts"`,
    )
  })

  it('rejects an exclude entry that is not a regular expression', () => {
    expect(failure('{"exclude": ["("]}')).toBe(
      `Invalid ${CONFIG_DISPLAY}: key "exclude" entry "(" is not a valid regular expression`,
    )
  })

  it('rejects an empty coverage path', () => {
    expect(failure('{"coverage": [""]}')).toBe(`Invalid ${CONFIG_DISPLAY}: key "coverage" entry "" must not be empty`)
  })
})

describe('loadConfig', () => {
  const tempRoot = (): string => realpathSync(mkdtempSync(path.join(os.tmpdir(), 'crap-config-')))

  it('returns the defaults when the file is missing', () => {
    expect(loadConfig(tempRoot())).toEqual(DEFAULT_CONFIG)
  })

  it('reads crap/config.json under the root', () => {
    const root = tempRoot()
    mkdirSync(path.join(root, 'crap'))
    writeFileSync(path.join(root, 'crap/config.json'), '{"threshold": 5}')
    expect(loadConfig(root)).toEqual({ ...DEFAULT_CONFIG, threshold: 5 })
  })

  it('fails on an invalid file', () => {
    const root = tempRoot()
    mkdirSync(path.join(root, 'crap'))
    writeFileSync(path.join(root, 'crap/config.json'), '{"nope": 1}')
    expect(() => loadConfig(root)).toThrow(`Invalid ${CONFIG_DISPLAY}: unknown key "nope"`)
  })

  it('fails when the path is not a readable file', () => {
    const root = tempRoot()
    mkdirSync(path.join(root, 'crap/config.json'), { recursive: true })
    expect(() => loadConfig(root)).toThrow(`Cannot read ${CONFIG_DISPLAY}`)
  })
})
