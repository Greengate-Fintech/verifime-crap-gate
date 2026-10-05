import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    // Builds dist/ for the bundle and licence tests (dist/ is not committed on main).
    globalSetup: ['./test/global-setup.ts'],
    // test/fixtures/vitest-versions is a synthetic package with its own tests, run only to make its coverage files.
    exclude: ['**/node_modules/**', '**/dist/**', '.worktrees/**', 'test/fixtures/**'],
    coverage: {
      provider: 'v8',
      // Istanbul-format JSON, the input the gate reads. `include` lists unloaded source files too.
      reporter: ['json'],
      include: ['src/**/*.ts'],
    },
  },
})
