import { FlatCompat } from '@eslint/eslintrc';

/**
 * Next.js ESLint config.
 *
 * The build warned "The Next.js plugin was not detected in your ESLint configuration", meaning
 * the frontend's own rules (hooks correctness, `next/no-img-element`, server/client boundary
 * mistakes) were never enforced. The root flat config deliberately ignores `apps/web/**`, so
 * without this file nothing linted the dashboard at all.
 */
const compat = new FlatCompat({ baseDirectory: import.meta.dirname });

const config = [
  ...compat.extends('next/core-web-vitals'),
  {
    ignores: ['.next/**', 'node_modules/**', 'out/**'],
  },
];

export default config;
