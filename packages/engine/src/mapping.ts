import {
  normalizeIsrc,
  normalizeUpc,
  stableId,
  type CatalogSnapshot,
  type CatalogSnapshotId,
  type Clock,
  type Release,
  type ReleaseId,
  type StoreSelection,
  type Track,
  type TrackId,
  type WorkspaceId,
} from '@sentinel/core';
import type { DistributorCatalogSnapshot, RawDSPItem, RawDistributorTrack } from '@sentinel/adapters';
import { parseTitle, toNormalizedItem, type NormalizedItem } from '@sentinel/matching';

export interface MappedCatalog {
  snapshot: CatalogSnapshot;
  releases: Release[];
  tracks: Track[];
}

/**
 * Map a distributor catalog snapshot onto canonical core entities, minting
 * STABLE ids (derived from UPC/ISRC/title) so re-importing the same catalog is
 * idempotent — no duplicate releases/tracks appear on rerun.
 */
export function mapDistributorSnapshot(
  snapshot: DistributorCatalogSnapshot,
  workspaceId: string,
  clock: Clock,
): MappedCatalog {
  const ws = workspaceId as WorkspaceId;
  const now = clock.nowIso();
  const snapshotId = stableId<'CatalogSnapshotId'>('snap', workspaceId, snapshot.provider, snapshot.capturedAt) as CatalogSnapshotId;

  const releases: Release[] = [];
  const tracks: Track[] = [];

  for (const rawRel of snapshot.releases) {
    const releaseKey = rawRel.upc || rawRel.distributorReleaseId || rawRel.title;
    const releaseId = stableId<'ReleaseId'>('rel', workspaceId, releaseKey) as ReleaseId;
    const storeSelections: StoreSelection[] = rawRel.storeSelections.map((s) => ({
      platform: s.platform,
      status: s.status,
      observedAt: snapshot.capturedAt,
    }));

    const trackIds: TrackId[] = [];
    rawRel.tracks.forEach((rawTrack, idx) => {
      const trackKey = rawTrack.isrc || `${releaseKey}|${rawTrack.trackNumber ?? idx + 1}|${rawTrack.title}`;
      const trackId = stableId<'TrackId'>('trk', workspaceId, trackKey) as TrackId;
      trackIds.push(trackId);
      tracks.push(buildTrack(rawTrack, trackId, releaseId, ws, now));
    });

    releases.push({
      id: releaseId,
      workspaceId: ws,
      snapshotId,
      title: rawRel.title,
      primaryArtistName: rawRel.primaryArtist,
      upc: normalizeUpc(rawRel.upc),
      distributorReleaseId: rawRel.distributorReleaseId,
      distributorUrl: rawRel.distributorUrl,
      releaseDate: rawRel.releaseDate,
      label: rawRel.label,
      identifiers: [
        ...(rawRel.upc ? [{ type: 'upc' as const, value: rawRel.upc }] : []),
        ...(rawRel.distributorUrl ? [{ type: 'distributor-url' as const, value: rawRel.distributorUrl }] : []),
      ],
      storeSelections,
      albumExtras: rawRel.albumExtras,
      trackIds,
      createdAt: now,
      updatedAt: now,
    });
  }

  const snap: CatalogSnapshot = {
    id: snapshotId,
    workspaceId: ws,
    source: snapshot.provider,
    sourceMode: snapshot.sourceMode,
    capturedAt: snapshot.capturedAt,
    releaseCount: releases.length,
    trackCount: tracks.length,
    notes: snapshot.warnings.length ? snapshot.warnings.join('; ') : null,
    createdAt: now,
    updatedAt: now,
  };

  return { snapshot: snap, releases, tracks };
}

function buildTrack(raw: RawDistributorTrack, id: TrackId, releaseId: ReleaseId, ws: WorkspaceId, now: string): Track {
  const parsed = parseTitle(raw.title);
  return {
    id,
    workspaceId: ws,
    releaseId,
    title: raw.title,
    versionTags: parsed.versionTags,
    featuredArtists: raw.featuredArtists.length ? raw.featuredArtists : parsed.featured,
    primaryArtistName: raw.primaryArtist,
    isrc: normalizeIsrc(raw.isrc),
    trackNumber: raw.trackNumber,
    durationSec: raw.durationSec,
    isExplicit: raw.isExplicit,
    identifiers: [
      ...(raw.isrc ? [{ type: 'isrc' as const, value: raw.isrc }] : []),
      ...(raw.distributorTrackId ? [{ type: 'distributor-track-id' as const, value: raw.distributorTrackId }] : []),
    ],
    lyrics: raw.lyrics
      ? { plain: raw.lyrics.plain, synced: raw.lyrics.synced, textProvidedByOwner: false, observedAt: now }
      : null,
    credits: raw.credits
      ? { state: raw.credits.state, hasSongwriter: raw.credits.hasSongwriter, hasProducer: raw.credits.hasProducer, observedAt: now }
      : null,
    createdAt: now,
    updatedAt: now,
  };
}

/** Convert a core Track (+ its release UPC) into a matching-engine item. */
export function trackToItem(track: Track, releaseUpc: string | null): NormalizedItem {
  return toNormalizedItem({
    id: track.id,
    title: track.title,
    artistNames: [track.primaryArtistName, ...track.featuredArtists],
    isrc: track.isrc,
    upc: releaseUpc,
    durationSec: track.durationSec,
    trackNumber: track.trackNumber,
  });
}

/** Convert a raw DSP item into a matching-engine candidate. */
export function dspItemToItem(item: RawDSPItem): NormalizedItem {
  return toNormalizedItem({
    id: item.externalId,
    title: item.title,
    artistNames: [item.primaryArtist, ...item.featuredArtists],
    isrc: item.isrc,
    upc: item.upc,
    durationSec: item.durationSec,
    externalIds: [item.externalId, ...(item.url ? [item.url] : [])],
    artistProfileId: item.artistProfileId,
  });
}
