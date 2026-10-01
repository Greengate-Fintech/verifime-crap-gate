// Builds dist/cli.cjs, dist/action.cjs and dist/THIRD-PARTY-LICENSES.txt.
//
// The output must be byte-identical on every machine: esbuild is pinned, nothing is stamped with a
// time or an absolute path, and there are no source maps. CI rebuilds and fails on any diff.
import { build } from 'esbuild'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SUPPLIED } from './licence-texts.mjs'

const root = path.dirname(fileURLToPath(import.meta.url))
const dist = path.join(root, 'dist')
// The build writes here, and moves the result to dist/ only when every step has succeeded.
const staging = path.join(root, 'dist.tmp')

// An esbuild warning fails the build unless its text matches an entry here, with the reason.
const ALLOWED_WARNINGS = []

const shared = {
  absWorkingDir: root,
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  legalComments: 'none',
  sourcemap: false,
  minifyWhitespace: true,
  minifySyntax: true,
  logLevel: 'warning',
}

// Two optional modules are replaced by a stub that fails loudly, so that the bundle never looks
// outside itself (a consumer's node_modules must not be reachable). ESLint loads `jiti` only to
// read a TypeScript config file, and the gate passes its own config. TypeScript requires
// `source-map-support` only in `tryEnableSourceMapsForHost` on the `sys` host (the `tsc` driver),
// inside a try block. Search for that name after a TypeScript bump.
const stubbed = /^(jiti|source-map-support)(\/.*)?$/
const stubOptional = {
  name: 'stub-optional',
  setup: (b) => {
    b.onResolve({ filter: stubbed }, (args) => ({ path: args.path, namespace: 'stub-optional' }))
    b.onLoad({ filter: /.*/, namespace: 'stub-optional' }, (args) => ({
      contents: `throw new Error(${JSON.stringify(`${args.path} is not bundled: the gate does not need it`)})`,
      loader: 'js',
    }))
  },
}

const cliBuild = () =>
  build({
    ...shared,
    entryPoints: ['src/cli.ts'],
    outfile: 'dist.tmp/cli.cjs',
    banner: { js: '#!/usr/bin/env node' },
    plugins: [stubOptional],
    metafile: true,
  })

// The action requires the CLI bundle at run time, so ESLint and TypeScript are bundled once.
const externalCli = {
  name: 'external-cli',
  setup: (b) => b.onResolve({ filter: /^\.\/cli$/ }, () => ({ path: './cli.cjs', external: true })),
}

const actionBuild = () =>
  build({ ...shared, entryPoints: ['src/action.ts'], outfile: 'dist.tmp/action.cjs', plugins: [externalCli] })

const LICENCE_FILE = /^(licen[sc]e|notice|thirdpartynotice)/i

/** The package directory (the nearest package.json that has a name) for a bundled input path. */
const packageDir = (input) => {
  let dir = path.dirname(path.join(root, input))
  while (dir !== root) {
    const file = path.join(dir, 'package.json')
    if (existsSync(file) && JSON.parse(readFileSync(file, 'utf8')).name) return dir
    dir = path.dirname(dir)
  }
  throw new Error(`No package.json above ${input}`)
}

const text = (file) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n').trimEnd()

const declaredOf = (meta) => (typeof meta.license === 'string' ? meta.license : JSON.stringify(meta.license ?? 'none declared'))

/** The licence text the package ships, else the entry in licence-texts.mjs, else a build error naming the package. */
const licenceBody = (dir, meta) => {
  const files = readdirSync(dir).filter((f) => LICENCE_FILE.test(f)).sort()
  if (files.length > 0) return files.map((f) => `${f}:\n\n${text(path.join(dir, f))}`).join('\n\n')
  const supplied = SUPPLIED[meta.name]
  if (supplied === undefined) {
    throw new Error(`${meta.name}@${meta.version} is bundled but ships no licence file and has no entry in licence-texts.mjs`)
  }
  if (supplied.licence !== declaredOf(meta)) {
    throw new Error(`${meta.name}@${meta.version} declares ${declaredOf(meta)}, but licence-texts.mjs has ${supplied.licence}`)
  }
  return `(The package ships no licence file. This text is supplied by this repository; the copyright line is from ${supplied.source}.)\n\n${supplied.text}`
}

const licenceSection = (dir) => {
  const meta = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'))
  const body = licenceBody(dir, meta)
  return { key: `${meta.name}@${meta.version}`, text: `${meta.name}@${meta.version}\nDeclared licence: ${declaredOf(meta)}\n\n${body}` }
}

const RULE = '='.repeat(72)

/** One section per package that contributes code to the CLI bundle, sorted by name and version. */
const licences = (metafile) => {
  const dirs = new Set(
    Object.keys(metafile.inputs)
      .filter((input) => input.includes('node_modules/'))
      .map(packageDir),
  )
  const sections = [...dirs].map(licenceSection).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  const intro = 'Third-party code bundled into dist/cli.cjs, with each package\'s licence text.\nGenerated by build.mjs from the esbuild metafile. Do not edit.'
  return `${intro}\n\n${sections.map((s) => `${RULE}\n${s.text}`).join('\n\n')}\n`
}

const failOnWarnings = (...results) => {
  const unexpected = results
    .flatMap((r) => r.warnings)
    .filter((w) => !ALLOWED_WARNINGS.some((allowed) => w.text.includes(allowed.text)))
  if (unexpected.length > 0) throw new Error(`esbuild reported ${unexpected.length} warning(s); see above. Fix them, or allow-list one in build.mjs with a reason.`)
}

try {
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  const [cli, action] = await Promise.all([cliBuild(), actionBuild()])
  failOnWarnings(cli, action)
  writeFileSync(path.join(staging, 'THIRD-PARTY-LICENSES.txt'), licences(cli.metafile))
  chmodSync(path.join(staging, 'cli.cjs'), 0o755)
  rmSync(dist, { recursive: true, force: true })
  renameSync(staging, dist)
} finally {
  rmSync(staging, { recursive: true, force: true })
}
