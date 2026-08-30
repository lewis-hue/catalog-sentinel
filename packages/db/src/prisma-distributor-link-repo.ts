import { randomUUID } from 'node:crypto';
import type { TenantContext, TenantEntity, TenantStore } from './tenant-repo';
import { CrossTenantError } from './tenant-repo';
import type {
  DistributorLinkRepository,
  ClaimConsentRevocationOptions,
  ClaimedConsentRevocationIntent,
  ConsentRevocationActor,
  ConsentRevocationIntent,
  ConsentRevocationWrite,
  LinkConnection,
  LinkConsent,
  LinkDeepScan,
  LinkSession,
  LinkStateRef,
} from './distributor-link-repo';

/**
 * Narrow shape of the Prisma `DistributorLinkRecord` delegate. Typed by hand so
 * this file compiles WITHOUT the generated `@prisma/client` (keeps CI/typecheck
 * green before `db:generate`). At runtime `prismaClient.distributorLinkRecord`
 * structurally satisfies it.
 */
export interface LinkRecordRow {
  id: string;
  userId: string;
  kind: string;
  dataJson: unknown;
}

export interface LinkRecordDelegate {
  findFirst(args: { where: { id: string; userId: string; kind: string } }): Promise<LinkRecordRow | null>;
  upsert(args: {
    where: { id: string };
    create: { id: string; userId: string; kind: string; dataJson: unknown };
    update: { dataJson: unknown };
  }): Promise<LinkRecordRow>;
  delete(args: { where: { id: string } }): Promise<unknown>;
  deleteMany(args: { where: { userId: string; kind?: string } }): Promise<{ count: number }>;
}

/**
 * Postgres-backed, per-user store. Every query filters by the owning subject
 * (the `userId` column; the TS context still calls the value `tenantId`, which now
 * carries that subject), so a caller can never read/write another user's rows, the
 * same guarantee the isolated-test adapter gives, now durable. Records are stored
 * per-kind in the `DistributorLinkRecord` operational table (JSON payload). The rich
 * normalized catalog models (DistributorRelease/Track/…) are written by the
 * normalization job and read separately.
 */
export class PrismaTenantStore<T extends TenantEntity> implements TenantStore<T> {
  constructor(
    private readonly delegate: LinkRecordDelegate,
    private readonly kind: string,
  ) {}

  async put(ctx: TenantContext, item: T): Promise<T> {
    if (item.tenantId !== ctx.tenantId) {
      throw new CrossTenantError(`Refusing to write ${this.kind} for tenant ${item.tenantId} under context ${ctx.tenantId}.`);
    }
    await this.delegate.upsert({
      where: { id: item.id },
      create: { id: item.id, userId: ctx.tenantId, kind: this.kind, dataJson: item },
      update: { dataJson: item },
    });
    return item;
  }

  async get(ctx: TenantContext, id: string): Promise<T | null> {
    const row = await this.delegate.findFirst({ where: { id, userId: ctx.tenantId, kind: this.kind } });
    return row ? (row.dataJson as T) : null;
  }

  async update(ctx: TenantContext, id: string, patch: Partial<T>): Promise<T | null> {
    const cur = await this.get(ctx, id);
    if (!cur) return null;
    const next = { ...cur, ...patch, id: cur.id, tenantId: cur.tenantId };
    await this.delegate.upsert({
      where: { id },
      create: { id, userId: ctx.tenantId, kind: this.kind, dataJson: next },
      update: { dataJson: next },
    });
    return next;
  }

  async delete(ctx: TenantContext, id: string): Promise<boolean> {
    const cur = await this.get(ctx, id);
    if (!cur) return false;
    await this.delegate.delete({ where: { id } });
    return true;
  }

  async deleteAllForTenant(tenantId: string): Promise<number> {
    const res = await this.delegate.deleteMany({ where: { userId: tenantId, kind: this.kind } });
    return res.count;
  }
}

/** A Prisma client exposing at least the DistributorLinkRecord delegate. */
export interface PrismaLinkClient {
  distributorLinkRecord: LinkRecordDelegate;
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
  $disconnect?(): Promise<void>;
}

interface RevocationIntentRow {
  id: string;
  userId: string;
  consentId: string;
  attempts: number;
  availableAt: Date | string;
  leaseToken: string | null;
  leaseExpiresAt: Date | string | null;
  lastError: string | null;
  completedAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
  consentJson?: unknown;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function nullableIso(value: Date | string | null): string | null {
  return value === null ? null : iso(value);
}

function mapRevocationIntent(row: RevocationIntentRow): ConsentRevocationIntent {
  return {
    id: row.id,
    tenantId: row.userId,
    consentId: row.consentId,
    attempts: row.attempts,
    availableAt: iso(row.availableAt),
    leaseToken: row.leaseToken,
    leaseExpiresAt: nullableIso(row.leaseExpiresAt),
    lastError: row.lastError,
    completedAt: nullableIso(row.completedAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export class PrismaDistributorLinkRepository implements DistributorLinkRepository {
  consents: TenantStore<LinkConsent>;
  sessions: TenantStore<LinkSession>;
  stateRefs: TenantStore<LinkStateRef>;
  connections: TenantStore<LinkConnection>;
  scans: TenantStore<LinkDeepScan>;

  constructor(private readonly client: PrismaLinkClient) {
    const d = client.distributorLinkRecord;
    this.consents = new PrismaTenantStore<LinkConsent>(d, 'consent');
    this.sessions = new PrismaTenantStore<LinkSession>(d, 'session');
    this.stateRefs = new PrismaTenantStore<LinkStateRef>(d, 'stateRef');
    this.connections = new PrismaTenantStore<LinkConnection>(d, 'connection');
    this.scans = new PrismaTenantStore<LinkDeepScan>(d, 'scan');
  }

  async revokeConsentAndCreateIntent(
    ctx: TenantContext,
    consentId: string,
    revokedAt: string,
    actor: ConsentRevocationActor,
  ): Promise<ConsentRevocationWrite | null> {
    const intentId = `consent-revoke-${randomUUID()}`;
    // One statement is the transaction boundary: either the JSON consent is revoked AND the
    // durable cleanup intent exists, or neither change commits. Repeated revocations reuse the
    // unique tenant/consent intent and never reopen a completed cleanup.
    const rows = await this.client.$queryRawUnsafe<RevocationIntentRow[]>(`
      WITH revoked AS (
        UPDATE "DistributorLinkRecord"
        SET "dataJson" = CASE
              WHEN NULLIF("dataJson"->>'revokedAt', '') IS NULL
                THEN jsonb_set("dataJson"::jsonb, '{revokedAt}', to_jsonb($3::text), true)
              ELSE "dataJson"::jsonb
            END,
            "updatedAt" = clock_timestamp()
        WHERE "id" = $1
          AND "userId" = $2
          AND "kind" = 'consent'
          AND ($5::boolean = true OR "dataJson"->>'grantedByUserId' = $6::text)
        RETURNING "dataJson"
      ), upserted AS (
        INSERT INTO "ConsentRevocationIntent" (
          "id", "userId", "consentId", "attempts",
          "availableAt", "leaseToken", "leaseExpiresAt", "lastError", "completedAt",
          "createdAt", "updatedAt"
        )
        SELECT $4, $2, $1, 0,
               clock_timestamp(), NULL, NULL, NULL, NULL, clock_timestamp(), clock_timestamp()
        FROM revoked
        ON CONFLICT ("userId", "consentId") DO UPDATE
          SET "updatedAt" = EXCLUDED."updatedAt"
        RETURNING *
      )
      SELECT upserted.*, revoked."dataJson" AS "consentJson"
      FROM upserted CROSS JOIN revoked
    `, consentId, ctx.tenantId, revokedAt, intentId, actor.allowTenantAdmin, actor.actorUserId);
    const row = rows[0];
    if (!row) return null;
    return {
      consent: row.consentJson as LinkConsent,
      intent: mapRevocationIntent(row),
    };
  }

  async getConsentRevocationIntent(ctx: TenantContext, consentId: string): Promise<ConsentRevocationIntent | null> {
    const rows = await this.client.$queryRawUnsafe<RevocationIntentRow[]>(`
      SELECT *
      FROM "ConsentRevocationIntent"
      WHERE "userId" = $1 AND "consentId" = $2
      LIMIT 1
    `, ctx.tenantId, consentId);
    return rows[0] ? mapRevocationIntent(rows[0]) : null;
  }

  async claimConsentRevocationIntents(options: ClaimConsentRevocationOptions): Promise<ClaimedConsentRevocationIntent[]> {
    const leaseToken = randomUUID();
    const rows = await this.client.$queryRawUnsafe<RevocationIntentRow[]>(`
      WITH due AS (
        SELECT "id"
        FROM "ConsentRevocationIntent"
        WHERE "completedAt" IS NULL
          AND "availableAt" <= clock_timestamp()
          AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" <= clock_timestamp())
          AND ($4::text IS NULL OR "id" = $4::text)
        ORDER BY "availableAt" ASC, "createdAt" ASC, "id" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT $1
      )
      UPDATE "ConsentRevocationIntent" AS intent
      SET "leaseToken" = $3,
          "leaseExpiresAt" = clock_timestamp() + ($2::double precision * INTERVAL '1 millisecond'),
          "attempts" = intent."attempts" + 1,
          "updatedAt" = clock_timestamp()
      FROM due
      WHERE intent."id" = due."id"
      RETURNING intent.*
    `, Math.max(0, Math.floor(options.limit)), Math.max(1, options.leaseMs), leaseToken, options.intentId ?? null);
    return rows.map((row) => mapRevocationIntent(row) as ClaimedConsentRevocationIntent);
  }

  async completeConsentRevocationIntent(intentId: string, leaseToken: string, _completedAt: string): Promise<boolean> {
    const changed = await this.client.$executeRawUnsafe(`
      UPDATE "ConsentRevocationIntent"
      SET "completedAt" = clock_timestamp(),
          "leaseToken" = NULL,
          "leaseExpiresAt" = NULL,
          "lastError" = NULL,
          "updatedAt" = clock_timestamp()
      WHERE "id" = $1
        AND "leaseToken" = $2
        AND "completedAt" IS NULL
    `, intentId, leaseToken);
    return changed === 1;
  }

  async retryConsentRevocationIntent(
    intentId: string,
    leaseToken: string,
    retryAfterMs: number,
    lastError: string,
  ): Promise<boolean> {
    const changed = await this.client.$executeRawUnsafe(`
      UPDATE "ConsentRevocationIntent"
      SET "availableAt" = clock_timestamp() + ($3::double precision * INTERVAL '1 millisecond'),
          "leaseToken" = NULL,
          "leaseExpiresAt" = NULL,
          "lastError" = $4,
          "updatedAt" = clock_timestamp()
      WHERE "id" = $1
        AND "leaseToken" = $2
        AND "completedAt" IS NULL
    `, intentId, leaseToken, Math.max(0, retryAfterMs), lastError.slice(0, 2_048));
    return changed === 1;
  }

  async deleteTenant(tenantId: string): Promise<void> {
    await this.client.$executeRawUnsafe(
      'DELETE FROM "ConsentRevocationIntent" WHERE "userId" = $1',
      tenantId,
    );
    await this.client.distributorLinkRecord.deleteMany({ where: { userId: tenantId } });
  }

  async close(): Promise<void> {
    await this.client.$disconnect?.();
  }
}
