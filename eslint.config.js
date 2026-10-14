// ESLint flat config. Deliberately small: strict TypeScript (`pnpm typecheck`) is the type gate, and this config only targets
// real bugs (unhandled promises, misused promises, unsafe awaits, unused code). No style rules: formatting is not linted.
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['node_modules/**', 'dist/**', '.cache/**', 'coverage/**', 'public-repo/**', 'src/vendor/**'],
  },
  {
    linterOptions: { reportUnusedDisableDirectives: 'error' },
  },
  js.configs.recommended,
  {
    files: ['**/*.{js,mjs}'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ['**/*.ts'],
    extends: [tseslint.configs.recommended],
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // real bugs around promises
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/return-await': ['error', 'in-try-catch'],
      // unused code is a bug magnet; a leading underscore opts out
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      // the agent parses untrusted JSON, so `any` should be explicit and rare
      '@typescript-eslint/no-explicit-any': 'warn',
      // Node runs the sources directly: no enums, namespaces or parameter properties (also enforced by erasableSyntaxOnly)
      '@typescript-eslint/no-namespace': 'error',
    },
  },
  {
    // tool configuration and monorepo-only tests sit outside the TypeScript project: lint them without type information
    files: ['vitest.config.ts', 'monorepo-tests/**/*.ts'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { parserOptions: { projectService: false } },
  },
);
