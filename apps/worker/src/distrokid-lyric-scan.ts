import { prepareDistroKidAlbumPage, readAlbumLyricsFromPage } from '@sentinel/browser-assist';
import type { DistroKidOutcomeRepository } from '@sentinel/persistence';
import type { DistroKidLyricScanJobPayload } from '@sentinel/contracts';
import { steelSessionSource } from './distrokid/composition';

/**
 * DEDICATED DistroKid lyric scan, the decoupled, separate-session pass.
 *
 * DistroKid lazy/virtual-renders per-track lyric controls, which cannot be read inside the fast,
 * parallel, deadline-bound metadata scrape (proven: only ~1 of N mount per release, and it blows the
 * wall-clock deadline). This pass runs AFTER the metadata scrape, RE-ATTACHES to the warm Steel
 * session (retained by DISTRIBUTOR_SESSION_REUSE), and reads each album unhurriedly on a dedicated
 * page, the exact conditions the ground-truth capture proved work. It writes only the lyric
 * columns, never touches metadata, and is bounded to the Steel session window. Read-only in the
 * browser: it navigates and reads, never mutates the distributor account.
 */

export interface DistroKidLyricScanDeps {
  outcomeRepo: DistroKidOutcomeRepository;
  env: NodeJS.ProcessEnv;
  log?: (message: string, extra?: Record<string, unknown>) => void;
}

const dashboardUrlOf = (distributorReleaseId: string): string =>
  /^https?:\/\//.test(distributorReleaseId)
    ? distributorReleaseId
    : `https://distrokid.com/dashboard/album/?albumuuid=${distributorReleaseId}`;

export async function runDistroKidLyricScan(payload: DistroKidLyricScanJobPayload, deps: DistroKidLyricScanDeps): Promise<void> {
  const { outcomeRepo, env } = deps;
  const log = deps.log ?? (() => {});
  const { snapshotId, tenantId, connectionId, steelSessionId, sessionExpiresAt } = payload;

  // RESUMABLE: only releases whose DistroKid lyric state was never read. A scan that ran out of the
  // Steel session window last time picks up the remaining releases now, instead of re-reading the
  // ones already done, so consecutive scans converge on full coverage of a large catalogue.
  const targets = await outcomeRepo.readLyricScanTargets(tenantId, snapshotId, { unreadDistroKidLyricsOnly: true });
  if (!targets.length) { log('lyric-scan: all completed releases already have lyric state, nothing to sweep', { snapshotId }); return; }

  // Re-attach to the SAME retained Steel session (borrowed: closing pages won't end the session).
  const sessions = steelSessionSource(env);
  const conn = await sessions.attach({ tenantId, connectionId, distributor: 'distrokid', steelSessionId });
  if (!conn) { log('lyric-scan: Steel session unavailable (expired, or session reuse was off), skipped', { snapshotId }); return; }

  // Bound the sweep to the Steel session window, leaving a cleanup grace.
  const GRACE_MS = 45_000;
  const expiry = sessionExpiresAt ? Date.parse(sessionExpiresAt) : NaN;
  const stopAt = Number.isFinite(expiry) ? expiry - GRACE_MS : Date.now() + 10 * 60_000;

  let page: Awaited<ReturnType<typeof conn.newPage>> | null = null;
  let releasesRead = 0;
  let tracksWritten = 0;
  try {
    page = await conn.newPage();
    await prepareDistroKidAlbumPage(page);
    for (const target of targets) {
      if (Date.now() >= stopAt) { log('lyric-scan: stopping before session expiry', { releasesRead, of: targets.length }); break; }
      const byNumber = await readAlbumLyricsFromPage(page, dashboardUrlOf(target.distributorReleaseId)).catch(() => null);
      if (!byNumber || byNumber.size === 0) continue;
      const updates: Array<{ trackIndex: number; plain: string; synced: string }> = [];
      for (const t of target.tracks) {
        const state = t.trackNumber != null ? byNumber.get(t.trackNumber) : undefined;
        if (state) updates.push({ trackIndex: t.trackIndex, plain: state.plain, synced: state.synced });
      }
      if (updates.length) {
        tracksWritten += await outcomeRepo.updateTrackLyrics(target.releaseOutcomeId, updates);
        releasesRead += 1;
      }
    }
  } catch (e) {
    log('lyric-scan: sweep failed', { error: e instanceof Error ? e.message : String(e) });
  } finally {
    if (page) await page.close().catch(() => undefined);
    // Borrowed attach ({ releaseOnClose: false }) → this closes only the pages we opened, NOT the
    // remote Steel session, which stays warm for the user until sign-out / Steel TTL.
    await conn.close().catch(() => undefined);
  }
  log('lyric-scan: complete', { snapshotId, releasesRead, of: targets.length, tracksWritten });
}
