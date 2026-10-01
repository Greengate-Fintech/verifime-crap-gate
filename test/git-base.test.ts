import { rmSync } from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { readBaseFile } from '../src/git'
import { commitAll, git, initRepo, tempRoot, writeFileIn } from './helpers/sandbox'

const repo = (): string => {
  const root = tempRoot('crap-git')
  initRepo(root)
  writeFileIn(root, 'crap/baseline.tsv', 'base text\n')
  commitAll(root, 'base')
  writeFileIn(root, 'crap/baseline.tsv', 'head text\n')
  commitAll(root, 'head')
  return root
}

describe('readBaseFile', () => {
  it('returns the file as committed at the revision, not the working tree', () => {
    expect(readBaseFile(repo(), 'HEAD^1', 'crap/baseline.tsv')).toBe('base text\n')
  })

  it('returns null when the path is absent at the revision', () => {
    expect(readBaseFile(repo(), 'HEAD^1', 'crap/unmatched.tsv')).toBeNull()
  })

  it('returns null when the whole directory is absent at the revision', () => {
    const root = tempRoot('crap-git-nodir')
    initRepo(root)
    writeFileIn(root, 'README.md', 'x\n')
    commitAll(root, 'first')
    expect(readBaseFile(root, 'HEAD', 'crap/baseline.tsv')).toBeNull()
  })

  it('throws, naming the revision, when it does not exist', () => {
    expect(() => readBaseFile(repo(), 'no-such-rev', 'crap/baseline.tsv')).toThrow(/no-such-rev/)
  })

  it('throws when the first parent does not exist (a root commit, or a shallow checkout)', () => {
    const root = repo()
    expect(() => readBaseFile(root, 'HEAD^2', 'crap/baseline.tsv')).toThrow(/HEAD\^2/)
    expect(git(root, 'rev-parse', 'HEAD^1')).toBeTruthy()
  })

  it('throws, naming the failure, when the git program cannot be run', () => {
    const root = repo()
    const original = process.env.PATH
    process.env.PATH = ''
    try {
      expect(() => readBaseFile(root, 'HEAD^1', 'crap/baseline.tsv')).toThrow(/ENOENT/)
    } finally {
      process.env.PATH = original
    }
  })

  it('throws outside a git repository', () => {
    expect(() => readBaseFile(tempRoot('crap-nogit'), 'HEAD^1', 'crap/baseline.tsv')).toThrow()
  })

  it('resolves a revision that looks like an option, as a name and not as an option', () => {
    const root = repo()
    git(root, 'update-ref', 'refs/heads/-dash', 'HEAD^1')
    expect(readBaseFile(root, '-dash', 'crap/baseline.tsv')).toBe('base text\n')
  })

  it('reads a nested package when run from a subdirectory of the git root', () => {
    const root = tempRoot('crap-git-sub')
    initRepo(root)
    writeFileIn(root, 'pkg/crap/baseline.tsv', 'base text\n')
    commitAll(root, 'base')
    writeFileIn(root, 'pkg/crap/baseline.tsv', 'head text\n')
    commitAll(root, 'head')
    const pkg = path.join(root, 'pkg')
    expect(readBaseFile(pkg, 'HEAD^1', 'crap/baseline.tsv')).toBe('base text\n')
    expect(readBaseFile(pkg, 'HEAD^1', 'crap/unmatched.tsv')).toBeNull()
  })

  /** Deletes the loose object `spec` names, so that git can no longer read it. */
  const destroyObject = (root: string, spec: string): void => {
    const id = git(root, 'rev-parse', spec).trim()
    rmSync(path.join(root, '.git', 'objects', id.slice(0, 2), id.slice(2)), { force: true })
  }

  it('throws, and does not report the file absent, when the base tree cannot be read', () => {
    const root = repo()
    destroyObject(root, 'HEAD^1^{tree}')
    expect(() => readBaseFile(root, 'HEAD^1', 'crap/baseline.tsv')).toThrow(/ls-tree/)
  })

  it('throws when the base file itself cannot be read', () => {
    const root = repo()
    destroyObject(root, 'HEAD^1:crap/baseline.tsv')
    expect(() => readBaseFile(root, 'HEAD^1', 'crap/baseline.tsv')).toThrow(/show/)
  })
})
