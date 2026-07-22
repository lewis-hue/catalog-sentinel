import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { DistroKidDistributorAdapter } from './distrokid-scanner';
import { runDistributorDeepScan, type ScanConnection } from './orchestrate';
import type { ScanEvent } from './types';

const baseUrl = pathToFileURL(resolve(process.cwd(), 'fixtures/distrokid')).href;
const nowIso = () => '2026-07-07T00:00:00.000Z';
let browser: Browser;
const contexts = new Set<BrowserContext>();

async function newPage() {
  const context = await browser.newContext();
  contexts.add(context);
  return context.newPage();
}

function connection(): ScanConnection {
  return {
    baseUrl,
    newPage,
    close: async () => {},
  };
}

beforeAll(async () => {
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
});
afterAll(async () => {
  await Promise.allSettled([...contexts].map((context) => context.close()));
  await browser.close();
}, 30_000);

describe('DistroKid deep scan (fixtures)', () => {
  it('validates login state from the page', async () => {
    const adapter = new DistroKidDistributorAdapter(nowIso);
    const page = await newPage();
    await page.goto(`${baseUrl}/login-required.html`, { waitUntil: 'domcontentloaded' });
    expect((await adapter.validateLoggedIn(page)).loggedIn).toBe(false);
    await page.goto(`${baseUrl}/login-success.html`, { waitUntil: 'domcontentloaded' });
    expect((await adapter.validateLoggedIn(page)).loggedIn).toBe(true);
    await page.close();
  });

  it('scans the full catalog into a canonical snapshot with provenance', async () => {
    const events: ScanEvent[] = [];
    const res = await runDistributorDeepScan(new DistroKidDistributorAdapter(nowIso), connection(), {
      tenantId: 't1',
      artistWorkspaceId: 'aw1',
      distributor: 'distrokid',
      snapshotId: 'snap1',
      minDelayMs: 0,
      nowIso,
      onEvent: (e) => events.push(e),
    });

    expect(res.status).toBe('COMPLETED_WITH_WARNINGS'); // release 2 is missing its UPC
    expect(res.releases).toHaveLength(2);
    expect(res.tracks).toHaveLength(4);

    const lagos = res.tracks.find((t) => t.title === 'Lagos City Nights')!;
    expect(lagos.isrc).toBe('USKE12310001');
    expect(lagos.lyricsStatus).toBe('APPROVED');
    expect(lagos.creditsStatus).toBe('DISPLAYED');
    expect(lagos.normalizedTitle).toBe('lagos city nights');

    // Every scanned data point carries source + timestamp + confidence.
    const rel1 = res.releases.find((r) => r.title === 'Lagos Nights')!;
    expect(rel1.upc).toBe('0888072100001');
    expect(rel1.stores.find((s) => s.normalizedStore === 'audiomack')?.status).toBe('DELIVERED');

    // events include lifecycle + progress
    expect(events.some((e) => e.type === 'scan_started')).toBe(true);
    expect(events.some((e) => e.type === 'scan_completed')).toBe(true);
    expect(events.filter((e) => e.type === 'release_found')).toHaveLength(2);
  });

  it('detects distributor-side issues from the scan', async () => {
    const res = await runDistributorDeepScan(new DistroKidDistributorAdapter(nowIso), connection(), {
      tenantId: 't1',
      artistWorkspaceId: 'aw1',
      distributor: 'distrokid',
      snapshotId: 'snap1',
      minDelayMs: 0,
      nowIso,
    });
    const codes = new Set(res.issues.map((i) => i.code));
    expect(codes.has('MISSING_ISRC')).toBe(true); // "Alone Tonight" has no ISRC
    expect(codes.has('MISSING_UPC')).toBe(true); // "Silent Waves" release
    expect(codes.has('NOT_SELECTED_FOR_AUDIOMACK')).toBe(true); // "Silent Waves"
    expect(codes.has('MISSING_PLAIN_LYRICS')).toBe(true);
    expect(codes.has('MISSING_CREDITS')).toBe(true);
  });

  it('is resumable: skips releases already scanned (checkpoint)', async () => {
    const res = await runDistributorDeepScan(new DistroKidDistributorAdapter(nowIso), connection(), {
      tenantId: 't1',
      artistWorkspaceId: 'aw1',
      distributor: 'distrokid',
      snapshotId: 'snap1',
      minDelayMs: 0,
      nowIso,
      scannedReleaseIds: new Set(['DK-REL-1']),
    });
    expect(res.releases).toHaveLength(1);
    expect(res.releases[0]?.title).toBe('Silent Waves');
  });
});
