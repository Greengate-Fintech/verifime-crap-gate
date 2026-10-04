import { spawnSync } from 'child_process'
import { builtinModules } from 'module'
import { cpSync, existsSync, readFileSync, rmSync } from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { tempRoot, writeFileIn } from './helpers/sandbox'

// Runs the bundles as processes, the way a consumer does. The Vitest global setup builds dist/ first,
// and a release commits that same build, so these tests exercise what ships.

const ROOT = path.join(__dirname, '..')
const CLI = path.join(ROOT, 'dist', 'cli.cjs')
const ACTION = path.join(ROOT, 'dist', 'action.cjs')
const FIXTURE = path.join(__dirname, 'e2e', 'project')

const MEASURE_LINE = 'CRAP measure: functions=4 over5=2 sumOver5=23.1 unmatched=0'

const copyProject = (): string => {
  const root = tempRoot('crap-bundle')
  cpSync(FIXTURE, root, { recursive: true })
  rmSync(path.join(root, 'coverage', 'crap-report.json'), { force: true })
  return root
}

const node = (script: string, cwd: string, args: string[] = [], env: Record<string, string> = {}) => {
  const r = spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', ...env } })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}

/**
 * A consumer with TypeScript 7 (which typescript-eslint cannot use), its own ESLint, and a config
 * that would change the results if the gate read it.
 */
const hostileProject = (): string => {
  const root = copyProject()
  for (const name of ['typescript', 'eslint', 'typescript-eslint']) {
    writeFileIn(root, `node_modules/${name}/package.json`, JSON.stringify({ name, version: '7.0.0', main: 'index.js' }))
    writeFileIn(root, `node_modules/${name}/index.js`, `throw new Error('consumer ${name} must not be loaded')\n`)
  }
  writeFileIn(root, 'eslint.config.mjs', 'export default [{ ignores: ["**/*"] }]\n')
  writeFileIn(root, '.eslintrc.json', '{ "root": true, "ignorePatterns": ["*"] }\n')
  return root
}

describe('dist/cli.cjs', () => {
  it('measures the fixture project and prints the same summary line as the source', () => {
    const r = node(CLI, copyProject(), ['measure'])
    expect(r.stdout).toBe(`${MEASURE_LINE}\n`)
    expect(r.status).toBe(0)
  })

  it('passes check against the committed baseline', () => {
    const r = node(CLI, copyProject(), ['check'])
    expect(r.stdout).toBe(`${MEASURE_LINE}\nCRAP ratchet: pass (2 frozen, 4 functions measured)\n`)
    expect(r.status).toBe(0)
  })

  it('regenerates the committed baseline files byte for byte', () => {
    const root = copyProject()
    const out = path.join(root, 'regen')
    expect(node(CLI, root, ['baseline', '--output-dir', out]).status).toBe(0)
    for (const file of ['baseline.tsv', 'unmatched.tsv']) {
      expect(readFileSync(path.join(out, file), 'utf8')).toBe(readFileSync(path.join(FIXTURE, 'crap', file), 'utf8'))
    }
  })

  it('has a node shebang and is executable', () => {
    expect(readFileSync(CLI, 'utf8').startsWith('#!/usr/bin/env node\n')).toBe(true)
    expect(spawnSync('test', ['-x', CLI]).status).toBe(0)
  })

  it('requires no module but Node built-ins, so nothing resolves from the consumer', () => {
    const source = readFileSync(CLI, 'utf8')
    const required = [...source.matchAll(/require\(\s*"([^"]+)"\s*\)/g)].map((m) => m[1])
    const outside = [...new Set(required)].filter((name) => !builtinModules.includes(name.replace(/^node:/, '')))
    expect(outside).toEqual([])
  })

  it('ignores the consumer toolchain and ESLint config', () => {
    const clean = node(CLI, copyProject(), ['check'])
    const hostile = node(CLI, hostileProject(), ['check'])
    expect(hostile).toEqual(clean)
    expect(hostile.status).toBe(0)
  })
})

describe('dist/action.cjs', () => {
  const inputs = (mode: string, extra: Record<string, string> = {}) => ({ INPUT_MODE: mode, ...extra })

  it('runs a mode from the inputs, in the working directory, and writes the summary output', () => {
    const root = copyProject()
    const parent = tempRoot('crap-bundle-ws')
    cpSync(root, path.join(parent, 'pkg'), { recursive: true })
    const output = path.join(parent, 'out')
    const r = node(ACTION, parent, [], { ...inputs('check', { 'INPUT_WORKING-DIRECTORY': 'pkg' }), GITHUB_OUTPUT: output })
    expect(r.status).toBe(0)
    expect(r.stdout).toBe(`${MEASURE_LINE}\nCRAP ratchet: pass (2 frozen, 4 functions measured)\n`)
    expect(readFileSync(output, 'utf8')).toBe('summary=CRAP ratchet: pass (2 frozen, 4 functions measured)\n')
  })

  it('ignores the consumer toolchain and ESLint config too', () => {
    const clean = node(ACTION, copyProject(), [], inputs('check'))
    const hostile = node(ACTION, hostileProject(), [], inputs('check'))
    expect(hostile).toEqual(clean)
    expect(hostile.status).toBe(0)
    expect(hostile.stdout).toContain('CRAP ratchet: pass')
  })

  it('exits 1 and emits the annotation for a new offender', () => {
    const r = node(ACTION, copyProject(), [], { ...inputs('check', { INPUT_CONFIG: 'crap/strict.json' }), GITHUB_ACTIONS: 'true' })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('::error file=src/pricing.ts,line=19::CRAP ratchet: NEW OFFENDER src/pricing.ts#tier')
  })

  it('does not run its CLI on require, so the CLI bundle can be loaded as a module', () => {
    expect(existsSync(CLI)).toBe(true)
    const r = spawnSync(process.execPath, ['-e', `const m = require(${JSON.stringify(CLI)}); console.log(typeof m.runCli)`], { encoding: 'utf8' })
    expect(r.stdout).toBe('function\n')
  })
})
