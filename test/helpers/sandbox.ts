import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'
import { afterAll } from 'vitest'

export const FIXTURES = path.join(__dirname, '..', 'fixtures')

const created: string[] = []

// Every directory a test file makes is removed when that file finishes.
afterAll(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

export const tempRoot = (prefix: string): string => {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), `${prefix}-`)))
  created.push(dir)
  return dir
}

export const writeFileIn = (root: string, rel: string, text: string): void => {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
  writeFileSync(path.join(root, rel), text)
}

export const readFixture = (name: string): string => readFileSync(path.join(FIXTURES, name), 'utf8')

export const makeIo = () => {
  const logs: string[] = []
  const errors: string[] = []
  return { logs, errors, io: { log: (s: string) => logs.push(s), error: (s: string) => errors.push(s) } }
}

const GIT_IDENTITY = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null']

export const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', [...GIT_IDENTITY, ...args], { cwd, encoding: 'utf8' })

export const initRepo = (root: string): void => {
  git(root, 'init', '-q', '-b', 'work')
}

export const commitAll = (root: string, message: string): void => {
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', message)
}

/** A function with two branch points: complexity 3 (two ifs), on lines 1 to 9. */
export const CC3_SOURCE = `export function busy(a: number, b: number): number {
  if (a > 1) {
    return a
  }
  if (b > 1) {
    return b
  }
  return 0
}
`

/** Istanbul coverage for CC3_SOURCE's `busy` at the given absolute path, never called. */
export const cc3Coverage = (absPath: string): string => {
  const span = { start: { line: 1, column: 0 }, end: { line: 9, column: 1 } }
  const entry = {
    path: absPath,
    statementMap: {},
    s: {},
    fnMap: { '0': { name: 'busy', decl: span, loc: span } },
    f: { '0': 0 },
    branchMap: {},
    b: {},
  }
  return JSON.stringify({ [absPath]: entry })
}

/**
 * Runs `fn` with the process working directory set to `root`. The gate reads and writes its
 * `crap/` and `coverage/` files relative to the directory it runs in, as it did when copied.
 */
export const inDirectory = async <T>(root: string, fn: () => Promise<T>): Promise<T> => {
  const original = process.cwd()
  process.chdir(root)
  try {
    return await fn()
  } finally {
    process.chdir(original)
  }
}
