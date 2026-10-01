// The flat config the in-process run must equal, written as a file for the real ESLint binary.
import tseslint from 'typescript-eslint'

export default [
  {
    ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**', '**/*.d.ts', '**/cdk.out/**'],
  },
  {
    files: ['**/*.ts'],
    languageOptions: { parser: tseslint.parser },
    linterOptions: { reportUnusedDisableDirectives: 'off', noInlineConfig: true },
    rules: { complexity: ['warn', { max: 0 }] },
  },
]
