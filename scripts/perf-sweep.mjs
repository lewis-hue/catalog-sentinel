/**
 * Performance sweep, Core Web Vitals per route, measured in the scanner image's Chromium
 * against the internal web service (production `next start`). A Lighthouse-equivalent gate
 * without Lighthouse's dependency tree (which isn't in the image).
 *
 *   docker compose cp scripts/perf-sweep.mjs scanner:/app/perf-sweep.mjs
 *   docker compose exec -e BASE_URL=http://web:3000 scanner sh -c 'cd /app && node perf-sweep.mjs'
 *
 * Exits non-zero if any route breaches the "good" Core Web Vitals thresholds.
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://web:3000';
const PAGES = (process.env.PAGES || '/,/catalog,/coverage,/integrations,/review,/support,/status,/connect,/history,/search').split(',');
// Core Web Vitals "good" thresholds.
const T = { lcp: 2500, cls: 0.1, fcp: 1800, tbt: 200 };

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
// Accumulate LCP / CLS / long-tasks from the very first paint.
await context.addInitScript(() => {
  window.__perf = { lcp: 0, cls: 0, tbt: 0 };
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__perf.lcp = e.startTime; }).observe({ type: 'largest-contentful-paint', buffered: true });
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__perf.cls += e.value; }).observe({ type: 'layout-shift', buffered: true });
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__perf.tbt += Math.max(0, e.duration - 50); }).observe({ type: 'longtask', buffered: true });
  } catch { /* observer type unsupported */ }
});

const rows = [];
for (const path of PAGES) {
  const page = await context.newPage();
  try {
    await page.goto(`${BASE}${path}`, { waitUntil: 'load', timeout: 45000 });
    await page.waitForTimeout(2600); // let LCP/CLS settle past client fetches
    const m = await page.evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0] || {};
      const fcp = performance.getEntriesByName('first-contentful-paint')[0]?.startTime || 0;
      const res = performance.getEntriesByType('resource');
      const bytes = res.reduce((n, r) => n + (r.transferSize || 0), 0) + (nav.transferSize || 0);
      const js = res.filter((r) => r.initiatorType === 'script' || /\.js(\?|$)/.test(r.name)).reduce((n, r) => n + (r.transferSize || 0), 0);
      return { ttfb: Math.round(nav.responseStart || 0), fcp: Math.round(fcp), lcp: Math.round(window.__perf.lcp || fcp), cls: +(window.__perf.cls).toFixed(3), tbt: Math.round(window.__perf.tbt), kb: Math.round(bytes / 1024), jsKb: Math.round(js / 1024), reqs: res.length };
    });
    const breaches = [];
    if (m.lcp > T.lcp) breaches.push(`LCP ${m.lcp}>${T.lcp}`);
    if (m.cls > T.cls) breaches.push(`CLS ${m.cls}>${T.cls}`);
    if (m.fcp > T.fcp) breaches.push(`FCP ${m.fcp}>${T.fcp}`);
    if (m.tbt > T.tbt) breaches.push(`TBT ${m.tbt}>${T.tbt}`);
    rows.push({ path, ...m, breaches });
  } catch (e) {
    rows.push({ path, error: e instanceof Error ? e.message : String(e) });
  }
  await page.close();
}
await browser.close();

console.log('\n============================== PERF SWEEP (Core Web Vitals) ==============================');
console.log('route             TTFB   FCP    LCP    CLS    TBT   transfer   JS     reqs   status');
console.log('-----------------------------------------------------------------------------------------');
let failed = 0;
for (const r of rows) {
  if (r.error) { console.log(`${r.path.padEnd(16)}  ERROR: ${r.error}`); failed++; continue; }
  const ok = r.breaches.length === 0;
  if (!ok) failed++;
  console.log(
    `${r.path.padEnd(16)} ${String(r.ttfb).padStart(4)}ms ${String(r.fcp).padStart(4)}ms ${String(r.lcp).padStart(4)}ms ${String(r.cls).padStart(5)} ${String(r.tbt).padStart(4)}ms ${String(r.kb).padStart(6)}KB ${String(r.jsKb).padStart(4)}KB ${String(r.reqs).padStart(5)}   ${ok ? '✓ good' : '● ' + r.breaches.join(', ')}`,
  );
}
console.log(`\n=============== ${failed} route(s) breaching Core Web Vitals "good" thresholds ===============`);
process.exit(failed > 0 ? 1 : 0);
