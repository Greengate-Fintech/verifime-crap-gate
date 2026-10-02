import { spawnSync } from 'child_process'
import { cpSync, existsSync, readFileSync, symlinkSync } from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { tempRoot, writeFileIn } from './helpers/sandbox'

const ROOT = path.join(__dirname, '..')

/** A copy of the build inputs, with the dependencies linked, an old dist/, and keyv's supplied licence removed. */
const brokenBuild = (): string => {
  const root = tempRoot('crap-build')
  for (const name of ['build.mjs', 'package.json', 'src']) cpSync(path.join(ROOT, name), path.join(root, name), { recursive: true })
  symlinkSync(path.join(ROOT, 'node_modules'), path.join(root, 'node_modules'))
  const texts = readFileSync(path.join(ROOT, 'licence-texts.mjs'), 'utf8')
  writeFileIn(root, 'licence-texts.mjs', texts.replace(/^ {2}keyv: \{/m, '  keyvRemoved: {'))
  writeFileIn(root, 'dist/cli.cjs', 'previous build\n')
  return root
}

describe('build.mjs', () => {
  // Starts esbuild on the whole toolchain, so allow for a slow runner.
  it('fails naming a bundled package that has no licence text, and leaves dist/ as it was', { timeout: 60_000 }, () => {
    const root = brokenBuild()
    const r = spawnSync(process.execPath, ['build.mjs'], { cwd: root, encoding: 'utf8' })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('keyv@')
    expect(r.stderr).toContain('no entry in licence-texts.mjs')
    expect(readFileSync(path.join(root, 'dist/cli.cjs'), 'utf8')).toBe('previous build\n')
    expect(existsSync(path.join(root, 'dist/action.cjs'))).toBe(false)
    expect(existsSync(path.join(root, 'dist.tmp'))).toBe(false)
  })
})
