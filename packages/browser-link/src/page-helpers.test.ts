import { describe, it, expect, afterAll } from 'vitest';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { preparePageForEvaluate } from './page-helpers';

/**
 * Guards the tsx/esbuild + Playwright `__name is not defined` fix. Uses a real
 * browser and STRING evaluate arguments (so vitest's own esbuild transform doesn't
 * interfere) to prove the `__name` shim is actually present in the page context.
 */
describe('preparePageForEvaluate', () => {
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  afterAll(async () => {
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }, 30_000);

  it('defines a working esbuild __name helper in the page', async () => {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    context = await browser.newContext();
    const page = await preparePageForEvaluate(await context.newPage());
    await page.goto('about:blank');
    expect(await page.evaluate('typeof __name')).toBe('function');
    // Faithful to esbuild's helper: sets the function name and returns the function.
    expect(await page.evaluate('__name(function(){}, "myFn").name')).toBe('myFn');
  }, 30000);
});
