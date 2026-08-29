import { DeezerStoreProvider } from './deezer';
import { ItunesStoreProvider } from './itunes';
import { SpotifyStoreProvider } from './spotify';
import { YouTubeMusicProvider } from './youtube';
import { AudiomackStoreProvider } from './audiomack';
import { SoundCloudStoreProvider } from './soundcloud';
import { TidalStoreProvider } from './tidal';
import { WebPresenceResolver, WEB_PLATFORMS } from './web-search';
import { createSearchProvider, searchBackendFrom } from './search-provider';
import type { ScannableStore } from './scan';
import type { StoreCatalogProvider } from './types';

export interface StoreScanOptions {
  /** false → API stores only (fast); skip the rate-limited web-search platforms. */
  includeWebSearch?: boolean;
  /** Optional per-platform artist profile URLs (platform name → URL) for exact resolution. */
  profiles?: Record<string, string>;
}

/**
 * Build the set of stores to scan from the environment. Two tiers:
 *  - Tier 1 (artist-catalogue APIs): Deezer + Apple (always, no key), and Spotify /
 *    YouTube / Audiomack / SoundCloud / TIDAL when their credentials are set. Each
 *    lists the artist's real catalogue → a precise set-compare against the distributor.
 *  - Tier 2 (web search via Serper): every remaining platform with no public artist API,
 *    confirmed on-page with a confidence score (a miss is 'unverifiable', not 'not-live').
 */
export function createStoreScanTargets(env: NodeJS.ProcessEnv = process.env, opts: StoreScanOptions = {}): ScannableStore[] {
  const profiles = {
    ...(env.AUDIOMACK_PROFILE_URL ? { Audiomack: env.AUDIOMACK_PROFILE_URL } : {}),
    ...(env.SOUNDCLOUD_PROFILE_URL ? { SoundCloud: env.SOUNDCLOUD_PROFILE_URL } : {}),
    ...(env.TIDAL_PROFILE_URL ? { TIDAL: env.TIDAL_PROFILE_URL } : {}),
    ...(opts.profiles ?? {}),
  };
  const deezer = new DeezerStoreProvider();
  const itunes = new ItunesStoreProvider();
  const stores: ScannableStore[] = [
    { catalog: deezer, isrc: deezer, title: deezer },
    { catalog: itunes, title: itunes }, // Apple/iTunes has no ISRC → title+artist search
  ];

  // Official APIs win over web search (more precise). Their catalogue results provide a
  // fast positive index; providers such as Spotify that cannot prove an exhaustive artist
  // catalogue mark misses incomplete so the deep pass performs exact per-track checks.
  const covered = new Set<string>();
  if (env.SPOTIFY_CLIENT_ID && env.SPOTIFY_CLIENT_SECRET) {
    const spotify = new SpotifyStoreProvider({ clientId: env.SPOTIFY_CLIENT_ID, clientSecret: env.SPOTIFY_CLIENT_SECRET });
    stores.push({ catalog: spotify, isrc: spotify, title: spotify });
    covered.add('Spotify');
  }
  // YouTube Data API is OFF by default: its free quota (100 units/search, 10k/day) can't cover a
  // real catalogue (a few hundred tracks exhausts it → false 0-live), so YouTube Music web-verifies
  // through the search provider (Serper) like the other stores. Opt back into the API with
  // YOUTUBE_USE_API=true only if you hold a high-quota key.
  if (env.YOUTUBE_API_KEY && /^(1|true|yes|on)$/i.test(env.YOUTUBE_USE_API ?? '')) {
    const yt = new YouTubeMusicProvider({ apiKey: env.YOUTUBE_API_KEY });
    stores.push({ catalog: yt, catalogMode: 'confirm-only', title: yt, confirmOnly: true }); // YouTube isn't a clean discography
    covered.add('YouTube Music');
  }
  if (env.AUDIOMACK_CONSUMER_KEY && env.AUDIOMACK_CONSUMER_SECRET) {
    const slug = profiles.Audiomack ? AudiomackStoreProvider.slugFromProfileUrl(profiles.Audiomack) ?? undefined : undefined;
    const am = new AudiomackStoreProvider({ consumerKey: env.AUDIOMACK_CONSUMER_KEY, consumerSecret: env.AUDIOMACK_CONSUMER_SECRET, slug });
    stores.push({ catalog: am });
    covered.add('Audiomack');
  }
  if (env.SOUNDCLOUD_CLIENT_ID && env.SOUNDCLOUD_CLIENT_SECRET) {
    const sc = new SoundCloudStoreProvider({ clientId: env.SOUNDCLOUD_CLIENT_ID, clientSecret: env.SOUNDCLOUD_CLIENT_SECRET, profileUrl: profiles.SoundCloud });
    stores.push({ catalog: sc });
    covered.add('SoundCloud');
  }
  if (env.TIDAL_CLIENT_ID && env.TIDAL_CLIENT_SECRET) {
    const td = new TidalStoreProvider({ clientId: env.TIDAL_CLIENT_ID, clientSecret: env.TIDAL_CLIENT_SECRET, profileUrl: profiles.TIDAL });
    stores.push({ catalog: td });
    covered.add('TIDAL');
  }

  // Fast path (distributor-connect scan): catalogue-LIST stores only. Exclude
  // confirmOnly stores (e.g. YouTube), which have no artist list and would do a
  // per-song API search for every distributor track, slow and quota-hungry over a
  // full catalogue. Those run in the deep/web pass instead. Whole catalogue in seconds.
  if (opts.includeWebSearch === false) return stores.filter((s) => !s.confirmOnly);

  // AUTO-FALLBACK (the core of the distributor sale): every platform whose official API
  // key is ABSENT is NOT in `covered`, so it falls through to web verification here. When
  // a buyer (e.g. DistroKid) supplies a platform's API keys, that platform moves to the
  // precise official-API path above and drops out of web search automatically, no code
  // change. Web verification is confirmOnly → a miss is 'unverifiable' (→ manual review),
  // never a false 'not-live'. Backend: Serper hosted SERP API (see createSearchProvider).
  // No web backend configured → official APIs only.
  const provider = createSearchProvider(env);
  const enableWeb = /^(1|true|yes|on)$/i.test(env.ENABLE_SEARCH_WEB_VERIFY ?? 'true') && provider !== null;
  if (enableWeb) {
    const search = searchBackendFrom(provider!);
    const webPlatforms = WEB_PLATFORMS.filter((p) => !covered.has(p.store)); // official API wins
    // ONE resolver shared by all platforms → a single broad "artist"+"title" query per
    // song (cached), with targeted follow-ups only for the platforms it missed.
    const resolver = new WebPresenceResolver(search, webPlatforms);
    for (const p of webPlatforms) {
      const catalog: StoreCatalogProvider = {
        store: p.store,
        method: 'api',
        needsCredential: false,
        async listArtistCatalog() {
          return {
            store: p.store,
            method: 'api' as const,
            artist: null,
            tracks: [],
            pagination: { total: null, fetched: 0, complete: false },
            warnings: ['Web verification cannot enumerate a complete artist catalog.'],
          };
        },
      };
      stores.push({ catalog, catalogMode: 'confirm-only', title: resolver.providerFor(p.store), confirmOnly: true });
    }
  }

  return stores;
}
