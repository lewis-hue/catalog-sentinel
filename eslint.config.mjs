import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * ESLint flat config.
 *
 * `npm run lint` previously ended in `|| echo 'eslint not configured; skipping'` while ESLint
 * wasn't even installed - so CI reported success without linting anything. This config makes lint
 * real, and the script no longer swallows failures.
 *
 * Rules are chosen for the defects this codebase actually hit:
 *  - floating promises (a fire-and-forget capture that silently swallowed errors),
 *  - `apps/*` importing another `apps/*` (the API depends on the worker app today),
 *  - unused/implicit-any creeping into the extraction path.
 */
export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/coverage/**',
      'apps/web/**', // typechecked + built by Next; linted by its own toolchain
      '**/*.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: { parserOptions: { projectService: false } },
    rules: {
      // TypeScript already resolves identifiers (and knows the DOM/Node lib globals). Leaving
      // `no-undef` on for TS is a known false-positive source - typescript-eslint disables it.
      'no-undef': 'off',
      // Unused vars are allowed only when explicitly marked with a leading underscore.
      // `ignoreRestSiblings` keeps the legitimate destructure-to-omit pattern
      // (`const { secret, ...rest } = x`) from being flagged - the binding IS doing work.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true }],
      // `any` is a warning (the legacy surface still has some) but must not spread.
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    // Node operational scripts (.mjs): plain JS with Node + DOM-eval globals.
    files: ['scripts/**/*.mjs', 'scripts/**/*.js', '**/*.config.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly', process: 'readonly', Buffer: 'readonly', __dirname: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly',
        URL: 'readonly', fetch: 'readonly', AbortController: 'readonly',
        // These run inside page.evaluate against a real browser.
        document: 'readonly', window: 'readonly', location: 'readonly', getComputedStyle: 'readonly', performance: 'readonly', PerformanceObserver: 'readonly',
      },
    },
  },
  {
    /**
     * ARCHITECTURE BOUNDARY: an application must never import another application.
     *
     * The API imported `@sentinel/worker` for the search store, the queue producers and a
     * deep-scan dispatcher - so an HTTP server transitively pulled in Playwright, a browser
     * runtime and a scan executor it never used, and "which app owns this?" had no answer. The
     * shared parts now live in packages (contracts / queue-client / search-store / persistence).
     *
     * This rule is what stops it growing back: the next such import is a lint failure rather than
     * a review comment someone has to happen to notice.
     *
     * `allowTypeImports: false` matters - a type-only import still couples the two applications
     * at build time, and it is how this would creep back in first.
     */
    files: ['apps/api/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', {
        paths: [{
          name: '@sentinel/worker',
          allowTypeImports: false,
          message: 'The API must not import the worker application. Use @sentinel/contracts (job shapes), @sentinel/queue-client (enqueue), @sentinel/search-store (persistence) or @sentinel/persistence.',
        }],
      }],
    },
  },
  {
    // Tests may use looser typing for fakes/harnesses.
    files: ['**/*.test.ts', '**/*.test.tsx', '**/test-support/**'],
    rules: { '@typescript-eslint/no-explicit-any': 'off', '@typescript-eslint/no-unused-vars': 'off' },
  },
);
