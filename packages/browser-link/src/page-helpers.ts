import type { Page } from 'playwright';

/**
 * At runtime the API/worker are executed by `tsx`, whose esbuild transform has
 * `keepNames` on. esbuild therefore wraps named functions with a `__name(fn, "…")`
 * helper. When Playwright serializes a function passed to `page.evaluate(...)` and
 * runs it inside the browser page, that `__name` helper is NOT defined in the page
 * context → `ReferenceError: __name is not defined`, and the scan fails.
 *
 * Fix: define `__name` in every page before any evaluate runs. We inject it as a
 * STRING init script (not a function — a function would itself be transpiled and
 * reintroduce a `__name` reference). The implementation matches esbuild's own
 * `__name` (sets the function's name, returns it), so it's a faithful shim.
 */
export const ESBUILD_PAGE_HELPERS =
  'globalThis.__name=globalThis.__name||function(t,v){try{Object.defineProperty(t,"name",{value:v,configurable:true})}catch(e){}return t};';

/** Register the esbuild page helpers, then return the page. Call at page creation. */
export async function preparePageForEvaluate(page: Page): Promise<Page> {
  await page.addInitScript({ content: ESBUILD_PAGE_HELPERS });
  return page;
}
