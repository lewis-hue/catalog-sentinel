/**
 * In-process job queue with a BullMQ-shaped surface. Every job is idempotent
 * (dedup by idempotency key), retryable (bounded attempts + backoff), and
 * observable (structured log lines). In production this is swapped for BullMQ on
 * Redis (or Temporal) behind the same `enqueue` contract — see docs/runbook.md.
 */
export interface JobContext {
  attempt: number;
  jobName: string;
  log: (message: string, extra?: Record<string, unknown>) => void;
}

export interface JobDefinition<TData = unknown, TResult = unknown> {
  name: string;
  maxAttempts?: number;
  handler: (data: TData, ctx: JobContext) => Promise<TResult>;
}

export interface EnqueueOptions {
  idempotencyKey?: string;
  maxAttempts?: number;
}

export interface JobRunRecord {
  jobName: string;
  status: 'succeeded' | 'failed' | 'skipped';
  attempts: number;
  idempotencyKey?: string;
  error?: string;
}

export class InProcessJobQueue {
  private readonly defs = new Map<string, JobDefinition>();
  private readonly completed = new Map<string, unknown>(); // idempotencyKey -> result
  readonly history: JobRunRecord[] = [];

  constructor(private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))) {}

  register<TData, TResult>(def: JobDefinition<TData, TResult>): void {
    this.defs.set(def.name, def as JobDefinition);
  }

  registered(): string[] {
    return [...this.defs.keys()];
  }

  /** Enqueue + run a job to completion. Returns the handler result (or cached). */
  async enqueue<TResult = unknown>(name: string, data: unknown, opts: EnqueueOptions = {}): Promise<TResult> {
    const def = this.defs.get(name);
    if (!def) throw new Error(`No job registered: ${name}`);

    if (opts.idempotencyKey && this.completed.has(opts.idempotencyKey)) {
      this.history.push({ jobName: name, status: 'skipped', attempts: 0, idempotencyKey: opts.idempotencyKey });
      return this.completed.get(opts.idempotencyKey) as TResult;
    }

    const maxAttempts = opts.maxAttempts ?? def.maxAttempts ?? 3;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const ctx: JobContext = {
        attempt,
        jobName: name,
        log: (message, extra) =>
          console.log(JSON.stringify({ level: 'info', job: name, attempt, message, ...extra })),
      };
      try {
        const result = await def.handler(data, ctx);
        if (opts.idempotencyKey) this.completed.set(opts.idempotencyKey, result);
        this.history.push({ jobName: name, status: 'succeeded', attempts: attempt, idempotencyKey: opts.idempotencyKey });
        return result as TResult;
      } catch (err) {
        lastError = err;
        if (attempt < maxAttempts) await this.sleep(2 ** (attempt - 1) * 50);
      }
    }
    this.history.push({
      jobName: name,
      status: 'failed',
      attempts: maxAttempts,
      idempotencyKey: opts.idempotencyKey,
      error: lastError instanceof Error ? lastError.message : String(lastError),
    });
    throw lastError;
  }
}
