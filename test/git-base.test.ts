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

  it('throws outside a git repository', () => {
    expect(() => readBaseFile(tempRoot('crap-nogit'), 'HEAD^1', 'crap/baseline.tsv')).toThrow()
  })

  it('does not treat a revision that looks like an option as an option', () => {
    expect(() => readBaseFile(repo(), '--output=/dev/null', 'crap/baseline.tsv')).toThrow(/--output=\/dev\/null/)
  })
})
