import { z } from 'zod';

/**
 * DistroKid extraction pipeline — the CROSS-APPLICATION contract.
 *
 * These types used to live in `apps/worker`, which forced the API to import the worker
 * application (and transitively Playwright) just to enqueue a job. An audit correctly called that
 * out as the wrong dependency direction: applications must not import other applications.
 *
 * This package therefore owns the wire format and nothing else — no queue driver, no browser, no
 * database. The producer (API) and the consumer (worker) both depend on it, and on each other
 * not at all.
 *
 * Everything here is versioned by `SCHEMA_VERSION`: a job enqueued by an old API replica must
 * still be readable by a new worker during a rolling deploy.
 */

export const DISTROKID_JOB_SCHEMA_VERSION = 2;

/** Queue names. Shared so a producer can never enqueue onto a queue no consumer reads. */
export const DK_QUEUES = {
  index: 'distrokid-catalog-index',
  plan: 'distrokid-plan-chunks',
  chunk: 'distrokid-release-chunk',
  retry: 'distrokid-retry-failed',
  reconcile: 'distrokid-reconcile',
  finalize: 'distrokid-finalize',
} as const;

export type DkQueueName = (typeof DK_QUEUES)[keyof typeof DK_QUEUES];
export const DK_QUEUE_NAMES: readonly DkQueueName[] = Object.values(DK_QUEUES);

export const DISTROKID_RELEASE_CHUNK_SIZE = 20;
export const DISTROKID_PER_ACCOUNT_CONCURRENCY = 1;
export const DISTROKID_REQUEST_MIN_DELAY_MS = 750;
export const DISTROKID_MAX_ATTEMPTS = 3;
/** Checkpoint cadence inside a chunk (also the Postgres write batch size). */
export const CHECKPOINT_EVERY = 10;
/** Leave enough of the provider lease for terminal persistence and an explicit Steel release. */
export const DISTROKID_SESSION_CLEANUP_GRACE_MS = 60_000;

// ---------------------------------------------------------------------------
// Job payloads
// ---------------------------------------------------------------------------

/**
 * `steelSessionId` is the envelope-encrypted remote id of the user's ALREADY-AUTHENTICATED
 * Steel session, handed off by the API after an attended login. It travels with the job so any
 * worker holding the deployment encryption key can re-attach without a side-channel lookup and
 * without forcing a re-login. Plaintext ids are accepted only by development/test workers for
 * fixture and rolling-upgrade compatibility.
 *
 * It is a session HANDLE, not a credential: the Steel API key stays server-side, and no password
 * or 2FA code is ever collected, transported or stored.
 */
export const snapshotRefSchema = z.object({
  tenantId: z.string().min(1),
  connectionId: z.string().min(1),
  snapshotId: z.string().min(1),
  distributor: z.string().min(1),
  /** Durable consent binding. Optional only for rolling-upgrade compatibility; production
   * workers reject browser work that arrives without it. */
  consentId: z.string().min(1).optional(),
  artistWorkspaceId: z.string().min(1).optional(),
  steelSessionId: z.string().min(1).optional(),
  /** The provider's actual immutable expiry, captured when Steel created the session. */
  sessionExpiresAt: z.string().datetime({ offset: true }).optional(),
  /** Wall-clock budget for the whole snapshot. Every stage carries and enforces this value. */
  deadlineAt: z.string().datetime({ offset: true }).optional(),
  schemaVersion: z.number().int().positive().optional(),
});

/**
 * The extraction PASS a job belongs to. Pass 1 is the initial sweep; pass N>1 is the Nth
 * retry-failed-only sweep.
 *
 * This is not bookkeeping — it is part of every job id from the chunk stage onward. Without it,
 * the second reconciliation re-used the first one's id; BullMQ retains completed jobs
 * (`removeOnComplete: 500`) and treats a colliding add as the existing job, so the retry pass's
 * reconciliation silently never ran and the snapshot never finalized.
 *
 * It also has to travel ON THE JOB. It was previously a default function parameter
 * (`reconcile(job, deps, attempt = 1)`), which the queue worker could not supply — so every
 * reconciliation believed it was pass 1 and re-enqueued retry pass 2 forever. That infinite loop
 * was invisible only because the id collision above discarded the repeat.
 */
const passField = z.number().int().positive().optional();

export const catalogIndexJobSchema = snapshotRefSchema.extend({
  artists: z.array(z.string().min(1)).min(1),
});
export const planChunksJobSchema = snapshotRefSchema.extend({ chunkSize: z.number().int().positive().optional() });
export const releaseChunkJobSchema = snapshotRefSchema.extend({
  chunkIndex: z.number().int().nonnegative(),
  releaseIds: z.array(z.string().min(1)),
  pass: passField,
  /** How many chunks this pass enqueued — lets the LAST chunk of the pass trigger its reconcile
   *  without racing the others. */
  passChunkCount: z.number().int().nonnegative().optional(),
  /**
   * How many times this chunk has been deferred because another worker held the account lock.
   *
   * It is part of the JOB ID. Without it, a deferred chunk re-enqueues under the id of the job
   * currently running, BullMQ treats it as a duplicate, and the chunk is dropped — silently, and
   * forever. With per-account concurrency of 1 that stranded every chunk after the first, so any
   * catalogue over one chunk could never finish.
   */
  deferAttempt: z.number().int().nonnegative().optional(),
});
export const retryFailedJobSchema = snapshotRefSchema.extend({ attempt: z.number().int().nonnegative() });
export const reconcileJobSchema = snapshotRefSchema.extend({ pass: passField });

export type SnapshotRef = z.infer<typeof snapshotRefSchema>;
export type CatalogIndexJob = z.infer<typeof catalogIndexJobSchema>;
export type PlanChunksJob = z.infer<typeof planChunksJobSchema>;
export type ReleaseChunkJob = z.infer<typeof releaseChunkJobSchema>;
export type RetryFailedJob = z.infer<typeof retryFailedJobSchema>;
export type ReconcileJob = z.infer<typeof reconcileJobSchema>;

// ---------------------------------------------------------------------------
// Completeness — the finalize payload's shape
// ---------------------------------------------------------------------------

/**
 * Coverage is reported PER IDENTIFIER LEVEL because UPC/artwork are release-level while ISRC is
 * track-level. A single blended "metadata coverage" number is what let 46/107 ISRCs read as
 * success once already.
 */
export interface ExtractionCompleteness {
  expectedReleases: number;
  attemptedReleases: number;
  completedReleases: number;
  failedReleases: number;
  skippedReleases: number;

  /** Whether `expectedTracks` came from an independent authoritative count. When false,
   * `expectedTracks` is only the observed track count and must not be presented as proof that
   * every track was extracted. */
  expectedTracksKnown: boolean;
  expectedTracks: number;
  extractedTracks: number;

  // Release-level coverage
  releasesWithUpc: number;
  releasesWithArtwork: number;
  // Track-level coverage
  tracksWithIsrc: number;
  tracksWithDistributorId: number;

  /** Absent because the distributor genuinely has no value (not our failure). */
  releasesUpcAbsentAtSource: number;
  tracksIsrcAbsentAtSource: number;
  /** Absent because OUR extraction failed — retryable, and must never read as "missing". */
  releasesUpcNotCaptured: number;
  tracksIsrcNotCaptured: number;

  unresolvedReleaseIds: string[];
  failureReasons: Record<string, number>;
}

export type SnapshotStatus =
  | 'COMPLETE'
  | 'COMPLETE_WITH_SOURCE_GAPS'
  | 'PARTIAL_RETRYABLE'
  | 'PARTIAL_REAUTH_REQUIRED'
  | 'FAILED_SCHEMA_CHANGED'
  | 'FAILED';

export const SNAPSHOT_STATUSES: readonly SnapshotStatus[] = [
  'COMPLETE', 'COMPLETE_WITH_SOURCE_GAPS', 'PARTIAL_RETRYABLE',
  'PARTIAL_REAUTH_REQUIRED', 'FAILED_SCHEMA_CHANGED', 'FAILED',
];

type ExtractionCompletenessWireInput = Omit<ExtractionCompleteness, 'expectedTracksKnown'> & {
  /** Optional only at the wire edge so old queued jobs remain readable during a rolling deploy. */
  expectedTracksKnown?: boolean;
};

const completenessSchema: z.ZodType<
  ExtractionCompleteness,
  z.ZodTypeDef,
  ExtractionCompletenessWireInput
> = z.object({
  expectedReleases: z.number(), attemptedReleases: z.number(), completedReleases: z.number(),
  failedReleases: z.number(), skippedReleases: z.number(),
  // Old API/worker replicas did not send this field. Defaulting to false is the conservative
  // rolling-deploy interpretation: an omitted expectation was never independently proven.
  expectedTracksKnown: z.boolean().optional().default(false),
  expectedTracks: z.number(), extractedTracks: z.number(),
  releasesWithUpc: z.number(), releasesWithArtwork: z.number(),
  tracksWithIsrc: z.number(), tracksWithDistributorId: z.number(),
  releasesUpcAbsentAtSource: z.number(), tracksIsrcAbsentAtSource: z.number(),
  releasesUpcNotCaptured: z.number(), tracksIsrcNotCaptured: z.number(),
  unresolvedReleaseIds: z.array(z.string()),
  failureReasons: z.record(z.number()),
});

export const finalizeJobSchema = snapshotRefSchema.extend({
  status: z.enum(['COMPLETE', 'COMPLETE_WITH_SOURCE_GAPS', 'PARTIAL_RETRYABLE', 'PARTIAL_REAUTH_REQUIRED', 'FAILED_SCHEMA_CHANGED', 'FAILED']),
  completeness: completenessSchema,
  /** The pass that produced this terminal verdict — part of the job id for the same reason as
   *  reconcile: a snapshot that reconciles twice must be able to finalize twice. */
  pass: passField,
});
export type FinalizeJob = z.infer<typeof finalizeJobSchema>;

// ---------------------------------------------------------------------------
// Idempotent job ids
// ---------------------------------------------------------------------------

/**
 * BullMQ REJECTS a custom job id containing ":" — it namespaces its own Redis keys with colons,
 * so a colon in the id would collide with its key structure ("Custom Id cannot contain :").
 *
 * These ids were previously colon-joined, which meant every enqueue threw and the pipeline could
 * not have processed a single job in production. Nothing caught it because every test dispatched
 * to the handlers through a fake queue and never asked BullMQ to accept an id.
 *
 * So: sanitize each segment, join with "__", and append a short deterministic hash of the ORIGINAL
 * segments. The hash keeps the id exact — without it, sanitizing "a:b" and "a-b" to the same
 * string would let two different accounts share a job id and silently deduplicate each other's
 * scans. Readable prefix for debugging, hash for correctness.
 */
const SEP = '__';
const safeSegment = (s: string): string => s.replace(/[^A-Za-z0-9_-]/g, '-');

/** FNV-1a (32-bit). Deterministic across processes and dependency-free — a contracts package
 *  must stay importable from anywhere, so no node:crypto. */
function shortHash(parts: readonly string[]): string {
  let h = 0x811c9dc5;
  for (const c of parts.join('\u0000')) {
    h ^= c.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).padStart(7, '0');
}

const buildId = (queue: string, segments: readonly string[]): string =>
  [queue, ...segments.map(safeSegment), shortHash(segments)].join(SEP);

/**
 * A duplicate delivery or a resumed run must be a no-op rather than a double extraction — the id
 * is derived from the work, never from a clock or a random value.
 */
export const jobIds = {
  index: (r: SnapshotRef): string => buildId(DK_QUEUES.index, [r.tenantId, r.connectionId, r.snapshotId]),
  plan: (r: SnapshotRef): string => buildId(DK_QUEUES.plan, [r.tenantId, r.connectionId, r.snapshotId]),
  // `pass` and `deferAttempt` both participate in the id.
  //  - `pass`, so a retry sweep's chunk 0 doesn't collide with the initial sweep's chunk 0.
  //  - `deferAttempt`, so a lock-deferred chunk gets a NEW id instead of colliding with the
  //    in-flight job and being discarded as a duplicate.
  // Extraction stays idempotent regardless: a re-run chunk skips releases already COMPLETED.
  chunk: (r: SnapshotRef, chunkIndex: number, deferAttempt = 0, pass = 1): string =>
    buildId(DK_QUEUES.chunk, [r.tenantId, r.connectionId, r.snapshotId, `p${pass}`, String(chunkIndex), ...(deferAttempt > 0 ? [`d${deferAttempt}`] : [])]),
  retry: (r: SnapshotRef, attempt: number): string => buildId(DK_QUEUES.retry, [r.tenantId, r.connectionId, r.snapshotId, String(attempt)]),
  // `pass` is REQUIRED for correctness here, not just tidiness: pass 2's reconciliation reused
  // pass 1's id, BullMQ returned the retained completed job instead of enqueuing, and the snapshot
  // hung forever without finalizing. Same for finalize.
  reconcile: (r: SnapshotRef, pass = 1): string => buildId(DK_QUEUES.reconcile, [r.tenantId, r.connectionId, r.snapshotId, `p${pass}`]),
  finalize: (r: SnapshotRef, pass = 1): string => buildId(DK_QUEUES.finalize, [r.tenantId, r.connectionId, r.snapshotId, `p${pass}`]),
};

/** BullMQ's constraint, asserted where it is cheap to check. */
export const isValidBullJobId = (id: string): boolean => !id.includes(':') && id.length > 0;

/**
 * Validate a job crossing the process boundary. A malformed payload must fail loudly at the edge
 * rather than half-run a catalogue read — and the error must never echo the payload back, since
 * jobs carry a session handle.
 */
export function parseJob<T>(schema: z.ZodType<T>, raw: unknown, queue: string): T {
  const res = schema.safeParse(raw);
  if (res.success) return res.data;
  const fields = res.error.issues.map((i) => i.path.join('.') || '(root)').join(', ');
  throw new InvalidJobPayloadError(queue, fields);
}

/** Names the invalid FIELDS, never their values (jobs carry a session handle). */
export class InvalidJobPayloadError extends Error {
  constructor(public readonly queue: string, public readonly fields: string) {
    super(`Invalid job payload on "${queue}": bad or missing field(s): ${fields}`);
    this.name = 'InvalidJobPayloadError';
  }
}
