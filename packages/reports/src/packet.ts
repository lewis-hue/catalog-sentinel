import { redact } from '@sentinel/security';
import type { GeneratedArtifact, GeneratedPacket, SupportPacketData } from './model';
import { renderTemplate } from './templates';
import { renderCsv, renderHtml, renderJson } from './render';

function byteSize(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'packet';
}

/**
 * Build a complete support packet from packet data: the email/ticket draft plus
 * CSV, HTML, and JSON artifacts. The JSON artifact is passed through the security
 * redactor as a final guarantee that no secret ever lands in an exported file.
 */
export function buildSupportPacket(data: SupportPacketData): GeneratedPacket {
  const { subject, body } = renderTemplate(data);

  const base = `${slug(data.artistName)}-${data.template}`;
  const csv = renderCsv(data);
  const html = renderHtml(data, subject, body);
  const json = renderJson(redact({ subject, body, ...data }) as Record<string, unknown>);

  const artifacts: GeneratedArtifact[] = [
    { format: 'csv', filename: `${base}.csv`, content: csv, byteSize: byteSize(csv) },
    { format: 'html', filename: `${base}.html`, content: html, byteSize: byteSize(html) },
    { format: 'json', filename: `${base}.json`, content: json, byteSize: byteSize(json) },
  ];

  return { subject, bodyMarkdown: body, artifacts, missingCount: data.rows.length };
}
