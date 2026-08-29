import { id } from '@sentinel/core';

/**
 * Search persistence shared between the API and the background workers. Types are
 * STRUCTURAL (the API's CatalogScanResult / ReleasedTrack satisfy them) so this
 * module has no dependency on the API package. Runtime composition uses
 * Postgres as its durable source of truth and can add Redis as a hot cache.
 */
export interface PerStoreLike {
  store: string;
  status: string;
  foundArtist: string | null;
  url: string | null;
  confidence: number;
  needsManualReview: boolean;
  reviewQuery: string | null;
  /** Human manual-review outcome (written back to the presence matrix), if resolved. */
  reviewDecision?: string;
  reviewedBy?: string;
  reviewedAt?: string;
  reviewNotes?: string;
}

/** Store-side lyric availability for one track, from the lyrics-verification microservice.
 *  `found`/`not-found`/`unverifiable` mirror the never-false-missing rule: a lookup failure is
 *  `unverifiable`, never a claim that lyrics are absent. */
export interface LyricsStoreLike {
  status: 'found' | 'not-found' | 'unverifiable';
  /** The store/aggregator holds plain lyrics for this track. */
  plain: boolean;
  /** The store/aggregator holds time-synced (LRC) lyrics for this track. */
  synced: boolean;
  /** True when the matched track is marked instrumental (legitimately lyric-free). */
  instrumental: boolean;
  /** Which source answered (e.g. "lrclib"). */
  source: string;
}

/**
 * Public, durable field evidence from the distributor extractor. A null scalar alone cannot say
 * whether the distributor omitted a value or Sentinel failed to capture it, so catalog records
 * retain the canonical status and provenance alongside the convenient scalar projection.
 */
export type CatalogMetadataFieldStatus =
  | 'PRESENT'
  | 'ABSENT_AT_SOURCE'
  | 'NOT_CAPTURED'
  | 'PARSE_FAILED'
  | 'REQUEST_FAILED'
  | 'TIMEOUT'
  | 'REAUTH_REQUIRED'
  | 'NOT_AUTHORIZED'
  | 'UNKNOWN';

export type CatalogMetadataSource =
  | 'OFFICIAL_API'
  | 'NETWORK_JSON'
  | 'DIRECT_JSON'
  | 'PAGE_STATE'
  | 'DOM'
  | 'CSV_IMPORT';

export interface CatalogMetadataFieldLike<T> {
  value?: T;
  status: CatalogMetadataFieldStatus;
  source: CatalogMetadataSource;
  capturedAt: string;
  parserVersion: string;
}

export interface CatalogTrackMetadataLike {
  isrc?: CatalogMetadataFieldLike<string>;
  upc?: CatalogMetadataFieldLike<string>;
  artworkUrl?: CatalogMetadataFieldLike<string>;
  label?: CatalogMetadataFieldLike<string>;
  releaseDate?: CatalogMetadataFieldLike<string>;
  uploadDate?: CatalogMetadataFieldLike<string>;
}

export interface CatalogTrackLike {
  title: string;
  primaryArtist?: string | null;
  /** Structured featured-artist credits from the distributor (never parsed from title text). */
  featuredArtists?: string[];
  album: string | null;
  isrc: string | null;
  artworkUrl: string | null;
  perStore: PerStoreLike[];
  /** Store-side lyric availability (LRCLIB), present once the lyrics check has run for this track. */
  lyricsStore?: LyricsStoreLike | null;
  /** Release-level distributor metadata (present when scanned from a connected/imported catalogue). */
  label?: string | null;
  upc?: string | null;
  releaseDate?: string | null;
  uploadDate?: string | null;
  /** Field-level extraction truth. Missing only on records created before evidence was retained. */
  metadata?: CatalogTrackMetadataLike;
}

export interface CatalogExtractionCompletenessLike {
  expectedReleases: number;
  attemptedReleases: number;
  completedReleases: number;
  failedReleases: number;
  skippedReleases: number;
  expectedTracksKnown: boolean;
  expectedTracks: number;
  extractedTracks: number;
  releasesWithUpc: number;
  releasesWithArtwork: number;
  tracksWithIsrc: number;
  tracksWithDistributorId: number;
  releasesUpcAbsentAtSource: number;
  tracksIsrcAbsentAtSource: number;
  releasesUpcNotCaptured: number;
  tracksIsrcNotCaptured: number;
  metadataFieldsAudited?: number;
  metadataFieldsPresent?: number;
  metadataFieldsAbsentAtSource?: number;
  metadataFieldsNotCaptured?: number;
  metadataIncompleteReleaseIds?: string[];
  unresolvedReleaseIds: string[];
  failureReasons: Record<string, number>;
}

export interface CatalogDistributorExtractionLike {
  engine: 'NETWORK_FIRST';
  status:
    | 'COMPLETE'
    | 'COMPLETE_WITH_SOURCE_GAPS'
    | 'PARTIAL_RETRYABLE'
    | 'PARTIAL_REAUTH_REQUIRED'
    | 'FAILED_SCHEMA_CHANGED'
    | 'FAILED';
  finalizedAt: string;
  completeness: CatalogExtractionCompletenessLike;
}
export interface CatalogResultLike {
  artist: string;
  stores: string[];
  profiles: Array<{ store: string; name: string; url: string }>;
  tracks: CatalogTrackLike[];
  summary: { tracks: number; live: number; notLive: number; wrongProfile: number; needsReview: number };
  generatedAt: string;
  warnings: string[];
  note: string;
  /** Terminal distributor-extraction verdict. Absent only for legacy/non-distributor scans. */
  distributorExtraction?: CatalogDistributorExtractionLike;
}
export interface ReleasedTrackLike {
  title: string;
  primaryArtist: string;
  /** Structured featured-artist credits from the distributor. */
  featuredArtists?: string[];
  isrc: string | null;
  releaseTitle?: string | null;
  /** Release-level distributor metadata carried onto the flattened track for presence scans. */
  artworkUrl?: string | null;
  label?: string | null;
  upc?: string | null;
  releaseDate?: string | null;
  uploadDate?: string | null;
  /** Retained while store presence is recomputed so a recheck cannot erase capture evidence. */
  metadata?: CatalogTrackMetadataLike;
}

export interface SearchInput {
  /** Optional user-facing history label. API boundaries validate user supplied values. */
  name?: string;
  /** Immediate predecessor when this record was created by a rescan. */
  sourceSearchId?: string;
  artist: string;
  distributor: string;
  platforms?: string[];
  song?: { title?: string; isrc?: string } | null;
}

/** Progress of the background multi-platform deep scan for a search. */
export interface DeepScanState {
  // `unchecked` = the catalogue is scraped but store-presence verification has NOT been run and is
  // not queued (the decoupled default). Unlike `idle`, a transient in-lifecycle state treated as
  // active, `unchecked` is terminal: the record is deletable and the UI shows a "Check stores"
  // call to action instead of polling for a job that will never arrive.
  status: 'unchecked' | 'idle' | 'queued' | 'running' | 'done' | 'error';
  platformsPending: string[];
  platformsDone: string[];
  startedAt?: string;
  updatedAt?: string;
  tracksScanned?: number;
  /** Contiguous track prefix verified by the deep pass for each platform. */
  platformTracksVerified?: Record<string, number>;
  error?: string;
}

/** Progress of the background lyric-availability verification (LRCLIB) for a search. Independent of
 *  `deepScan` (store presence) so the two fault-isolated checks run and report separately. */
export interface LyricsScanState {
  status: 'unchecked' | 'idle' | 'queued' | 'running' | 'done' | 'error';
  /** Tracks whose lyric availability has been resolved so far. */
  checked: number;
  /** Total tracks to resolve. */
  total: number;
  startedAt?: string;
  updatedAt?: string;
  error?: string;
}

export interface SearchRecord {
  id: string;
  /** Monotonic concurrency token shared by hot and durable tiers. Missing means legacy revision 0. */
  revision?: number;
  /**
   * Keycloak `sub` that owns this record. Every read on behalf of a user MUST be filtered by
   * this, see `apps/api/src/tenant-scoped-search-store.ts`.
   */
  userId: string;
  /** User-facing history label. Optional for records created before scan naming existed. */
  name?: string;
  /** Immutable link to the scan that was explicitly rescanned. */
  sourceSearchId?: string;
  createdAt: string;
  artist: string;
  distributor: string;
  platforms: string[];
  song: { title?: string; isrc?: string } | null;
  result: CatalogResultLike;
  released?: ReleasedTrackLike[];
  deepScan?: DeepScanState;
  /** Progress + results of the independent lyric-availability (LRCLIB) check. */
  lyricsScan?: LyricsScanState;
}

/** A record's owner: the keycloak `sub` that created it, and the sole scoping key. */
export const ownerOf = (r: Pick<SearchRecord, 'userId'>): string => r.userId;

export interface SearchSummary {
  id: string;
  userId: string;
  name?: string;
  sourceSearchId?: string;
  createdAt: string;
  artist: string;
  distributor: string;
  platforms: string[];
  song: { title?: string; isrc?: string } | null;
  summary: CatalogResultLike['summary'];
  stores: string[];
  deepScan?: Pick<DeepScanState, 'status' | 'platformsDone' | 'platformsPending'>;
}

/** Stable seek position for newest-first scan history. Kept structural for storage adapters. */
export interface SearchPageCursor {
  createdAt: string;
  id: string;
}

export interface SearchPageOptions {
  limit: number;
  after?: SearchPageCursor;
}

export interface SearchPage {
  items: SearchSummary[];
  nextCursor?: SearchPageCursor;
}

/** API callers may request fewer rows, but no storage adapter can be made to return an unbounded page. */
export const SEARCH_HISTORY_MAX_PAGE_SIZE = 100;

export function validateSearchPageOptions(options: SearchPageOptions): void {
  if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > SEARCH_HISTORY_MAX_PAGE_SIZE) {
    throw new RangeError(`search history page size must be between 1 and ${SEARCH_HISTORY_MAX_PAGE_SIZE}`);
  }
}

function compareNewestFirst(a: Pick<SearchSummary, 'createdAt' | 'id'>, b: Pick<SearchSummary, 'createdAt' | 'id'>): number {
  const byCreatedAt = b.createdAt.localeCompare(a.createdAt);
  return byCreatedAt || b.id.localeCompare(a.id);
}

function isAfterCursor(item: Pick<SearchSummary, 'createdAt' | 'id'>, cursor: SearchPageCursor): boolean {
  return item.createdAt < cursor.createdAt || (item.createdAt === cursor.createdAt && item.id < cursor.id);
}

/** Shared seek-pagination semantics used by test-memory and Redis adapters. */
export function paginateSearchSummaries(items: SearchSummary[], options: SearchPageOptions): SearchPage {
  validateSearchPageOptions(options);
  const unique = new Map<string, SearchSummary>();
  for (const item of items) if (!unique.has(item.id)) unique.set(item.id, item);
  const ordered = [...unique.values()]
    .sort(compareNewestFirst)
    .filter((item) => !options.after || isAfterCursor(item, options.after));
  const pageItems = ordered.slice(0, options.limit);
  return {
    items: pageItems,
    ...(ordered.length > options.limit && pageItems.length
      ? { nextCursor: { createdAt: pageItems[pageItems.length - 1]!.createdAt, id: pageItems[pageItems.length - 1]!.id } }
      : {}),
  };
}

export function toSummary(r: SearchRecord): SearchSummary {
  return {
    id: r.id,
    userId: r.userId,
    ...(r.name ? { name: r.name } : {}),
    ...(r.sourceSearchId ? { sourceSearchId: r.sourceSearchId } : {}),
    createdAt: r.createdAt,
    artist: r.artist,
    distributor: r.distributor,
    platforms: r.platforms,
    song: r.song,
    summary: r.result.summary,
    stores: r.result.stores,
    ...(r.deepScan ? { deepScan: { status: r.deepScan.status, platformsDone: r.deepScan.platformsDone, platformsPending: r.deepScan.platformsPending } } : {}),
  };
}

function newRecord(
  input: SearchInput,
  result: CatalogResultLike,
  released?: ReleasedTrackLike[],
  owner?: { userId: string },
): SearchRecord {
  return {
    id: id('search'),
    revision: 1,
    userId: owner?.userId ?? '',
    ...(input.name ? { name: input.name } : {}),
    ...(input.sourceSearchId ? { sourceSearchId: input.sourceSearchId } : {}),
    createdAt: new Date().toISOString(),
    artist: input.artist,
    distributor: input.distributor,
    platforms: input.platforms ?? [],
    song: input.song ?? null,
    result,
    ...(released ? { released } : {}),
  };
}

/** Invalid/missing legacy revisions are deliberately treated as the oldest possible value. */
export function revisionOf(record: Pick<SearchRecord, 'revision'>): number {
  return Number.isSafeInteger(record.revision) && (record.revision ?? 0) >= 0 ? record.revision! : 0;
}

/** Apply a mutation while preserving immutable identity/ownership and advancing its revision. */
export function applySearchMutation(
  current: SearchRecord,
  mutate: (record: SearchRecord) => SearchRecord,
): SearchRecord {
  // Capture before the callback so even an accidentally in-place mutation cannot change them.
  const identity = {
    id: current.id,
    userId: current.userId,
    createdAt: current.createdAt,
    revision: revisionOf(current) + 1,
  };
  // A worker/projection update may change scan results and a history rename may change `name`,
  // but neither is allowed to rewrite lineage after the record has been created.
  const {
    id: _ignoredId,
    userId: _ignoredUserId,
    createdAt: _ignoredCreatedAt,
    revision: _ignoredRevision,
    sourceSearchId: _ignoredLineage,
    ...mutated
  } = mutate(current);
  return {
    ...mutated,
    ...identity,
    ...(current.sourceSearchId ? { sourceSearchId: current.sourceSearchId } : {}),
  };
}

/** JSON-semantic equality (object key order and undefined fields are not durable JSON state). */
export function searchRecordsEqual(a: SearchRecord, b: SearchRecord): boolean {
  return JSON.stringify(canonicalJson(a)) === JSON.stringify(canonicalJson(b));
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonicalJson(item)]),
    );
  }
  return value;
}

export interface SearchStore {
  /** `owner` stamps `record.userId`; concrete stores must not accept ownership any other way. */
  save(input: SearchInput, result: CatalogResultLike, released?: ReleasedTrackLike[], owner?: { userId: string }): Promise<SearchRecord>;
  get(id: string): Promise<SearchRecord | null>;
  list(): Promise<SearchSummary[]>;
  /** List at the user index so a busy peer cannot starve this owner's page. */
  listForUser(userId: string): Promise<SearchSummary[]>;
  /** Seek-paginated user history, ordered by createdAt DESC then id DESC. */
  pageForUser(userId: string, options: SearchPageOptions): Promise<SearchPage>;
  /** Apply a partial update (used by the deep-scan worker to record progress/results). */
  update(id: string, mutate: (r: SearchRecord) => SearchRecord): Promise<SearchRecord | null>;
  /** Project a full record by id; older revisions are ignored (used to re-warm hot from durable). */
  put(rec: SearchRecord): Promise<void>;
  /** Permanently remove a record and every list/index entry that references it. */
  delete(id: string, userId?: string): Promise<boolean>;
}

/**
 * Process-local store for isolated automated tests only. Runtime composition
 * rejects this adapter so a restart cannot silently erase scan history.
 * @internal
 */
export class InMemorySearchStore implements SearchStore {
  constructor() {
    if (process.env.NODE_ENV !== 'test') {
      throw new Error('InMemorySearchStore is test-only; configure DATABASE_URL for runtime persistence.');
    }
  }

  private readonly records: SearchRecord[] = [];

  async save(input: SearchInput, result: CatalogResultLike, released?: ReleasedTrackLike[], owner?: { userId: string }): Promise<SearchRecord> {
    const rec = newRecord(input, result, released, owner);
    this.records.unshift(rec);
    return rec;
  }
  async get(recordId: string): Promise<SearchRecord | null> {
    return this.records.find((r) => r.id === recordId) ?? null;
  }
  async list(): Promise<SearchSummary[]> {
    return this.records.map(toSummary);
  }
  async listForUser(userId: string): Promise<SearchSummary[]> {
    return this.records.filter((record) => record.userId === userId).slice(0, 200).map(toSummary);
  }
  async pageForUser(userId: string, options: SearchPageOptions): Promise<SearchPage> {
    return paginateSearchSummaries(
      this.records.filter((record) => record.userId === userId).map(toSummary),
      options,
    );
  }
  async update(recordId: string, mutate: (r: SearchRecord) => SearchRecord): Promise<SearchRecord | null> {
    const i = this.records.findIndex((r) => r.id === recordId);
    if (i < 0) return null;
    this.records[i] = applySearchMutation(this.records[i]!, mutate);
    return this.records[i]!;
  }
  async put(rec: SearchRecord): Promise<void> {
    const i = this.records.findIndex((r) => r.id === rec.id);
    if (i >= 0) {
      const current = this.records[i]!;
      assertSameSecurityScope(current, rec);
      const order = revisionOf(rec) - revisionOf(current);
      if (order < 0) return;
      if (order === 0 && !searchRecordsEqual(current, rec)) throw new Error('conflicting search record revision');
      if (order > 0) this.records[i] = rec;
    } else { this.records.unshift(rec); }
  }
  async delete(recordId: string, userId?: string): Promise<boolean> {
    const index = this.records.findIndex((record) =>
      record.id === recordId && (!userId || record.userId === userId));
    if (index < 0) return false;
    this.records.splice(index, 1);
    return true;
  }
}

/**
 * Redis-backed store SHARED across the API and worker containers. Records are JSON at
 * `search:{id}`; `search:index` is a capped list of ids (newest first). This is what
 * lets a separate worker write deep-scan results that the API then serves.
 */
export class RedisSearchStore implements SearchStore {
  constructor(private readonly redis: RedisLike, private readonly prefix = 'search') {}
  private key(recordId: string): string { return `${this.prefix}:${recordId}`; }
  private get indexKey(): string { return `${this.prefix}:index`; }
  private userIndexKey(userId: string): string { return `${this.prefix}:user:${encodeURIComponent(userId)}:index`; }

  private async indexRecord(rec: SearchRecord): Promise<void> {
    await this.redis.lpush(this.indexKey, rec.id);
    await this.redis.ltrim(this.indexKey, 0, 199);
    await this.redis.lpush(this.userIndexKey(rec.userId), rec.id);
  }

  async save(input: SearchInput, result: CatalogResultLike, released?: ReleasedTrackLike[], owner?: { userId: string }): Promise<SearchRecord> {
    const rec = newRecord(input, result, released, owner);
    await this.redis.set(this.key(rec.id), JSON.stringify(rec));
    await this.indexRecord(rec);
    return rec;
  }
  async get(recordId: string): Promise<SearchRecord | null> {
    const raw = await this.redis.get(this.key(recordId));
    return raw ? (JSON.parse(raw) as SearchRecord) : null;
  }
  async list(): Promise<SearchSummary[]> {
    return this.listFromIndex(this.indexKey);
  }
  async listForUser(userId: string): Promise<SearchSummary[]> {
    return this.listFromIndex(this.userIndexKey(userId), userId);
  }
  async pageForUser(userId: string, options: SearchPageOptions): Promise<SearchPage> {
    return paginateSearchSummaries(
      await this.summariesFromIndex(this.userIndexKey(userId), userId),
      options,
    );
  }
  private async listFromIndex(indexKey: string, userId?: string): Promise<SearchSummary[]> {
    const ids = await this.redis.lrange(indexKey, 0, 199);
    return this.summariesForIds(ids, userId);
  }
  private async summariesFromIndex(indexKey: string, userId?: string): Promise<SearchSummary[]> {
    const ids = await this.redis.lrange(indexKey, 0, -1);
    return this.summariesForIds(ids, userId);
  }
  private async summariesForIds(ids: string[], userId?: string): Promise<SearchSummary[]> {
    const out: SearchSummary[] = [];
    for (const rid of ids) {
      const raw = await this.redis.get(this.key(rid));
      if (raw) {
        const record = JSON.parse(raw) as SearchRecord;
        // Defense in depth against a stale/corrupt index entry.
        if (!userId || record.userId === userId) out.push(toSummary(record));
      }
    }
    return out;
  }
  async update(recordId: string, mutate: (r: SearchRecord) => SearchRecord): Promise<SearchRecord | null> {
    // API actions, finalization, and presence workers can update the same record concurrently.
    // Use an optimistic compare-and-set when the real Redis client is available so one writer
    // cannot silently erase another's checkpoint.
    if (this.redis.eval) {
      const key = this.key(recordId);
      for (let attempt = 0; attempt < 8; attempt++) {
        const raw = await this.redis.get(key);
        if (!raw) return null;
        const next = applySearchMutation(JSON.parse(raw) as SearchRecord, mutate);
        const swapped = await this.redis.eval(REDIS_COMPARE_AND_SET, 1, key, raw, JSON.stringify(next));
        if (Number(swapped) === 1) return next;
      }
      throw new Error('search record changed repeatedly during update');
    }
    // Narrow test implementations may not implement EVAL.
    const cur = await this.get(recordId);
    if (!cur) return null;
    const next = applySearchMutation(cur, mutate);
    await this.redis.set(this.key(recordId), JSON.stringify(next));
    return next;
  }
  async put(rec: SearchRecord): Promise<void> {
    const key = this.key(rec.id);
    if (this.redis.eval) {
      for (let attempt = 0; attempt < 8; attempt++) {
        const raw = await this.redis.get(key);
        if (!raw) {
          const inserted = await this.redis.eval(REDIS_PUT_IF_ABSENT, 1, key, JSON.stringify(rec));
          if (Number(inserted) === 1) {
            await this.indexRecord(rec);
            return;
          }
          continue;
        }
        const current = JSON.parse(raw) as SearchRecord;
        assertSameSecurityScope(current, rec);
        const order = revisionOf(rec) - revisionOf(current);
        if (order < 0) return;
        if (order === 0) {
          if (searchRecordsEqual(current, rec)) return;
          throw new Error('conflicting search record revision');
        }
        const swapped = await this.redis.eval(REDIS_COMPARE_AND_SET, 1, key, raw, JSON.stringify(rec));
        if (Number(swapped) === 1) return;
      }
      throw new Error('search record changed repeatedly during put');
    }
    const current = await this.get(rec.id);
    if (current) {
      assertSameSecurityScope(current, rec);
      const order = revisionOf(rec) - revisionOf(current);
      if (order < 0) return;
      if (order === 0) {
        if (searchRecordsEqual(current, rec)) return;
        throw new Error('conflicting search record revision');
      }
    }
    await this.redis.set(key, JSON.stringify(rec));
    if (!current) await this.indexRecord(rec);
  }
  async delete(recordId: string, userId?: string): Promise<boolean> {
    const raw = await this.redis.get(this.key(recordId));
    if (!raw) {
      // A prior partial cleanup may have removed the value first. A user-scoped caller still
      // gives us enough ownership information to repair the index idempotently.
      await this.redis.lrem(this.indexKey, 0, recordId);
      if (userId) await this.redis.lrem(this.userIndexKey(userId), 0, recordId);
      return false;
    }
    const record = JSON.parse(raw) as SearchRecord;
    if (userId && record.userId !== userId) return false;
    const userIndex = this.userIndexKey(userId ?? record.userId);
    if (this.redis.eval) {
      const removed = await this.redis.eval(
        REDIS_DELETE_WITH_INDEXES,
        3,
        this.key(recordId),
        this.indexKey,
        userIndex,
        recordId,
      );
      return Number(removed) === 1;
    }
    // Minimal development adapters may not support Lua. Production ioredis always does.
    const removed = await this.redis.del(this.key(recordId));
    await this.redis.lrem(this.indexKey, 0, recordId);
    await this.redis.lrem(userIndex, 0, recordId);
    return Number(removed) > 0;
  }
}

function assertSameSecurityScope(current: SearchRecord, incoming: SearchRecord): void {
  if (current.userId !== incoming.userId) throw new Error('search record id is already owned by another user');
}

/** Minimal Redis surface we use (satisfied by ioredis). */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  lpush(key: string, value: string): Promise<unknown>;
  ltrim(key: string, start: number, stop: number): Promise<unknown>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  lrem(key: string, count: number, value: string): Promise<unknown>;
  del(key: string): Promise<unknown>;
  eval?(script: string, numberOfKeys: number, ...args: string[]): Promise<unknown>;
}

const REDIS_COMPARE_AND_SET = `
local current = redis.call('GET', KEYS[1])
if current == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[2])
  return 1
end
return 0`;

const REDIS_PUT_IF_ABSENT = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  redis.call('SET', KEYS[1], ARGV[1])
  return 1
end
return 0`;

const REDIS_DELETE_WITH_INDEXES = `
local current = redis.call('GET', KEYS[1])
for i = 2, #KEYS do
  redis.call('LREM', KEYS[i], 0, ARGV[1])
end
if not current then
  return 0
end
redis.call('DEL', KEYS[1])
return 1`;

export function createSearchStore(redis: RedisLike | null): SearchStore {
  if (redis) return new RedisSearchStore(redis);
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('A durable runtime store must be composed with buildSearchStore and DATABASE_URL.');
  }
  return new InMemorySearchStore();
}
