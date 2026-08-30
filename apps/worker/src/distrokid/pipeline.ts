import {
  DISTROKID_CATALOG_INDEX_ERROR_CODES,
  DistroKidCatalogIndexError,
  distroKidCatalogIndexErrorCodeFromMessage,
  reconcile, retryableReleaseIds, describeCompleteness, releaseNeedsMetadataRetry,
  mergeCanonicalRelease,
  type DistroKidCatalogIndexErrorCode,
  type ReleaseExtractionOutcome,
} from '@sentinel/browser-assist';
import type { SnapshotStatus, ExtractionCompleteness } from '@sentinel/contracts';
import type {
  SnapshotCheckpointStore, ReleaseRefRecord, SnapshotProgress, SnapshotTerminalTombstone,
} from './snapshot-store';
import { backoffWithJitter, startLockHeartbeat, type HeldLock } from './locks';

/**
 * How many times a chunk may be deferred by the per-account lock before it fails.
 *
 * Sized for the worst legitimate case: a 1000-release catalogue is 50 chunks, each serialized on
 * one account. Deferring with jittered backoff capped at 30s, a chunk at the back of that queue
 * waits a long time, so this is high. It is a stuck-holder backstop, not a tuning knob.
 */
/** Legacy backstop for rolling-upgrade jobs which pre-date the mandatory wall-clock deadline. */
export const MAX_CHUNK_DEFERS = 200;

/** The initial extraction sweep. Retry sweeps are pass 2, 3, … up to DISTROKID_MAX_ATTEMPTS. */
export const INITIAL_PASS = 1;

/**
 * DistroKid extraction pipeline, chunked by RELEASE, resumable, retry-failed-only.
 *
 *   extract-catalog-index → plan-release-chunks → extract-release-chunk (xN)
 *        → retry-failed-releases → reconcile-snapshot → finalize-snapshot
 *
 * Why chunks of releases (not tracks): one browser navigation yields a whole release's track
 * list in a single metadata response. Enqueuing per-track would multiply browser work for no
 * gain. Chunking bounds memory, gives us checkpoints, and lets a crash resume mid-catalogue.
 *
 * The job payloads and ids live in `@sentinel/contracts`, the API must be able to enqueue stage 1
 * without importing this application. Re-exported here so worker-internal imports stay short.
 */

export {
  DISTROKID_RELEASE_CHUNK_SIZE, DISTROKID_PER_ACCOUNT_CONCURRENCY,
  DISTROKID_REQUEST_MIN_DELAY_MS, DISTROKID_MAX_ATTEMPTS, CHECKPOINT_EVERY, jobIds,
} from '@sentinel/contracts';
export type {
  SnapshotRef, CatalogIndexJob, PlanChunksJob, ReleaseChunkJob,
  RetryFailedJob, ReconcileJob, FinalizeJob,
} from '@sentinel/contracts';

import {
  DISTROKID_RELEASE_CHUNK_SIZE, DISTROKID_MAX_ATTEMPTS, DISTROKID_REQUEST_MIN_DELAY_MS,
  DISTROKID_SESSION_CLEANUP_GRACE_MS,
  type SnapshotRef, type CatalogIndexJob, type PlanChunksJob, type ReleaseChunkJob,
  type RetryFailedJob, type ReconcileJob, type FinalizeJob,
} from '@sentinel/contracts';

/** Injected side effects, so the pipeline is testable with no browser/Redis. */
export interface PipelineDeps {
  store: SnapshotCheckpointStore;
  /** Reads the catalog index (release list) over the authenticated session. */
  readCatalogIndex(job: CatalogIndexJob, control: BrowserWorkControl): Promise<ReleaseRefRecord[]>;
  /** Extracts ONE chunk of releases network-first. Must return a terminal outcome per release. */
  extractChunk(
    job: ReleaseChunkJob,
    refs: ReleaseRefRecord[],
    onCheckpoint: (o: ReleaseExtractionOutcome[]) => Promise<void>,
    control: BrowserWorkControl,
  ): Promise<ReleaseExtractionOutcome[]>;
  /** Take the per-connection lock; null → another worker holds it. */
  acquireLock(job: SnapshotRef): Promise<HeldLock | null>;
  enqueue: {
    plan(job: PlanChunksJob): Promise<void>;
    /** `delayMs` backs off a chunk deferred by the per-account lock, so it doesn't spin. */
    chunk(job: ReleaseChunkJob, opts?: { delayMs?: number }): Promise<void>;
    retry(job: RetryFailedJob): Promise<void>;
    reconcile(job: ReconcileJob): Promise<void>;
    finalize(job: FinalizeJob): Promise<void>;
  };
  /** Persist the finished snapshot (batched write). */
  persistSnapshot(job: FinalizeJob, outcomes: ReleaseExtractionOutcome[]): Promise<void>;
  /** Release the borrowed remote browser session only after the public snapshot and terminal
   * progress checkpoint are durable. Keeping cleanup separate means a transient provider
   * failure cannot make a finalizer repeat an already-completed projection. */
  releaseSession?(job: FinalizeJob): Promise<void>;
  /** Observe terminal infrastructure/browser failure. The pipeline itself owns the durable
   * tombstone and finalizer enqueue; this hook must not be their sole source of durability. */
  terminalFailure?(job: SnapshotRef, stage: string, error: Error): Promise<void>;
  log?(msg: string, extra?: Record<string, unknown>): void;
  metrics?: PipelineMetrics;
  now?(): number;
  /** Production compositions require an immutable producer-anchored deadline. */
  requireDeadline?: boolean;
  /** Composition shutdown aborts active browser work before BullMQ/resource teardown waits. */
  shutdownSignal?: AbortSignal;
}

export interface BrowserWorkControl {
  /** Aborted immediately on lock loss or when the snapshot deadline elapses. */
  signal: AbortSignal;
  /** Must be awaited immediately before each browser navigation/work item. */
  assertCanContinue(): Promise<void>;
}

export interface PipelineMetrics {
  releasesExpected(n: number, r: SnapshotRef): void;
  releasesCompleted(n: number, r: SnapshotRef): void;
  releasesFailed(n: number, r: SnapshotRef): void;
  chunkDuration(ms: number, r: SnapshotRef): void;
  snapshotStatus(status: SnapshotStatus, r: SnapshotRef): void;
}

const nowIso = (): string => new Date().toISOString();

function reconcileCheckpoint(index: ReleaseRefRecord[], outcomes: ReleaseExtractionOutcome[]) {
  const expectedTracks = index.length > 0 && index.every((release) => release.expectedTrackCount !== undefined)
    ? index.reduce((total, release) => total + release.expectedTrackCount!, 0)
    : undefined;
  return reconcile({
    expectedReleaseIds: index.map((release) => release.releaseId),
    outcomes,
    ...(expectedTracks !== undefined ? { expectedTracks } : {}),
  });
}

/**
 * Carry a snapshot's identity, INCLUDING the authenticated session handle, to the next stage.
 *
 * Every stage transition previously rebuilt this object field-by-field, and the chunk→reconcile
 * and retry→reconcile hops simply forgot `steelSessionId`. Reconcile then created the retry job
 * from that reduced object, so retry chunks had no session, `attach()` returned null, and every
 * retried release failed `REAUTH_REQUIRED`. The failed-release retry path, a core acceptance
 * criterion, could therefore never succeed.
 *
 * Using one helper everywhere means a stage cannot drop the handle by omission. That is the whole
 * point: the bug was silent because nothing forced the field to be mentioned.
 */
const refOf = (job: SnapshotRef): SnapshotRef => ({
  tenantId: job.tenantId,
  connectionId: job.connectionId,
  snapshotId: job.snapshotId,
  distributor: job.distributor,
  ...(job.steelSessionId ? { steelSessionId: job.steelSessionId } : {}),
  ...(job.consentId ? { consentId: job.consentId } : {}),
  ...(job.artistWorkspaceId ? { artistWorkspaceId: job.artistWorkspaceId } : {}),
  ...(job.sessionExpiresAt ? { sessionExpiresAt: job.sessionExpiresAt } : {}),
  ...(job.deadlineAt ? { deadlineAt: job.deadlineAt } : {}),
  ...(job.schemaVersion ? { schemaVersion: job.schemaVersion } : {}),
});

const outcomeReleaseId = (outcome: ReleaseExtractionOutcome): string =>
  outcome.kind === 'COMPLETED' ? outcome.release.distributorReleaseId : outcome.distributorReleaseId;

/**
 * Converge a targeted retry with its previous checkpoint without losing verified songs/fields.
 * A transient retry failure never erases a previously completed (but field-incomplete) release;
 * a successful retry is authoritative for current data and backfills only evidence it still could
 * not capture from the previous attempt.
 */
export function convergeReleaseRetryOutcome(
  previous: ReleaseExtractionOutcome | undefined,
  incoming: ReleaseExtractionOutcome,
): ReleaseExtractionOutcome {
  if (!previous) return incoming;
  if (previous.kind === 'COMPLETED' && incoming.kind !== 'COMPLETED') return previous;
  if (incoming.kind !== 'COMPLETED' || previous.kind !== 'COMPLETED') return incoming;
  return {
    ...incoming,
    release: mergeCanonicalRelease(incoming.release, previous.release),
    ...(incoming.endpointFingerprint || previous.endpointFingerprint
      ? { endpointFingerprint: incoming.endpointFingerprint ?? previous.endpointFingerprint }
      : {}),
  };
}

/** Bind before touching any checkpoint. The durable store rejects a queue replay that reuses a
 * snapshot id under another tenant or distributor connection. */
const bindCheckpoint = (job: SnapshotRef, deps: Pick<PipelineDeps, 'store'>): Promise<void> =>
  deps.store.bindSnapshot({
    snapshotId: job.snapshotId,
    tenantId: job.tenantId,
    connectionId: job.connectionId,
    distributor: job.distributor,
  });

export class PipelineDeadlineExceededError extends Error {
  constructor(message = 'DistroKid catalogue-read wall-clock deadline exceeded') {
    super(message);
    this.name = 'PipelineDeadlineExceededError';
  }
}

export class InvalidPipelineDeadlineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPipelineDeadlineError';
  }
}

export class SnapshotStoppedError extends Error {
  constructor(public readonly tombstone: SnapshotTerminalTombstone) {
    super(`snapshot is already ${tombstone.kind.toLowerCase()}`);
    this.name = 'SnapshotStoppedError';
  }
}

export class AccountLockUnavailableError extends Error {
  constructor() {
    super('the distributor account is currently owned by another catalogue read');
    this.name = 'AccountLockUnavailableError';
  }
}

export class PipelineShutdownError extends Error {
  constructor() {
    super('PIPELINE_SHUTDOWN_RETRY: DistroKid pipeline worker is shutting down');
    this.name = 'PipelineShutdownError';
  }
}

const PIPELINE_TERMINAL_FAILURE_CODES = [
  'PIPELINE_DEADLINE_EXCEEDED',
  'PIPELINE_CONFIGURATION_INVALID',
  'ACCOUNT_LOCK_UNAVAILABLE',
  'ACCOUNT_LOCK_LOST',
  'STAGE_TIMEOUT',
  'CATALOG_INDEX_FAILED',
  'PIPELINE_STAGE_FAILED',
] as const;

type PipelineTerminalFailureCode = (typeof PIPELINE_TERMINAL_FAILURE_CODES)[number];

/**
 * The only terminal infrastructure/browser categories allowed into customer-visible
 * completeness. Exception messages are operational diagnostics and may contain provider data;
 * they must never become durable keys or values.
 */
export const DISTROKID_TERMINAL_FAILURE_CODES = [
  ...DISTROKID_CATALOG_INDEX_ERROR_CODES,
  ...PIPELINE_TERMINAL_FAILURE_CODES,
] as const;

export type DistroKidTerminalFailureCode =
  | DistroKidCatalogIndexErrorCode
  | PipelineTerminalFailureCode;

class RecoveredDistroKidTerminalError extends Error {
  constructor(readonly failureCode: DistroKidTerminalFailureCode) {
    super(`[DISTROKID_PIPELINE_FAILURE:${failureCode}] recovered from the durable failed-job ledger`);
    this.name = 'RecoveredDistroKidTerminalError';
  }
}

const isCatalogIndexStage = (stage: string): boolean =>
  stage === 'distrokid-catalog-index' || /(?:^|[-_ ])catalog[-_ ]?index(?:$|[-_ ])/i.test(stage);

/**
 * Reduce an arbitrary exception to one stable, allowlisted code.
 *
 * Typed catalog-index failures are preferred. The message parser exists for BullMQ recovery:
 * custom Error properties do not survive in `failedReason`, while the browser boundary embeds
 * only its allowlisted code in a controlled prefix. Remaining message checks produce fixed
 * categories and never return the matched text.
 */
export function classifyDistroKidTerminalFailure(
  stage: string,
  error: Error,
): DistroKidTerminalFailureCode {
  if (error instanceof RecoveredDistroKidTerminalError) return error.failureCode;
  if (error instanceof DistroKidCatalogIndexError) return error.code;
  const recoveredCatalogCode = distroKidCatalogIndexErrorCodeFromMessage(error.message);
  if (recoveredCatalogCode) return recoveredCatalogCode;
  if (error instanceof PipelineDeadlineExceededError) return 'PIPELINE_DEADLINE_EXCEEDED';
  if (error instanceof InvalidPipelineDeadlineError) return 'PIPELINE_CONFIGURATION_INVALID';
  if (error instanceof AccountLockUnavailableError) return 'ACCOUNT_LOCK_UNAVAILABLE';
  if (error instanceof LockLostError) return 'ACCOUNT_LOCK_LOST';

  // These are deliberately narrow compatibility checks for errors raised outside the typed
  // catalog reader (for example, failure to re-attach the authenticated Steel session).
  if (/(?:no authenticated distributor session|authentication (?:is )?required|authentication expired)/i.test(error.message)) {
    return 'AUTHENTICATION_REQUIRED';
  }
  if (/(?:timed out|timeout)/i.test(error.message)) return 'STAGE_TIMEOUT';
  return isCatalogIndexStage(stage) ? 'CATALOG_INDEX_FAILED' : 'PIPELINE_STAGE_FAILED';
}

/**
 * Rehydrate a BullMQ `failedReason` without carrying its arbitrary text into terminal hooks,
 * logs, tombstones, or the public snapshot. Only an allowlisted classification survives.
 */
export function sanitizeRecoveredDistroKidFailure(
  stage: string,
  failedReason: unknown,
): Error {
  const transient = new Error(typeof failedReason === 'string' ? failedReason : '');
  return new RecoveredDistroKidTerminalError(classifyDistroKidTerminalFailure(stage, transient));
}

const pipelineNow = (deps: PipelineDeps): number => deps.now?.() ?? Date.now();

function deadlineMs(job: SnapshotRef, deps: PipelineDeps): number | null {
  if (!job.deadlineAt) {
    if (deps.requireDeadline) throw new InvalidPipelineDeadlineError('production pipeline job has no wall-clock deadline');
    return null;
  }
  const deadline = Date.parse(job.deadlineAt);
  if (!Number.isFinite(deadline)) throw new InvalidPipelineDeadlineError('pipeline deadline is invalid');
  if (job.sessionExpiresAt) {
    const sessionExpiry = Date.parse(job.sessionExpiresAt);
    if (!Number.isFinite(sessionExpiry)) throw new InvalidPipelineDeadlineError('Steel session expiry is invalid');
    if (deadline > sessionExpiry - DISTROKID_SESSION_CLEANUP_GRACE_MS) {
      throw new InvalidPipelineDeadlineError('pipeline deadline does not leave the required Steel cleanup lease');
    }
  } else if (deps.requireDeadline) {
    throw new InvalidPipelineDeadlineError('production pipeline job has no actual Steel session expiry');
  }
  return deadline;
}

export function assertPipelineDeadline(job: SnapshotRef, deps: PipelineDeps): void {
  const deadline = deadlineMs(job, deps);
  if (deadline !== null && pipelineNow(deps) >= deadline) throw new PipelineDeadlineExceededError();
}

/** Re-enqueue the immutable winning finalizer after a crash between verdict and queue add. */
export async function resumeTerminalFinalizer(job: SnapshotRef, deps: PipelineDeps): Promise<boolean> {
  await bindCheckpoint(job, deps);
  const tombstone = await deps.store.getTerminal(job.snapshotId);
  if (!tombstone) return false;
  if (tombstone.kind === 'TERMINAL') await deps.enqueue.finalize(tombstone.finalizeJob);
  return true;
}

async function assertSnapshotCanContinue(job: SnapshotRef, deps: PipelineDeps): Promise<void> {
  assertPipelineDeadline(job, deps);
  const tombstone = await deps.store.getTerminal(job.snapshotId);
  if (tombstone) throw new SnapshotStoppedError(tombstone);
}

const abortReason = (signal: AbortSignal): Error =>
  signal.reason instanceof Error ? signal.reason : new Error('browser work aborted');

async function raceAbort<T>(signal: AbortSignal, work: Promise<T>): Promise<T> {
  if (signal.aborted) throw abortReason(signal);
  let onAbort: (() => void) | undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([work, stopped]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

async function underAccountLock<T>(
  job: SnapshotRef,
  deps: PipelineDeps,
  lock: HeldLock,
  work: (control: BrowserWorkControl) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const shutdown = (): void => controller.abort(new PipelineShutdownError());
  if (deps.shutdownSignal?.aborted) shutdown();
  else deps.shutdownSignal?.addEventListener('abort', shutdown, { once: true });
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const heartbeat = startLockHeartbeat(lock, {
    onLost: (reason) => {
      const error = new LockLostError(reason);
      controller.abort(error);
      deps.log?.('account lock LOST during browser work - aborting', { snapshotId: job.snapshotId, reason });
    },
    ...(deps.log ? { log: deps.log } : {}),
  });
  const deadline = deadlineMs(job, deps);
  if (deadline !== null) {
    const remaining = Math.max(0, deadline - pipelineNow(deps));
    deadlineTimer = setTimeout(() => controller.abort(new PipelineDeadlineExceededError()), remaining);
    deadlineTimer.unref?.();
  }
  const control: BrowserWorkControl = {
    signal: controller.signal,
    async assertCanContinue() {
      if (controller.signal.aborted) throw abortReason(controller.signal);
      await assertSnapshotCanContinue(job, deps);
      if (controller.signal.aborted) throw abortReason(controller.signal);
    },
  };
  try {
    await control.assertCanContinue();
    const running = work(control);
    try {
      return await raceAbort(controller.signal, running);
    } catch (error) {
      // The browser implementation closes its page/connection on `signal`. Do not release the
      // account lock until that in-flight operation has actually quiesced: Promise.race alone
      // would let a stale navigation continue after a new worker acquired the lock.
      await running.catch(() => undefined);
      throw error;
    }
  } finally {
    deps.shutdownSignal?.removeEventListener('abort', shutdown);
    if (deadlineTimer) clearTimeout(deadlineTimer);
    heartbeat.stop();
    await lock.release();
  }
}

/** 1. Read the catalog index, the authoritative expectation for completeness. */
export async function extractDistroKidCatalogIndex(
  job: CatalogIndexJob,
  deps: PipelineDeps,
): Promise<{ expected: number; stopped?: boolean }> {
  if (await resumeTerminalFinalizer(job, deps)) return { expected: 0, stopped: true };
  assertPipelineDeadline(job, deps);
  const lock = await deps.acquireLock(job);
  if (!lock) throw new AccountLockUnavailableError();
  try {
    return await underAccountLock(job, deps, lock, async (control) => {
      const releases = await deps.readCatalogIndex(job, control);
      await control.assertCanContinue();
      await deps.store.putIndex(job.snapshotId, releases);
      const progress: SnapshotProgress = {
        snapshotId: job.snapshotId, tenantId: job.tenantId, connectionId: job.connectionId, distributor: job.distributor,
        status: 'PLANNED', expectedReleases: releases.length, completedReleases: 0, failedReleases: 0,
        chunkCount: 0, completedChunks: [], startedAt: nowIso(), updatedAt: nowIso(),
      };
      await control.assertCanContinue();
      await deps.store.putProgress(progress);
      deps.metrics?.releasesExpected(releases.length, job);
      deps.log?.('catalog index extracted', { snapshotId: job.snapshotId, releases: releases.length });
      await control.assertCanContinue();
      await deps.enqueue.plan(refOf(job));
      return { expected: releases.length };
    });
  } catch (error) {
    if (error instanceof SnapshotStoppedError) return { expected: 0, stopped: true };
    throw error;
  }
}

/** 2. Split into release chunks. Already-completed chunks are skipped (resume). */
export async function planDistroKidReleaseChunks(
  job: PlanChunksJob,
  deps: PipelineDeps,
): Promise<{ chunks: number; skipped: number; stopped?: boolean }> {
  if (await resumeTerminalFinalizer(job, deps)) return { chunks: 0, skipped: 0, stopped: true };
  assertPipelineDeadline(job, deps);
  const index = await deps.store.getIndex(job.snapshotId);
  const size = job.chunkSize ?? (Number(process.env.DISTROKID_RELEASE_CHUNK_SIZE) || DISTROKID_RELEASE_CHUNK_SIZE);
  const done = new Set(await deps.store.completedChunks(job.snapshotId, INITIAL_PASS));
  let chunks = await deps.store.getPassPlan(job.snapshotId, INITIAL_PASS);
  if (!chunks) {
    chunks = chunkReleases(index.map((release) => release.releaseId), size);
    await assertSnapshotCanContinue(job, deps);
    await deps.store.putPassPlan(job.snapshotId, INITIAL_PASS, chunks);
  }
  const progress = await deps.store.getProgress(job.snapshotId);
  if (progress) {
    await assertSnapshotCanContinue(job, deps);
    await deps.store.putProgress({ ...progress, status: 'RUNNING', chunkCount: chunks.length, updatedAt: nowIso() });
  }

  // Queue exactly one chunk. Completion of chunk N durably chains N+1.
  const next = chunks.findIndex((_chunk, chunkIndex) => !done.has(chunkIndex));
  if (next >= 0) {
    await assertSnapshotCanContinue(job, deps);
    await deps.enqueue.chunk({
      ...refOf(job), pass: INITIAL_PASS, chunkIndex: next,
      releaseIds: chunks[next]!, passChunkCount: chunks.length,
    });
  }
  deps.log?.('release chunks planned as a sequential chain', {
    snapshotId: job.snapshotId, chunks: chunks.length, queued: next >= 0 ? 1 : 0, completed: done.size,
  });
  // Nothing to do (empty catalogue, or a fully-resumed run) → go straight to reconciliation.
  if (next < 0) await deps.enqueue.reconcile({ ...refOf(job), pass: INITIAL_PASS });
  return { chunks: chunks.length, skipped: done.size };
}

/**
 * 3. Extract one chunk under the per-connection lock. Checkpoints as it goes, so a crash
 *    resumes from the last checkpoint rather than restarting the catalogue.
 */
export async function extractDistroKidReleaseChunk(
  job: ReleaseChunkJob,
  deps: PipelineDeps,
): Promise<{ completed: number; failed: number; deferred?: boolean; stopped?: boolean }> {
  if (await resumeTerminalFinalizer(job, deps)) return { completed: 0, failed: 0, stopped: true };
  assertPipelineDeadline(job, deps);
  const started = deps.now?.() ?? Date.now();
  const lock = await deps.acquireLock(job);
  if (!lock) {
    // Another worker owns this account: requeue rather than hammer the same session.
    //
    // Sequential chaining prevents same-snapshot siblings from contending. A different snapshot
    // for the account can still own the lock, so requeue under a fresh id and let the immutable
    // wall-clock deadline bound deferral instead of a fixed large-catalogue retry count.
    const deferAttempt = (job.deferAttempt ?? 0) + 1;
    if (!job.deadlineAt && deferAttempt > MAX_CHUNK_DEFERS) {
      // Give up loudly instead of deferring for eternity: a lock this persistent means a stuck
      // holder, and a terminal failure is retryable by the operator. Silence is not.
      deps.log?.('chunk abandoned, account lock held across every defer', { snapshotId: job.snapshotId, chunkIndex: job.chunkIndex, deferAttempt });
      throw new Error(`chunk ${job.chunkIndex} could not acquire the account lock after ${MAX_CHUNK_DEFERS} attempts`);
    }
    const delayMs = backoffWithJitter(deferAttempt, 500, 30_000);
    const deadline = deadlineMs(job, deps);
    if (deadline !== null && pipelineNow(deps) + delayMs >= deadline) {
      throw new PipelineDeadlineExceededError('account lock cannot be reacquired before the catalogue-read deadline');
    }
    deps.log?.('chunk deferred, connection lock held', { snapshotId: job.snapshotId, chunkIndex: job.chunkIndex, deferAttempt, delayMs });
    await deps.enqueue.chunk({ ...job, deferAttempt }, { delayMs });
    return { completed: 0, failed: 0, deferred: true };
  }
  try {
    return await underAccountLock(job, deps, lock, async (control) => {
    const index = await deps.store.getIndex(job.snapshotId);
    const byId = new Map(index.map((r) => [r.releaseId, r]));
    const refs = job.releaseIds.map((id) => byId.get(id)).filter((r): r is ReleaseRefRecord => !!r);

    // A fully complete release is an idempotent no-op. A COMPLETED release with extractor-owned
    // field gaps is deliberately NOT skipped: retry passes target exactly those releases.
    const existing = new Map((await deps.store.getOutcomes(job.snapshotId)).map((outcome) => [outcomeReleaseId(outcome), outcome]));
    const todo = refs.filter((ref) => {
      const prior = existing.get(ref.releaseId);
      return prior?.kind !== 'COMPLETED' || releaseNeedsMetadataRetry(prior.release);
    });
    const converge = (batch: ReleaseExtractionOutcome[]): ReleaseExtractionOutcome[] => batch.map((incoming) => {
      const releaseId = outcomeReleaseId(incoming);
      const merged = convergeReleaseRetryOutcome(existing.get(releaseId), incoming);
      existing.set(releaseId, merged);
      return merged;
    });

    const extractedOutcomes = await deps.extractChunk(job, todo, async (batch) => {
      await control.assertCanContinue();
      await deps.store.putOutcomes(job.snapshotId, converge(batch));
    }, control);
    // Work is checkpointed, so a re-run resumes rather than repeats. But we must not mark the
    // chunk complete or reconcile off a run we no longer had the right to be doing.
    await control.assertCanContinue();
    const pass = job.pass ?? INITIAL_PASS;
    const outcomes = converge(extractedOutcomes);
    await deps.store.putOutcomes(job.snapshotId, outcomes);
    await control.assertCanContinue();
    await deps.store.markChunkComplete(job.snapshotId, pass, job.chunkIndex);

    const completed = outcomes.filter((o) => o.kind === 'COMPLETED').length;
    const failed = outcomes.filter((o) => o.kind === 'FAILED').length;
    deps.metrics?.releasesCompleted(completed, job);
    deps.metrics?.releasesFailed(failed, job);
    deps.metrics?.chunkDuration((deps.now?.() ?? Date.now()) - started, job);

    const doneChunks = await deps.store.completedChunks(job.snapshotId, pass);
    const progress = await deps.store.getProgress(job.snapshotId);
    if (progress) {
      const all = await deps.store.getOutcomes(job.snapshotId);
      await control.assertCanContinue();
      await deps.store.putProgress({
        ...progress,
        completedReleases: all.filter((o) => o.kind === 'COMPLETED').length,
        failedReleases: all.filter((o) => o.kind === 'FAILED').length,
        completedChunks: doneChunks,
        updatedAt: nowIso(),
      });
    }

    const plan = await deps.store.getPassPlan(job.snapshotId, pass);
    if (plan) {
      const completedSet = new Set(doneChunks);
      const next = plan.findIndex((_chunk, chunkIndex) => !completedSet.has(chunkIndex));
      await control.assertCanContinue();
      if (next >= 0) {
        await deps.enqueue.chunk({
          ...refOf(job), pass, chunkIndex: next, releaseIds: plan[next]!, passChunkCount: plan.length,
        }, { delayMs: DISTROKID_REQUEST_MIN_DELAY_MS });
      } else {
        await deps.enqueue.reconcile({ ...refOf(job), pass });
      }
    } else {
      // Rolling-upgrade compatibility for jobs fanned out before durable pass plans existed.
      const expectedForPass = job.passChunkCount ?? progress?.chunkCount ?? 0;
      if (expectedForPass > 0 && doneChunks.length >= expectedForPass) {
        await control.assertCanContinue();
        await deps.enqueue.reconcile({ ...refOf(job), pass });
      }
    }
    return { completed, failed };
    });
  } catch (error) {
    if (error instanceof SnapshotStoppedError) return { completed: 0, failed: 0, stopped: true };
    throw error;
  }
}

/**
 * The account lock expired or was taken while we were mid-chunk.
 *
 * Thrown rather than swallowed so BullMQ retries the chunk: work already checkpointed is kept, and
 * the retry re-acquires the lock properly. Continuing without the lock would mean two workers
 * reading one distributor account at once.
 */
export class LockLostError extends Error {
  constructor(reason: string) {
    super(`account lock lost mid-chunk: ${reason}`);
    this.name = 'LockLostError';
  }
}

/** 4. Retry FAILED releases only, never the whole catalogue. */
export async function retryFailedDistroKidReleases(
  job: RetryFailedJob,
  deps: PipelineDeps,
): Promise<{ retried: number; stopped?: boolean }> {
  if (await resumeTerminalFinalizer(job, deps)) return { retried: 0, stopped: true };
  assertPipelineDeadline(job, deps);
  const pass = job.attempt;
  const index = await deps.store.getIndex(job.snapshotId);
  const outcomes = await deps.store.getOutcomes(job.snapshotId);
  const ids = retryableReleaseIds({ expectedReleaseIds: index.map((r) => r.releaseId), outcomes });
  if (ids.length === 0 || pass > DISTROKID_MAX_ATTEMPTS) {
    // Nothing left to retry (or budget spent) → reconcile THIS pass to a terminal verdict. The
    // pass makes the id unique, so this reconciliation actually runs instead of colliding with
    // the previous pass's completed job and being dropped.
    await assertSnapshotCanContinue(job, deps);
    await deps.enqueue.reconcile({ ...refOf(job), pass });
    return { retried: 0 };
  }
  const size = Number(process.env.DISTROKID_RELEASE_CHUNK_SIZE) || DISTROKID_RELEASE_CHUNK_SIZE;
  let plan = await deps.store.getPassPlan(job.snapshotId, pass);
  if (!plan) {
    plan = chunkReleases(ids, size);
    await assertSnapshotCanContinue(job, deps);
    await deps.store.putPassPlan(job.snapshotId, pass, plan);
  }
  const done = new Set(await deps.store.completedChunks(job.snapshotId, pass));
  const next = plan.findIndex((_chunk, chunkIndex) => !done.has(chunkIndex));
  await assertSnapshotCanContinue(job, deps);
  if (next >= 0) {
    await deps.enqueue.chunk({
      ...refOf(job), pass, chunkIndex: next, passChunkCount: plan.length, releaseIds: plan[next]!,
    });
  } else {
    await deps.enqueue.reconcile({ ...refOf(job), pass });
  }
  const chunkCount = plan.length;
  deps.log?.('retrying failed releases only', { snapshotId: job.snapshotId, pass, releases: ids.length, chunks: chunkCount, hasSession: !!job.steelSessionId });
  return { retried: ids.length };
}

/** 5. Reconcile index vs results. A snapshot is only complete when every release is terminal. */
export async function reconcileDistroKidSnapshot(
  job: ReconcileJob,
  deps: PipelineDeps,
): Promise<{ status: SnapshotStatus; completeness: ExtractionCompleteness; stopped?: boolean }> {
  await bindCheckpoint(job, deps);
  const prior = await deps.store.getTerminal(job.snapshotId);
  if (prior) {
    if (prior.kind === 'TERMINAL') {
      await deps.enqueue.finalize(prior.finalizeJob);
      return { status: prior.finalizeJob.status, completeness: prior.finalizeJob.completeness, stopped: true };
    }
    const index = await deps.store.getIndex(job.snapshotId);
    const outcomes = await deps.store.getOutcomes(job.snapshotId);
    const observed = reconcileCheckpoint(index, outcomes);
    return { ...observed, stopped: true };
  }
  assertPipelineDeadline(job, deps);
  // The pass comes from the JOB. It used to be a default parameter (`attempt = 1`) that the queue
  // worker had no way to supply, so every reconciliation across a queue hop believed it was pass 1
  // and re-enqueued retry pass 2, forever. That infinite loop was masked only by the id collision
  // that silently discarded the repeat, turning two bugs into one permanent hang.
  const pass = job.pass ?? INITIAL_PASS;
  const index = await deps.store.getIndex(job.snapshotId);
  const outcomes = await deps.store.getOutcomes(job.snapshotId);
  const { completeness, status } = reconcileCheckpoint(index, outcomes);
  deps.log?.(`reconciled: ${describeCompleteness(completeness, status)}`, { snapshotId: job.snapshotId, pass });

  // Retryable gaps → one more targeted pass (failed releases only), bounded by MAX_ATTEMPTS.
  if (status === 'PARTIAL_RETRYABLE' && pass < DISTROKID_MAX_ATTEMPTS) {
    await assertSnapshotCanContinue(job, deps);
    await deps.enqueue.retry({ ...refOf(job), attempt: pass + 1 });
    return { status, completeness };
  }
  // Terminal for this pass. The pass rides along so finalize's id is unique per pass too.
  const proposed: FinalizeJob = { ...refOf(job), status, completeness, pass };
  const winning = await deps.store.claimTerminal(job.snapshotId, {
    kind: 'TERMINAL', finalizeJob: proposed, createdAt: nowIso(), reason: 'reconciled',
  });
  if (winning.kind === 'TERMINAL') {
    await deps.enqueue.finalize(winning.finalizeJob);
    return {
      status: winning.finalizeJob.status,
      completeness: winning.finalizeJob.completeness,
      ...(winning.finalizeJob.status !== status ? { stopped: true } : {}),
    };
  }
  const observed = reconcileCheckpoint(index, outcomes);
  return { ...observed, stopped: true };
}

/** Convert a fatal/exhausted stage into one immutable FAILED finalizer. */
export async function terminalizeDistroKidFailure(
  job: SnapshotRef,
  stage: string,
  error: Error,
  deps: PipelineDeps,
): Promise<SnapshotTerminalTombstone> {
  await bindCheckpoint(job, deps);
  const index = await deps.store.getIndex(job.snapshotId);
  const outcomes = await deps.store.getOutcomes(job.snapshotId);
  const { completeness } = reconcileCheckpoint(index, outcomes);
  const failureCode = classifyDistroKidTerminalFailure(stage, error);
  const terminalCompleteness: ExtractionCompleteness = {
    ...completeness,
    failureReasons: {
      ...completeness.failureReasons,
      [failureCode]: (completeness.failureReasons[failureCode] ?? 0) + 1,
    },
  };
  const finalJob: FinalizeJob = {
    ...refOf(job), status: 'FAILED', completeness: terminalCompleteness,
    pass: 'pass' in job && typeof job.pass === 'number' ? job.pass : INITIAL_PASS,
  };
  const winning = await deps.store.claimTerminal(job.snapshotId, {
    kind: 'TERMINAL', finalizeJob: finalJob, createdAt: nowIso(), reason: `${stage}:${failureCode}`,
  });
  if (winning.kind === 'TERMINAL') {
    if (winning.finalizeJob.status === 'FAILED') await deps.terminalFailure?.(job, stage, error);
    await deps.enqueue.finalize(winning.finalizeJob);
  }
  return winning;
}

/** Durable cancellation hook for operators/coordinators; every stage observes the tombstone. */
export async function cancelDistroKidSnapshot(
  job: SnapshotRef,
  deps: Pick<PipelineDeps, 'store'>,
  reason: string,
): Promise<SnapshotTerminalTombstone> {
  await bindCheckpoint(job, deps);
  return deps.store.claimTerminal(job.snapshotId, { kind: 'CANCELLED', createdAt: nowIso(), reason });
}

/** 6. Persist the snapshot with its terminal status. */
export async function finalizeDistroKidSnapshot(job: FinalizeJob, deps: PipelineDeps): Promise<void> {
  await bindCheckpoint(job, deps);
  const winning = await deps.store.claimTerminal(job.snapshotId, {
    kind: 'TERMINAL', finalizeJob: job, createdAt: nowIso(), reason: 'legacy-finalizer',
  });
  if (winning.kind === 'CANCELLED') return;
  const finalJob = winning.finalizeJob;
  const progress = await deps.store.getProgress(finalJob.snapshotId);
  const alreadyPersisted = Boolean(
    progress
    && progress.tenantId === finalJob.tenantId
    && progress.connectionId === finalJob.connectionId
    && progress.distributor === finalJob.distributor
    && progress.status === finalJob.status
    && progress.expectedReleases === finalJob.completeness.expectedReleases
    && progress.completedReleases === finalJob.completeness.completedReleases
    && progress.failedReleases === finalJob.completeness.failedReleases,
  );

  if (!alreadyPersisted) {
    const outcomes = await deps.store.getOutcomes(finalJob.snapshotId);
    await deps.persistSnapshot(finalJob, outcomes);
    // A snapshot must ALWAYS end with a recorded terminal status, upsert rather than skip, so a
    // missing progress row can never leave a finished snapshot looking like it's still running.
    // This checkpoint is deliberately written BEFORE releasing the remote session. If release
    // fails, BullMQ can retry just that cleanup without re-projecting the customer-facing record.
    await deps.store.putProgress({
      ...(progress ?? {}),
      snapshotId: finalJob.snapshotId, tenantId: finalJob.tenantId, connectionId: finalJob.connectionId, distributor: finalJob.distributor,
      expectedReleases: finalJob.completeness.expectedReleases,
      completedReleases: finalJob.completeness.completedReleases,
      failedReleases: finalJob.completeness.failedReleases,
      chunkCount: progress?.chunkCount ?? 0,
      completedChunks: progress?.completedChunks ?? [],
      startedAt: progress?.startedAt ?? nowIso(),
      status: finalJob.status,
      updatedAt: nowIso(),
    });
    deps.metrics?.snapshotStatus(finalJob.status, finalJob);
    deps.log?.(`snapshot finalized: ${describeCompleteness(finalJob.completeness, finalJob.status)}`, { snapshotId: finalJob.snapshotId });
  } else {
    deps.log?.('snapshot projection already durable; retrying terminal cleanup only', { snapshotId: finalJob.snapshotId });
  }

  // Cleanup remains retryable, but cannot roll back or repeat the durable terminal projection.
  await deps.releaseSession?.(finalJob);
}

/** Split a list into release chunks (exported for planning/tests). */
export function chunkReleases<T>(items: T[], size = DISTROKID_RELEASE_CHUNK_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i * size < items.length; i++) out.push(items.slice(i * size, (i + 1) * size));
  return out;
}
