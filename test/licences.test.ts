import { readFileSync } from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'

// The bundle redistributes other people's code, so each package's own copyright and permission
// text must travel with it. These checks read the committed licences file.

const FILE = path.join(__dirname, '..', 'dist', 'THIRD-PARTY-LICENSES.txt')
const text = readFileSync(FILE, 'utf8')
const sections = text.split(/^={72}\n/m).slice(1)

const sectionOf = (name: string): string => {
  const found = sections.find((s) => s.startsWith(`${name}@`))
  if (found === undefined) throw new Error(`no section for ${name}`)
  return found
}

const PERMISSION = /Permission is hereby granted|Permission to use, copy, modify|Redistribution and use in source and binary forms|Apache License|Blue Oak Model License/

describe('dist/THIRD-PARTY-LICENSES.txt', () => {
  it.each([
    'eslint',
    'typescript',
    '@typescript-eslint/parser',
    '@typescript-eslint/typescript-estree',
    'espree',
    'esrecurse',
    'imurmurhash',
    'keyv',
    'natural-compare',
  ])('carries the licence text and a copyright line for %s', (name) => {
    const section = sectionOf(name)
    expect(section).toMatch(PERMISSION)
    expect(section).toMatch(/Copyright|\(c\)|Microsoft/i)
  })

  it('has no placeholder section', () => {
    expect(text).not.toContain('The package has no licence file')
    expect(text).not.toContain('none declared')
    expect(sections.every((s) => PERMISSION.test(s))).toBe(true)
  })

  it('marks the text this repository supplied, with where its copyright line came from', () => {
    expect(sectionOf('keyv')).toContain('This text is supplied by this repository; the copyright line is from')
  })
})
