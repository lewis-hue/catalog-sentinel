import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import type { GovernanceSqlPool } from './governance-types';
import { GovernanceAuthorizationError, GovernanceConflictError } from './governance-types';
import { PostgresOrganizationRepository } from './organization-repository';
import { PostgresAuditChainAppender, PostgresTenantAuditChainReader, verifyAuditChain } from './audit-chain';
import { PostgresRetentionRepository } from './retention';
import {
  PostgresTenantErasureRepository,
  PostgresTenantRowsErasureAdapter,
  PRODUCTION_TENANT_ERASURE_RESOURCES,
} from './tenant-erasure';

const databaseUrl = process.env.DATABASE_URL ?? process.env.DATABASE_TEST_URL;

describe.skipIf(!databaseUrl)('governance controls against real PostgreSQL', () => {
  let nativePool: { query(sql: string, values?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>; end(): Promise<void>; connect(): Promise<unknown> };
  let pool: GovernanceSqlPool;
  const suffix = randomUUID();
  const tenantId = `gov-tenant-${suffix}`;
  const otherTenantId = `gov-other-${suffix}`;
  const purgeTenantId = `gov-purge-${suffix}`;
  const workspaceId = `gov-workspace-${suffix}`;
  const personalSubject = `personal-${suffix}`;
  const owner = { tenantId, subjectId: `owner-${suffix}` };
  const invitedSubject = `member-${suffix}`;

  beforeAll(async () => {
    const pg = await import('pg' as string) as { default?: { Pool: new (config: { connectionString: string }) => typeof nativePool }; Pool?: new (config: { connectionString: string }) => typeof nativePool };
    const Pool = pg.Pool ?? pg.default?.Pool;
    if (!Pool) throw new Error('pg Pool is unavailable');
    nativePool = new Pool({ connectionString: databaseUrl! });
    pool = nativePool as unknown as GovernanceSqlPool;
    await nativePool.query(
      `INSERT INTO "Tenant" ("id", "name", "updatedAt") VALUES ($1, 'Governance integration', clock_timestamp()), ($2, 'Other', clock_timestamp())`,
      [tenantId, otherTenantId],
    );
    await nativePool.query(
      `INSERT INTO "Tenant" ("id", "name", "updatedAt") VALUES ($1, 'Audit purge integration', clock_timestamp())`,
      [purgeTenantId],
    );
    await nativePool.query(
      `INSERT INTO "Workspace" ("id", "tenantId", "name", "updatedAt") VALUES ($1, $2, 'Catalog', clock_timestamp())`,
      [workspaceId, tenantId],
    );
  }, 30_000);

  afterAll(async () => {
    if (!nativePool) return;
    await nativePool.query(`DELETE FROM "TenantErasureStep" WHERE "requestId" IN (SELECT "id" FROM "TenantErasureRequest" WHERE "tenantHash" IS NOT NULL AND "idempotencyKey" LIKE $1)`, [`%${suffix}%`]);
    await nativePool.query(`DELETE FROM "TenantErasureRequest" WHERE "idempotencyKey" LIKE $1`, [`%${suffix}%`]);
    await nativePool.query(`DELETE FROM "RetentionRun" WHERE "policyId" IN (SELECT "id" FROM "RetentionPolicy" WHERE "tenantId" IN ($1, $2))`, [tenantId, otherTenantId]);
    await nativePool.query(`DELETE FROM "RetentionPolicy" WHERE "tenantId" IN ($1, $2)`, [tenantId, otherTenantId]);
    await nativePool.query(`DELETE FROM "Tenant" WHERE "id" IN ($1, $2, $3, $4)`, [tenantId, otherTenantId, personalSubject, purgeTenantId]);
    await nativePool.end();
  }, 30_000);

  it('provisions subject-based access and accepts a one-time hashed invitation idempotently', async () => {
    const repository = new PostgresOrganizationRepository(pool);
    const membership = await repository.bootstrapOwner(owner.tenantId, owner.subjectId);
    expect(membership).toMatchObject({ role: 'OWNER', status: 'ACTIVE', subjectId: owner.subjectId });

    const issued = await repository.issueInvitation(owner, {
      email: ' Member@Example.COM ',
      organizationRole: 'MEMBER',
      workspaceGrants: [{ workspaceId, role: 'EDITOR' }],
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      idempotencyKey: `invite-${suffix}`,
    });
    expect(issued.bearerToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    const stored = await nativePool.query(`SELECT "tokenHash" FROM "OrganizationInvitation" WHERE "id" = $1`, [issued.invitation.id]);
    expect(stored.rows[0]).toMatchObject({ tokenHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(JSON.stringify(stored.rows[0])).not.toContain(issued.bearerToken!);

    await expect(repository.acceptInvitation({
      bearerToken: issued.bearerToken!, subjectId: invitedSubject, verifiedEmail: 'wrong@example.com',
    })).rejects.toBeInstanceOf(GovernanceAuthorizationError);

    const [left, right] = await Promise.all([
      repository.acceptInvitation({ bearerToken: issued.bearerToken!, subjectId: invitedSubject, verifiedEmail: 'member@example.com' }),
      repository.acceptInvitation({ bearerToken: issued.bearerToken!, subjectId: invitedSubject, verifiedEmail: 'member@example.com' }),
    ]);
    expect(left.organizationMembership.id).toBe(right.organizationMembership.id);
    expect(left.workspaceMemberships).toHaveLength(1);
    expect((await repository.listWorkspaceMemberships({ tenantId, subjectId: invitedSubject }, workspaceId))[0]).toMatchObject({ role: 'EDITOR' });

    await expect(repository.listOrganizationMembers({ tenantId: otherTenantId, subjectId: invitedSubject })).rejects.toBeInstanceOf(GovernanceAuthorizationError);
    await expect(repository.removeOrganizationMember(owner, owner.subjectId)).rejects.toBeInstanceOf(GovernanceConflictError);
  }, 30_000);

  it('atomically provisions one audited personal organization under concurrent first-login requests', async () => {
    const repository = new PostgresOrganizationRepository(pool);
    const results = await Promise.all(Array.from({ length: 12 }, () =>
      repository.provisionPersonalOrganization(personalSubject, personalSubject)));
    expect(new Set(results.map((result) => result.workspaceId)).size).toBe(1);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(results.every((result) =>
      result.organizationMembership.role === 'OWNER'
      && result.workspaceMembership.role === 'OWNER'
      && result.workspaceMembership.status === 'ACTIVE')).toBe(true);

    const counts = await nativePool.query(
      `SELECT
         (SELECT count(*)::int FROM "Tenant" WHERE "id" = $1) AS tenants,
         (SELECT count(*)::int FROM "Workspace" WHERE "tenantId" = $1) AS workspaces,
         (SELECT count(*)::int FROM "OrganizationMembership" WHERE "tenantId" = $1) AS organization_memberships,
         (SELECT count(*)::int FROM "WorkspaceMembership" WHERE "tenantId" = $1) AS workspace_memberships,
         (SELECT count(*)::int FROM security_audit_events
           WHERE tenant_id = $1 AND action = 'organization.personal.provisioned') AS audit_events`,
      [personalSubject],
    );
    expect(counts.rows[0]).toMatchObject({
      tenants: 1, workspaces: 1, organization_memberships: 1, workspace_memberships: 1, audit_events: 1,
    });
    await expect(repository.provisionPersonalOrganization(personalSubject, 'different-subject'))
      .rejects.toBeInstanceOf(GovernanceAuthorizationError);
  }, 30_000);

  it('serializes concurrent audit appends and rejects mutation', async () => {
    const appender = new PostgresAuditChainAppender(pool);
    await Promise.all(Array.from({ length: 24 }, (_, index) => appender.append({
      tenantId,
      actorUserId: owner.subjectId,
      action: 'governance.integration',
      targetType: 'test-event',
      targetId: String(index),
      metadata: { ordinal: index },
    })));
    const reader = new PostgresTenantAuditChainReader(pool);
    const records = await reader.export(owner, { limit: 100 });
    expect(records).toHaveLength(24);
    expect(records.map((record) => record.chainSequence)).toEqual(Array.from({ length: 24 }, (_, index) => BigInt(index + 1)));
    expect(verifyAuditChain(records)).toMatchObject({ valid: true, verifiedEvents: 24 });
    await expect(nativePool.query(`UPDATE security_audit_events SET action = 'tampered' WHERE id = $1`, [records[0]!.id])).rejects.toThrow(/append-only/);
    await expect(nativePool.query(`DELETE FROM security_audit_events WHERE id = $1`, [records[0]!.id])).rejects.toThrow(/append-only/);
  }, 30_000);

  it('freezes an exact purge manifest atomically against concurrent append and resumes after a crash boundary', async () => {
    const appender = new PostgresAuditChainAppender(pool);
    await appender.append({
      tenantId: purgeTenantId,
      action: 'governance.audit-purge.before',
      targetType: 'integration-test',
    });
    const digest = createHash('sha256').update(purgeTenantId, 'utf8').digest('hex');
    const requestId = `purge-request-${suffix}`;
    const holdUntil = '2020-01-01T00:00:00.000Z';
    await nativePool.query(
      `INSERT INTO "TenantErasureRequest"
         ("id", "tenantId", "tenantHash", "requestedBySubjectHash", "pseudonymKeyVersion",
          "idempotencyKey", "reason", "status", "completedAt", "createdAt", "updatedAt")
       VALUES ($1, NULL, $2, $2, 'integration-key', $3, 'audit purge race verification',
         'SUCCEEDED', clock_timestamp(), clock_timestamp(), clock_timestamp())`,
      [requestId, digest, `audit-purge-${suffix}`],
    );
    await nativePool.query(
      `INSERT INTO "TenantErasureStep"
         ("id", "requestId", "resourceKind", "status", "checkpoint", "legalBasis",
          "startedAt", "completedAt", "updatedAt")
       VALUES ($1, $2, 'audit_legal_record', 'SKIPPED_LEGAL_HOLD', $3::jsonb,
         'Integration finite audit hold', clock_timestamp(), clock_timestamp(), clock_timestamp())`,
      [`purge-step-${suffix}`, requestId, JSON.stringify({ holdUntil, tenantDigest: digest, subjectRef: 'encrypted-test-only' })],
    );

    const [prepareResult, racingAppend] = await Promise.allSettled([
      nativePool.query(`SELECT * FROM sentinel_prepare_expired_audit_purge($1, $2, $3)`, [requestId, purgeTenantId, digest]),
      appender.append({
        tenantId: purgeTenantId,
        action: 'governance.audit-purge.racing',
        targetType: 'integration-test',
      }),
    ]);
    expect(prepareResult.status).toBe('fulfilled');
    expect(['fulfilled', 'rejected']).toContain(racingAppend.status);

    // Simulate a worker crash after phase-one commit: the manifest remains authoritative and all
    // later appends are rejected until the external objects are erased and phase two commits.
    const manifestResult = await nativePool.query(
      `SELECT "security_event_count" AS "eventCount", "last_chain_sequence" AS "lastSequence",
              "last_event_hash" AS "lastHash", "external_anchor_count" AS "anchorCount",
              "external_anchor_digest" AS "anchorDigest", "hold_until" AS "holdUntil"
       FROM audit_purge_manifests WHERE request_id = $1`,
      [requestId],
    );
    const manifest = manifestResult.rows[0] as {
      eventCount: string; lastSequence: string; lastHash: string; anchorCount: string;
      anchorDigest: string; holdUntil: Date;
    };
    const actual = await nativePool.query(
      `SELECT count(*)::text AS count FROM security_audit_events WHERE tenant_id = $1`,
      [purgeTenantId],
    );
    expect(manifest.eventCount).toBe((actual.rows[0] as { count: string }).count);
    await expect(appender.append({
      tenantId: purgeTenantId,
      action: 'governance.audit-purge.after-freeze',
      targetType: 'integration-test',
    })).rejects.toThrow(/frozen for controlled tenant erasure/);

    const purgedAt = new Date().toISOString();
    const canonicalHold = manifest.holdUntil.toISOString();
    const payload = [
      'sentinel-audit-erasure-v1', requestId, digest, canonicalHold,
      manifest.eventCount, manifest.lastSequence, manifest.lastHash,
      manifest.anchorCount, manifest.anchorDigest, purgedAt,
    ].join('\n');
    await nativePool.query(
      `SELECT * FROM sentinel_purge_expired_audit_chain($1, $2, $3, $4::bigint, $5, $6, $7, $8, $9)`,
      [requestId, purgeTenantId, digest, manifest.anchorCount, manifest.anchorDigest,
        purgedAt, payload, 'integration-signing-key', 'integration-signature'],
    );
    expect((await nativePool.query(`SELECT 1 FROM audit_purge_manifests WHERE request_id = $1`, [requestId])).rowCount).toBe(0);
    expect((await nativePool.query(`SELECT 1 FROM audit_erasure_receipts WHERE request_id = $1`, [requestId])).rowCount).toBe(1);
    expect((await nativePool.query(`SELECT 1 FROM security_audit_events WHERE tenant_id = $1`, [purgeTenantId])).rowCount).toBe(0);
    await expect(appender.append({
      tenantId: purgeTenantId,
      action: 'governance.audit-purge.after-receipt',
      targetType: 'integration-test',
    })).rejects.toThrow(/frozen for controlled tenant erasure/);
  }, 30_000);

  it('version-controls policies and leases each scheduled retention run once', async () => {
    const repository = new PostgresRetentionRepository(pool);
    const policy = await repository.setTenantPolicy(owner, {
      resourceKind: 'scan_history', retentionDays: 30, deletionGraceDays: 7, enabled: true,
      nextRunAt: new Date(Date.now() - 1_000).toISOString(), expectedVersion: null,
    });
    await expect(repository.setTenantPolicy(owner, {
      resourceKind: 'scan_history', retentionDays: 31, deletionGraceDays: 7, enabled: true,
      nextRunAt: new Date().toISOString(), expectedVersion: 99,
    })).rejects.toBeInstanceOf(GovernanceConflictError);
    const scheduled = await repository.scheduleDue(new Date().toISOString(), 86_400_000, 10);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]).toMatchObject({ policyId: policy.id, resourceKind: 'scan_history', status: 'PENDING' });
    const [first, second] = await Promise.all([
      repository.claimRuns({ limit: 1, leaseMs: 60_000 }),
      repository.claimRuns({ limit: 1, leaseMs: 60_000 }),
    ]);
    expect(first.length + second.length).toBe(1);
    const claimed = first[0] ?? second[0]!;
    expect(await repository.saveBatch({ runId: claimed.id, leaseToken: claimed.leaseToken!, cursor: {}, deletedCount: 17n, done: true })).toBe(true);
    expect(await repository.saveBatch({ runId: claimed.id, leaseToken: claimed.leaseToken!, cursor: {}, deletedCount: 1n, done: true })).toBe(false);
  }, 30_000);

  it('tracks the complete erasure inventory and deletes all classified PostgreSQL tenant rows', async () => {
    const repository = new PostgresTenantErasureRepository(pool, Buffer.alloc(32, 7));
    const requested = await repository.request(owner, { idempotencyKey: `erase-${suffix}`, reason: 'Integration verification' });
    expect(requested.steps.map((step) => step.resourceKind)).toEqual(PRODUCTION_TENANT_ERASURE_RESOURCES);
    const abandoned = (await repository.claim({ limit: 1, leaseMs: 60_000 })).find((entry) => entry.id === requested.id)!;
    expect(abandoned).toBeTruthy();
    await nativePool.query(
      `UPDATE "TenantErasureRequest" SET "leaseExpiresAt" = clock_timestamp() - interval '1 second' WHERE "id" = $1`,
      [requested.id],
    );
    const claimed = (await repository.claim({ limit: 1, leaseMs: 60_000 })).find((entry) => entry.id === requested.id)!;
    expect(claimed.leaseToken).not.toBe(abandoned.leaseToken);
    expect(await repository.renew(abandoned.id, abandoned.leaseToken, 60_000)).toBe(false);

    for (const resourceKind of PRODUCTION_TENANT_ERASURE_RESOURCES) {
      const started = await repository.startStep(claimed.id, claimed.leaseToken, resourceKind);
      expect(started).toBeTruthy();
      let deletedCount = 0n;
      let legalBasis: string | undefined;
      if (resourceKind === 'postgres_tenant_rows') {
        const result = await new PostgresTenantRowsErasureAdapter(pool).erase({ tenantId, checkpoint: {} });
        deletedCount = result.deletedCount;
      } else if (resourceKind === 'audit_legal_record' || resourceKind === 'backup_expiry') {
        legalBasis = 'Statutory security-record retention; tenant identifiers are opaque and metadata is secret-filtered.';
      }
      expect(await repository.finishStep({
        requestId: claimed.id, leaseToken: claimed.leaseToken, resourceKind,
        deletedCount, checkpoint: { completed: true }, legalBasis,
      })).toBe(true);
    }
    expect(await repository.complete(claimed.id, claimed.leaseToken)).toBe(true);
    expect((await nativePool.query(`SELECT 1 FROM "Tenant" WHERE "id" = $1`, [tenantId])).rowCount).toBe(0);
    const receipt = await nativePool.query(`SELECT "tenantId", "status", "completedAt" FROM "TenantErasureRequest" WHERE "id" = $1`, [claimed.id]);
    expect(receipt.rows[0]).toMatchObject({ tenantId: null, status: 'SUCCEEDED', completedAt: expect.any(Date) });
    const retainedReceipt = await repository.get(owner, claimed.id);
    expect(retainedReceipt).toMatchObject({ id: claimed.id, tenantId: null, status: 'SUCCEEDED' });
  }, 30_000);
});
