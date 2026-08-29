import { CONFIDENCE_BAND_LABEL, SEVERITY_LABEL } from '@sentinel/core';
import type { PacketRow, SupportPacketData } from './model';

// --- CSV --------------------------------------------------------------------

const CSV_COLUMNS: Array<{ key: string; header: string; get: (r: PacketRow, d: SupportPacketData) => string }> = [
  { key: 'release', header: 'Release Title', get: (r) => r.releaseTitle },
  { key: 'track', header: 'Track Title', get: (r) => r.trackTitle },
  { key: 'isrc', header: 'ISRC', get: (r) => r.isrc ?? '' },
  { key: 'upc', header: 'UPC', get: (r) => r.upc ?? '' },
  { key: 'url', header: 'Distributor Release URL', get: (r) => r.distributorUrl ?? '' },
  { key: 'date', header: 'Release Date', get: (r) => r.releaseDate ?? '' },
  { key: 'expected', header: 'Expected Status', get: (r) => r.expectedStatus },
  { key: 'evidence', header: 'Evidence', get: (r) => r.evidence },
  { key: 'confidence', header: 'Confidence', get: (r) => r.confidence.toFixed(2) },
  { key: 'band', header: 'Confidence Band', get: (r) => CONFIDENCE_BAND_LABEL[r.confidenceBand] },
  { key: 'reason', header: 'Reason Code', get: (r) => r.reasonCode },
  { key: 'severity', header: 'Severity', get: (r) => SEVERITY_LABEL[r.severity] },
  { key: 'remediation', header: 'Recommended Remediation', get: (r) => r.remediation },
  { key: 'scan', header: 'Scan Timestamp', get: (_r, d) => d.scanTimestamp },
];

function csvEscape(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function renderCsv(data: SupportPacketData): string {
  const lines = [CSV_COLUMNS.map((c) => csvEscape(c.header)).join(',')];
  for (const row of data.rows) {
    lines.push(CSV_COLUMNS.map((c) => csvEscape(c.get(row, data))).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

// --- JSON -------------------------------------------------------------------

export function renderJson(data: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...data, ...extra }, null, 2);
}

// --- HTML -------------------------------------------------------------------

function esc(v: string): string {
  return v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const BAND_COLOR: Record<string, string> = {
  confirmed: '#0a7',
  strong: '#3a6',
  probable: '#c80',
  weak: '#c50',
  'no-match': '#a33',
};

/**
 * Self-contained, printable HTML report (no external assets), safe to render in
 * the dashboard's evidence drawer or Print-to-PDF. All interpolated values are
 * HTML-escaped.
 */
export function renderHtml(data: SupportPacketData, subject: string, bodyMarkdown: string): string {
  const rowsHtml = data.rows
    .map(
      (r) => `<tr>
      <td>${esc(r.releaseTitle)}</td>
      <td>${esc(r.trackTitle)}</td>
      <td class="mono">${esc(r.isrc ?? '-')}</td>
      <td class="mono">${esc(r.upc ?? '-')}</td>
      <td>${r.distributorUrl ? `<a href="${esc(r.distributorUrl)}">link</a>` : '-'}</td>
      <td>${esc(r.expectedStatus)}</td>
      <td>${esc(r.evidence)}</td>
      <td><span class="badge" style="background:${BAND_COLOR[r.confidenceBand] ?? '#666'}">${r.confidence.toFixed(2)}</span></td>
      <td class="mono">${esc(r.reasonCode)}</td>
    </tr>`,
    )
    .join('\n');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${esc(subject)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.5 -apple-system, Segoe UI, Roboto, sans-serif; margin: 0; padding: 32px; background: #fff; color: #111; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #666; margin: 0 0 20px; }
  .stats { display: flex; gap: 16px; flex-wrap: wrap; margin: 16px 0 24px; }
  .stat { border: 1px solid #e3e3e3; border-radius: 10px; padding: 12px 16px; min-width: 120px; }
  .stat .n { font-size: 24px; font-weight: 700; }
  .stat .l { color: #666; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
  pre.draft { white-space: pre-wrap; background: #f7f7f8; border: 1px solid #ececec; border-radius: 10px; padding: 16px; }
  table { border-collapse: collapse; width: 100%; margin-top: 8px; font-size: 13px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #eee; vertical-align: top; }
  th { background: #fafafa; position: sticky; top: 0; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  .badge { color: #fff; padding: 2px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; }
  .foot { color: #888; font-size: 12px; margin-top: 24px; }
  @media (prefers-color-scheme: dark) { body { background: #0c0c0d; color: #eaeaea; } .stat{border-color:#2a2a2c} th{background:#151517} pre.draft{background:#151517;border-color:#2a2a2c} td,th{border-color:#222} .sub,.stat .l,.foot{color:#9a9a9a} }
</style></head>
<body>
  <h1>${esc(subject)}</h1>
  <p class="sub">Artist: <strong>${esc(data.artistName)}</strong> · Target: ${esc(data.targetProvider)} · Generated ${esc(
    data.scanTimestamp,
  )}</p>
  <div class="stats">
    <div class="stat"><div class="n">${data.rows.length}</div><div class="l">Affected tracks</div></div>
    <div class="stat"><div class="n">${data.rows.filter((r) => r.confidenceBand === 'confirmed' || r.confidenceBand === 'strong').length}</div><div class="l">High confidence</div></div>
    <div class="stat"><div class="n">${data.rows.filter((r) => r.isrc).length}</div><div class="l">With ISRC</div></div>
  </div>
  <h2>Support ticket draft</h2>
  <pre class="draft">${esc(bodyMarkdown)}</pre>
  <h2>Evidence table</h2>
  <div style="overflow-x:auto">
  <table>
    <thead><tr>
      <th>Release</th><th>Track</th><th>ISRC</th><th>UPC</th><th>URL</th>
      <th>Expected</th><th>Evidence</th><th>Conf.</th><th>Reason</th>
    </tr></thead>
    <tbody>
${rowsHtml}
    </tbody>
  </table>
  </div>
  <p class="foot">Generated by Artist Catalog Sentinel. Evidence reflects platform state at scan time; unavailable-API results are marked for manual review, never as confirmed absence.</p>
</body></html>`;
}
