import type { ReleaseExtractionOutcome, SnapshotStatus } from '@sentinel/browser-assist';
import type { FinalizeJob } from '@sentinel/contracts';
import type { Pool, PoolClient } from 'pg';

/**
 * Snapshot checkpoint store.
 *
 * The old reader did the WHOLE catalogue in one unit of work: any failure meant re-reading
 * everything, and a worker crash lost the lot. This store makes extraction resumable and
 * idempotent: outcomes are keyed by `snapshotId + distributorReleaseId`, so re-running a chunk
 * (retry, crash recovery, duplicate delivery) can never create duplicate records.
 */

export interface ReleaseRefRecord {
  releaseId: string;
  dashboardUrl: string;
  title?: string;
  artist?: string;
  expectedTrackCount?: number;
}

export interface SnapshotProgress {
  snapshotId: string;
  tenantId: string;
  connectionId: string;
  distributor: string;
  status: SnapshotStatus | 'RUNNING' | 'PLANNED';
  expectedReleases: number;
  completedReleases: number;
  failedReleases: number;
  chunkCount: number;
  completedChunks: number[];
  startedAt: string;
  updatedAt: string;
}

/**
 * First-writer-wins stop record. Keeping the complete finalizer payload lets any queued sibling
 * repair a crash between choosing the verdict and enqueuing the finalizer.
 */
export type SnapshotTerminalTombstone =
  | { kind: 'TERMINAL'; finalizeJob: FinalizeJob; createdAt: string; reason?: string }
  | { kind: 'CANCELLED'; createdAt: string; reason: string };

/** Immutable principal scope carried by every pipeline job. Session handles are deliberately not
 * part of checkpoint identity and are never copied into this binding. */
export interface SnapshotCheckpointBinding {
  snapshotId: string;
  tenantId: string;
  connectionId: string;
  distributor: string;
}

export class SnapshotPrincipalMismatchError extends Error {
  constructor() {
    super('snapshot checkpoint principal does not match its immutable tenant/connection binding');
    this.name = 'SnapshotPrincipalMismatchError';
  }
}

export class SnapshotBindingRequiredError extends Error {
  constructor(snapshotId: string) {
    super(`snapshot checkpoint ${snapshotId} must be principal-bound before use`);
    this.name = 'SnapshotBindingRequiredError';
  }
}

export interface SnapshotCheckpointStore {
  /** Establish or verify the immutable tenant + connection owner before any checkpoint access. */
  bindSnapshot(binding: SnapshotCheckpointBinding): Promise<void>;
  /** Persist the catalog index (the authoritative expectation). */
  putIndex(snapshotId: string, releases: ReleaseRefRecord[]): Promise<void>;
  getIndex(snapshotId: string): Promise<ReleaseRefRecord[]>;
  /** Idempotent by (snapshotId, releaseId) — a retried chunk overwrites, never duplicates. */
  putOutcomes(snapshotId: string, outcomes: ReleaseExtractionOutcome[]): Promise<void>;
  getOutcomes(snapshotId: string): Promise<ReleaseExtractionOutcome[]>;
  putProgress(progress: SnapshotProgress): Promise<void>;
  getProgress(snapshotId: string): Promise<SnapshotProgress | null>;
  /**
   * Chunk completion is tracked PER PASS. Pass 1 is the initial sweep; pass N>1 is the Nth
   * retry-failed-only sweep, whose chunk indices restart at 0. Without the pass in the key, a
   * retry chunk 0 would look like the initial chunk 0 — so a retry pass would appear complete the
   * instant it started, and its reconciliation would run against results that hadn't arrived.
   */
  markChunkComplete(snapshotId: string, pass: number, chunkIndex: number): Promise<void>;
  /** Chunks already done in ONE pass — lets a resumed run skip them entirely. */
  completedChunks(snapshotId: string, pass: number): Promise<number[]>;
  /** Durable, ordered work plan for one extraction pass. */
  putPassPlan(snapshotId: string, pass: number, releaseIdChunks: string[][]): Promise<void>;
  getPassPlan(snapshotId: string, pass: number): Promise<string[][] | null>;
  /** Atomically choose the snapshot's one terminal/cancel outcome (first writer wins). */
  claimTerminal(snapshotId: string, tombstone: SnapshotTerminalTombstone): Promise<SnapshotTerminalTombstone>;
  getTerminal(snapshotId: string): Promise<SnapshotTerminalTombstone | null>;
}

const outcomeId = (o: ReleaseExtractionOutcome): string =>
  o.kind === 'COMPLETED' ? o.release.distributorReleaseId : o.distributorReleaseId;

/** In-memory store — tests and single-process runs. */
export class InMemorySnapshotStore implements SnapshotCheckpointStore {
  private readonly bindings = new Map<string, SnapshotCheckpointBinding>();
  private readonly index = new Map<string, ReleaseRefRecord[]>();
  private readonly outcomes = new Map<string, Map<string, ReleaseExtractionOutcome>>();
  private readonly progress = new Map<string, SnapshotProgress>();
  /** snapshotId → set of `${pass}:${chunkIndex}`. */
  private readonly chunks = new Map<string, Set<string>>();
  private readonly plans = new Map<string, string[][]>();
  private readonly terminals = new Map<string, SnapshotTerminalTombstone>();

  async bindSnapshot(binding: SnapshotCheckpointBinding): Promise<void> {
    validateBinding(binding);
    const existing = this.bindings.get(binding.snapshotId);
    if (existing && !sameBinding(existing, binding)) throw new SnapshotPrincipalMismatchError();
    this.bindings.set(binding.snapshotId, { ...binding });
  }

  async putIndex(snapshotId: string, releases: ReleaseRefRecord[]): Promise<void> { this.index.set(snapshotId, releases); }
  async getIndex(snapshotId: string): Promise<ReleaseRefRecord[]> { return this.index.get(snapshotId) ?? []; }
  async putOutcomes(snapshotId: string, outcomes: ReleaseExtractionOutcome[]): Promise<void> {
    const m = this.outcomes.get(snapshotId) ?? new Map<string, ReleaseExtractionOutcome>();
    for (const o of outcomes) m.set(outcomeId(o), o); // idempotent upsert
    this.outcomes.set(snapshotId, m);
  }
  async getOutcomes(snapshotId: string): Promise<ReleaseExtractionOutcome[]> { return [...(this.outcomes.get(snapshotId)?.values() ?? [])]; }
  async putProgress(p: SnapshotProgress): Promise<void> { this.progress.set(p.snapshotId, p); }
  async getProgress(snapshotId: string): Promise<SnapshotProgress | null> { return this.progress.get(snapshotId) ?? null; }
  async markChunkComplete(snapshotId: string, pass: number, chunkIndex: number): Promise<void> {
    const s = this.chunks.get(snapshotId) ?? new Set<string>();
    s.add(`${pass}:${chunkIndex}`);
    this.chunks.set(snapshotId, s);
  }
  async completedChunks(snapshotId: string, pass: number): Promise<number[]> {
    return [...(this.chunks.get(snapshotId) ?? [])]
      .filter((m) => m.startsWith(`${pass}:`))
      .map((m) => Number(m.slice(String(pass).length + 1)))
      .sort((a, b) => a - b);
  }
  async putPassPlan(snapshotId: string, pass: number, releaseIdChunks: string[][]): Promise<void> {
    this.plans.set(`${snapshotId}:${pass}`, releaseIdChunks.map((chunk) => [...chunk]));
  }
  async getPassPlan(snapshotId: string, pass: number): Promise<string[][] | null> {
    const plan = this.plans.get(`${snapshotId}:${pass}`);
    return plan ? plan.map((chunk) => [...chunk]) : null;
  }
  async claimTerminal(snapshotId: string, tombstone: SnapshotTerminalTombstone): Promise<SnapshotTerminalTombstone> {
    const existing = this.terminals.get(snapshotId);
    if (existing) return existing;
    this.terminals.set(snapshotId, tombstone);
    return tombstone;
  }
  async getTerminal(snapshotId: string): Promise<SnapshotTerminalTombstone | null> {
    return this.terminals.get(snapshotId) ?? null;
  }
}

/**
 * Reject anything that could break out of its key namespace or collide with a sibling.
 *
 * A `:` in a snapshot id would silently re-namespace the key (`dk:snap:a:b:index` is
 * indistinguishable from snapshot `a` part `b:index`), so two scans could share checkpoints.
 * Ids are server-minted today; this makes that an enforced precondition rather than a convention
 * a future caller can quietly break.
 */
function assertKeySegment(value: string, name: string): void {
  if (!value || /[:\s*?[\]{}]/.test(value)) {
    throw new Error(`invalid ${name} for a Redis key: must be non-empty and free of ":" and glob characters`);
  }
}

/** Minimal Redis surface (matches ioredis) so we don't couple to a client. */
export interface SnapshotRedis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode?: string, duration?: number, flag?: string): Promise<unknown>;
  hset(key: string, field: string, value: string): Promise<unknown>;
  hgetall(key: string): Promise<Record<string, string>>;
  sadd(key: string, member: string): Promise<unknown>;
  smembers(key: string): Promise<string[]>;
  expire(key: string, seconds: number): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
}

/**
 * Redis-backed store: survives a worker crash, so a resumed run continues from the last
 * checkpoint instead of restarting the catalogue. Writes are batched per chunk, not per release.
 */
export class RedisSnapshotStore implements SnapshotCheckpointStore {
  constructor(private readonly redis: SnapshotRedis, private readonly ttlSeconds = 7 * 24 * 3600) {}
  private k(snapshotId: string, part: string): string {
    // Keyed by snapshot id alone, which is minted server-side per scan and never client-supplied.
    //
    // Tenant/connection are deliberately NOT in the key. That looks like weaker isolation but is
    // stronger: the key would then have to be built from job fields at every call site, and a
    // caller passing the wrong tenant would silently read an empty checkpoint set and re-extract
    // a whole catalogue. Isolation is enforced where the data leaves the system — the API's
    // tenant-scoped reads and the Postgres unique key `(tenantId, snapshotId)` — while the
    // checkpoint namespace stays a simple, unforgeable function of one server-minted id.
    assertKeySegment(snapshotId, 'snapshotId');
    return `dk:snap:${snapshotId}:${part}`;
  }

  async bindSnapshot(binding: SnapshotCheckpointBinding): Promise<void> {
    validateBinding(binding);
    const key = this.k(binding.snapshotId, 'binding');
    const encoded = JSON.stringify(binding);
    const won = await this.redis.set(key, encoded, 'EX', this.ttlSeconds, 'NX');
    if (won === null || won === undefined) {
      const raw = await this.redis.get(key);
      if (!raw) throw new Error('snapshot Redis binding ownership could not be confirmed');
      let existing: SnapshotCheckpointBinding;
      try { existing = JSON.parse(raw) as SnapshotCheckpointBinding; }
      catch { throw new SnapshotPrincipalMismatchError(); }
      if (!sameBinding(existing, binding)) throw new SnapshotPrincipalMismatchError();
      await this.redis.expire(key, this.ttlSeconds);
    }
  }

  async putIndex(snapshotId: string, releases: ReleaseRefRecord[]): Promise<void> {
    await this.redis.set(this.k(snapshotId, 'index'), JSON.stringify(releases), 'EX', this.ttlSeconds);
  }
  async getIndex(snapshotId: string): Promise<ReleaseRefRecord[]> {
    return await this.getIndexIfPresent(snapshotId) ?? [];
  }
  async getIndexIfPresent(snapshotId: string): Promise<ReleaseRefRecord[] | null> {
    const raw = await this.redis.get(this.k(snapshotId, 'index'));
    return raw ? (JSON.parse(raw) as ReleaseRefRecord[]) : null;
  }
  async putOutcomes(snapshotId: string, outcomes: ReleaseExtractionOutcome[]): Promise<void> {
    const key = this.k(snapshotId, 'outcomes');
    // One hset per release keyed by releaseId → idempotent upsert on retry.
    for (const o of outcomes) await this.redis.hset(key, outcomeId(o), JSON.stringify(o));
    await this.redis.expire(key, this.ttlSeconds);
  }
  async getOutcomes(snapshotId: string): Promise<ReleaseExtractionOutcome[]> {
    const all = await this.redis.hgetall(this.k(snapshotId, 'outcomes'));
    return Object.values(all ?? {}).map((v) => JSON.parse(v) as ReleaseExtractionOutcome);
  }
  async putProgress(p: SnapshotProgress): Promise<void> {
    await this.redis.set(this.k(p.snapshotId, 'progress'), JSON.stringify(p), 'EX', this.ttlSeconds);
  }
  async getProgress(snapshotId: string): Promise<SnapshotProgress | null> {
    const raw = await this.redis.get(this.k(snapshotId, 'progress'));
    return raw ? (JSON.parse(raw) as SnapshotProgress) : null;
  }
  async markChunkComplete(snapshotId: string, pass: number, chunkIndex: number): Promise<void> {
    const key = this.k(snapshotId, `chunks:${pass}`);
    // `${pass}:${chunkIndex}` — a retry sweep restarts its chunk indices at 0, so without the
    // pass a retry chunk 0 would be indistinguishable from the initial chunk 0.
    await this.redis.sadd(key, String(chunkIndex));
    await this.redis.expire(key, this.ttlSeconds);
  }
  async completedChunks(snapshotId: string, pass: number): Promise<number[]> {
    const members = await this.redis.smembers(this.k(snapshotId, `chunks:${pass}`));
    return members
      .map((m) => Number(m))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b);
  }
  async putPassPlan(snapshotId: string, pass: number, releaseIdChunks: string[][]): Promise<void> {
    await this.redis.set(this.k(snapshotId, `plan:${pass}`), JSON.stringify(releaseIdChunks), 'EX', this.ttlSeconds);
  }
  async getPassPlan(snapshotId: string, pass: number): Promise<string[][] | null> {
    const raw = await this.redis.get(this.k(snapshotId, `plan:${pass}`));
    return raw ? (JSON.parse(raw) as string[][]) : null;
  }
  async claimTerminal(snapshotId: string, tombstone: SnapshotTerminalTombstone): Promise<SnapshotTerminalTombstone> {
    const key = this.k(snapshotId, 'terminal');
    const encoded = JSON.stringify(tombstone);
    const won = await this.redis.set(key, encoded, 'EX', this.ttlSeconds, 'NX');
    if (won !== null && won !== undefined) return tombstone;
    const existing = await this.redis.get(key);
    if (!existing) throw new Error('terminal tombstone ownership could not be confirmed');
    return JSON.parse(existing) as SnapshotTerminalTombstone;
  }
  async getTerminal(snapshotId: string): Promise<SnapshotTerminalTombstone | null> {
    const raw = await this.redis.get(this.k(snapshotId, 'terminal'));
    return raw ? (JSON.parse(raw) as SnapshotTerminalTombstone) : null;
  }


  /** Authoritative cache fill used only after PostgreSQL has chosen the terminal winner. */
  async putTerminal(snapshotId: string, tombstone: SnapshotTerminalTombstone): Promise<void> {
    await this.redis.set(this.k(snapshotId, 'terminal'), JSON.stringify(tombstone), 'EX', this.ttlSeconds);
  }

  async replaceOutcomes(snapshotId: string, outcomes: ReleaseExtractionOutcome[]): Promise<void> {
    await this.redis.del(this.k(snapshotId, 'outcomes'));
    await this.putOutcomes(snapshotId, outcomes);
  }

  async replaceCompletedChunks(snapshotId: string, pass: number, chunks: number[]): Promise<void> {
    await this.redis.del(this.k(snapshotId, `chunks:${pass}`));
    for (const chunk of chunks) await this.markChunkComplete(snapshotId, pass, chunk);
  }

  async putVersion(snapshotId: string, part: string, version: bigint): Promise<void> {
    await this.redis.set(this.k(snapshotId, `version:${part}`), version.toString(), 'EX', this.ttlSeconds);
  }

  async getVersion(snapshotId: string, part: string): Promise<bigint | null> {
    const raw = await this.redis.get(this.k(snapshotId, `version:${part}`));
    if (raw === null || !/^\d+$/.test(raw)) return null;
    return BigInt(raw);
  }
}

function validateBinding(binding: SnapshotCheckpointBinding): void {
  for (const [name, value] of Object.entries(binding)) {
    if (typeof value !== 'string' || !value.trim() || value.length > 512 || hasControlCharacter(value, false)) {
      throw new Error(`invalid snapshot checkpoint ${name}`);
    }
  }
  assertKeySegment(binding.snapshotId, 'snapshotId');
}

function sameBinding(left: SnapshotCheckpointBinding, right: SnapshotCheckpointBinding): boolean {
  return left.snapshotId === right.snapshotId
    && left.tenantId === right.tenantId
    && left.connectionId === right.connectionId
    && left.distributor === right.distributor;
}

const CHECKPOINT_PAGE_SIZE = 250;
const MAX_RELEASES = 50_000;
type CheckpointPart = 'index' | 'outcomes' | 'progress' | 'chunks' | 'plans' | 'terminal';
type CheckpointVersions = Record<CheckpointPart, bigint>;
const VERSION_COLUMNS: Record<CheckpointPart, string> = {
  index: 'indexVersion',
  outcomes: 'outcomesVersion',
  progress: 'progressVersion',
  chunks: 'chunksVersion',
  plans: 'plansVersion',
  terminal: 'terminalVersion',
};
const METADATA_STATUSES = new Set([
  'PRESENT', 'ABSENT_AT_SOURCE', 'NOT_CAPTURED', 'PARSE_FAILED', 'REQUEST_FAILED',
  'TIMEOUT', 'REAUTH_REQUIRED', 'NOT_AUTHORIZED', 'UNKNOWN',
]);
const METADATA_SOURCES = new Set(['OFFICIAL_API', 'NETWORK_JSON', 'DIRECT_JSON', 'PAGE_STATE', 'DOM', 'CSV_IMPORT']);
const FAILURE_REASONS = new Set([
  'TIMEOUT', 'REQUEST_FAILED', 'PARSE_FAILED', 'SCHEMA_CHANGED', 'REAUTH_REQUIRED',
  'NOT_AUTHORIZED', 'RATE_LIMITED', 'BUDGET_EXHAUSTED', 'UNKNOWN',
]);

function hasControlCharacter(value: string, allowTextWhitespace: boolean): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 && !(allowTextWhitespace && (code === 9 || code === 10 || code === 13))) return true;
  }
  return false;
}

function textValue(value: unknown, name: string, max = 2_048): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || hasControlCharacter(value, true)) {
    throw new Error(`invalid ${name} in snapshot checkpoint`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`invalid ${name} in snapshot checkpoint`);
  return Number(value);
}

function positiveInteger(value: unknown, name: string): number {
  const parsed = nonNegativeInteger(value, name);
  if (parsed < 1) throw new Error(`invalid ${name} in snapshot checkpoint`);
  return parsed;
}

function nonNegativeNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`invalid ${name} in snapshot checkpoint`);
  return value;
}

function isoTimestamp(value: unknown, name: string): string {
  const candidate = textValue(value, name, 64);
  const epoch = Date.parse(candidate);
  if (!Number.isFinite(epoch)) throw new Error(`invalid ${name} in snapshot checkpoint`);
  return new Date(epoch).toISOString();
}

function safeUrl(value: unknown, name: string, dashboard = false): string {
  const input = textValue(value, name, 8_192);
  let parsed: URL;
  try { parsed = new URL(input); }
  catch { throw new Error(`invalid ${name} in snapshot checkpoint`); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error(`invalid ${name} in snapshot checkpoint`);
  if (dashboard && parsed.hostname !== 'distrokid.com' && !parsed.hostname.endsWith('.distrokid.com')) {
    throw new Error('DistroKid checkpoint dashboard URL has an unexpected host');
  }
  parsed.hash = '';
  if (dashboard) {
    const permitted = new Set(['albumuuid', 'albumid', 'releaseid', 'id']);
    for (const key of [...parsed.searchParams.keys()]) if (!permitted.has(key.toLowerCase())) parsed.searchParams.delete(key);
  } else {
    // Signed CDN query strings are bearer credentials. The stable artwork resource URL is enough
    // for a recovery checkpoint; a later projection can obtain a fresh signed URL if required.
    parsed.search = '';
  }
  return parsed.toString();
}

function sanitizeField(value: unknown, name: string, asUrl = false): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`invalid ${name} in snapshot checkpoint`);
  const field = value as Record<string, unknown>;
  const status = textValue(field['status'], `${name}.status`, 64);
  const source = textValue(field['source'], `${name}.source`, 64);
  if (!METADATA_STATUSES.has(status) || !METADATA_SOURCES.has(source)) throw new Error(`invalid ${name} provenance in snapshot checkpoint`);
  const sanitized: Record<string, unknown> = {
    status,
    source,
    capturedAt: isoTimestamp(field['capturedAt'], `${name}.capturedAt`),
    parserVersion: textValue(field['parserVersion'], `${name}.parserVersion`, 256),
  };
  if (field['value'] !== undefined) {
    if (status !== 'PRESENT') throw new Error(`non-present ${name} cannot carry a checkpoint value`);
    sanitized['value'] = asUrl ? safeUrl(field['value'], `${name}.value`) : textValue(field['value'], `${name}.value`, 8_192);
  }
  return sanitized;
}

function sanitizeReleaseRef(record: ReleaseRefRecord): ReleaseRefRecord {
  return {
    releaseId: textValue(record.releaseId, 'releaseId', 512),
    dashboardUrl: safeUrl(record.dashboardUrl, 'dashboardUrl', true),
    ...(record.title != null ? { title: textValue(record.title, 'release title', 2_048) } : {}),
    ...(record.artist != null ? { artist: textValue(record.artist, 'release artist', 2_048) } : {}),
    ...(record.expectedTrackCount != null
      ? { expectedTrackCount: positiveInteger(record.expectedTrackCount, 'expected track count') }
      : {}),
  };
}

function sanitizeOutcome(input: ReleaseExtractionOutcome): ReleaseExtractionOutcome {
  if (!input || typeof input !== 'object') throw new Error('invalid extraction outcome in snapshot checkpoint');
  if (input.kind === 'FAILED') {
    const reason = textValue(input.reason, 'failure reason', 64);
    if (!FAILURE_REASONS.has(reason)) throw new Error('invalid failure reason in snapshot checkpoint');
    return {
      kind: 'FAILED',
      distributorReleaseId: textValue(input.distributorReleaseId, 'outcome releaseId', 512),
      reason: reason as Extract<ReleaseExtractionOutcome, { kind: 'FAILED' }>['reason'],
      // Error detail can contain response fragments. The reason code is sufficient for resume.
      detail: `checkpointed failure: ${reason}`,
      elapsedMs: nonNegativeNumber(input.elapsedMs, 'failure elapsedMs'),
      ...(input.endpointFingerprint !== undefined
        ? { endpointFingerprint: textValue(input.endpointFingerprint, 'endpoint fingerprint', 256) }
        : {}),
    };
  }
  if (input.kind === 'SKIPPED') {
    return {
      kind: 'SKIPPED',
      distributorReleaseId: textValue(input.distributorReleaseId, 'outcome releaseId', 512),
      // Free-form skip messages are not recovery data and can accidentally contain raw payloads.
      reason: 'release skipped during extraction',
    };
  }
  if (input.kind !== 'COMPLETED') throw new Error('invalid extraction outcome kind in snapshot checkpoint');
  const release = input.release;
  if (!release || typeof release !== 'object' || !Array.isArray(release.tracks) || release.tracks.length > MAX_RELEASES) {
    throw new Error('invalid completed release in snapshot checkpoint');
  }
  const tracks = release.tracks.map((track, index) => ({
    ...(track.distributorTrackId !== undefined
      ? { distributorTrackId: textValue(track.distributorTrackId, `track ${index} id`, 512) }
      : {}),
    title: textValue(track.title, `track ${index} title`, 2_048),
    isrc: sanitizeField(track.isrc, `track ${index} isrc`) as never,
    ...(track.trackNumber !== undefined ? { trackNumber: nonNegativeInteger(track.trackNumber, `track ${index} number`) } : {}),
    ...(track.durationSec !== undefined ? { durationSec: nonNegativeNumber(track.durationSec, `track ${index} duration`) } : {}),
  }));
  const source = textValue(input.source, 'outcome source', 64);
  if (!METADATA_SOURCES.has(source)) throw new Error('invalid outcome source in snapshot checkpoint');
  return {
    kind: 'COMPLETED',
    release: {
      distributorReleaseId: textValue(release.distributorReleaseId, 'outcome releaseId', 512),
      title: textValue(release.title, 'release title', 2_048),
      ...(release.primaryArtist !== undefined ? { primaryArtist: textValue(release.primaryArtist, 'primary artist', 2_048) } : {}),
      ...(release.featuredArtists !== undefined
        ? { featuredArtists: release.featuredArtists.slice(0, 100).map((artist, index) => textValue(artist, `featured artist ${index}`, 2_048)) }
        : {}),
      upc: sanitizeField(release.upc, 'release upc') as never,
      artworkUrl: sanitizeField(release.artworkUrl, 'release artwork', true) as never,
      releaseDate: sanitizeField(release.releaseDate, 'release date') as never,
      ...(release.uploadDate !== undefined ? { uploadDate: sanitizeField(release.uploadDate, 'upload date') as never } : {}),
      ...(release.label !== undefined ? { label: sanitizeField(release.label, 'release label') as never } : {}),
      tracks,
    },
    source: source as Extract<ReleaseExtractionOutcome, { kind: 'COMPLETED' }>['source'],
    elapsedMs: nonNegativeNumber(input.elapsedMs, 'outcome elapsedMs'),
    ...(input.endpointFingerprint !== undefined
      ? { endpointFingerprint: textValue(input.endpointFingerprint, 'endpoint fingerprint', 256) }
      : {}),
  };
}

function sanitizeProgress(progress: SnapshotProgress, binding: SnapshotCheckpointBinding): SnapshotProgress {
  if (!sameBinding(progress, binding)) throw new SnapshotPrincipalMismatchError();
  const chunks = [...new Set(progress.completedChunks.map((chunk) => nonNegativeInteger(chunk, 'completed chunk')))].sort((a, b) => a - b);
  return {
    snapshotId: binding.snapshotId,
    tenantId: binding.tenantId,
    connectionId: binding.connectionId,
    distributor: binding.distributor,
    status: textValue(progress.status, 'progress status', 128) as SnapshotProgress['status'],
    expectedReleases: nonNegativeInteger(progress.expectedReleases, 'expected releases'),
    completedReleases: nonNegativeInteger(progress.completedReleases, 'completed releases'),
    failedReleases: nonNegativeInteger(progress.failedReleases, 'failed releases'),
    chunkCount: nonNegativeInteger(progress.chunkCount, 'chunk count'),
    completedChunks: chunks,
    startedAt: isoTimestamp(progress.startedAt, 'progress startedAt'),
    updatedAt: isoTimestamp(progress.updatedAt, 'progress updatedAt'),
  };
}

function sanitizeCompleteness(input: FinalizeJob['completeness']): FinalizeJob['completeness'] {
  const countNames = [
    'expectedReleases', 'attemptedReleases', 'completedReleases', 'failedReleases', 'skippedReleases',
    'expectedTracks', 'extractedTracks', 'releasesWithUpc', 'releasesWithArtwork', 'tracksWithIsrc',
    'tracksWithDistributorId', 'releasesUpcAbsentAtSource', 'tracksIsrcAbsentAtSource',
    'releasesUpcNotCaptured', 'tracksIsrcNotCaptured',
  ] as const;
  const counts = Object.fromEntries(countNames.map((name) => [name, nonNegativeInteger(input[name], `completeness ${name}`)]));
  const optionalCountNames = [
    'metadataFieldsAudited', 'metadataFieldsPresent',
    'metadataFieldsAbsentAtSource', 'metadataFieldsNotCaptured',
  ] as const;
  const optionalCounts = Object.fromEntries(optionalCountNames.flatMap((name) =>
    input[name] === undefined ? [] : [[name, nonNegativeInteger(input[name], `completeness ${name}`)]]));
  if (typeof input.expectedTracksKnown !== 'boolean') throw new Error('invalid expectedTracksKnown in terminal checkpoint');
  if (!Array.isArray(input.unresolvedReleaseIds) || input.unresolvedReleaseIds.length > MAX_RELEASES) {
    throw new Error('invalid unresolved release ids in terminal checkpoint');
  }
  const failureReasons: Record<string, number> = {};
  for (const [reason, count] of Object.entries(input.failureReasons)) {
    if (Object.keys(failureReasons).length >= 100) throw new Error('too many failure reasons in terminal checkpoint');
    failureReasons[textValue(reason, 'completeness failure reason', 128)] = nonNegativeInteger(count, 'failure reason count');
  }
  if (input.metadataIncompleteReleaseIds !== undefined
    && (!Array.isArray(input.metadataIncompleteReleaseIds) || input.metadataIncompleteReleaseIds.length > MAX_RELEASES)) {
    throw new Error('invalid metadata-incomplete release ids in terminal checkpoint');
  }
  return {
    ...counts as Pick<FinalizeJob['completeness'], (typeof countNames)[number]>,
    ...optionalCounts,
    expectedTracksKnown: input.expectedTracksKnown,
    unresolvedReleaseIds: input.unresolvedReleaseIds.map((id) => textValue(id, 'unresolved release id', 512)),
    ...(input.metadataIncompleteReleaseIds !== undefined ? {
      metadataIncompleteReleaseIds: input.metadataIncompleteReleaseIds
        .map((id) => textValue(id, 'metadata-incomplete release id', 512)),
    } : {}),
    failureReasons,
  };
}

function sanitizeTombstone(input: SnapshotTerminalTombstone, binding: SnapshotCheckpointBinding): SnapshotTerminalTombstone {
  if (input.kind === 'CANCELLED') {
    return {
      kind: 'CANCELLED',
      createdAt: isoTimestamp(input.createdAt, 'terminal createdAt'),
      reason: textValue(input.reason, 'cancellation reason', 512).replace(/(?:bearer|cookie|password|api[_-]?key|token)\s*[:=]\s*\S+/gi, '[redacted]'),
    };
  }
  if (input.kind !== 'TERMINAL') throw new Error('invalid terminal tombstone kind');
  const job = input.finalizeJob;
  if (!sameBinding(job, binding)) throw new SnapshotPrincipalMismatchError();
  if (job.steelSessionId && !/^v[12]\./.test(job.steelSessionId)) {
    throw new Error('refusing to persist a plaintext Steel session handle in a durable checkpoint');
  }
  const finalJob: FinalizeJob = {
    tenantId: binding.tenantId,
    connectionId: binding.connectionId,
    snapshotId: binding.snapshotId,
    distributor: binding.distributor,
    ...(job.consentId ? { consentId: textValue(job.consentId, 'consentId', 512) } : {}),
    ...(job.artistWorkspaceId ? { artistWorkspaceId: textValue(job.artistWorkspaceId, 'artistWorkspaceId', 512) } : {}),
    ...(job.steelSessionId ? { steelSessionId: textValue(job.steelSessionId, 'encrypted Steel session handle', 16_384) } : {}),
    ...(job.sessionExpiresAt ? { sessionExpiresAt: isoTimestamp(job.sessionExpiresAt, 'Steel session expiry') } : {}),
    ...(job.deadlineAt ? { deadlineAt: isoTimestamp(job.deadlineAt, 'snapshot deadline') } : {}),
    ...(job.schemaVersion !== undefined ? { schemaVersion: nonNegativeInteger(job.schemaVersion, 'schema version') } : {}),
    status: textValue(job.status, 'terminal status', 128) as FinalizeJob['status'],
    completeness: sanitizeCompleteness(job.completeness),
    pass: nonNegativeInteger(job.pass, 'terminal pass'),
  };
  return {
    kind: 'TERMINAL',
    finalizeJob: finalJob,
    createdAt: isoTimestamp(input.createdAt, 'terminal createdAt'),
    ...(input.reason ? { reason: textValue(input.reason, 'terminal reason', 512) } : {}),
  };
}

function parseJson<T>(value: unknown): T {
  if (typeof value === 'string') return JSON.parse(value) as T;
  return value as T;
}

function placeholders(rowCount: number, columnCount: number): string {
  return Array.from({ length: rowCount }, (_, row) =>
    `(${Array.from({ length: columnCount }, (_unused, column) => `$${row * columnCount + column + 1}`).join(',')})`,
  ).join(',');
}

/** PostgreSQL source of truth for in-flight snapshots. Every method requires a prior immutable
 * principal binding, and every query repeats that tenant + connection scope. */
export class PostgresSnapshotCheckpointStore implements SnapshotCheckpointStore {
  private readonly bindings = new Map<string, SnapshotCheckpointBinding>();
  private readonly versions = new Map<string, CheckpointVersions>();

  constructor(private readonly pool: Pool, private readonly batchSize = 100) {
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500) throw new Error('checkpoint batch size must be between 1 and 500');
  }

  async bindSnapshot(binding: SnapshotCheckpointBinding): Promise<void> {
    validateBinding(binding);
    const cached = this.bindings.get(binding.snapshotId);
    if (cached && !sameBinding(cached, binding)) throw new SnapshotPrincipalMismatchError();
    await this.pool.query(
      `INSERT INTO "DistroKidSnapshotCheckpoint" ("tenantId", "connectionId", "snapshotId", "distributor")
       VALUES ($1,$2,$3,$4) ON CONFLICT ("snapshotId") DO NOTHING`,
      [binding.tenantId, binding.connectionId, binding.snapshotId, binding.distributor],
    );
    const result = await this.pool.query(
      `SELECT "tenantId", "connectionId", "snapshotId", "distributor",
              "indexVersion", "outcomesVersion", "progressVersion", "chunksVersion", "plansVersion", "terminalVersion"
         FROM "DistroKidSnapshotCheckpoint" WHERE "snapshotId" = $1`,
      [binding.snapshotId],
    );
    const row = result.rows[0] as (SnapshotCheckpointBinding & Record<`${CheckpointPart}Version`, string | bigint>) | undefined;
    if (!row || !sameBinding(row, binding)) throw new SnapshotPrincipalMismatchError();
    this.bindings.set(binding.snapshotId, { ...binding });
    this.versions.set(binding.snapshotId, {
      index: BigInt(row.indexVersion), outcomes: BigInt(row.outcomesVersion),
      progress: BigInt(row.progressVersion), chunks: BigInt(row.chunksVersion),
      plans: BigInt(row.plansVersion), terminal: BigInt(row.terminalVersion),
    });
  }

  async refreshVersion(snapshotId: string, part: CheckpointPart): Promise<bigint> {
    const binding = this.binding(snapshotId);
    const column = VERSION_COLUMNS[part];
    const result = await this.pool.query(
      `SELECT "${column}" AS "version" FROM "DistroKidSnapshotCheckpoint"
        WHERE "tenantId"=$1 AND "connectionId"=$2 AND "snapshotId"=$3`,
      this.params(binding),
    );
    if (!result.rows[0]) throw new SnapshotPrincipalMismatchError();
    const version = BigInt(result.rows[0]['version'] as string | bigint);
    const versions = this.versions.get(snapshotId);
    if (!versions) throw new SnapshotBindingRequiredError(snapshotId);
    versions[part] = version;
    return version;
  }

  currentVersion(snapshotId: string, part: CheckpointPart): bigint {
    this.binding(snapshotId);
    const versions = this.versions.get(snapshotId);
    if (!versions) throw new SnapshotBindingRequiredError(snapshotId);
    return versions[part];
  }

  private binding(snapshotId: string): SnapshotCheckpointBinding {
    const binding = this.bindings.get(snapshotId);
    if (!binding) throw new SnapshotBindingRequiredError(snapshotId);
    return binding;
  }

  private params(binding: SnapshotCheckpointBinding): string[] {
    return [binding.tenantId, binding.connectionId, binding.snapshotId];
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async lock(client: PoolClient, binding: SnapshotCheckpointBinding): Promise<void> {
    const locked = await client.query(
      `SELECT 1 FROM "DistroKidSnapshotCheckpoint"
        WHERE "tenantId"=$1 AND "connectionId"=$2 AND "snapshotId"=$3 FOR UPDATE`,
      this.params(binding),
    );
    if (locked.rowCount !== 1) throw new SnapshotPrincipalMismatchError();
  }

  private async bumpVersion(client: PoolClient, binding: SnapshotCheckpointBinding, part: CheckpointPart): Promise<bigint> {
    const column = VERSION_COLUMNS[part];
    const result = await client.query(
      `UPDATE "DistroKidSnapshotCheckpoint"
          SET "${column}"="${column}"+1, "updatedAt"=clock_timestamp()
        WHERE "tenantId"=$1 AND "connectionId"=$2 AND "snapshotId"=$3
        RETURNING "${column}" AS "version"`,
      this.params(binding),
    );
    if (!result.rows[0]) throw new SnapshotPrincipalMismatchError();
    const version = BigInt(result.rows[0]['version'] as string | bigint);
    const versions = this.versions.get(binding.snapshotId);
    if (!versions) throw new SnapshotBindingRequiredError(binding.snapshotId);
    versions[part] = version;
    return version;
  }

  async putIndex(snapshotId: string, releases: ReleaseRefRecord[]): Promise<void> {
    const binding = this.binding(snapshotId);
    if (!Array.isArray(releases) || releases.length > MAX_RELEASES) throw new Error('snapshot index exceeds its bounded release limit');
    const sanitized = releases.map(sanitizeReleaseRef);
    if (new Set(sanitized.map((release) => release.releaseId)).size !== sanitized.length) throw new Error('snapshot index contains duplicate release ids');
    await this.transaction(async (client) => {
      await this.lock(client, binding);
      await client.query(
        `DELETE FROM "DistroKidCheckpointIndex" WHERE "tenantId"=$1 AND "connectionId"=$2 AND "snapshotId"=$3`,
        this.params(binding),
      );
      for (let offset = 0; offset < sanitized.length; offset += this.batchSize) {
        const batch = sanitized.slice(offset, offset + this.batchSize);
        const values = batch.flatMap((release, index) => [
          binding.tenantId, binding.connectionId, binding.snapshotId, release.releaseId,
          offset + index, release.dashboardUrl, release.title ?? null, release.artist ?? null,
          release.expectedTrackCount ?? null,
        ]);
        await client.query(
          `INSERT INTO "DistroKidCheckpointIndex"
             ("tenantId","connectionId","snapshotId","releaseId","ordinal","dashboardUrl","title","artist","expectedTrackCount")
           VALUES ${placeholders(batch.length, 9)}`,
          values,
        );
      }
      await this.bumpVersion(client, binding, 'index');
    });
  }

  async getIndex(snapshotId: string): Promise<ReleaseRefRecord[]> {
    const binding = this.binding(snapshotId);
    const result: ReleaseRefRecord[] = [];
    let after = -1;
    while (true) {
      const query = await this.pool.query(
        `SELECT "releaseId", "dashboardUrl", "title", "artist", "expectedTrackCount", "ordinal"
           FROM "DistroKidCheckpointIndex"
          WHERE "tenantId"=$1 AND "connectionId"=$2 AND "snapshotId"=$3 AND "ordinal">$4
          ORDER BY "ordinal" LIMIT $5`,
        [...this.params(binding), after, CHECKPOINT_PAGE_SIZE],
      );
      for (const raw of query.rows as Array<ReleaseRefRecord & { ordinal: number }>) {
        result.push(sanitizeReleaseRef(raw));
        after = raw.ordinal;
      }
      if (query.rows.length < CHECKPOINT_PAGE_SIZE) break;
    }
    return result;
  }

  async putOutcomes(snapshotId: string, outcomes: ReleaseExtractionOutcome[]): Promise<void> {
    const binding = this.binding(snapshotId);
    if (!Array.isArray(outcomes) || outcomes.length > MAX_RELEASES) throw new Error('outcome checkpoint batch exceeds its bounded release limit');
    const sanitized = outcomes.map(sanitizeOutcome);
    await this.transaction(async (client) => {
      await this.lock(client, binding);
      for (let offset = 0; offset < sanitized.length; offset += this.batchSize) {
        const batch = sanitized.slice(offset, offset + this.batchSize);
        const values = batch.flatMap((outcome) => [
          binding.tenantId, binding.connectionId, binding.snapshotId, outcomeId(outcome), JSON.stringify(outcome),
        ]);
        await client.query(
          `INSERT INTO "DistroKidCheckpointOutcome"
             ("tenantId","connectionId","snapshotId","releaseId","outcome")
           VALUES ${placeholders(batch.length, 5)}
           ON CONFLICT ("tenantId","connectionId","snapshotId","releaseId") DO UPDATE
             SET "outcome"=EXCLUDED."outcome", "updatedAt"=clock_timestamp()`,
          values,
        );
      }
      if (sanitized.length > 0) await this.bumpVersion(client, binding, 'outcomes');
    });
  }

  async getOutcomes(snapshotId: string): Promise<ReleaseExtractionOutcome[]> {
    const binding = this.binding(snapshotId);
    const outcomes: ReleaseExtractionOutcome[] = [];
    let after = '';
    while (true) {
      const query = await this.pool.query(
        `SELECT "releaseId", "outcome" FROM "DistroKidCheckpointOutcome"
          WHERE "tenantId"=$1 AND "connectionId"=$2 AND "snapshotId"=$3 AND "releaseId">$4
          ORDER BY "releaseId" LIMIT $5`,
        [...this.params(binding), after, CHECKPOINT_PAGE_SIZE],
      );
      for (const raw of query.rows as Array<{ releaseId: string; outcome: unknown }>) {
        outcomes.push(sanitizeOutcome(parseJson<ReleaseExtractionOutcome>(raw.outcome)));
        after = raw.releaseId;
      }
      if (query.rows.length < CHECKPOINT_PAGE_SIZE) break;
    }
    return outcomes;
  }

  async putProgress(progress: SnapshotProgress): Promise<void> {
    const binding = this.binding(progress.snapshotId);
    const value = sanitizeProgress(progress, binding);
    await this.transaction(async (client) => {
      await this.lock(client, binding);
      await client.query(
        `INSERT INTO "DistroKidCheckpointProgress"
         ("tenantId","connectionId","snapshotId","distributor","status","expectedReleases","completedReleases","failedReleases","chunkCount","completedChunks","startedAt","updatedAt")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT ("tenantId","connectionId","snapshotId") DO UPDATE SET
         "distributor"=EXCLUDED."distributor", "status"=EXCLUDED."status",
         "expectedReleases"=EXCLUDED."expectedReleases", "completedReleases"=EXCLUDED."completedReleases",
         "failedReleases"=EXCLUDED."failedReleases", "chunkCount"=EXCLUDED."chunkCount",
         "completedChunks"=EXCLUDED."completedChunks", "startedAt"=EXCLUDED."startedAt", "updatedAt"=EXCLUDED."updatedAt"`,
        [
          value.tenantId, value.connectionId, value.snapshotId, value.distributor, value.status,
          value.expectedReleases, value.completedReleases, value.failedReleases, value.chunkCount,
          value.completedChunks, value.startedAt, value.updatedAt,
        ],
      );
      await this.bumpVersion(client, binding, 'progress');
    });
  }

  async getProgress(snapshotId: string): Promise<SnapshotProgress | null> {
    const binding = this.binding(snapshotId);
    const query = await this.pool.query(
      `SELECT "snapshotId", "tenantId", "connectionId", "distributor", "status",
              "expectedReleases", "completedReleases", "failedReleases", "chunkCount",
              "completedChunks", "startedAt", "updatedAt"
         FROM "DistroKidCheckpointProgress"
        WHERE "tenantId"=$1 AND "connectionId"=$2 AND "snapshotId"=$3`,
      this.params(binding),
    );
    const raw = query.rows[0] as (Omit<SnapshotProgress, 'startedAt' | 'updatedAt'> & { startedAt: Date | string; updatedAt: Date | string }) | undefined;
    if (!raw) return null;
    return sanitizeProgress({
      ...raw,
      startedAt: raw.startedAt instanceof Date ? raw.startedAt.toISOString() : raw.startedAt,
      updatedAt: raw.updatedAt instanceof Date ? raw.updatedAt.toISOString() : raw.updatedAt,
    }, binding);
  }

  async markChunkComplete(snapshotId: string, pass: number, chunkIndex: number): Promise<void> {
    const binding = this.binding(snapshotId);
    const safePass = nonNegativeInteger(pass, 'chunk pass');
    if (safePass < 1) throw new Error('checkpoint pass must be positive');
    const safeChunk = nonNegativeInteger(chunkIndex, 'chunk index');
    await this.transaction(async (client) => {
      await this.lock(client, binding);
      const inserted = await client.query(
        `INSERT INTO "DistroKidCheckpointChunk" ("tenantId","connectionId","snapshotId","pass","chunkIndex")
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING 1`,
        [...this.params(binding), safePass, safeChunk],
      );
      if (inserted.rowCount === 1) await this.bumpVersion(client, binding, 'chunks');
    });
  }

  async completedChunks(snapshotId: string, pass: number): Promise<number[]> {
    const binding = this.binding(snapshotId);
    const safePass = nonNegativeInteger(pass, 'chunk pass');
    if (safePass < 1) throw new Error('checkpoint pass must be positive');
    const chunks: number[] = [];
    let after = -1;
    while (true) {
      const query = await this.pool.query(
        `SELECT "chunkIndex" FROM "DistroKidCheckpointChunk"
          WHERE "tenantId"=$1 AND "connectionId"=$2 AND "snapshotId"=$3 AND "pass"=$4 AND "chunkIndex">$5
          ORDER BY "chunkIndex" LIMIT $6`,
        [...this.params(binding), safePass, after, CHECKPOINT_PAGE_SIZE],
      );
      for (const row of query.rows as Array<{ chunkIndex: number }>) {
        chunks.push(nonNegativeInteger(row.chunkIndex, 'stored chunk index'));
        after = row.chunkIndex;
      }
      if (query.rows.length < CHECKPOINT_PAGE_SIZE) break;
    }
    return chunks;
  }

  async completedChunkCount(snapshotId: string, pass: number): Promise<bigint> {
    const binding = this.binding(snapshotId);
    const safePass = nonNegativeInteger(pass, 'chunk pass');
    if (safePass < 1) throw new Error('checkpoint pass must be positive');
    const query = await this.pool.query(
      `SELECT count(*)::bigint AS "count" FROM "DistroKidCheckpointChunk"
        WHERE "tenantId"=$1 AND "connectionId"=$2 AND "snapshotId"=$3 AND "pass"=$4`,
      [...this.params(binding), safePass],
    );
    return BigInt(query.rows[0]?.['count'] as string | bigint);
  }

  async putPassPlan(snapshotId: string, pass: number, releaseIdChunks: string[][]): Promise<void> {
    const binding = this.binding(snapshotId);
    const safePass = nonNegativeInteger(pass, 'plan pass');
    if (safePass < 1 || !Array.isArray(releaseIdChunks) || releaseIdChunks.length > MAX_RELEASES) throw new Error('invalid pass plan checkpoint');
    const plan = releaseIdChunks.map((chunk, chunkIndex) => {
      if (!Array.isArray(chunk) || chunk.length > 1_000) throw new Error(`pass plan chunk ${chunkIndex} exceeds its bounded size`);
      return chunk.map((id) => textValue(id, `pass plan ${chunkIndex} releaseId`, 512));
    });
    await this.transaction(async (client) => {
      await this.lock(client, binding);
      await client.query(
        `DELETE FROM "DistroKidCheckpointPassPlanChunk"
          WHERE "tenantId"=$1 AND "connectionId"=$2 AND "snapshotId"=$3 AND "pass"=$4`,
        [...this.params(binding), safePass],
      );
      for (let offset = 0; offset < plan.length; offset += this.batchSize) {
        const batch = plan.slice(offset, offset + this.batchSize);
        const values = batch.flatMap((releaseIds, index) => [
          binding.tenantId, binding.connectionId, binding.snapshotId, safePass, offset + index, releaseIds,
        ]);
        await client.query(
          `INSERT INTO "DistroKidCheckpointPassPlanChunk"
             ("tenantId","connectionId","snapshotId","pass","chunkIndex","releaseIds")
           VALUES ${placeholders(batch.length, 6)}`,
          values,
        );
      }
      await this.bumpVersion(client, binding, 'plans');
    });
  }

  async getPassPlan(snapshotId: string, pass: number): Promise<string[][] | null> {
    const binding = this.binding(snapshotId);
    const safePass = nonNegativeInteger(pass, 'plan pass');
    if (safePass < 1) throw new Error('checkpoint plan pass must be positive');
    const plan: string[][] = [];
    let after = -1;
    while (true) {
      const query = await this.pool.query(
        `SELECT "chunkIndex", "releaseIds" FROM "DistroKidCheckpointPassPlanChunk"
          WHERE "tenantId"=$1 AND "connectionId"=$2 AND "snapshotId"=$3 AND "pass"=$4 AND "chunkIndex">$5
          ORDER BY "chunkIndex" LIMIT $6`,
        [...this.params(binding), safePass, after, CHECKPOINT_PAGE_SIZE],
      );
      for (const row of query.rows as Array<{ chunkIndex: number; releaseIds: string[] }>) {
        if (row.chunkIndex !== plan.length) throw new Error('durable pass plan contains a non-contiguous chunk index');
        plan.push(row.releaseIds.map((id) => textValue(id, 'stored pass plan releaseId', 512)));
        after = row.chunkIndex;
      }
      if (query.rows.length < CHECKPOINT_PAGE_SIZE) break;
    }
    return plan.length > 0 ? plan : null;
  }

  async claimTerminal(snapshotId: string, tombstone: SnapshotTerminalTombstone): Promise<SnapshotTerminalTombstone> {
    const binding = this.binding(snapshotId);
    const proposed = sanitizeTombstone(tombstone, binding);
    const inserted = await this.transaction(async (client) => {
      await this.lock(client, binding);
      const result = await client.query(
        `INSERT INTO "DistroKidCheckpointTerminal" ("tenantId","connectionId","snapshotId","tombstone")
         VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING RETURNING "tombstone"`,
        [...this.params(binding), JSON.stringify(proposed)],
      );
      if (result.rows[0]) await this.bumpVersion(client, binding, 'terminal');
      return result;
    });
    if (inserted.rows[0]) return sanitizeTombstone(parseJson<SnapshotTerminalTombstone>(inserted.rows[0]['tombstone']), binding);
    const existing = await this.getTerminal(snapshotId);
    if (!existing) throw new Error('durable terminal tombstone ownership could not be confirmed');
    return existing;
  }

  async getTerminal(snapshotId: string): Promise<SnapshotTerminalTombstone | null> {
    const binding = this.binding(snapshotId);
    const query = await this.pool.query(
      `SELECT "tombstone" FROM "DistroKidCheckpointTerminal"
        WHERE "tenantId"=$1 AND "connectionId"=$2 AND "snapshotId"=$3`,
      this.params(binding),
    );
    if (!query.rows[0]) return null;
    return sanitizeTombstone(parseJson<SnapshotTerminalTombstone>(query.rows[0]['tombstone']), binding);
  }
}

export interface TieredSnapshotStoreOptions {
  redisTtlSeconds?: number;
  postgresBatchSize?: number;
  onCacheError?: (error: Error) => void;
}

/** PostgreSQL-first writes and Redis-first reads. A cache miss/failure is repaired from the
 * durable store; a durable write is never acknowledged only by Redis. */
export class TieredSnapshotCheckpointStore implements SnapshotCheckpointStore {
  private readonly hot: RedisSnapshotStore;
  private readonly durable: PostgresSnapshotCheckpointStore;
  private readonly bindings = new Map<string, SnapshotCheckpointBinding>();

  constructor(redis: SnapshotRedis, pool: Pool, private readonly options: TieredSnapshotStoreOptions = {}) {
    this.hot = new RedisSnapshotStore(redis, options.redisTtlSeconds);
    this.durable = new PostgresSnapshotCheckpointStore(pool, options.postgresBatchSize);
  }

  private binding(snapshotId: string): SnapshotCheckpointBinding {
    const binding = this.bindings.get(snapshotId);
    if (!binding) throw new SnapshotBindingRequiredError(snapshotId);
    return binding;
  }

  private cacheError(error: unknown): void {
    if (error instanceof SnapshotPrincipalMismatchError) throw error;
    this.options.onCacheError?.(error instanceof Error ? error : new Error('unknown Redis checkpoint error'));
  }

  private async cacheWrite(work: () => Promise<unknown>): Promise<void> {
    try { await work(); }
    catch (error) { this.cacheError(error); }
  }

  private async cacheProjection(snapshotId: string, part: CheckpointPart, work: () => Promise<unknown>): Promise<void> {
    const version = this.durable.currentVersion(snapshotId, part);
    await this.cacheWrite(async () => {
      await work();
      // Written last: equality proves the preceding projection write completed for this durable
      // revision. A Redis outage can therefore leave only an old/missing version, never a false hit.
      await this.hot.putVersion(snapshotId, part, version);
    });
  }

  private async hotMatchesDurable(snapshotId: string, part: CheckpointPart): Promise<boolean> {
    const durableVersion = await this.durable.refreshVersion(snapshotId, part);
    try { return await this.hot.getVersion(snapshotId, part) === durableVersion; }
    catch (error) {
      this.cacheError(error);
      return false;
    }
  }

  async bindSnapshot(binding: SnapshotCheckpointBinding): Promise<void> {
    validateBinding(binding);
    await this.durable.bindSnapshot(binding); // durable ownership is authoritative
    const existing = this.bindings.get(binding.snapshotId);
    if (existing && !sameBinding(existing, binding)) throw new SnapshotPrincipalMismatchError();
    this.bindings.set(binding.snapshotId, { ...binding });
    await this.cacheWrite(() => this.hot.bindSnapshot(binding));
  }

  async putIndex(snapshotId: string, releases: ReleaseRefRecord[]): Promise<void> {
    this.binding(snapshotId);
    await this.durable.putIndex(snapshotId, releases);
    const sanitized = releases.map(sanitizeReleaseRef);
    await this.cacheProjection(snapshotId, 'index', () => this.hot.putIndex(snapshotId, sanitized));
  }

  async getIndex(snapshotId: string): Promise<ReleaseRefRecord[]> {
    this.binding(snapshotId);
    if (await this.hotMatchesDurable(snapshotId, 'index')) try {
      const cached = await this.hot.getIndexIfPresent(snapshotId);
      if (cached) return cached.map(sanitizeReleaseRef);
    } catch (error) { this.cacheError(error); }
    const durable = await this.durable.getIndex(snapshotId);
    await this.cacheProjection(snapshotId, 'index', () => this.hot.putIndex(snapshotId, durable));
    return durable;
  }

  async putOutcomes(snapshotId: string, outcomes: ReleaseExtractionOutcome[]): Promise<void> {
    this.binding(snapshotId);
    await this.durable.putOutcomes(snapshotId, outcomes);
    const sanitized = outcomes.map(sanitizeOutcome);
    const version = this.durable.currentVersion(snapshotId, 'outcomes');
    let hotVersion: bigint | null = null;
    try { hotVersion = await this.hot.getVersion(snapshotId, 'outcomes'); }
    catch (error) { this.cacheError(error); }
    await this.cacheProjection(snapshotId, 'outcomes', async () => {
      if (hotVersion === version || hotVersion === version - 1n) await this.hot.putOutcomes(snapshotId, sanitized);
      else await this.hot.replaceOutcomes(snapshotId, await this.durable.getOutcomes(snapshotId));
    });
  }

  async getOutcomes(snapshotId: string): Promise<ReleaseExtractionOutcome[]> {
    this.binding(snapshotId);
    if (await this.hotMatchesDurable(snapshotId, 'outcomes')) try {
      const cached = (await this.hot.getOutcomes(snapshotId)).map(sanitizeOutcome);
      if (cached.length > 0 || this.durable.currentVersion(snapshotId, 'outcomes') === 0n) return cached;
    } catch (error) { this.cacheError(error); }
    const durable = await this.durable.getOutcomes(snapshotId);
    await this.cacheProjection(snapshotId, 'outcomes', () => this.hot.replaceOutcomes(snapshotId, durable));
    return durable;
  }

  async putProgress(progress: SnapshotProgress): Promise<void> {
    const binding = this.binding(progress.snapshotId);
    const sanitized = sanitizeProgress(progress, binding);
    await this.durable.putProgress(sanitized);
    await this.cacheProjection(progress.snapshotId, 'progress', () => this.hot.putProgress(sanitized));
  }

  async getProgress(snapshotId: string): Promise<SnapshotProgress | null> {
    const binding = this.binding(snapshotId);
    if (await this.hotMatchesDurable(snapshotId, 'progress')) try {
      const cached = await this.hot.getProgress(snapshotId);
      if (cached) return sanitizeProgress(cached, binding);
    } catch (error) { this.cacheError(error); }
    const durable = await this.durable.getProgress(snapshotId);
    if (durable) await this.cacheProjection(snapshotId, 'progress', () => this.hot.putProgress(durable));
    return durable;
  }

  async markChunkComplete(snapshotId: string, pass: number, chunkIndex: number): Promise<void> {
    this.binding(snapshotId);
    await this.durable.markChunkComplete(snapshotId, pass, chunkIndex);
    const versionPart = `chunks:${pass}`;
    const version = await this.durable.completedChunkCount(snapshotId, pass);
    let hotVersion: bigint | null = null;
    try { hotVersion = await this.hot.getVersion(snapshotId, versionPart); }
    catch (error) { this.cacheError(error); }
    await this.cacheWrite(async () => {
      if (hotVersion === version || hotVersion === version - 1n) await this.hot.markChunkComplete(snapshotId, pass, chunkIndex);
      else await this.hot.replaceCompletedChunks(snapshotId, pass, await this.durable.completedChunks(snapshotId, pass));
      await this.hot.putVersion(snapshotId, versionPart, version);
    });
  }

  async completedChunks(snapshotId: string, pass: number): Promise<number[]> {
    this.binding(snapshotId);
    const versionPart = `chunks:${pass}`;
    const durableCount = await this.durable.completedChunkCount(snapshotId, pass);
    try {
      if (await this.hot.getVersion(snapshotId, versionPart) === durableCount) {
        const cached = await this.hot.completedChunks(snapshotId, pass);
        if (BigInt(cached.length) === durableCount) return cached;
      }
    } catch (error) { this.cacheError(error); }
    const durable = await this.durable.completedChunks(snapshotId, pass);
    await this.cacheWrite(async () => {
      await this.hot.replaceCompletedChunks(snapshotId, pass, durable);
      await this.hot.putVersion(snapshotId, versionPart, BigInt(durable.length));
    });
    return durable;
  }

  async putPassPlan(snapshotId: string, pass: number, releaseIdChunks: string[][]): Promise<void> {
    this.binding(snapshotId);
    await this.durable.putPassPlan(snapshotId, pass, releaseIdChunks);
    await this.cacheProjection(snapshotId, 'plans', () => this.hot.putPassPlan(snapshotId, pass, releaseIdChunks));
  }

  async getPassPlan(snapshotId: string, pass: number): Promise<string[][] | null> {
    this.binding(snapshotId);
    if (await this.hotMatchesDurable(snapshotId, 'plans')) try {
      const cached = await this.hot.getPassPlan(snapshotId, pass);
      if (cached) return cached.map((chunk) => chunk.map((id) => textValue(id, 'cached pass plan releaseId', 512)));
    } catch (error) { this.cacheError(error); }
    const durable = await this.durable.getPassPlan(snapshotId, pass);
    if (durable) await this.cacheProjection(snapshotId, 'plans', () => this.hot.putPassPlan(snapshotId, pass, durable));
    return durable;
  }

  async claimTerminal(snapshotId: string, tombstone: SnapshotTerminalTombstone): Promise<SnapshotTerminalTombstone> {
    const binding = this.binding(snapshotId);
    const sanitized = sanitizeTombstone(tombstone, binding);
    const winner = await this.durable.claimTerminal(snapshotId, sanitized);
    await this.cacheProjection(snapshotId, 'terminal', () => this.hot.putTerminal(snapshotId, winner));
    return winner;
  }

  async getTerminal(snapshotId: string): Promise<SnapshotTerminalTombstone | null> {
    const binding = this.binding(snapshotId);
    if (await this.hotMatchesDurable(snapshotId, 'terminal')) try {
      const cached = await this.hot.getTerminal(snapshotId);
      if (cached) return sanitizeTombstone(cached, binding);
    } catch (error) { this.cacheError(error); }
    const durable = await this.durable.getTerminal(snapshotId);
    if (durable) await this.cacheProjection(snapshotId, 'terminal', () => this.hot.putTerminal(snapshotId, durable));
    return durable;
  }
}
