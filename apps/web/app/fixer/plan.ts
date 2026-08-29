/**
 * One-Click Fixer, Fix planner (pure).
 *
 * Turns the issues the detection modules already computed (catalogue metadata, store presence,
 * wrong-profile, LRCLIB lyric availability) into a prioritized list of prepared, one-click
 * remediations. COMPLIANCE: the planner only PREPARES a diagnosis + a deep link + prepared content;
 * it never takes an action. The human reviews and performs the authorized action.
 */

export type FixKind = 'wrong-profile' | 'missing-store' | 'missing-metadata' | 'missing-lyrics';
export type FixSeverity = 'high' | 'medium' | 'low';

export interface FixLink { href: string; label: string }
export interface Fix {
  id: string;
  releaseId: string;
  releaseTitle: string;
  trackTitle?: string;
  trackNumber?: number | null;
  store?: string;
  kind: FixKind;
  severity: FixSeverity;
  diagnosis: string;
  action: string;
  /** External deep link that lands the user on the exact place to act (opens in a new tab). */
  link?: FixLink;
  /** Prepared content the user needs at hand (ISRC, the wrong artist name, etc.). */
  prepared?: string;
}

export interface CatTrack {
  title: string | null; isrc: string | null; isrcStatus: string; trackNumber: number | null;
  /** Lyric facts served on each catalogue track, both DistroKid-side and store-side (LRCLIB). */
  plainLyrics?: string; syncedLyrics?: string;
  storeLyricStatus?: string; storeHasPlain?: boolean; storeHasSynced?: boolean;
  /** Manual per-track override the user applied on the store-health grid: 'missing' | 'resolved'. */
  mark?: string | null;
}
export interface CatRelease {
  releaseId: string;
  distributorReleaseId: string;
  title: string | null;
  upc: string | null;
  upcStatus: string;
  artworkStatus: string;
  tracks: CatTrack[];
}
export interface Catalogue { releases: CatRelease[] }

export interface PerStore { store: string; status: string; foundArtist: string | null; url: string | null }
export interface RecTrack { title: string | null; isrc: string | null; perStore: PerStore[] }
export interface RecordView { result: { stores: string[]; tracks: RecTrack[] } }

const DISTROKID = 'https://distrokid.com';
const isrcKey = (s: string | null | undefined): string => (s ?? '').trim().toUpperCase();

/** "For Artists" relink destinations for the stores where a namesake collision is common. */
const RELINK: Record<string, FixLink> = {
  Spotify: { href: 'https://artists.spotify.com', label: 'Open Spotify for Artists' },
  'Apple Music': { href: 'https://artists.apple.com', label: 'Open Apple Music for Artists' },
  'Apple Music / iTunes': { href: 'https://artists.apple.com', label: 'Open Apple Music for Artists' },
};

const editHrefOf = (r: CatRelease): FixLink => ({
  href: r.distributorReleaseId && /^https?:\/\//.test(r.distributorReleaseId)
    ? r.distributorReleaseId
    : `${DISTROKID}/dashboard/album/?albumuuid=${r.releaseId}`,
  label: 'Open release on DistroKid',
});

const SEVERITY_RANK: Record<FixSeverity, number> = { high: 0, medium: 1, low: 2 };

/**
 * Build the prioritized fix list from the scraped catalogue and (optionally) the store-presence +
 * lyric-check results on the search record. Store/lyric fixes only appear once those checks have run.
 */
export function planFixes(catalogue: Catalogue, record: RecordView | null): Fix[] {
  const fixes: Fix[] = [];
  const byIsrc = new Map<string, RecTrack>();
  for (const t of record?.result.tracks ?? []) {
    const k = isrcKey(t.isrc);
    if (k) byIsrc.set(k, t);
  }

  for (const r of catalogue.releases) {
    const title = r.title || 'Untitled';
    const edit = editHrefOf(r);

    // Release-level metadata gaps.
    if (r.upcStatus !== 'PRESENT' && !r.upc) {
      fixes.push({
        id: `${r.releaseId}:upc`, releaseId: r.releaseId, releaseTitle: title,
        kind: 'missing-metadata', severity: 'medium',
        diagnosis: 'No UPC was captured for this release.',
        action: 'Confirm the release UPC on DistroKid.', link: edit,
      });
    }
    if (r.artworkStatus !== 'PRESENT') {
      fixes.push({
        id: `${r.releaseId}:art`, releaseId: r.releaseId, releaseTitle: title,
        kind: 'missing-metadata', severity: 'medium',
        diagnosis: 'No cover art was captured for this release.',
        action: 'Add or confirm cover art on DistroKid.', link: edit,
      });
    }

    for (const t of r.tracks) {
      const trackTitle = t.title || 'Untitled';
      const num = t.trackNumber;
      const rec = t.isrc ? byIsrc.get(isrcKey(t.isrc)) : undefined;

      // Manual "marked missing", a user-asserted gap, surfaced at the top of the fix list.
      if (t.mark === 'missing') {
        fixes.push({
          id: `${r.releaseId}:${num}:marked-missing`, releaseId: r.releaseId, releaseTitle: title,
          trackTitle, trackNumber: num, kind: 'missing-store', severity: 'high',
          diagnosis: 'You marked this track as missing.',
          action: 'Follow up on this track, request redelivery to the stores or open a support ticket.', link: edit,
          prepared: `${t.isrc ? `ISRC ${t.isrc}` : 'no ISRC'} · ${title}, ${trackTitle}`,
        });
      }

      // Track-level metadata gap.
      if (t.isrcStatus !== 'PRESENT' && !t.isrc) {
        fixes.push({
          id: `${r.releaseId}:${num}:isrc`, releaseId: r.releaseId, releaseTitle: title,
          trackTitle, trackNumber: num, kind: 'missing-metadata', severity: 'medium',
          diagnosis: 'No ISRC was captured for this track.',
          action: 'Confirm the track ISRC on DistroKid.', link: edit,
        });
      }

      // Store presence + wrong profile (from the store check).
      for (const c of rec?.perStore ?? []) {
        if (c.status === 'wrong-profile') {
          fixes.push({
            id: `${r.releaseId}:${num}:${c.store}:wrong`, releaseId: r.releaseId, releaseTitle: title,
            trackTitle, trackNumber: num, store: c.store, kind: 'wrong-profile', severity: 'high',
            diagnosis: `On ${c.store} this track resolves to a different artist${c.foundArtist ? `, "${c.foundArtist}"` : ''}.`,
            action: `Claim/relink this track to your ${c.store} profile.`,
            link: RELINK[c.store] ?? (c.url ? { href: c.url, label: `Open on ${c.store}` } : edit),
            prepared: `${t.isrc ? `ISRC ${t.isrc}` : 'no ISRC'}${c.foundArtist ? ` · currently under "${c.foundArtist}"` : ''}`,
          });
        } else if (c.status === 'not-live') {
          fixes.push({
            id: `${r.releaseId}:${num}:${c.store}:missing`, releaseId: r.releaseId, releaseTitle: title,
            trackTitle, trackNumber: num, store: c.store, kind: 'missing-store', severity: 'high',
            diagnosis: `Not found live on ${c.store}.`,
            action: `Request redelivery to ${c.store} (or open a support ticket).`, link: edit,
            prepared: `${t.isrc ? `ISRC ${t.isrc}` : 'no ISRC'} · ${title}, ${trackTitle}`,
          });
        }
      }

      // Lyric reconciliation (DistroKid-side vs the stores, from the LRCLIB check). Only once the
      // store-lyric check has produced a verdict for this track.
      const dkHasLyrics = t.plainLyrics === 'present' || t.syncedLyrics === 'present';
      const storeChecked = t.storeLyricStatus && t.storeLyricStatus !== 'unknown' && t.storeLyricStatus !== 'unverifiable';
      const storeHasLyrics = t.storeLyricStatus === 'found' && (!!t.storeHasPlain || !!t.storeHasSynced);
      if (storeChecked && dkHasLyrics && !storeHasLyrics) {
        fixes.push({
          id: `${r.releaseId}:${num}:lyrics-store`, releaseId: r.releaseId, releaseTitle: title,
          trackTitle, trackNumber: num, kind: 'missing-lyrics', severity: 'medium',
          diagnosis: 'Lyrics are on your DistroKid release but not live on the stores.',
          action: 'Request redelivery so your lyrics propagate to the stores.', link: edit,
          prepared: `${t.isrc ? `ISRC ${t.isrc}` : 'no ISRC'} · ${title}, ${trackTitle}`,
        });
      } else if (storeChecked && !dkHasLyrics && storeHasLyrics) {
        fixes.push({
          id: `${r.releaseId}:${num}:lyrics-dk`, releaseId: r.releaseId, releaseTitle: title,
          trackTitle, trackNumber: num, kind: 'missing-lyrics', severity: 'low',
          diagnosis: 'The stores show lyrics for this track but your DistroKid release has none.',
          action: 'Add lyrics on DistroKid so your release matches the stores.',
          link: { href: `${DISTROKID}/lyrics/track/?id=${r.releaseId},${num ?? 1}`, label: 'Add lyrics on DistroKid' },
        });
      }
    }
  }

  return fixes.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

/** Group fixes by release, preserving severity order within each group. */
export function groupByRelease(fixes: Fix[]): Array<{ releaseId: string; releaseTitle: string; fixes: Fix[] }> {
  const order: string[] = [];
  const map = new Map<string, { releaseId: string; releaseTitle: string; fixes: Fix[] }>();
  for (const f of fixes) {
    let g = map.get(f.releaseId);
    if (!g) { g = { releaseId: f.releaseId, releaseTitle: f.releaseTitle, fixes: [] }; map.set(f.releaseId, g); order.push(f.releaseId); }
    g.fixes.push(f);
  }
  return order.map((id) => map.get(id)!);
}
