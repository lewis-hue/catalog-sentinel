/**
 * Release Alerts, scan diff (pure).
 *
 * Compares the latest scan to the previous one and surfaces what CHANGED: new releases/tracks, and
 *, when both scans have store-presence results, tracks that dropped off a store, flipped to a
 * wrong profile, or recovered. Positive changes are included too. Matching is by stable releaseId
 * and by ISRC, so re-scrapes line up across snapshots.
 */

export type AlertKind = 'new-release' | 'new-track' | 'store-lost' | 'wrong-profile' | 'store-recovered' | 'metadata-lost';
export type AlertSeverity = 'high' | 'medium' | 'low' | 'good';

export interface Alert {
  kind: AlertKind;
  severity: AlertSeverity;
  releaseId: string;
  releaseTitle: string;
  trackTitle?: string;
  store?: string;
  detail: string;
}

export interface DiffTrack { title: string | null; isrc: string | null }
export interface DiffRelease { releaseId: string; title: string | null; upc: string | null; tracks: DiffTrack[] }
export interface DiffCatalogue { releases: DiffRelease[] }
export interface DiffPerStore { store: string; status: string }
export interface DiffRecTrack { isrc: string | null; perStore: DiffPerStore[] }
export interface DiffRecord { result: { tracks: DiffRecTrack[] } }
export interface Scan { catalogue: DiffCatalogue; record: DiffRecord | null }

const key = (s: string | null | undefined): string => (s ?? '').trim().toUpperCase();
const SEVERITY_RANK: Record<AlertSeverity, number> = { high: 0, medium: 1, low: 2, good: 3 };

function storeByIsrc(record: DiffRecord | null): Map<string, Map<string, string>> {
  const m = new Map<string, Map<string, string>>();
  for (const t of record?.result.tracks ?? []) {
    const k = key(t.isrc);
    if (!k) continue;
    m.set(k, new Map((t.perStore ?? []).map((c) => [c.store, c.status])));
  }
  return m;
}

export function diffScans(prev: Scan, latest: Scan): Alert[] {
  const alerts: Alert[] = [];
  const prevRel = new Map(prev.catalogue.releases.map((r) => [r.releaseId, r]));
  const prevStores = storeByIsrc(prev.record);
  const latestStores = storeByIsrc(latest.record);

  for (const lr of latest.catalogue.releases) {
    const title = lr.title || 'Untitled';
    const pr = prevRel.get(lr.releaseId);

    if (!pr) {
      alerts.push({ kind: 'new-release', severity: 'good', releaseId: lr.releaseId, releaseTitle: title, detail: `New release with ${lr.tracks.length} track${lr.tracks.length === 1 ? '' : 's'}.` });
      continue; // a brand-new release has no prior state to diff track-by-track
    }

    const priorIsrcs = new Set(pr.tracks.map((t) => key(t.isrc)).filter(Boolean));
    if (pr.upc && !lr.upc) {
      alerts.push({ kind: 'metadata-lost', severity: 'medium', releaseId: lr.releaseId, releaseTitle: title, detail: 'UPC is no longer captured for this release.' });
    }

    for (const t of lr.tracks) {
      const trackTitle = t.title || 'Untitled';
      const isrc = key(t.isrc);
      if (isrc && !priorIsrcs.has(isrc)) {
        alerts.push({ kind: 'new-track', severity: 'low', releaseId: lr.releaseId, releaseTitle: title, trackTitle, detail: 'New track added to this release.' });
      }
      if (!isrc) continue;
      const was = prevStores.get(isrc);
      const now = latestStores.get(isrc);
      if (!was || !now) continue; // need both scans' store results to diff presence
      for (const [store, status] of now) {
        const before = was.get(store);
        if (before === 'live' && status === 'not-live') {
          alerts.push({ kind: 'store-lost', severity: 'high', releaseId: lr.releaseId, releaseTitle: title, trackTitle, store, detail: `Was live on ${store}, now not found.` });
        } else if (before === 'live' && status === 'wrong-profile') {
          alerts.push({ kind: 'wrong-profile', severity: 'high', releaseId: lr.releaseId, releaseTitle: title, trackTitle, store, detail: `Now resolves to a different artist on ${store}.` });
        } else if ((before === 'not-live' || before === 'wrong-profile') && status === 'live') {
          alerts.push({ kind: 'store-recovered', severity: 'good', releaseId: lr.releaseId, releaseTitle: title, trackTitle, store, detail: `Now live on ${store} (was ${before === 'wrong-profile' ? 'a wrong profile' : 'missing'}).` });
        }
      }
    }
  }

  return alerts.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}
