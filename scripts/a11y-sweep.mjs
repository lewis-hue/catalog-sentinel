/**
 * Accessibility sweep. Loads each app route in Chromium, injects axe-core, and reports
 * WCAG 2.1 A/AA violations per page. Designed to run inside the scanner image (which ships
 * Playwright + Chromium) against the internal web service:
 *
 *   docker compose cp node_modules/axe-core/axe.min.js scanner:/app/axe.min.js
 *   docker compose cp scripts/a11y-sweep.mjs scanner:/app/a11y-sweep.mjs
 *   docker compose exec -e BASE_URL=http://web:3000 scanner sh -c 'cd /app && node a11y-sweep.mjs'
 *
 * Exits non-zero if any serious/critical violation is found.
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://web:3000';
const AXE = process.env.AXE_PATH || '/app/axe.min.js';
const PAGES = (process.env.PAGES || '/,/catalog,/coverage,/integrations,/review,/support,/status,/connect,/history,/search').split(',');
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

let serious = 0;
const report = [];
for (const path of PAGES) {
  const url = `${BASE}${path}`;
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
    // Let client components fetch + render.
    await page.waitForTimeout(1200);
    await page.addScriptTag({ path: AXE });
    const result = await page.evaluate(async (tags) => {
      // eslint-disable-next-line no-undef
      return await axe.run(document, { runOnly: { type: 'tag', values: tags } });
    }, TAGS);
    const violations = result.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, help: v.help, sample: v.nodes[0]?.target?.join(' ') ?? '', targets: v.nodes.slice(0, 4).map((n) => n.target.join(' ')) }));
    serious += violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').length;
    report.push({ path, ok: violations.length === 0, violations });
  } catch (e) {
    report.push({ path, error: e instanceof Error ? e.message : String(e) });
  }
}
await browser.close();

console.log('\n==================== A11Y SWEEP ====================');
for (const r of report) {
  if (r.error) { console.log(`\n✖ ${r.path}  ERROR: ${r.error}`); continue; }
  if (r.ok) { console.log(`\n✓ ${r.path}  no WCAG 2.1 A/AA violations`); continue; }
  console.log(`\n● ${r.path}  ${r.violations.length} violation type(s)`);
  for (const v of r.violations) {
    console.log(`   [${(v.impact || 'n/a').toUpperCase()}] ${v.id} ×${v.nodes} — ${v.help}`);
    for (const t of v.targets) console.log(`        ↳ ${t}`);
  }
}
console.log(`\n=================== ${serious} serious/critical across all pages ===================`);
process.exit(serious > 0 ? 1 : 0);
