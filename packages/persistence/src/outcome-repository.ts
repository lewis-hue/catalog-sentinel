import type { Pool, PoolClient } from 'pg';
import type { ReleaseExtractionOutcome, CanonicalDistributorRelease, FinalizeJob } from '@sentinel/contracts';
import { parseReleaseTitle } from './title-parse';

/**
 * DURABLE persistence for finalized extraction outcomes.
 *
 * Why this exists: `persistSnapshot` previously flipped a status flag and logged counts. Redis
 * held the checkpoints, so after a Redis flush/expiry there was no catalog anywhere, the system
 * had no durable record of what it had read. Redis is operational checkpoint storage; Postgres
 * is the system of record.
 *
 * Three properties this must have, all of which the old code lacked:
 *
 *  - IDEMPOTENT. Finalize can be retried (BullMQ redelivery, a resumed run). Every write upserts
 *    on `(extractionSnapshotId, distributorReleaseId)` / `(releaseOutcomeId, trackIndex)`, so a
 *    second finalize converges instead of duplicating a catalogue.
 *  - TRANSACTIONAL. A snapshot and its releases land together or not at all; a crash mid-write
 *    must not leave a snapshot claiming COMPLETE over half a catalogue.
 *  - LOSSLESS ABOUT FAILURE. Failed and skipped releases are persisted as rows with a reason
 *    code, not dropped. "We failed to read this" is a fact the user is entitled to see, and it
 *    is what makes a retry targeted rather than a full re-scan.
 *
 * Privacy: normalized allowlisted fields only. No raw payloads, no URLs carrying query values, no
 * headers/cookies/tokens. Reason CODES are stored, never error messages (a message can quote a
 * value from the response).
 */

export interface OutcomeRepository {
  readonly durable: boolean;
  persist(job: FinalizeJob, outcomes: ReleaseExtractionOutcome[]): Promise<void>;
}

/** A single track of the pure scraped catalogue (read-back shape, decoupled from store verify). */
export interface CatalogueTrackRow {
  title: string | null;
  isrc: string | null;
  isrcStatus: string;
  trackNumber: number | null;
  /** Stable DB key within the release, needed to line up bulk marks + store-lyric writes. */
  trackIndex: number;
  featuredArtists: string[];
  /** Distributor-side lyric availability: present | processing | none | unknown. */
  plainLyrics: string;
  syncedLyrics: string;
  /** Store-side lyric availability, derived from the per-store Serper verdict: found | not-found |
   *  unverifiable | unknown (found = at least one store shows lyrics). */
  storeLyricStatus: string;
  storeHasPlain: boolean;
  storeHasSynced: boolean;
  /** Per-store lyric DISPLAY verdict from Serper: { store -> 'shown' | 'not-shown' | 'unverifiable' }.
   *  Only lyric-capable stores appear; the store-presence grid renders these per cell. */
  storeLyricsPerStore: Record<string, string>;
  /** LyricFind distribution signal for this track's song (true = lyrics delivered to stores). */
  lyricfindDistributed: boolean | null;
  lyricfindUrl: string | null;
  /** Manual per-track status override: 'missing' | 'resolved' | null (no mark). */
  mark: string | null;
  markNote: string | null;
}

/** Progress of the independent store-lyrics check for a snapshot (kept off the search record). */
export interface StoreLyricsProgress {
  /** idle | queued | running | done | error */
  status: string;
  checked: number;
  total: number;
  error: string | null;
  checkedAt: string | null;
}

/** A single release of the pure scraped catalogue. */
export interface CatalogueReleaseRow {
  /** Stable, URL-safe public id for this release (the DistroKid album UUID). Used to deep-link a
   *  release detail page (`/catalogue/<releaseId>`); stable across re-scans. */
  releaseId: string;
  distributorReleaseId: string;
  /** Clean base title (type/version/artist stripped), e.g. "Feelings". */
  title: string | null;
  /** Variant if any, e.g. "Sped Up", "Remix". */
  version: string | null;
  /** Release type if any, e.g. "Single", "EP", "Album". */
  releaseType: string | null;
  primaryArtist: string | null;
  /** Additional credited artists beyond the primary. */
  featuredArtists: string[];
  label: string | null;
  releaseDate: string | null;
  uploadDate: string | null;
  artworkUrl: string | null;
  upc: string | null;
  upcStatus: string;
  artworkStatus: string;
  /** Stores DistroKid submitted this release to (authoritative delivery signal), with deep-links. */
  submittedStores: Array<{ store: string; url: string | null }>;
  tracks: CatalogueTrackRow[];
}

/** The pure scraped DistroKid catalogue for one snapshot, the standalone foundation the product
 *  reads, independent of any store-presence verification. */
export interface CatalogueSnapshotView {
  snapshotId: string;
  status: string;
  finalizedAt: string | null;
  releaseCount: number;
  trackCount: number;
  upcPresent: number;
  artworkPresent: number;
  isrcPresent: number;
  /** Progress of the independent store-lyrics check for this snapshot. */
  storeLyricsCheck: StoreLyricsProgress;
  releases: CatalogueReleaseRow[];
}

/** One track within a lyric-scan target: `trackIndex` keys the DB row; `trackNumber` matches the
 *  album page's per-track lyric control id. `title`/`primaryArtist`/`isrc` feed the store-side
 *  (LRCLIB) lookup, the DistroKid-side DOM scan ignores them and uses `trackNumber`. */
export interface LyricScanTargetTrack {
  trackIndex: number;
  trackNumber: number | null;
  title: string | null;
  primaryArtist: string | null;
  isrc: string | null;
}
/** A completed release to sweep for lyric state: the row id (UPDATE key), the raw
 *  `distributorReleaseId` (navigable dashboard URL or bare album UUID), the release title (used as
 *  the LRCLIB album hint) and artist, and its tracks. */
export interface LyricScanTarget {
  releaseOutcomeId: string;
  distributorReleaseId: string;
  releaseTitle: string | null;
  releaseArtist: string | null;
  tracks: LyricScanTargetTrack[];
}

/** Derive a stable, URL-safe release id from the distributor release id. DistroKid release ids are
 *  `…?albumuuid=<UUID>`; the UUID is stable across scans and safe in a path. Falls back to an
 *  encoded form of the raw id when no album UUID is present. */
function albumUuidOf(distributorReleaseId: string): string {
  const m = /albumuuid=([A-Za-z0-9-]+)/i.exec(distributorReleaseId);
  return m?.[1] ?? encodeURIComponent(distributorReleaseId).replace(/%/g, '_');
}

export class DistroKidOutcomeRepository implements OutcomeRepository {
  constructor(private readonly pool: Pool) {}

  get durable(): boolean {
    return true;
  }

  /**
   * Read the pure scraped catalogue (COMPLETED releases + their tracks) for an application
   * snapshot id (the `search_…` id). Tenant-scoped. Two-hop lookup: the app snapshotId lives in
   * `DistributorExtractionSnapshot.snapshotId`, whose `id` (a UUID) is the FK the outcome rows use.
   * Returns null when the tenant has no such snapshot.
   */
  async readCatalogue(tenantId: string, snapshotId: string): Promise<CatalogueSnapshotView | null> {
    const snap = await this.pool.query<{
      id: string; status: string; finalizedAt: Date | null;
      storeLyricsStatus: string; storeLyricsChecked: number; storeLyricsTotal: number;
      storeLyricsError: string | null; storeLyricsCheckedAt: Date | null;
    }>(
      `SELECT "id", "status", "finalizedAt", "storeLyricsStatus", "storeLyricsChecked",
              "storeLyricsTotal", "storeLyricsError", "storeLyricsCheckedAt"
       FROM "DistributorExtractionSnapshot"
       WHERE "userId" = $1 AND "snapshotId" = $2 LIMIT 1`,
      [tenantId, snapshotId],
    );
    const snapshotRow = snap.rows[0];
    if (!snapshotRow) return null;

    const rel = await this.pool.query<{
      id: string; distributorReleaseId: string; title: string | null; primaryArtist: string | null;
      label: string | null; releaseDate: string | null; uploadDate: string | null;
      artworkUrl: string | null; upc: string | null; upcStatus: string; artworkStatus: string;
      submittedStores: Array<{ store: string; url: string | null }> | null;
    }>(
      `SELECT "id", "distributorReleaseId", "title", "primaryArtist", "label", "releaseDate",
              "uploadDate", "artworkUrl", "upc", "upcStatus", "artworkStatus", "submittedStores"
       FROM "DistributorReleaseOutcome"
       WHERE "extractionSnapshotId" = $1 AND "kind" = 'COMPLETED'
       ORDER BY "title" NULLS LAST`,
      [snapshotRow.id],
    );
    const releaseRowIds = rel.rows.map((r) => r.id);

    const tracks = releaseRowIds.length
      ? await this.pool.query<{
          releaseOutcomeId: string; title: string | null; isrc: string | null; isrcStatus: string;
          trackNumber: number | null; trackIndex: number; featuredArtists: string[] | null;
          plainLyricsStatus: string | null; syncedLyricsStatus: string | null;
          storeLyricStatus: string | null; storeHasPlain: boolean | null; storeHasSynced: boolean | null;
          storeLyricsPerStore: Record<string, string> | null;
          lyricfindDistributed: boolean | null; lyricfindUrl: string | null;
          mark: string | null; markNote: string | null;
        }>(
          `SELECT "releaseOutcomeId", "title", "isrc", "isrcStatus", "trackNumber", "trackIndex", "featuredArtists",
                  "plainLyricsStatus", "syncedLyricsStatus",
                  "storeLyricStatus", "storeHasPlain", "storeHasSynced",
                  "storeLyricsPerStore", "lyricfindDistributed", "lyricfindUrl", "mark", "markNote"
           FROM "DistributorTrackOutcome"
           WHERE "releaseOutcomeId" = ANY($1::text[])
           ORDER BY "trackNumber" NULLS LAST, "trackIndex"`,
          [releaseRowIds],
        )
      : { rows: [] as never[] };

    const byRelease = new Map<string, CatalogueTrackRow[]>();
    for (const t of tracks.rows) {
      const list = byRelease.get(t.releaseOutcomeId) ?? [];
      list.push({
        title: t.title, isrc: t.isrc, isrcStatus: t.isrcStatus, trackNumber: t.trackNumber,
        trackIndex: t.trackIndex, featuredArtists: t.featuredArtists ?? [],
        plainLyrics: t.plainLyricsStatus ?? 'unknown', syncedLyrics: t.syncedLyricsStatus ?? 'unknown',
        storeLyricStatus: t.storeLyricStatus ?? 'unknown',
        storeHasPlain: t.storeHasPlain ?? false, storeHasSynced: t.storeHasSynced ?? false,
        storeLyricsPerStore: t.storeLyricsPerStore ?? {},
        lyricfindDistributed: t.lyricfindDistributed ?? null, lyricfindUrl: t.lyricfindUrl ?? null,
        mark: t.mark ?? null, markNote: t.markNote ?? null,
      });
      byRelease.set(t.releaseOutcomeId, list);
    }

    const releases: CatalogueReleaseRow[] = rel.rows.map((r) => {
      const parsed = parseReleaseTitle(r.title, r.primaryArtist);
      const tracks = byRelease.get(r.id) ?? [];
      // When the title didn't state a type, infer it from the real track count.
      const releaseType = parsed.releaseType ?? (tracks.length <= 1 ? 'Single' : tracks.length >= 7 ? 'Album' : 'EP');
      return {
        releaseId: albumUuidOf(r.distributorReleaseId),
        distributorReleaseId: r.distributorReleaseId,
        title: parsed.title || r.title,
        version: parsed.version,
        releaseType,
        primaryArtist: parsed.primaryArtist,
        featuredArtists: parsed.featuredArtists,
        label: r.label,
        releaseDate: r.releaseDate,
        uploadDate: r.uploadDate,
        artworkUrl: r.artworkUrl,
        upc: r.upc,
        upcStatus: r.upcStatus,
        artworkStatus: r.artworkStatus,
        submittedStores: Array.isArray(r.submittedStores) ? r.submittedStores : [],
        tracks,
      };
    });

    const trackCount = releases.reduce((n, r) => n + r.tracks.length, 0);
    return {
      snapshotId,
      status: snapshotRow.status,
      finalizedAt: snapshotRow.finalizedAt ? snapshotRow.finalizedAt.toISOString() : null,
      releaseCount: releases.length,
      trackCount,
      upcPresent: releases.filter((r) => r.upcStatus === 'PRESENT').length,
      artworkPresent: releases.filter((r) => r.artworkStatus === 'PRESENT').length,
      isrcPresent: releases.reduce((n, r) => n + r.tracks.filter((t) => t.isrcStatus === 'PRESENT').length, 0),
      storeLyricsCheck: {
        status: snapshotRow.storeLyricsStatus ?? 'idle',
        checked: snapshotRow.storeLyricsChecked ?? 0,
        total: snapshotRow.storeLyricsTotal ?? 0,
        error: snapshotRow.storeLyricsError ?? null,
        checkedAt: snapshotRow.storeLyricsCheckedAt ? snapshotRow.storeLyricsCheckedAt.toISOString() : null,
      },
      releases,
    };
  }

  /**
   * Targets for the dedicated DistroKid lyric scan: each COMPLETED release's row id + raw
   * `distributorReleaseId` (a navigable dashboard URL or bare album UUID) + every track's stable
   * `(trackIndex, trackNumber)`. `trackIndex` is the DB unique key; `trackNumber` matches the id
   * on the album page's per-track lyric control. Independent of `readCatalogue` because that view
   * deliberately drops the row id + trackIndex.
   */
  async readLyricScanTargets(tenantId: string, snapshotId: string, opts: { unreadDistroKidLyricsOnly?: boolean } = {}): Promise<LyricScanTarget[]> {
    const snap = await this.pool.query<{ id: string }>(
      `SELECT "id" FROM "DistributorExtractionSnapshot" WHERE "userId" = $1 AND "snapshotId" = $2 LIMIT 1`,
      [tenantId, snapshotId],
    );
    const snapshotUuid = snap.rows[0]?.id;
    if (!snapshotUuid) return [];
    // Resumability for the DistroKid lyric scan: with `unreadDistroKidLyricsOnly`, only releases that
    // still have at least one track whose DistroKid lyric state was never read (`plainLyricsStatus =
    // 'unknown'`) are returned, so a scan that ran out of session time resumes on the remaining
    // releases instead of re-reading the ones already done. The store-lyrics check omits this flag
    // and gets every release.
    const unreadFilter = opts.unreadDistroKidLyricsOnly
      ? `AND EXISTS (SELECT 1 FROM "DistributorTrackOutcome" u WHERE u."releaseOutcomeId" = r."id" AND u."plainLyricsStatus" = 'unknown')`
      : '';
    const rows = await this.pool.query<{
      releaseOutcomeId: string; distributorReleaseId: string; releaseTitle: string | null;
      releaseArtist: string | null; trackIndex: number; trackNumber: number | null;
      title: string | null; primaryArtist: string | null; isrc: string | null;
    }>(
      `SELECT r."id" AS "releaseOutcomeId", r."distributorReleaseId", r."title" AS "releaseTitle",
              r."primaryArtist" AS "releaseArtist", t."trackIndex", t."trackNumber",
              t."title", t."primaryArtist", t."isrc"
       FROM "DistributorReleaseOutcome" r
       JOIN "DistributorTrackOutcome" t ON t."releaseOutcomeId" = r."id"
       WHERE r."extractionSnapshotId" = $1 AND r."kind" = 'COMPLETED' ${unreadFilter}
       ORDER BY r."id", t."trackIndex"`,
      [snapshotUuid],
    );
    const byRelease = new Map<string, LyricScanTarget>();
    const order: string[] = [];
    for (const row of rows.rows) {
      let target = byRelease.get(row.releaseOutcomeId);
      if (!target) {
        target = {
          releaseOutcomeId: row.releaseOutcomeId, distributorReleaseId: row.distributorReleaseId,
          releaseTitle: row.releaseTitle, releaseArtist: row.releaseArtist, tracks: [],
        };
        byRelease.set(row.releaseOutcomeId, target);
        order.push(row.releaseOutcomeId);
      }
      target.tracks.push({
        trackIndex: row.trackIndex, trackNumber: row.trackNumber,
        title: row.title, primaryArtist: row.primaryArtist, isrc: row.isrc,
      });
    }
    return order.map((id) => byRelease.get(id)!);
  }

  /**
   * Carry forward already-read DistroKid lyric state into a NEW snapshot from the most recent prior
   * snapshot that read the same album+track (matched by `distributorReleaseId` + `trackIndex`, which
   * are stable across re-scans). Only fills rows still `unknown` in the new snapshot. Combined with
   * `readLyricScanTargets({ unreadDistroKidLyricsOnly })`, this makes the session-bounded lyric scan
   * RESUMABLE across scans: each run only live-reads albums never read before, so a large catalogue
   * that can't fit one 15-min Steel session converges to full coverage over consecutive scans.
   * Returns the number of track rows seeded.
   */
  async carryForwardLyrics(tenantId: string, snapshotId: string): Promise<number> {
    const res = await this.pool.query(
      `UPDATE "DistributorTrackOutcome" t
       SET "plainLyricsStatus" = prior."plain", "syncedLyricsStatus" = prior."synced"
       FROM "DistributorReleaseOutcome" r
       JOIN "DistributorExtractionSnapshot" s ON r."extractionSnapshotId" = s."id"
       JOIN LATERAL (
         SELECT t2."plainLyricsStatus" AS "plain", t2."syncedLyricsStatus" AS "synced"
         FROM "DistributorTrackOutcome" t2
         JOIN "DistributorReleaseOutcome" r2 ON t2."releaseOutcomeId" = r2."id"
         JOIN "DistributorExtractionSnapshot" s2 ON r2."extractionSnapshotId" = s2."id"
         WHERE s2."userId" = $1 AND s2."snapshotId" <> $2
           AND r2."distributorReleaseId" = r."distributorReleaseId"
           AND t2."trackIndex" = t."trackIndex"
           AND t2."plainLyricsStatus" <> 'unknown'
         ORDER BY s2."startedAt" DESC
         LIMIT 1
       ) prior ON TRUE
       WHERE t."releaseOutcomeId" = r."id" AND s."userId" = $1 AND s."snapshotId" = $2
         AND t."plainLyricsStatus" = 'unknown'`,
      [tenantId, snapshotId],
    );
    return res.rowCount ?? 0;
  }

  /** Update ONLY the store-side lyric columns for a release's tracks, keyed by `(releaseOutcomeId,
   *  trackIndex)`. Independent of `updateTrackLyrics` (DistroKid side) so the two lyric passes never
   *  overwrite each other's column. Returns the number of rows updated. */
  async updateStoreLyrics(
    releaseOutcomeId: string,
    updates: Array<{
      trackIndex: number;
      /** Per-store display verdict: { store -> 'shown' | 'not-shown' | 'unverifiable' }. */
      perStore: Record<string, string>;
      /** Derived global status kept for the existing missing-lyrics comparison. */
      status: string; hasPlain: boolean; hasSynced: boolean; source: string | null;
      lyricfindDistributed: boolean; lyricfindUrl: string | null;
    }>,
  ): Promise<number> {
    let updated = 0;
    for (const u of updates) {
      const res = await this.pool.query(
        `UPDATE "DistributorTrackOutcome"
         SET "storeLyricsPerStore" = $3::jsonb, "lyricfindDistributed" = $4, "lyricfindUrl" = $5,
             "storeLyricStatus" = $6, "storeHasPlain" = $7, "storeHasSynced" = $8,
             "storeLyricSource" = $9, "storeLyricCheckedAt" = NOW()
         WHERE "releaseOutcomeId" = $1 AND "trackIndex" = $2`,
        [releaseOutcomeId, u.trackIndex, JSON.stringify(u.perStore), u.lyricfindDistributed, u.lyricfindUrl,
          u.status, u.hasPlain, u.hasSynced, u.source],
      );
      updated += res.rowCount ?? 0;
    }
    return updated;
  }

  /** Set the snapshot-level progress of the store-lyrics check. `done` also stamps `checkedAt`. */
  async setStoreLyricsProgress(
    tenantId: string,
    snapshotId: string,
    p: { status: string; checked?: number; total?: number; error?: string | null },
  ): Promise<void> {
    await this.pool.query(
      `UPDATE "DistributorExtractionSnapshot"
       SET "storeLyricsStatus" = $3,
           "storeLyricsChecked" = COALESCE($4, "storeLyricsChecked"),
           "storeLyricsTotal" = COALESCE($5, "storeLyricsTotal"),
           "storeLyricsError" = $6,
           "storeLyricsCheckedAt" = CASE WHEN $3 = 'done' THEN NOW() ELSE "storeLyricsCheckedAt" END
       WHERE "userId" = $1 AND "snapshotId" = $2`,
      [tenantId, snapshotId, p.status, p.checked ?? null, p.total ?? null, p.error ?? null],
    );
  }

  /** Lightweight read of just the store-lyrics-check progress (for the polling status endpoint). */
  async readStoreLyricsProgress(tenantId: string, snapshotId: string): Promise<StoreLyricsProgress | null> {
    const res = await this.pool.query<{
      storeLyricsStatus: string; storeLyricsChecked: number; storeLyricsTotal: number;
      storeLyricsError: string | null; storeLyricsCheckedAt: Date | null;
    }>(
      `SELECT "storeLyricsStatus", "storeLyricsChecked", "storeLyricsTotal", "storeLyricsError", "storeLyricsCheckedAt"
       FROM "DistributorExtractionSnapshot" WHERE "userId" = $1 AND "snapshotId" = $2 LIMIT 1`,
      [tenantId, snapshotId],
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      status: row.storeLyricsStatus ?? 'idle',
      checked: row.storeLyricsChecked ?? 0,
      total: row.storeLyricsTotal ?? 0,
      error: row.storeLyricsError ?? null,
      checkedAt: row.storeLyricsCheckedAt ? row.storeLyricsCheckedAt.toISOString() : null,
    };
  }

  /** Apply manual per-track marks (bulk). Each mark targets a track by its public `releaseId` (the
   *  album UUID exposed by `readCatalogue`) + `trackIndex`; the releaseId is resolved to the internal
   *  release row within this snapshot. `mark: null` clears it. Returns the number of rows updated. */
  async updateTrackMarks(
    tenantId: string,
    snapshotId: string,
    marks: Array<{ releaseId: string; trackIndex: number; mark: string | null; note?: string | null }>,
  ): Promise<number> {
    const snap = await this.pool.query<{ id: string }>(
      `SELECT "id" FROM "DistributorExtractionSnapshot" WHERE "userId" = $1 AND "snapshotId" = $2 LIMIT 1`,
      [tenantId, snapshotId],
    );
    const snapshotUuid = snap.rows[0]?.id;
    if (!snapshotUuid) return 0;
    const rels = await this.pool.query<{ id: string; distributorReleaseId: string }>(
      `SELECT "id", "distributorReleaseId" FROM "DistributorReleaseOutcome" WHERE "extractionSnapshotId" = $1`,
      [snapshotUuid],
    );
    const byReleaseId = new Map<string, string>();
    for (const r of rels.rows) byReleaseId.set(albumUuidOf(r.distributorReleaseId), r.id);

    let updated = 0;
    for (const m of marks) {
      const releaseOutcomeId = byReleaseId.get(m.releaseId);
      if (!releaseOutcomeId) continue;
      const res = await this.pool.query(
        `UPDATE "DistributorTrackOutcome"
         SET "mark" = $3, "markNote" = $4, "markedAt" = CASE WHEN $3 IS NULL THEN NULL ELSE NOW() END
         WHERE "releaseOutcomeId" = $1 AND "trackIndex" = $2`,
        [releaseOutcomeId, m.trackIndex, m.mark, m.note ?? null],
      );
      updated += res.rowCount ?? 0;
    }
    return updated;
  }

  /** Update ONLY the lyric columns for a release's tracks, keyed by the `(releaseOutcomeId,
   *  trackIndex)` unique constraint. Returns the number of rows updated. */
  async updateTrackLyrics(releaseOutcomeId: string, updates: Array<{ trackIndex: number; plain: string; synced: string }>): Promise<number> {
    let updated = 0;
    for (const u of updates) {
      const res = await this.pool.query(
        `UPDATE "DistributorTrackOutcome" SET "plainLyricsStatus" = $3, "syncedLyricsStatus" = $4
         WHERE "releaseOutcomeId" = $1 AND "trackIndex" = $2`,
        [releaseOutcomeId, u.trackIndex, u.plain, u.synced],
      );
      updated += res.rowCount ?? 0;
    }
    return updated;
  }

  async persist(job: FinalizeJob, outcomes: ReleaseExtractionOutcome[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const snapshotRowId = await upsertSnapshot(client, job);
      for (const outcome of outcomes) await upsertOutcome(client, job, snapshotRowId, outcome);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
}

async function upsertSnapshot(client: PoolClient, job: FinalizeJob): Promise<string> {
  const c = job.completeness;
  const res = await client.query<{ id: string }>(
    `INSERT INTO "DistributorExtractionSnapshot" (
       "id", "userId", "connectionId", "snapshotId", "distributor", "status", "engine",
       "expectedReleases", "completedReleases", "failedReleases", "expectedTracksKnown", "expectedTracks", "extractedTracks",
       "releasesWithUpc", "releasesWithArtwork", "tracksWithIsrc",
       "releasesUpcAbsentAtSource", "tracksIsrcAbsentAtSource",
       "releasesUpcNotCaptured", "tracksIsrcNotCaptured",
       "unresolvedReleaseIds", "failureReasons", "finalizedAt"
     ) VALUES (
       gen_random_uuid()::text, $1, $2, $3, $4, $5, 'NETWORK_FIRST',
       $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20::jsonb, NOW()
     )
     ON CONFLICT ("userId", "snapshotId") DO UPDATE SET
       "status" = EXCLUDED."status",
       "expectedReleases" = EXCLUDED."expectedReleases",
       "completedReleases" = EXCLUDED."completedReleases",
       "failedReleases" = EXCLUDED."failedReleases",
       "expectedTracksKnown" = EXCLUDED."expectedTracksKnown",
       "expectedTracks" = EXCLUDED."expectedTracks",
       "extractedTracks" = EXCLUDED."extractedTracks",
       "releasesWithUpc" = EXCLUDED."releasesWithUpc",
       "releasesWithArtwork" = EXCLUDED."releasesWithArtwork",
       "tracksWithIsrc" = EXCLUDED."tracksWithIsrc",
       "releasesUpcAbsentAtSource" = EXCLUDED."releasesUpcAbsentAtSource",
       "tracksIsrcAbsentAtSource" = EXCLUDED."tracksIsrcAbsentAtSource",
       "releasesUpcNotCaptured" = EXCLUDED."releasesUpcNotCaptured",
       "tracksIsrcNotCaptured" = EXCLUDED."tracksIsrcNotCaptured",
       "unresolvedReleaseIds" = EXCLUDED."unresolvedReleaseIds",
       "failureReasons" = EXCLUDED."failureReasons",
       "finalizedAt" = NOW()
     RETURNING "id"`,
    [
      job.tenantId, job.connectionId, job.snapshotId, job.distributor, job.status,
      c.expectedReleases, c.completedReleases, c.failedReleases,
      // Be conservative if an old in-flight finalizer bypassed the current Zod edge parser.
      c.expectedTracksKnown === true, c.expectedTracks, c.extractedTracks,
      c.releasesWithUpc, c.releasesWithArtwork, c.tracksWithIsrc,
      c.releasesUpcAbsentAtSource, c.tracksIsrcAbsentAtSource,
      c.releasesUpcNotCaptured, c.tracksIsrcNotCaptured,
      c.unresolvedReleaseIds, JSON.stringify(c.failureReasons ?? {}),
    ],
  );
  const id = res.rows[0]?.id;
  if (!id) throw new Error('failed to upsert extraction snapshot');
  return id;
}

async function upsertOutcome(
  client: PoolClient, job: FinalizeJob, snapshotRowId: string, outcome: ReleaseExtractionOutcome,
): Promise<void> {
  const releaseId = outcome.kind === 'COMPLETED' ? outcome.release.distributorReleaseId : outcome.distributorReleaseId;
  const r: CanonicalDistributorRelease | null = outcome.kind === 'COMPLETED' ? outcome.release : null;
  // Reason CODE only. `detail` is deliberately never persisted: it can quote response content.
  const reason = outcome.kind === 'COMPLETED' ? null : outcome.reason;

  const res = await client.query<{ id: string }>(
    `INSERT INTO "DistributorReleaseOutcome" (
       "id", "userId", "extractionSnapshotId", "distributorReleaseId", "kind", "reason",
       "title", "primaryArtist", "label", "releaseDate", "uploadDate", "artworkUrl", "upc",
       "upcStatus", "artworkStatus", "source", "parserVersion", "endpointFingerprint",
       "capturedAt", "submittedStores", "updatedAt"
     ) VALUES (
       gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19::jsonb, NOW()
     )
     ON CONFLICT ("extractionSnapshotId", "distributorReleaseId") DO UPDATE SET
       "kind" = EXCLUDED."kind", "reason" = EXCLUDED."reason",
       "title" = EXCLUDED."title", "primaryArtist" = EXCLUDED."primaryArtist",
       "label" = EXCLUDED."label", "releaseDate" = EXCLUDED."releaseDate",
       "uploadDate" = EXCLUDED."uploadDate", "artworkUrl" = EXCLUDED."artworkUrl",
       "upc" = EXCLUDED."upc", "upcStatus" = EXCLUDED."upcStatus",
       "artworkStatus" = EXCLUDED."artworkStatus", "source" = EXCLUDED."source",
       "parserVersion" = EXCLUDED."parserVersion",
       "endpointFingerprint" = EXCLUDED."endpointFingerprint",
       "capturedAt" = EXCLUDED."capturedAt",
       "submittedStores" = EXCLUDED."submittedStores",
       "updatedAt" = NOW()
     RETURNING "id"`,
    [
      job.tenantId, snapshotRowId, releaseId, outcome.kind, reason,
      r?.title ?? null, r?.primaryArtist ?? null,
      r?.label?.value ?? null, r?.releaseDate.value ?? null, r?.uploadDate?.value ?? null,
      r?.artworkUrl.value ?? null, r?.upc.value ?? null,
      r?.upc.status ?? 'UNKNOWN', r?.artworkUrl.status ?? 'UNKNOWN',
      outcome.kind === 'COMPLETED' ? outcome.source : null,
      r?.upc.parserVersion ?? null,
      // Provenance: which sanitized endpoint served this release. The column existed but nothing
      // ever wrote to it, so a stored release could not be traced back to its endpoint profile -
      // exactly when you need that link is when a profile degrades and you must decide what to
      // re-read. Truncated: the full hash adds nothing an operator can use.
      outcome.kind === 'SKIPPED' ? null : outcome.endpointFingerprint?.slice(0, 32) ?? null,
      r?.upc.capturedAt ?? null,
      r?.submittedStores?.length ? JSON.stringify(r.submittedStores) : null,
    ],
  );
  const outcomeRowId = res.rows[0]?.id;
  if (!outcomeRowId) return;

  // Finalization is AUTHORITATIVE: the incoming track set replaces whatever is stored, it does
  // not merge with it.
  //
  // Upserting alone left orphans. A corrected re-read returning 9 tracks after a 10-track read
  // left track 9 in place forever, and a release that turned into a terminal FAILURE kept the
  // tracks from its earlier success, so the database would show tracks hanging off a release we
  // are simultaneously reporting as unread. Both are silent, and both make the catalogue lie.
  const keepIndexes = r ? r.tracks.map((_, i) => i) : [];
  if (keepIndexes.length === 0) {
    await client.query(`DELETE FROM "DistributorTrackOutcome" WHERE "releaseOutcomeId" = $1`, [outcomeRowId]);
  } else {
    await client.query(
      `DELETE FROM "DistributorTrackOutcome" WHERE "releaseOutcomeId" = $1 AND "trackIndex" <> ALL($2::int[])`,
      [outcomeRowId, keepIndexes],
    );
  }
  if (!r) return;

  for (const [i, t] of r.tracks.entries()) {
    await client.query(
      `INSERT INTO "DistributorTrackOutcome" (
         "id", "userId", "releaseOutcomeId", "distributorTrackId", "trackIndex",
         "title", "primaryArtist", "featuredArtists", "trackNumber", "durationMs",
         "isrc", "isrcStatus", "source", "parserVersion", "capturedAt",
         "plainLyricsStatus", "syncedLyricsStatus"
       ) VALUES (
         gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
       )
       ON CONFLICT ("releaseOutcomeId", "trackIndex") DO UPDATE SET
         "distributorTrackId" = EXCLUDED."distributorTrackId",
         "title" = EXCLUDED."title", "primaryArtist" = EXCLUDED."primaryArtist",
         "featuredArtists" = EXCLUDED."featuredArtists",
         "trackNumber" = EXCLUDED."trackNumber", "durationMs" = EXCLUDED."durationMs",
         "isrc" = EXCLUDED."isrc", "isrcStatus" = EXCLUDED."isrcStatus",
         "source" = EXCLUDED."source", "parserVersion" = EXCLUDED."parserVersion",
         "capturedAt" = EXCLUDED."capturedAt",
         "plainLyricsStatus" = EXCLUDED."plainLyricsStatus",
         "syncedLyricsStatus" = EXCLUDED."syncedLyricsStatus"`,
      [
        job.tenantId, outcomeRowId, t.distributorTrackId ?? null, i,
        t.title, r.primaryArtist ?? null, [...(r.featuredArtists ?? [])],
        t.trackNumber ?? null, t.durationSec != null ? Math.round(t.durationSec * 1000) : null,
        t.isrc.value ?? null, t.isrc.status,
        t.isrc.source, t.isrc.parserVersion, t.isrc.capturedAt,
        t.lyrics?.plain ?? 'unknown', t.lyrics?.synced ?? 'unknown',
      ],
    );
  }
}
