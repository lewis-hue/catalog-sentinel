import type { Page } from 'playwright';
import { detectDistributorIssues, type ScanIssue } from './issue-detection';
import { normalizeCatalog, type CanonicalCatalogSnapshot, type CanonicalRelease, type CanonicalTrack } from './normalization';
import type { DistributorProviderName, DistributorReleaseSnapshot, DistributorScanner, ScanEvent } from './types';
import { PageShapeError } from './types';

/** Structural connection contract, satisfied by browser-link's AutomationConnection. */
export interface ScanConnection {
  baseUrl: string;
  newPage(): Promise<Page>;
  close(): Promise<void>;
}

export type DeepScanStatus = 'COMPLETED' | 'COMPLETED_WITH_WARNINGS' | 'PAUSED_NEEDS_USER' | 'FAILED';

export interface DeepScanConfig {
  tenantId: string;
  artistWorkspaceId: string;
  distributor: DistributorProviderName;
  snapshotId: string;
  minDelayMs?: number;
  onEvent?: (e: ScanEvent) => void;
  nowIso?: () => string;
  idFor?: (kind: string, ...parts: string[]) => string;
  /** Resume checkpoint, release ids already scanned in a previous run. */
  scannedReleaseIds?: Set<string>;
}

export interface DeepScanResult {
  status: DeepScanStatus;
  snapshot: CanonicalCatalogSnapshot | null;
  releases: CanonicalRelease[];
  tracks: CanonicalTrack[];
  issues: ScanIssue[];
  stats: { pagesScanned: number; releasesFound: number; tracksFound: number; warningsCount: number };
  needsMaintenance: string[];
  error?: string;
}

/**
 * Orchestrates a distributor deep scan: validate login → discover catalog index →
 * scan each release (rate-limited, resumable) → normalize → detect issues. Stops
 * gracefully and reports PAUSED_NEEDS_USER on logout/re-auth, and records a
 * maintenance note on unknown page shapes instead of guessing.
 */
export async function runDistributorDeepScan(
  scanner: DistributorScanner,
  connection: ScanConnection,
  cfg: DeepScanConfig,
): Promise<DeepScanResult> {
  const nowIso = cfg.nowIso ?? (() => new Date().toISOString());
  const minDelayMs = cfg.minDelayMs ?? 1500;
  const needsMaintenance: string[] = [];
  const scanned = cfg.scannedReleaseIds ?? new Set<string>();
  const emit = (e: ScanEvent) => cfg.onEvent?.(e);

  const ctx = { baseUrl: connection.baseUrl, minDelayMs, onEvent: cfg.onEvent, scannedReleaseIds: scanned };
  const page = await connection.newPage();
  const snapshots: DistributorReleaseSnapshot[] = [];
  let pagesScanned = 0;

  try {
    emit({ type: 'scan_started', at: nowIso() });

    // Validate login on an authenticated surface before touching the catalog.
    await page.goto(`${ctx.baseUrl}/catalog-index.html`, { waitUntil: 'domcontentloaded' });
    pagesScanned++;
    const login = await scanner.validateLoggedIn(page);
    if (!login.loggedIn) {
      emit({ type: 'scan_paused_needs_user', at: nowIso(), reason: login.reason ?? 'Not logged in.' });
      return empty('PAUSED_NEEDS_USER', pagesScanned);
    }

    const index = await scanner.discoverCatalogIndex(page, ctx);
    pagesScanned++;

    for (const item of index) {
      const key = item.releaseId ?? item.url;
      if (scanned.has(key)) continue; // resume: skip already-scanned
      try {
        const snap = await scanner.scanRelease(page, item, ctx);
        snapshots.push(snap);
        scanned.add(key);
        pagesScanned++;
        emit({
          type: 'scan_progress',
          at: nowIso(),
          percent: Math.round((snapshots.length / index.length) * 100),
          step: `Scanned ${snapshots.length}/${index.length} releases`,
        });
      } catch (err) {
        if (err instanceof PageShapeError) {
          needsMaintenance.push(`${err.pageKind}: ${err.message}`);
          emit({ type: 'page_shape_changed', at: nowIso(), page: err.pageKind });
          continue; // skip this release, keep going
        }
        throw err;
      }
    }

    const { snapshot, releases, tracks } = normalizeCatalog({
      snapshots,
      tenantId: cfg.tenantId,
      artistWorkspaceId: cfg.artistWorkspaceId,
      snapshotId: cfg.snapshotId,
      distributor: cfg.distributor,
      nowIso,
      idFor: cfg.idFor,
    });
    const issues = detectDistributorIssues({ releases, tracks });
    const warningsCount = snapshots.reduce((n, s) => n + s.warnings.length, 0) + needsMaintenance.length;

    emit({ type: 'scan_completed', at: nowIso(), releases: releases.length, tracks: tracks.length });
    return {
      status: needsMaintenance.length > 0 || warningsCount > 0 ? 'COMPLETED_WITH_WARNINGS' : 'COMPLETED',
      snapshot,
      releases,
      tracks,
      issues,
      stats: { pagesScanned, releasesFound: releases.length, tracksFound: tracks.length, warningsCount },
      needsMaintenance,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emit({ type: 'scan_failed', at: nowIso(), error: message });
    return { ...empty('FAILED', pagesScanned), error: message };
  } finally {
    await page.close().catch(() => undefined);
  }

  function empty(status: DeepScanStatus, pages: number): DeepScanResult {
    return {
      status,
      snapshot: null,
      releases: [],
      tracks: [],
      issues: [],
      stats: { pagesScanned: pages, releasesFound: 0, tracksFound: 0, warningsCount: needsMaintenance.length },
      needsMaintenance,
    };
  }
}
