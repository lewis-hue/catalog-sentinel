/**
 * Full account deletion: erase a user's data, then remove their Keycloak login.
 *
 * The data purge runs in ONE transaction so it is all-or-nothing: if any statement fails (for
 * example a foreign-key ordering surprise), the whole delete rolls back rather than leaving a
 * half-erased account. Tables are listed leaf-to-root; children that cascade are covered either way.
 *
 * Deliberately NOT purged: the append-only security audit trail (`security_audit_events` and its
 * hash-chain) is retained for compliance and is protected by an append-only trigger. Governance
 * bookkeeping tables are out of scope.
 */

/** Narrow pg surface: a Pool that hands out clients for a transaction. */
export interface SqlPool {
  connect(): Promise<{
    query(sql: string, values?: readonly unknown[]): Promise<unknown>;
    release(): void;
  }>;
}

/** Prisma-managed tables scoped by a `"userId"` column, ordered leaf-to-root. */
const USER_TABLES_CAMEL: string[] = [
  'IssueEvidence',
  'DistributorEndpointCandidate',
  'RoyaltyReport',
  'ObjectStorageArtifact',
  'ScanEvent',
  'DistributorTrackOutcome',
  'DistributorReleaseOutcome',
  'DistributorTrack',
  'DistributorRelease',
  'Track',
  'Release',
  'Issue',
  'ScanJob',
  'ScanRun',
  'DeepScanCheckpoint',
  'DeepScanRun',
  'DistroKidSnapshotCheckpoint',
  'DistributorExtractionSnapshot',
  'DistributorCatalogSnapshot',
  'CatalogSnapshot',
  'BrowserLinkSession',
  'BrowserStateRef',
  'CredentialReference',
  'DistributorEndpointProfile',
  'DSPAccount',
  'DistributorAccount',
  'DistributorConnection',
  'ConsentRevocationIntent',
  'ConsentGrant',
  'DistributorLinkRecord',
  'SupportPacket',
  'Artist',
];

/** Erase every non-audit record owned by `userId`, transactionally. */
export async function purgeUserData(pool: SqlPool, userId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Search store (raw, snake_case column).
    await client.query('DELETE FROM scan_records WHERE user_id = $1', [userId]);
    for (const table of USER_TABLES_CAMEL) {
      await client.query(`DELETE FROM "${table}" WHERE "userId" = $1`, [userId]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function keycloakAdminToken(env: NodeJS.ProcessEnv): Promise<string> {
  const base = (env.KEYCLOAK_BASE_URL ?? '').replace(/\/+$/, '');
  const username = env.KEYCLOAK_ADMIN_USERNAME?.trim();
  const password = env.KEYCLOAK_ADMIN_PASSWORD?.trim();
  if (!base || !username || !password) {
    throw new Error('Keycloak admin credentials are not configured (KEYCLOAK_ADMIN_USERNAME/PASSWORD).');
  }
  // Bootstrap admin on the master realm's built-in admin-cli client; it can manage users in any realm.
  const res = await fetch(`${base}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username, password }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error('Could not obtain a Keycloak admin token.');
  const body = (await res.json()) as { access_token?: string };
  if (!body.access_token) throw new Error('Keycloak admin token response was empty.');
  return body.access_token;
}

/** Remove the user's Keycloak login. A 404 (already gone) is treated as success. */
export async function deleteKeycloakUser(env: NodeJS.ProcessEnv, userId: string): Promise<void> {
  const base = (env.KEYCLOAK_BASE_URL ?? '').replace(/\/+$/, '');
  const realm = env.KEYCLOAK_REALM ?? 'sentinel';
  const token = await keycloakAdminToken(env);
  const res = await fetch(`${base}/admin/realms/${encodeURIComponent(realm)}/users/${encodeURIComponent(userId)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`Keycloak user deletion failed (${res.status}).`);
  }
}
