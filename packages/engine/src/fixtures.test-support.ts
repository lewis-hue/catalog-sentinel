import { toCsv, type ArtistProfileCandidate, type RawDSPItem } from '@sentinel/adapters';
import type { AudiomackDataset } from '../../adapters/src/dsp/audiomack.test-support';

/**
 * Deterministic synthetic data used solely by automated tests:
 *   150 distributor tracks · 50 found on Audiomack · 100 missing · plus
 *   wrong-profile, duplicate-profile, private/unplayable, and missing-ISRC cases.
 */

type Placement = 'canonical-live' | 'canonical-private' | 'duplicate-profile' | 'wrong-profile' | 'missing';

const FIRSTS = [
  'Lagos', 'Midnight', 'Golden', 'Silent', 'Neon', 'Broken', 'Rising', 'Velvet', 'Crimson', 'Electric',
  'Sunday', 'Northern', 'Lonely', 'Sacred', 'Restless', 'Wild', 'Frozen', 'Hidden', 'Distant', 'Burning',
];
const SECONDS = [
  'Nights', 'Dreams', 'Roads', 'Hearts', 'Skies', 'Echoes', 'Fires', 'Waves', 'Shadows', 'Lights',
  'Streets', 'Rivers', 'Storms', 'Kings', 'Ghosts', 'Angels', 'Memories', 'Horizons', 'Anthem', 'Motion',
];
const THIRDS = ['II', 'Reprise', 'Interlude', 'Redux', 'Pt 2', 'Revisited', 'Encore', 'Coda'];

/** Tiny deterministic LCG so durations/variations are reproducible run-to-run. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

interface TrackSpec {
  index: number;
  title: string;
  isrc: string | null;
  durationSec: number;
  placement: Placement;
  releaseTitle: string;
  releaseIndex: number;
  upc: string | null;
  releaseDate: string;
  url: string;
  plainLyrics: string;
  songwriter: string;
}

function buildSpecs(): TrackSpec[] {
  const rand = lcg(20260707);
  const usedTitles = new Set<string>();
  const specs: TrackSpec[] = [];

  // Group 150 tracks into releases using a repeating size pattern.
  const sizePattern = [3, 1, 5, 1, 4, 2, 1, 3, 1, 2];
  let releaseIndex = -1;
  let remainingInRelease = 0;
  let releaseTitle = '';
  let releaseUpc: string | null = null;
  let releaseDate = '';
  let releaseUrl = '';

  // Indices with null ISRC (distinctive "Untitled Sketch" tracks) — exercises
  // ISRC_MISSING while staying unambiguous for matching (unique titles).
  const untitledIdx = new Set([1, 10, 19, 28]);

  for (let i = 0; i < 150; i++) {
    if (remainingInRelease === 0) {
      releaseIndex++;
      remainingInRelease = sizePattern[releaseIndex % sizePattern.length]!;
      const rf = FIRSTS[(releaseIndex * 3) % FIRSTS.length]!;
      const rs = SECONDS[(releaseIndex * 5 + 2) % SECONDS.length]!;
      releaseTitle = remainingInRelease > 1 ? `${rf} ${rs} EP` : `${rf} ${rs}`;
      // ~1 in 5 releases is missing its UPC (exercises title-based grouping/UPC_MISSING).
      releaseUpc = releaseIndex % 5 === 4 ? null : `0888072${String(10000 + releaseIndex).slice(-5)}`;
      const year = 2021 + (releaseIndex % 5);
      const month = String(1 + (releaseIndex % 12)).padStart(2, '0');
      releaseDate = `${year}-${month}-05`;
      releaseUrl = `https://distrokid.com/hyperfollow/lewiske/${slug(releaseTitle)}-${releaseIndex}`;
    }
    remainingInRelease--;

    // Deterministic, ISRC-driven placement. The 50 "found" tracks are i % 3 === 1;
    // among them 1 wrong-profile, 1 duplicate-profile, 2 private, rest live.
    // Everything else (100 tracks) is missing. Matching is ISRC-decisive, so the
    // exact counts hold regardless of title similarity.
    let placement: Placement = 'missing';
    if (i % 3 === 1) {
      if (i === 139) placement = 'wrong-profile';
      else if (i === 142) placement = 'duplicate-profile';
      else if (i === 145 || i === 148) placement = 'canonical-private';
      else placement = 'canonical-live';
    }

    // Unique, distinctive title.
    let title: string;
    if (untitledIdx.has(i)) {
      title = `Untitled Sketch ${[...untitledIdx].indexOf(i) + 1}`;
    } else {
      title = `${FIRSTS[i % FIRSTS.length]} ${SECONDS[(i * 7 + 3) % SECONDS.length]}`;
      while (usedTitles.has(title)) title = `${title} ${THIRDS[usedTitles.size % THIRDS.length]}`;
    }
    usedTitles.add(title);

    // Every track carries a unique ISRC except the distinctive "Untitled" tracks
    // (which stay canonical-live and are matched by exact title).
    const isrc = untitledIdx.has(i) ? null : `USKE123${String(10000 + i).slice(-5)}`;
    const durationSec = 150 + Math.floor(rand() * 140);
    const plainLyrics = i % 4 === 0 ? 'No' : 'Approved';
    const songwriter = i % 6 === 0 ? '' : 'Lewis K. Emeka';

    specs.push({
      index: i,
      title,
      isrc,
      durationSec,
      placement,
      releaseTitle,
      releaseIndex,
      upc: releaseUpc,
      releaseDate,
      url: releaseUrl,
      plainLyrics,
      songwriter,
    });
  }
  return specs;
}

const ARTIST = 'Lewis KE';

function csvFromSpecs(specs: TrackSpec[]): string {
  const columns = [
    'Release Title', 'Track Title', 'Artist', 'ISRC', 'UPC', 'Release Date',
    'DistroKid URL', 'Stores', 'Plain Lyrics', 'Synced Lyrics', 'Songwriter', 'Duration', 'Explicit',
  ];
  const rows = specs.map((s) => ({
    'Release Title': s.releaseTitle,
    'Track Title': s.title,
    Artist: ARTIST,
    ISRC: s.isrc ?? '',
    UPC: s.upc ?? '',
    'Release Date': s.releaseDate,
    'DistroKid URL': s.url,
    Stores: 'Spotify, Apple Music, Audiomack, YouTube Music, Amazon Music',
    'Plain Lyrics': s.plainLyrics,
    'Synced Lyrics': '',
    Songwriter: s.songwriter,
    Duration: `${Math.floor(s.durationSec / 60)}:${String(s.durationSec % 60).padStart(2, '0')}`,
    Explicit: s.index % 8 === 0 ? 'Yes' : 'No',
  }));
  return toCsv(columns, rows);
}

function profile(externalId: string, slugStr: string, name: string, confidence: number, verified: boolean): ArtistProfileCandidate {
  return {
    platform: 'audiomack',
    externalId,
    slug: slugStr,
    url: `https://audiomack.com/${slugStr}`,
    name,
    confidence,
    verified,
    followerCount: verified ? 48213 : 112,
  };
}

function item(spec: TrackSpec, profileId: string, slugStr: string, artist: string, status: RawDSPItem['status']): RawDSPItem {
  return {
    externalId: `am_${profileId}_${spec.index}`,
    url: `https://audiomack.com/${slugStr}/song/${slug(spec.title)}`,
    title: spec.title,
    primaryArtist: artist,
    featuredArtists: [],
    isrc: spec.isrc,
    upc: spec.upc,
    durationSec: spec.durationSec,
    kind: 'song',
    status,
    artistProfileId: profileId,
    markets: ['US', 'NG', 'GB'],
  };
}

function audiomackFromSpecs(specs: TrackSpec[]): AudiomackDataset {
  const canonical: RawDSPItem[] = [];
  const official: RawDSPItem[] = [];
  const phantom: RawDSPItem[] = [];

  for (const s of specs) {
    switch (s.placement) {
      case 'canonical-live':
        canonical.push(item(s, 'am_lewis_ke', 'lewis_ke', ARTIST, 'confirmed-live'));
        break;
      case 'canonical-private':
        canonical.push(item(s, 'am_lewis_ke', 'lewis_ke', ARTIST, 'private-unplayable'));
        break;
      case 'duplicate-profile':
        official.push(item(s, 'am_lewis_ke_official', 'lewis_ke_official', ARTIST, 'confirmed-live'));
        break;
      case 'wrong-profile':
        phantom.push(item(s, 'am_dj_phantom', 'dj_phantom', 'DJ Phantom', 'confirmed-live'));
        break;
      case 'missing':
        break;
    }
  }

  return {
    profiles: {
      lewis_ke: { profile: profile('am_lewis_ke', 'lewis_ke', ARTIST, 1, true), items: canonical },
      lewis_ke_official: { profile: profile('am_lewis_ke_official', 'lewis_ke_official', ARTIST, 0.8, false), items: official },
      dj_phantom: { profile: profile('am_dj_phantom', 'dj_phantom', 'DJ Phantom', 0.6, false), items: phantom },
    },
  };
}

export interface LewisKeWorkflowFixture {
  artistName: string;
  audiomackSlug: string;
  distributorCsvText: string;
  audiomackDataset: AudiomackDataset;
  expected: { totalTracks: number; live: number; private: number; duplicateProfile: number; wrongProfile: number; missing: number };
}

export function buildLewisKeWorkflowFixture(): LewisKeWorkflowFixture {
  const specs = buildSpecs();
  const counts = specs.reduce(
    (acc, s) => {
      acc[s.placement]++;
      return acc;
    },
    { 'canonical-live': 0, 'canonical-private': 0, 'duplicate-profile': 0, 'wrong-profile': 0, missing: 0 } as Record<Placement, number>,
  );
  return {
    artistName: ARTIST,
    audiomackSlug: 'lewis_ke',
    distributorCsvText: csvFromSpecs(specs),
    audiomackDataset: audiomackFromSpecs(specs),
    expected: {
      totalTracks: specs.length,
      live: counts['canonical-live'],
      private: counts['canonical-private'],
      duplicateProfile: counts['duplicate-profile'],
      wrongProfile: counts['wrong-profile'],
      missing: counts.missing,
    },
  };
}
