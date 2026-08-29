import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { DISTROKID_JOB_SCHEMA_VERSION, type CatalogIndexJob } from '@sentinel/contracts';
import { EnvelopeEncryptor } from '@sentinel/security';
import {
  DistroKidRecoveryAlreadyTerminalError,
  DistroKidRecoveryPrincipalMismatchError,
  PostgresDistroKidRecoveryRepository,
  type DistroKidRecoverySqlPool,
} from './distrokid-recovery';

const DATABASE_URL = process.env.DATABASE_URL ?? process.env.DATABASE_TEST_URL;
const NOW = Date.parse('2026-07-23T12:00:00.000Z');
const nonce = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const snapshotIds: string[] = [];

function recoveryJob(snapshotId: string, steelSessionId: string): CatalogIndexJob {
  return {
    tenantId: `recovery-tenant-${nonce}`,
    connectionId: `recovery-connection-${nonce}`,
    snapshotId,
    distributor: 'distrokid',
    artists: ['Recovery Artist'],
    consentId: `recovery-consent-${nonce}`,
    artistWorkspaceId: `recovery-workspace-${nonce}`,
    steelSessionId,
    sessionExpiresAt: new Date(NOW + 60 * 60_000).toISOString(),
    deadlineAt: new Date(NOW + 45 * 60_000).toISOString(),
    schemaVersion: DISTROKID_JOB_SCHEMA_VERSION,
  };
}

describe.skipIf(!DATABASE_URL)('PostgreSQL DistroKid recovery envelope', () => {
  let pool: Pool;
  let repository: PostgresDistroKidRecoveryRepository;

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 2 });
    repository = new PostgresDistroKidRecoveryRepository(
      pool as unknown as DistroKidRecoverySqlPool,
      () => NOW,
    );
  });

  afterAll(async () => {
    for (const snapshotId of snapshotIds) {
      await pool.query(
        'DELETE FROM "DistroKidSnapshotCheckpoint" WHERE "snapshotId"=$1',
        [snapshotId],
      ).catch(() => undefined);
    }
    await pool.end().catch(() => undefined);
  });

  it('persists before queueing, keeps the first authority immutable, lists it, and clears it', async () => {
    const snapshotId = `recovery-envelope-${nonce}`;
    snapshotIds.push(snapshotId);
    const encryptor = new EnvelopeEncryptor(Buffer.alloc(32, 19).toString('base64'));
    const firstHandle = encryptor.encrypt('steel-live-provider-session-id');
    const replayHandle = encryptor.encrypt('steel-live-provider-session-id');
    const first = recoveryJob(snapshotId, firstHandle);

    const persisted = await repository.prepare(first);
    expect(persisted).toEqual(first);

    // API retries re-encrypt the same provider id and may recompute a shorter deadline. The first
    // durable ciphertext/deadline remains the sole queue-recovery authority for this snapshot.
    const replay = {
      ...first,
      steelSessionId: replayHandle,
      deadlineAt: new Date(NOW + 40 * 60_000).toISOString(),
    };
    expect(replayHandle).not.toBe(firstHandle);
    const replayed = await repository.prepare(replay);
    expect(replayed.steelSessionId).toBe(firstHandle);
    expect(replayed.deadlineAt).toBe(first.deadlineAt);

    await expect(repository.prepare({ ...first, artists: ['A different artist'] }))
      .rejects.toBeInstanceOf(DistroKidRecoveryPrincipalMismatchError);
    await expect(repository.prepare({ ...first, tenantId: `other-tenant-${nonce}` }))
      .rejects.toBeInstanceOf(DistroKidRecoveryPrincipalMismatchError);

    const listed = (await repository.list(500)).find((job) => job.snapshotId === snapshotId);
    expect(listed).toEqual(first);
    const raw = await pool.query(
      `SELECT "recoverySteelSessionIdEncrypted" AS handle
         FROM "DistroKidSnapshotCheckpoint" WHERE "snapshotId"=$1`,
      [snapshotId],
    );
    expect(raw.rows[0]?.handle).toBe(firstHandle);
    expect(String(raw.rows[0]?.handle)).not.toContain('steel-live-provider-session-id');

    expect(await repository.clear({ ...first, tenantId: `other-tenant-${nonce}` })).toBe(false);
    await pool.query(
      `INSERT INTO "DistroKidCheckpointTerminal" (
         "userId", "connectionId", "snapshotId", "tombstone"
       ) VALUES ($1,$2,$3,$4::jsonb)`,
      [
        first.tenantId,
        first.connectionId,
        first.snapshotId,
        JSON.stringify({ kind: 'CANCELLED', createdAt: new Date(NOW).toISOString(), reason: 'terminal test' }),
      ],
    );
    expect(await repository.clear(first)).toBe(true);
    expect((await repository.list(500)).some((job) => job.snapshotId === snapshotId)).toBe(false);
    const cleared = await pool.query(
      `SELECT "recoveryArtists", "recoveryConsentId", "recoveryArtistWorkspaceId",
              "recoverySteelSessionIdEncrypted", "recoverySessionExpiresAt",
              "recoveryDeadlineAt", "recoverySchemaVersion"
         FROM "DistroKidSnapshotCheckpoint" WHERE "snapshotId"=$1`,
      [snapshotId],
    );
    expect(Object.values(cleared.rows[0] ?? {}).every((value) => value === null)).toBe(true);
    await expect(repository.prepare(replay))
      .rejects.toBeInstanceOf(DistroKidRecoveryAlreadyTerminalError);
  });

  it('rejects a partially populated recovery row at the database boundary', async () => {
    const snapshotId = `recovery-partial-${nonce}`;
    snapshotIds.push(snapshotId);

    await expect(pool.query(
      `INSERT INTO "DistroKidSnapshotCheckpoint" (
         "userId", "connectionId", "snapshotId", "distributor", "recoveryConsentId"
       ) VALUES ($1,$2,$3,'distrokid',$4)`,
      [`partial-tenant-${nonce}`, `partial-connection-${nonce}`, snapshotId, 'partial-consent'],
    )).rejects.toMatchObject({ code: '23514' });

    const count = await pool.query(
      'SELECT count(*)::int AS count FROM "DistroKidSnapshotCheckpoint" WHERE "snapshotId"=$1',
      [snapshotId],
    );
    expect(count.rows[0]?.count).toBe(0);
  });
});
