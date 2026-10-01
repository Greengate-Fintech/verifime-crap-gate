import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    exclude: ['**/node_modules/**', '**/dist/**', '.worktrees/**'],
    coverage: {
      provider: 'v8',
      // Istanbul-format JSON, the input the gate reads. `include` lists unloaded source files too.
      reporter: ['json'],
      include: ['src/**/*.ts'],
    },
  },
})
