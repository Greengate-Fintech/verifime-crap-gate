import { execFileSync } from 'child_process'
import path from 'path'

// dist/ is generated and not committed on main, so the suites that run the bundle need a fresh one.
// Vitest runs this once per run, before any test file, for every entry point (npm test, test:coverage,
// npx vitest), which a `pretest` script would not cover.
export default function setup(): void {
  execFileSync(process.execPath, ['build.mjs'], { cwd: path.join(__dirname, '..'), stdio: 'inherit' })
}
