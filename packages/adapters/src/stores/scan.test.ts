import { describe, it, expect } from 'vitest';
import { prepareStorePresence, scanStorePresence, type ReleasedTrack, type ScannableStore } from './scan';
import { normalizeTitle, type IsrcLookupProvider, type StoreArtistCatalog, type StoreCatalogProvider, type StoreTrack, type TitleSearchProvider } from './types';

const track = (title: string, isrc: string | null, primaryArtist = 'Lewis KE'): ReleasedTrack => ({ title, isrc, primaryArtist });
const st = (title: string, isrc: string | null): StoreTrack => ({ title, primaryArtist: 'Lewis KE', album: null, isrc, url: null, releaseDate: null, artworkUrl: null });

/** A store with a fixed catalogue, ISRC index, and/or title-search index. */
function fakeStore(name: string, opts: {
  catalog: StoreTrack[];
  isrcTable?: Record<string, { artist: string }>; // artist-agnostic ISRC lookups
  titleSearch?: string[]; // titles findable by artist+title search but not in the listing
  complete?: boolean;
  warnings?: string[];
}): ScannableStore {
  const catalog: StoreCatalogProvider = {
    store: name,
    method: 'api',
    needsCredential: false,
    async listArtistCatalog(): Promise<StoreArtistCatalog> {
      return {
        store: name,
        method: 'api',
        artist: { id: '1', name: 'Lewis KE', url: 'x' },
        tracks: opts.catalog,
        pagination: { total: opts.catalog.length, fetched: opts.catalog.length, complete: opts.complete ?? true },
        warnings: opts.warnings ?? [],
      };
    },
  };
  const isrc: IsrcLookupProvider | undefined = opts.isrcTable
    ? {
        store: name,
        async lookupIsrc(code) {
          const hit = opts.isrcTable![code];
          return hit ? { found: true, artist: hit.artist, title: 't', url: 'u', artworkUrl: null } : { found: false, artist: null, title: null, url: null, artworkUrl: null };
        },
      }
    : undefined;
  const title: TitleSearchProvider | undefined = opts.titleSearch
    ? {
        store: name,
        async searchTitle(_artist, t) {
          const found = opts.titleSearch!.some((x) => normalizeTitle(x) === normalizeTitle(t));
          return { found, url: found ? 'u' : null };
        },
      }
    : undefined;
  return { catalog, isrc, title };
}

describe('scanStorePresence, not-live + wrong-profile detection', () => {
  it('marks LIVE when the ISRC resolves under the expected artist', async () => {
    const store = fakeStore('Deezer', { catalog: [], isrcTable: { QZK6K2090500: { artist: 'Lewis KE' } } });
    const rep = await scanStorePresence({ expectedArtist: 'Lewis KE', releasedTracks: [track('Icy Love', 'QZK6K2090500')], stores: [store] });
    expect(rep.results[0]!.perStore[0]).toMatchObject({ status: 'live', matchedBy: 'isrc' });
    expect(rep.summary.live).toBe(1);
  });

  it('flags WRONG-PROFILE when the ISRC resolves under a different artist', async () => {
    const store = fakeStore('Deezer', { catalog: [], isrcTable: { QZK6K2090500: { artist: 'Some Other Artist' } } });
    const rep = await scanStorePresence({ expectedArtist: 'Lewis KE', releasedTracks: [track('Icy Love', 'QZK6K2090500')], stores: [store] });
    expect(rep.results[0]!.perStore[0]).toMatchObject({ status: 'wrong-profile', foundArtist: 'Some Other Artist' });
    expect(rep.summary.wrongProfile).toBe(1);
  });

  it('marks NOT-LIVE when the ISRC is nowhere and no title match exists', async () => {
    const store = fakeStore('Deezer', { catalog: [st('Different Song', 'US1111100001')], isrcTable: {} });
    const rep = await scanStorePresence({ expectedArtist: 'Lewis KE', releasedTracks: [track('Unreleased Somewhere', 'QZK6K2090500')], stores: [store] });
    expect(rep.results[0]!.perStore[0]!.status).toBe('not-live');
    expect(rep.summary.notLive).toBe(1);
  });

  it('falls back to title match on stores without ISRC lookup (e.g. Apple)', async () => {
    const store = fakeStore('Apple Music', { catalog: [st('Butterfly', null)] }); // no isrc table
    const rep = await scanStorePresence({ expectedArtist: 'Lewis KE', releasedTracks: [track('Butterfly (Remix)', 'QZK6J2107865')], stores: [store] });
    expect(rep.results[0]!.perStore[0]).toMatchObject({ status: 'live', matchedBy: 'title-artist' });
  });

  it('confirms existence by artist+title SEARCH, clearing a false not-live gap', async () => {
    // Not in the catalogue listing and no ISRC hit, but an artist+title search finds it.
    const store = fakeStore('Deezer', { catalog: [], isrcTable: {}, titleSearch: ['Icy Love'] });
    const rep = await scanStorePresence({ expectedArtist: 'Lewis KE', releasedTracks: [track('Icy Love', 'QZK6K2090500')], stores: [store] });
    expect(rep.results[0]!.perStore[0]).toMatchObject({ status: 'live', matchedBy: 'title-artist' });
  });

  it('stays not-live when neither ISRC nor an artist+title search finds it', async () => {
    const store = fakeStore('Deezer', { catalog: [], isrcTable: {}, titleSearch: ['Some Other Song'] });
    const rep = await scanStorePresence({ expectedArtist: 'Lewis KE', releasedTracks: [track('Truly Missing', 'QZK6K2090500')], stores: [store] });
    expect(rep.results[0]!.perStore[0]!.status).toBe('not-live');
  });

  it('MULTI-ARTIST: a track live under a SIBLING label artist is LIVE, not wrong-profile', async () => {
    // A label roster: "Lewis KE" and "Boeyylee". A track by Boeyylee resolves under "Boeyylee"
    // on the store; with the roster passed, that's LIVE (a sibling), not wrong-profile.
    const store = fakeStore('Deezer', { catalog: [], isrcTable: { QZWFN2584354: { artist: 'Boeyylee' } } });
    const rep = await scanStorePresence({
      expectedArtist: 'Lewis KE',
      expectedArtists: ['Lewis KE', 'Boeyylee'],
      releasedTracks: [{ title: 'Cruise Ship II', isrc: 'QZWFN2584354', primaryArtist: 'Lewis KE & Boeyylee' }],
      stores: [store],
    });
    expect(rep.results[0]!.perStore[0]!.status).toBe('live');
    expect(rep.summary.wrongProfile).toBe(0);
  });

  it('MULTI-ARTIST: prefetches each roster artist’s catalogue into one index', async () => {
    // Deezer lists only Boeyylee's track; the released track is by Boeyylee. Because the roster
    // includes Boeyylee, its catalogue is prefetched → the ISRC index matches → LIVE.
    const seen: string[] = [];
    const store: ScannableStore = {
      catalog: {
        store: 'Deezer', method: 'api', needsCredential: false,
        async listArtistCatalog(artist: string): Promise<StoreArtistCatalog> {
          seen.push(artist);
          const tracks = artist === 'Boeyylee' ? [{ title: 'Solo', primaryArtist: 'Boeyylee', album: null, isrc: 'QZWFN2599999', url: null, releaseDate: null, artworkUrl: null }] : [];
          return {
            store: 'Deezer',
            method: 'api',
            artist: { id: '1', name: artist, url: 'x' },
            tracks,
            pagination: { total: tracks.length, fetched: tracks.length, complete: true },
            warnings: [],
          };
        },
      },
    };
    const rep = await scanStorePresence({
      expectedArtist: 'Lewis KE',
      expectedArtists: ['Lewis KE', 'Boeyylee'],
      releasedTracks: [{ title: 'Solo', isrc: 'QZWFN2599999', primaryArtist: 'Boeyylee' }],
      stores: [store],
      quick: true,
    });
    expect(seen).toEqual(expect.arrayContaining(['Lewis KE', 'Boeyylee']));
    expect(rep.results[0]!.perStore[0]!.status).toBe('live');
  });

  it('reconciles many tracks across multiple stores and summarizes', async () => {
    const deezer = fakeStore('Deezer', { catalog: [], isrcTable: { USAAA0000001: { artist: 'Lewis KE' }, USAAA0000002: { artist: 'Impostor' } } });
    const apple = fakeStore('Apple Music', { catalog: [st('Song One', null)] });
    const tracks = [track('Song One', 'USAAA0000001'), track('Song Two', 'USAAA0000002')];
    const rep = await scanStorePresence({ expectedArtist: 'Lewis KE', releasedTracks: tracks, stores: [deezer, apple] });
    expect(rep.stores).toEqual(['Deezer', 'Apple Music']);
    // Song One: live on Deezer (isrc) + live on Apple (title). Song Two: wrong-profile on Deezer, not-live on Apple.
    expect(rep.summary.live).toBe(2);
    expect(rep.summary.wrongProfile).toBe(1);
    expect(rep.summary.notLive).toBe(1);
  });

  it('never turns a miss from an incomplete artist catalog into not-live', async () => {
    const store = fakeStore('Capped Store', {
      catalog: [st('Earlier Song', 'USAAA0000001')],
      complete: false,
      warnings: ['Catalog stopped at limit 1; incomplete.'],
    });
    const rep = await scanStorePresence({
      expectedArtist: 'Lewis KE',
      releasedTracks: [track('Beyond The Cap', 'USAAA0000002')],
      stores: [store],
      quick: true,
    });
    expect(rep.results[0]!.perStore[0]).toMatchObject({ status: 'unverifiable', needsManualReview: true });
    expect(rep.summary).toMatchObject({ notLive: 0, unverifiable: 1, needsReview: 1 });
  });

  it('allows positive evidence from an incomplete catalog', async () => {
    const store = fakeStore('Capped Store', { catalog: [st('Found Before Cap', 'USAAA0000001')], complete: false });
    const rep = await scanStorePresence({
      expectedArtist: 'Lewis KE',
      releasedTracks: [track('Found Before Cap', 'USAAA0000001')],
      stores: [store],
      quick: true,
    });
    expect(rep.results[0]!.perStore[0]).toMatchObject({ status: 'live', matchedBy: 'isrc' });
  });

  it('applies completeness per artist instead of trusting one healthy roster member for all', async () => {
    const store: ScannableStore = {
      catalog: {
        store: 'Roster Store', method: 'api', needsCredential: false,
        async listArtistCatalog(artist: string): Promise<StoreArtistCatalog> {
          if (artist === 'Boeyylee') throw new Error('upstream timeout');
          return {
            store: 'Roster Store', method: 'api', artist: { id: artist, name: artist, url: 'x' }, tracks: [],
            pagination: { total: 0, fetched: 0, complete: true }, warnings: [],
          };
        },
      },
    };
    const rep = await scanStorePresence({
      expectedArtist: 'Lewis KE',
      expectedArtists: ['Lewis KE', 'Boeyylee'],
      releasedTracks: [track('Missing A', null, 'Lewis KE'), track('Missing B', null, 'Boeyylee')],
      stores: [store],
      quick: true,
    });
    expect(rep.results[0]!.perStore[0]!.status).toBe('not-live');
    expect(rep.results[1]!.perStore[0]).toMatchObject({ status: 'unverifiable', needsManualReview: true });
  });

  it('does not use a sibling artist title or ISRC as positive evidence for a solo track', async () => {
    const siblingTrack: StoreTrack = { ...st('Shared Title', 'USAAA0000001'), primaryArtist: 'Boeyylee' };
    const store: ScannableStore = {
      catalog: {
        store: 'Roster Store', method: 'api', needsCredential: false,
        async listArtistCatalog(artist: string): Promise<StoreArtistCatalog> {
          const tracks = artist === 'Boeyylee' ? [siblingTrack] : [];
          return {
            store: 'Roster Store', method: 'api', artist: { id: artist, name: artist, url: 'x' }, tracks,
            pagination: { total: tracks.length, fetched: tracks.length, complete: true }, warnings: [],
          };
        },
      },
      isrc: {
        store: 'Roster Store',
        async lookupIsrc() { return { found: true, artist: 'Boeyylee', title: 'Shared Title', url: 'u', artworkUrl: null }; },
      },
    };
    const rep = await scanStorePresence({
      expectedArtist: 'Lewis KE', expectedArtists: ['Lewis KE', 'Boeyylee'],
      releasedTracks: [track('Shared Title', 'USAAA0000001', 'Lewis KE')], stores: [store],
    });
    expect(rep.results[0]!.perStore[0]).toMatchObject({ status: 'wrong-profile', foundArtist: 'Boeyylee' });
  });

  it('serializes artist-catalogue reads within one provider while allowing a large roster', async () => {
    let calls = 0;
    let active = 0;
    let maxActive = 0;
    const store: ScannableStore = {
      catalog: {
        store: 'Bounded DSP', method: 'api', needsCredential: false,
        async listArtistCatalog(artist): Promise<StoreArtistCatalog> {
          calls++;
          active++;
          maxActive = Math.max(maxActive, active);
          await Promise.resolve();
          active--;
          return {
            store: 'Bounded DSP', method: 'api', artist: { id: artist, name: artist, url: 'x' }, tracks: [],
            pagination: { total: 0, fetched: 0, complete: true }, warnings: [],
          };
        },
      },
    };
    const tracks = Array.from({ length: 250 }, (_, index) => track(`Song ${index}`, null, `Artist ${index}`));
    await prepareStorePresence({ expectedArtist: 'Primary Artist', releasedTracks: tracks, stores: [store], maxDistinctArtists: 500 });
    expect(calls).toBe(251);
    expect(maxActive).toBe(1);
  });

  it('fails a roster bound instead of silently dropping excess artists', async () => {
    let calls = 0;
    const store = fakeStore('Bounded DSP', { catalog: [] });
    const original = store.catalog.listArtistCatalog.bind(store.catalog);
    store.catalog.listArtistCatalog = async (...args) => { calls++; return original(...args); };
    await expect(prepareStorePresence({
      expectedArtist: 'Artist A',
      releasedTracks: [track('One', null, 'Artist A'), track('Two', null, 'Artist B'), track('Three', null, 'Artist C')],
      stores: [store],
      maxDistinctArtists: 2,
    })).rejects.toThrow(/no artist was dropped/i);
    expect(calls).toBe(0);
  });

  it('does not re-enumerate catalog-backed title search once a prepared catalogue misses', async () => {
    let catalogCalls = 0;
    let titleCalls = 0;
    const store = fakeStore('Catalog DSP', { catalog: [], complete: false, titleSearch: ['Missing'] });
    const original = store.catalog.listArtistCatalog.bind(store.catalog);
    store.catalog.listArtistCatalog = async (...args) => { catalogCalls++; return original(...args); };
    store.titleSearchMode = 'catalog';
    store.title = { store: 'Catalog DSP', async searchTitle() { titleCalls++; return { found: true, url: 'x' }; } };
    const report = await scanStorePresence({ expectedArtist: 'Lewis KE', releasedTracks: [track('Missing', null)], stores: [store] });
    expect(catalogCalls).toBe(1);
    expect(titleCalls).toBe(0);
    expect(report.results[0]!.perStore[0]!.status).toBe('unverifiable');
  });
});
