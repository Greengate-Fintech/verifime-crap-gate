import { describe, expect, it } from 'vitest'
import { runCli } from '../src/cli'
import { commitAll, inDirectory, initRepo, makeIo, tempRoot, writeFileIn } from './helpers/sandbox'

const HEADER = '# header\n'
const row = (symbol: string, score: string): string => `src/a.ts\t${symbol}\t${score}\n`

interface Files {
  baseline?: string
  unmatched?: string
}

const writeFiles = (root: string, files: Files): void => {
  if (files.baseline !== undefined) writeFileIn(root, 'crap/baseline.tsv', files.baseline)
  if (files.unmatched !== undefined) writeFileIn(root, 'crap/unmatched.tsv', files.unmatched)
}

/** Two commits: `base` then `head` (the merge commit's first parent is the base). */
const repoWith = (base: Files, head: Files): string => {
  const root = tempRoot('crap-diff')
  initRepo(root)
  writeFileIn(root, 'README.md', 'x\n')
  writeFiles(root, base)
  commitAll(root, 'base')
  writeFiles(root, head)
  writeFileIn(root, 'README.md', 'y\n')
  commitAll(root, 'head')
  return root
}

const runDiff = async (root: string, argv: string[] = ['diff']) => {
  const out = makeIo()
  const code = await inDirectory(root, () => runCli(argv, {}, root, out.io))
  return { code, logs: out.logs, errors: out.errors }
}

const BASE = { baseline: HEADER + row('f', '10.000'), unmatched: '# header\nsrc/a.ts\tg\n' }

describe('diff reads the base with git', () => {
  it('passes when neither file grew, naming the revision-free comparison', async () => {
    const root = repoWith(BASE, { baseline: HEADER + row('f', '9.000'), unmatched: BASE.unmatched })
    const r = await runDiff(root)
    expect(r.code).toBe(0)
    expect(r.logs).toEqual(['CRAP baseline diff: pass (no baseline growth against the base; no unmatched list growth against the base)'])
  })

  it('fails on baseline growth against the base and reports the grown row', async () => {
    const root = repoWith(BASE, { baseline: HEADER + row('f', '12.000'), unmatched: BASE.unmatched })
    const r = await runDiff(root)
    expect(r.code).toBe(1)
    expect(r.errors[0]).toBe('CRAP baseline diff: GROWN src/a.ts#f grew from 10.0 in the base to 12.0')
    expect(r.errors.at(-1)).toBe('CRAP baseline diff: fail (1 row grew compared with the base; the reviewer decides)')
  })

  it('fails on a new unmatched entry', async () => {
    const root = repoWith(BASE, { baseline: BASE.baseline, unmatched: '# header\nsrc/a.ts\tg\nsrc/a.ts\th\n' })
    const r = await runDiff(root)
    expect(r.code).toBe(1)
    expect(r.errors[0]).toContain('GROWN src/a.ts#h is a new unmatched entry')
  })

  it('passes with a note when the base has no crap/baseline.tsv (initial freeze)', async () => {
    const root = repoWith({}, { baseline: HEADER + row('f', '10.000'), unmatched: BASE.unmatched })
    const r = await runDiff(root)
    expect(r.code).toBe(0)
    expect(r.logs).toEqual([
      'CRAP baseline diff: pass (no baseline on the base, nothing to compare: HEAD^1:crap/baseline.tsv; no unmatched list on the base, nothing to compare: HEAD^1:crap/unmatched.tsv)',
    ])
  })

  it('compares the baseline but not the list when the base lacks only crap/unmatched.tsv', async () => {
    const root = repoWith({ baseline: BASE.baseline }, { baseline: BASE.baseline, unmatched: BASE.unmatched })
    const r = await runDiff(root)
    expect(r.code).toBe(0)
    expect(r.logs[0]).toContain('no baseline growth against the base')
    expect(r.logs[0]).toContain('no unmatched list on the base, nothing to compare: HEAD^1:crap/unmatched.tsv')
  })

  it('still fails baseline growth when the base lacks only crap/unmatched.tsv', async () => {
    const root = repoWith({ baseline: BASE.baseline }, { baseline: HEADER + row('f', '11.000'), unmatched: BASE.unmatched })
    expect((await runDiff(root)).code).toBe(1)
  })

  it('takes the base from --base-ref', async () => {
    const root = repoWith(BASE, { baseline: HEADER + row('f', '12.000'), unmatched: BASE.unmatched })
    expect((await runDiff(root, ['diff', '--base-ref', 'HEAD'])).code).toBe(0)
    expect((await runDiff(root, ['diff', '--base-ref', 'HEAD~1'])).code).toBe(1)
  })

  it('exits 1 on a bad revision and says which', async () => {
    const root = repoWith(BASE, BASE)
    const r = await runDiff(root, ['diff', '--base-ref', 'no-such-rev'])
    expect(r.code).toBe(1)
    expect(r.errors.join('\n')).toContain('no-such-rev')
    expect(r.logs).toEqual([])
  })

  it('exits 1 outside a git repository', async () => {
    const root = tempRoot('crap-diff-nogit')
    writeFiles(root, BASE)
    expect((await runDiff(root)).code).toBe(1)
  })

  it('exits 1 when the head baseline is missing', async () => {
    const root = tempRoot('crap-diff-nohead')
    initRepo(root)
    writeFileIn(root, 'a', '1')
    commitAll(root, 'one')
    writeFileIn(root, 'a', '2')
    commitAll(root, 'two')
    const r = await runDiff(root)
    expect(r.code).toBe(1)
    expect(r.errors.join('\n')).toContain('Missing baseline input')
  })

  it('exits 1 when the base baseline is malformed', async () => {
    const root = repoWith({ baseline: 'not a row\n', unmatched: BASE.unmatched }, BASE)
    const r = await runDiff(root)
    expect(r.code).toBe(1)
    expect(r.errors.join('\n')).toContain('HEAD^1:crap/baseline.tsv')
  })

  it('rejects --base-ref combined with the file flags, and a missing value', async () => {
    const root = repoWith(BASE, BASE)
    expect((await runDiff(root, ['diff', '--base-ref', 'HEAD', '--base', 'x.tsv'])).code).toBe(1)
    expect((await runDiff(root, ['diff', '--base-ref'])).code).toBe(1)
    expect((await runDiff(root, ['diff', '--base-ref', 'HEAD', '--base-ref', 'HEAD'])).code).toBe(1)
  })

  it('keeps the file-path flags working', async () => {
    const root = repoWith(BASE, BASE)
    const r = await runDiff(root, ['diff', '--base', 'crap/baseline.tsv', '--base-unmatched', 'crap/unmatched.tsv'])
    expect(r.code).toBe(0)
  })
})
