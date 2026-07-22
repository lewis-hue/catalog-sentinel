import { normalizeIsrc, normalizeUpc } from '@sentinel/core';
import { normalizeArtist, parseTitle } from '@sentinel/matching';
import type {
  CreditsStatusValue,
  DistributorProviderName,
  DistributorReleaseSnapshot,
  LyricsStatusValue,
  StoreStatus,
} from './types';

export interface CanonicalIdentifier {
  type: 'isrc' | 'upc' | 'distributor-release-id' | 'distributor-track-id';
  value: string;
}

export interface CanonicalStoreStatus {
  store: string;
  normalizedStore: string;
  status: StoreStatus;
}

export interface CanonicalTrack {
  id: string;
  tenantId: string;
  artistWorkspaceId: string;
  snapshotId: string;
  distributor: DistributorProviderName;
  distributorTrackId: string | null;
  distributorTrackUrl: string | null;
  title: string;
  normalizedTitle: string;
  primaryArtist: string;
  normalizedPrimaryArtist: string;
  featuredArtists: string[];
  /** TRACK-level recording identifier. UPC is deliberately absent: it identifies the RELEASE,
   *  and duplicating it here let a track-level query report a release-level fact. */
  isrc: string | null;
  releaseTitle: string;
  trackNumber: number | null;
  durationMs: number | null;
  releaseDate: string | null;
  lyricsStatus: LyricsStatusValue;
  syncedLyricsStatus: LyricsStatusValue;
  creditsStatus: CreditsStatusValue;
  createdAt: string;
}

export interface CanonicalRelease {
  id: string;
  tenantId: string;
  artistWorkspaceId: string;
  snapshotId: string;
  distributor: DistributorProviderName;
  distributorReleaseId: string | null;
  releaseUrl: string;
  title: string;
  normalizedTitle: string;
  primaryArtist: string;
  upc: string | null;
  releaseDate: string | null;
  stores: CanonicalStoreStatus[];
  identifiers: CanonicalIdentifier[];
  trackIds: string[];
  createdAt: string;
}

export interface CanonicalCatalogSnapshot {
  id: string;
  tenantId: string;
  artistWorkspaceId: string;
  distributor: DistributorProviderName;
  capturedAt: string;
  releaseCount: number;
  trackCount: number;
}

export interface NormalizeInput {
  snapshots: DistributorReleaseSnapshot[];
  tenantId: string;
  artistWorkspaceId: string;
  snapshotId: string;
  distributor: DistributorProviderName;
  nowIso?: () => string;
  idFor?: (kind: string, ...parts: string[]) => string;
}

export interface NormalizeResult {
  snapshot: CanonicalCatalogSnapshot;
  releases: CanonicalRelease[];
  tracks: CanonicalTrack[];
}

/** Normalize distributor release snapshots into canonical releases + tracks. */
export function normalizeCatalog(input: NormalizeInput): NormalizeResult {
  const now = (input.nowIso ?? (() => new Date().toISOString()))();
  const idFor = input.idFor ?? ((kind, ...parts) => `${kind}_${parts.join('|')}`);

  const releases: CanonicalRelease[] = [];
  const tracks: CanonicalTrack[] = [];

  for (const rel of input.snapshots) {
    const upc = normalizeUpc(rel.upc);
    const releaseKey = rel.releaseId || upc || rel.title;
    const releaseId = idFor('rel', input.artistWorkspaceId, releaseKey);
    const trackIds: string[] = [];

    for (const t of rel.tracks) {
      const parsed = parseTitle(t.title);
      const isrc = normalizeIsrc(t.isrc);
      const trackKey = t.trackId || isrc || `${releaseKey}|${t.trackNumber ?? ''}|${t.title}`;
      const trackId = idFor('trk', input.artistWorkspaceId, trackKey);
      trackIds.push(trackId);
      tracks.push({
        id: trackId,
        tenantId: input.tenantId,
        artistWorkspaceId: input.artistWorkspaceId,
        snapshotId: input.snapshotId,
        distributor: input.distributor,
        distributorTrackId: t.trackId,
        distributorTrackUrl: t.trackUrl,
        title: t.title,
        normalizedTitle: parsed.base,
        primaryArtist: rel.artist ?? '',
        normalizedPrimaryArtist: normalizeArtist(rel.artist ?? ''),
        featuredArtists: parsed.featured,
        isrc,
        releaseTitle: rel.title,
        trackNumber: t.trackNumber,
        durationMs: null,
        releaseDate: rel.releaseDate,
        lyricsStatus: t.lyrics.plain,
        syncedLyricsStatus: t.lyrics.synced,
        creditsStatus: t.credits.status,
        createdAt: now,
      });
    }

    releases.push({
      id: releaseId,
      tenantId: input.tenantId,
      artistWorkspaceId: input.artistWorkspaceId,
      snapshotId: input.snapshotId,
      distributor: input.distributor,
      distributorReleaseId: rel.releaseId,
      releaseUrl: rel.releaseUrl,
      title: rel.title,
      normalizedTitle: parseTitle(rel.title).base,
      primaryArtist: rel.artist ?? '',
      upc,
      releaseDate: rel.releaseDate,
      stores: rel.stores.map((s) => ({ store: s.store, normalizedStore: s.store.toLowerCase().replace(/[^a-z0-9]/g, ''), status: s.status })),
      identifiers: [
        ...(upc ? [{ type: 'upc' as const, value: upc }] : []),
        ...(rel.releaseId ? [{ type: 'distributor-release-id' as const, value: rel.releaseId }] : []),
      ],
      trackIds,
      createdAt: now,
    });
  }

  return {
    snapshot: {
      id: input.snapshotId,
      tenantId: input.tenantId,
      artistWorkspaceId: input.artistWorkspaceId,
      distributor: input.distributor,
      capturedAt: now,
      releaseCount: releases.length,
      trackCount: tracks.length,
    },
    releases,
    tracks,
  };
}
