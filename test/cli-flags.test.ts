import { existsSync, readFileSync } from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { runCli } from '../src/cli'
import { cc3Coverage, CC3_SOURCE, inDirectory, makeIo, tempRoot, writeFileIn } from './helpers/sandbox'

const ONE_COVERAGE = JSON.stringify({ coverage: ['coverage/coverage-final.json'] })

const project = (): string => {
  const root = tempRoot('crap-flags')
  writeFileIn(root, 'crap/config.json', ONE_COVERAGE)
  writeFileIn(root, 'src/busy.ts', CC3_SOURCE)
  writeFileIn(root, 'coverage/coverage-final.json', cc3Coverage(path.join(root, 'src/busy.ts')))
  return root
}

const run = async (root: string, ...argv: string[]) => {
  const out = makeIo()
  const code = await inDirectory(root, () => runCli(argv, {}, root, out.io))
  return { code, logs: out.logs, errors: out.errors }
}

const read = (root: string, rel: string): string => readFileSync(path.join(root, rel), 'utf8')

describe('--config', () => {
  it('reads the named file instead of crap/config.json', async () => {
    const root = project()
    writeFileIn(root, 'conf/gate.json', JSON.stringify({ coverage: ['coverage/coverage-final.json'], threshold: 20 }))
    const r = await run(root, 'measure', '--config', 'conf/gate.json')
    expect(r.logs).toEqual(['CRAP measure: functions=1 over5=0 sumOver5=0.0 unmatched=0'])
  })

  it('may come before the command', async () => {
    const root = project()
    writeFileIn(root, 'conf/gate.json', JSON.stringify({ coverage: ['coverage/coverage-final.json'], threshold: 20 }))
    const r = await run(root, '--config', 'conf/gate.json', 'measure')
    expect(r.code).toBe(0)
    expect(r.logs[0]).toContain('over5=0')
  })

  it('fails when a named file is missing, naming it', async () => {
    const r = await run(project(), 'measure', '--config', 'conf/none.json')
    expect(r.code).toBe(1)
    expect(r.errors).toEqual(['Cannot read conf/none.json (ENOENT)'])
  })

  it('names the given path when the file is invalid', async () => {
    const root = project()
    writeFileIn(root, 'conf/gate.json', '{"scoop": []}')
    const r = await run(root, 'measure', '--config', 'conf/gate.json')
    expect(r.code).toBe(1)
    expect(r.errors).toEqual(['Invalid conf/gate.json: unknown key "scoop"'])
  })

  it('treats the default path as optional, as before', async () => {
    const root = tempRoot('crap-flags-default')
    const r = await run(root, 'measure', '--config', 'crap/config.json')
    expect(r.errors.join('\n')).not.toContain('Cannot read')
  })

  it('is a usage error when repeated', async () => {
    const r = await run(project(), 'measure', '--config', 'a.json', '--config', 'b.json')
    expect(r.code).toBe(1)
    expect(r.errors[0]).toContain('Duplicate flag: --config')
  })

  it('is a usage error without a value', async () => {
    const r = await run(project(), 'measure', '--config')
    expect(r.code).toBe(1)
    expect(r.errors[0]).toContain('Missing value for --config')
  })
})

describe('baseline --output-dir', () => {
  it('writes both files to the directory and leaves crap/ untouched', async () => {
    const root = project()
    const r = await run(root, 'baseline', '--output-dir', 'out')
    expect(r.code).toBe(0)
    expect(read(root, 'out/baseline.tsv')).toContain('src/busy.ts\tbusy\t12.000\n')
    expect(existsSync(path.join(root, 'out/unmatched.tsv'))).toBe(true)
    expect(existsSync(path.join(root, 'crap/baseline.tsv'))).toBe(false)
    expect(r.logs.slice(1)).toEqual([
      `CRAP baseline: wrote 1 rows to ${path.join('out', 'baseline.tsv')}`,
      `CRAP baseline: wrote 0 unmatched rows to ${path.join('out', 'unmatched.tsv')}`,
    ])
  })

  it('still refuses growth against crap/baseline.tsv and writes nothing', async () => {
    const root = project()
    writeFileIn(root, 'crap/baseline.tsv', '# empty\nsrc/other.ts\tz\t9.000\n')
    const r = await run(root, 'baseline', '--output-dir', 'out')
    expect(r.code).toBe(1)
    expect(r.errors.join('\n')).toContain('refusing to grow the baseline')
    expect(existsSync(path.join(root, 'out'))).toBe(false)
  })

  it('is a usage error without a value', async () => {
    const r = await run(project(), 'baseline', '--output-dir')
    expect(r.code).toBe(1)
    expect(r.errors[0]).toContain('Missing value for --output-dir')
  })

  it('is rejected by the other commands', async () => {
    const r = await run(project(), 'check', '--output-dir', 'out')
    expect(r.code).toBe(1)
    expect(r.errors[0]).toContain('Unknown flag for check: --output-dir')
  })

  it('combines with --allow-growth', async () => {
    const root = project()
    writeFileIn(root, 'crap/baseline.tsv', '# empty\nsrc/other.ts\tz\t9.000\n')
    const r = await run(root, 'baseline', '--allow-growth', '--output-dir', 'out')
    expect(r.code).toBe(0)
    expect(read(root, 'crap/baseline.tsv')).toBe('# empty\nsrc/other.ts\tz\t9.000\n')
  })
})
