import type { StoreCheckMethod } from './types';

/**
 * Honest coverage map for the requested stores. `method` states HOW presence can
 * actually be determined for each — no store is marked verifiable unless a real
 * data path exists. `needsKey` flags official APIs that require a credential.
 *
 *  - api                  : real public/official API (verifiable now or with a key)
 *  - distributor-reported : no store API; use the distributor's delivered status
 *  - unverifiable         : no public API and no reliable independent signal
 */
export interface StoreCoverage {
  store: string;
  method: StoreCheckMethod;
  needsKey?: boolean;
  note?: string;
}

export const STORE_COVERAGE: StoreCoverage[] = [
  // --- Real public/official APIs -------------------------------------------
  { store: 'Deezer', method: 'api', needsKey: false, note: 'Public API, ISRC lookup' },
  { store: 'Apple Music', method: 'api', needsKey: false, note: 'iTunes Search API (title match)' },
  { store: 'iTunes', method: 'api', needsKey: false, note: 'iTunes Search API' },
  { store: 'Spotify', method: 'api', needsKey: true, note: 'Web API (free app: client id/secret)' },
  { store: 'YouTube Music', method: 'api', needsKey: true, note: 'YouTube Data API key' },
  { store: 'YouTube Shorts', method: 'api', needsKey: true, note: 'YouTube Data API key' },
  { store: 'TIDAL', method: 'api', needsKey: true, note: 'TIDAL API (developer credentials)' },
  { store: 'Qobuz', method: 'api', needsKey: true, note: 'Qobuz API (app id/secret)' },
  { store: 'Napster', method: 'api', needsKey: true, note: 'Napster/Rhapsody API key' },
  { store: 'Boomplay', method: 'api', needsKey: true, note: 'Boomplay OpenAPI (partner key)' },
  { store: 'Anghami', method: 'api', needsKey: true, note: 'Anghami API (partner key)' },
  { store: 'JioSaavn', method: 'api', needsKey: true, note: 'Unofficial public JSON endpoints' },
  { store: 'Shazam', method: 'api', needsKey: true, note: 'Shazam via RapidAPI (key)' },

  // --- No store API → use the distributor's own delivered/live status --------
  { store: 'Amazon Music', method: 'distributor-reported', note: 'No public catalog API' },
  { store: 'TikTok', method: 'distributor-reported', note: 'No catalog presence API' },
  { store: 'TikTok Music', method: 'distributor-reported' },
  { store: 'Instagram', method: 'distributor-reported', note: 'Meta music library, no public API' },
  { store: 'Facebook', method: 'distributor-reported', note: 'Meta music library, no public API' },
  { store: 'Pandora', method: 'distributor-reported', note: 'No public catalog API' },
  { store: 'iHeartRadio', method: 'distributor-reported' },
  { store: 'Claro Música', method: 'distributor-reported' },
  { store: 'KKBOX', method: 'distributor-reported', note: 'API is partner-gated' },
  { store: 'QQ Music', method: 'distributor-reported', note: 'Tencent, region-gated' },
  { store: 'Tencent Music', method: 'distributor-reported' },
  { store: 'Kugou Music', method: 'distributor-reported' },
  { store: 'Kuwo Music', method: 'distributor-reported' },
  { store: 'NetEase Cloud Music', method: 'distributor-reported' },
  { store: 'Hungama', method: 'distributor-reported' },
  { store: 'JOOX', method: 'distributor-reported' },
  { store: 'WeSing', method: 'distributor-reported' },
  { store: 'Traxsource', method: 'distributor-reported', note: 'Site search only' },
  { store: 'Beatport', method: 'distributor-reported', note: 'API is partner-gated' },
  { store: 'Juno Download', method: 'distributor-reported' },
  { store: 'CapCut', method: 'distributor-reported', note: 'Commercial music library' },
  { store: 'Snapchat', method: 'distributor-reported', note: 'Sound library' },
  { store: 'Roblox', method: 'distributor-reported' },
  { store: 'TouchTunes', method: 'distributor-reported', note: 'Jukebox network' },
  { store: 'PlayNetwork', method: 'distributor-reported', note: 'B2B background music' },
  { store: 'Pretzel', method: 'distributor-reported', note: 'Streamer-safe music' },
  { store: 'LunaMedia', method: 'distributor-reported' },
  { store: 'MediaNet', method: 'distributor-reported', note: 'B2B aggregator' },
  { store: 'Napster (PlayNetwork)', method: 'distributor-reported' },
];

/** DistroKid, CD Baby, TuneCore etc. are DISTRIBUTORS (catalog source), not stores. */
export const DISTRIBUTORS = ['DistroKid', 'CD Baby', 'TuneCore', 'UnitedMasters', 'Ditto', 'Amuse'] as const;

export function coverageSummary(): { api: number; apiNoKey: number; distributorReported: number; total: number } {
  const api = STORE_COVERAGE.filter((s) => s.method === 'api');
  return {
    api: api.length,
    apiNoKey: api.filter((s) => !s.needsKey).length,
    distributorReported: STORE_COVERAGE.filter((s) => s.method === 'distributor-reported').length,
    total: STORE_COVERAGE.length,
  };
}
