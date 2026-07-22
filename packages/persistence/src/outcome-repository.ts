import type { Pool, PoolClient } from 'pg';
import type { ReleaseExtractionOutcome, CanonicalDistributorRelease, FinalizeJob } from '@sentinel/contracts';

/**
 * DURABLE persistence for finalized extraction outcomes.
 *
 * Why this exists: `persistSnapshot` previously flipped a status flag and logged counts. Redis
 * held the checkpoints, so after a Redis flush/expiry there was no catalog anywhere — the system
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
 *    code — not dropped. "We failed to read this" is a fact the user is entitled to see, and it
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

export class DistroKidOutcomeRepository implements OutcomeRepository {
  constructor(private readonly pool: Pool) {}

  get durable(): boolean {
    return true;
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
       "id", "tenantId", "connectionId", "snapshotId", "distributor", "status", "engine",
       "expectedReleases", "completedReleases", "failedReleases", "expectedTracksKnown", "expectedTracks", "extractedTracks",
       "releasesWithUpc", "releasesWithArtwork", "tracksWithIsrc",
       "releasesUpcAbsentAtSource", "tracksIsrcAbsentAtSource",
       "releasesUpcNotCaptured", "tracksIsrcNotCaptured",
       "unresolvedReleaseIds", "failureReasons", "finalizedAt"
     ) VALUES (
       gen_random_uuid()::text, $1, $2, $3, $4, $5, 'NETWORK_FIRST',
       $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20::jsonb, NOW()
     )
     ON CONFLICT ("tenantId", "snapshotId") DO UPDATE SET
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
       "id", "tenantId", "extractionSnapshotId", "distributorReleaseId", "kind", "reason",
       "title", "primaryArtist", "label", "releaseDate", "uploadDate", "artworkUrl", "upc",
       "upcStatus", "artworkStatus", "source", "parserVersion", "endpointFingerprint",
       "capturedAt", "updatedAt"
     ) VALUES (
       gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, NOW()
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
      // ever wrote to it, so a stored release could not be traced back to its endpoint profile —
      // exactly when you need that link is when a profile degrades and you must decide what to
      // re-read. Truncated: the full hash adds nothing an operator can use.
      outcome.kind === 'SKIPPED' ? null : outcome.endpointFingerprint?.slice(0, 32) ?? null,
      r?.upc.capturedAt ?? null,
    ],
  );
  const outcomeRowId = res.rows[0]?.id;
  if (!outcomeRowId) return;

  // Finalization is AUTHORITATIVE: the incoming track set replaces whatever is stored, it does
  // not merge with it.
  //
  // Upserting alone left orphans. A corrected re-read returning 9 tracks after a 10-track read
  // left track 9 in place forever, and a release that turned into a terminal FAILURE kept the
  // tracks from its earlier success — so the database would show tracks hanging off a release we
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
         "id", "tenantId", "releaseOutcomeId", "distributorTrackId", "trackIndex",
         "title", "primaryArtist", "featuredArtists", "trackNumber", "durationMs",
         "isrc", "isrcStatus", "source", "parserVersion", "capturedAt"
       ) VALUES (
         gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
       )
       ON CONFLICT ("releaseOutcomeId", "trackIndex") DO UPDATE SET
         "distributorTrackId" = EXCLUDED."distributorTrackId",
         "title" = EXCLUDED."title", "primaryArtist" = EXCLUDED."primaryArtist",
         "featuredArtists" = EXCLUDED."featuredArtists",
         "trackNumber" = EXCLUDED."trackNumber", "durationMs" = EXCLUDED."durationMs",
         "isrc" = EXCLUDED."isrc", "isrcStatus" = EXCLUDED."isrcStatus",
         "source" = EXCLUDED."source", "parserVersion" = EXCLUDED."parserVersion",
         "capturedAt" = EXCLUDED."capturedAt"`,
      [
        job.tenantId, outcomeRowId, t.distributorTrackId ?? null, i,
        t.title, r.primaryArtist ?? null, [...(r.featuredArtists ?? [])],
        t.trackNumber ?? null, t.durationSec != null ? Math.round(t.durationSec * 1000) : null,
        t.isrc.value ?? null, t.isrc.status,
        t.isrc.source, t.isrc.parserVersion, t.isrc.capturedAt,
      ],
    );
  }
}
