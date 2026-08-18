import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

/**
 * Flat config (ESLint 9).
 *
 * Deliberately narrow: type-aware linting is not enabled, because `tsc --noEmit`
 * already runs in CI and covers type correctness far better than lint rules do.
 * What lint adds on top is the class of mistake the compiler accepts — a floating
 * promise, an unused binding, `any` creeping in — so those are what is configured.
 */
export default tseslint.config(
  {
    ignores: ['dist/**', 'dist-web/**', 'coverage/**', 'node_modules/**', 'data/**'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      // An unused parameter is often deliberate (Express error handlers need four
      // arguments), so allow a leading underscore to mark intent.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': 'off', // structured logging goes to stdout by design
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },

  // Server code: Node globals.
  {
    files: [
      'src/**/*.ts',
      'tests/**/*.ts',
      'scripts/**/*.mjs',
      '*.config.ts',
      '*.config.js',
    ],
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  // Browser code: DOM globals.
  {
    files: ['web/**/*.ts', 'web/**/*.tsx'],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },

  // Tests reach for non-null assertions on fixtures constantly, and forbidding it
  // there buys nothing but noise.
  {
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
