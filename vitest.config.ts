import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * Root Vitest config. Packages are plain TypeScript with `exports` pointing at
 * `src/index.ts`, so Vitest (esbuild) resolves them without a build step. The
 * explicit aliases below make workspace resolution robust even before/without
 * npm workspace symlinks, keeping the fixture-backed demo and the whole test
 * suite runnable with zero infrastructure (no Postgres / Redis / Docker).
 */
const pkg = (p: string) => fileURLToPath(new URL(`./packages/${p}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@sentinel/security/test-support': fileURLToPath(new URL('./packages/security/src/compliance-approval.test-support.ts', import.meta.url)),
      '@sentinel/contracts': pkg('contracts'),
      '@sentinel/queue-client': pkg('queue-client'),
      '@sentinel/persistence': pkg('persistence'),
      '@sentinel/search-store': pkg('search-store'),
      '@sentinel/core': pkg('core'),
      '@sentinel/matching': pkg('matching'),
      '@sentinel/adapters': pkg('adapters'),
      '@sentinel/security': pkg('security'),
      '@sentinel/reports': pkg('reports'),
      '@sentinel/db': pkg('db'),
      '@sentinel/engine': pkg('engine'),
      '@sentinel/browser-link': pkg('browser-link'),
      '@sentinel/steel': pkg('steel'),
      '@sentinel/scanner': pkg('scanner'),
      '@sentinel/worker': fileURLToPath(new URL('./apps/worker/src/index.ts', import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['packages/**/*.{test,spec}.ts', 'apps/**/*.{test,spec}.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**'],
    reporters: ['default'],
    // Bound the worker pool. Vitest defaults to one thread per core; when the suite runs
    // alongside a build/typecheck (or against real Redis/Postgres in CI) that oversubscribes the
    // box and tests time out. Those timeouts look like flaky functional failures but are pure
    // resource starvation - the honest fix is to bound concurrency, not to inflate timeouts
    // until the symptom hides.
    pool: 'threads',
    maxWorkers: 4,
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/index.ts', '**/fixtures/**'],
    },
  },
});
