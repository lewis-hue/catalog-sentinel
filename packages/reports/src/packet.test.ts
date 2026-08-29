import { describe, it, expect } from 'vitest';
import { buildSupportPacket } from './packet';
import { renderTemplate, TEMPLATE_IDS } from './templates';
import type { PacketRow, SupportPacketData } from './model';

function row(overrides: Partial<PacketRow> = {}): PacketRow {
  return {
    releaseTitle: 'Lagos Nights',
    trackTitle: 'Lagos City Nights',
    isrc: 'USRC11700001',
    upc: '088807219903',
    distributorUrl: 'https://distrokid.com/hyperfollow/lewiske/lagos-nights',
    releaseDate: '2023-04-01',
    expectedStatus: 'Selected for Audiomack',
    evidence: 'Absent from 132 scanned Audiomack uploads and search',
    confidence: 0.95,
    confidenceBand: 'strong',
    reasonCode: 'MISSING_ON_PLATFORM',
    severity: 'high',
    remediation: 'Ask DistroKid to redeliver to Audiomack.',
    ...overrides,
  };
}

const data: SupportPacketData = {
  template: 'distrokid-missing-audiomack',
  targetAudience: 'distributor',
  targetProvider: 'distrokid',
  artistName: 'Lewis KE',
  distributorAccountRef: 't***@gmail.com',
  audiomackProfileUrl: 'https://audiomack.com/lewis_ke',
  scanTimestamp: '2026-07-07T00:00:00.000Z',
  rows: [row(), row({ trackTitle: 'Alone, Tonight', releaseTitle: 'Solo Single', isrc: 'USRC11700003' })],
};

describe('buildSupportPacket', () => {
  const packet = buildSupportPacket(data);

  it('produces a subject with the artist and missing count', () => {
    expect(packet.subject).toBe('Audiomack Reinstatement Request, Lewis KE, 2 Missing Songs');
    expect(packet.missingCount).toBe(2);
  });

  it('emits CSV / HTML / JSON artifacts', () => {
    expect(packet.artifacts.map((a) => a.format).sort()).toEqual(['csv', 'html', 'json']);
    for (const a of packet.artifacts) expect(a.byteSize).toBeGreaterThan(0);
  });

  it('CSV has a header + one row per track and escapes commas', () => {
    const csv = packet.artifacts.find((a) => a.format === 'csv')!.content;
    const lines = csv.trim().split('\r\n');
    expect(lines).toHaveLength(3); // header + 2 rows
    expect(lines[0]).toContain('ISRC');
    expect(lines[0]).toContain('Distributor Release URL');
    expect(csv).toContain('USRC11700001');
    expect(csv).toContain('"Alone, Tonight"'); // comma-containing title quoted
  });

  it('HTML contains the subject, the ticket draft, and an escaped evidence table', () => {
    const html = packet.artifacts.find((a) => a.format === 'html')!.content;
    expect(html).toContain('Audiomack Reinstatement Request');
    expect(html).toContain('Support ticket draft');
    expect(html).toContain('Lagos City Nights');
    expect(html).toContain('audiomack.com/lewis_ke');
  });

  it('JSON is valid and carries the rows', () => {
    const json = packet.artifacts.find((a) => a.format === 'json')!.content;
    const parsed = JSON.parse(json);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.subject).toContain('Reinstatement');
  });

  it('the ticket body names the confirmed Audiomack profile and the count', () => {
    expect(packet.bodyMarkdown).toContain('https://audiomack.com/lewis_ke');
    expect(packet.bodyMarkdown).toContain('found 2 tracks');
  });
});

describe('templates', () => {
  it('every template renders a subject and non-empty body', () => {
    for (const template of TEMPLATE_IDS) {
      const rendered = renderTemplate({ ...data, template });
      expect(rendered.subject.length).toBeGreaterThan(0);
      expect(rendered.body.length).toBeGreaterThan(20);
    }
  });

  it('appends caller-provided requested action', () => {
    const rendered = renderTemplate({ ...data, requestedAction: 'Escalate to tier 2.' });
    expect(rendered.body).toContain('Escalate to tier 2.');
  });
});
