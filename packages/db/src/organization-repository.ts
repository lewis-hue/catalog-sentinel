import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type {
  AcceptedInvitation,
  GovernanceActor,
  GovernanceSqlClient,
  GovernanceSqlPool,
  IssuedInvitation,
  MembershipStatus,
  OrganizationInvitationRecord,
  OrganizationMembershipRecord,
  OrganizationRole,
  WorkspaceInvitationGrant,
  WorkspaceMembershipRecord,
  WorkspaceRole,
} from './governance-types';
import {
  GovernanceAuthorizationError,
  GovernanceConflictError,
  GovernanceValidationError,
} from './governance-types';
import type { TenantPseudonymizer } from './tenant-erasure';

export interface OrganizationProvisioner {
  /** Trusted control-plane operation; never expose as an ordinary tenant route. */
  bootstrapOwner(tenantId: string, subjectId: string): Promise<OrganizationMembershipRecord>;
}

export interface PersonalOrganizationProvisioningResult {
  tenantId: string;
  workspaceId: string;
  /** True only for the transaction that inserted at least one provisioning record. */
  created: boolean;
  organizationMembership: OrganizationMembershipRecord;
  workspaceMembership: WorkspaceMembershipRecord;
}

export interface PersonalOrganizationProvisioner {
  /**
   * Trusted first-login operation. The caller must supply the verified OIDC home tenant and
   * subject; this method independently requires them to be identical and is never a public API.
   */
  provisionPersonalOrganization(tenantId: string, subjectId: string): Promise<PersonalOrganizationProvisioningResult>;
}

export interface MembershipReader {
  listOrganizationMembers(actor: GovernanceActor): Promise<OrganizationMembershipRecord[]>;
  listWorkspaceMemberships(actor: GovernanceActor, workspaceId?: string): Promise<WorkspaceMembershipRecord[]>;
}

export type WorkspaceCapability = 'READ' | 'EDIT' | 'MANAGE_MEMBERS' | 'DELETE';

export interface WorkspaceAccessAuthorizer {
  hasWorkspaceCapability(actor: GovernanceActor, workspaceId: string, capability: WorkspaceCapability): Promise<boolean>;
}

export interface MembershipAdministrator {
  setOrganizationMembership(
    actor: GovernanceActor,
    subjectId: string,
    change: { role: OrganizationRole; status: MembershipStatus },
  ): Promise<OrganizationMembershipRecord>;
  removeOrganizationMember(actor: GovernanceActor, subjectId: string): Promise<boolean>;
  grantWorkspaceMembership(
    actor: GovernanceActor,
    input: { workspaceId: string; subjectId: string; role: WorkspaceRole },
  ): Promise<WorkspaceMembershipRecord>;
  removeWorkspaceMembership(actor: GovernanceActor, workspaceId: string, subjectId: string): Promise<boolean>;
}

export interface InvitationAdministrator {
  issueInvitation(actor: GovernanceActor, input: {
    email: string;
    organizationRole: OrganizationRole;
    workspaceGrants: WorkspaceInvitationGrant[];
    expiresAt: string;
    idempotencyKey: string;
  }): Promise<IssuedInvitation>;
  revokeInvitation(actor: GovernanceActor, invitationId: string): Promise<boolean>;
}

export interface InvitationAcceptor {
  acceptInvitation(input: { bearerToken: string; subjectId: string; verifiedEmail: string }): Promise<AcceptedInvitation>;
}

interface MembershipRow {
  id: string;
  tenantId: string;
  subjectId: string;
  role: OrganizationRole;
  status: MembershipStatus;
  createdAt: Date | string;
  updatedAt: Date | string;
}

interface WorkspaceMembershipRow {
  id: string;
  tenantId: string;
  workspaceId: string;
  subjectId: string;
  role: WorkspaceRole;
  status: MembershipStatus;
  createdAt: Date | string;
  updatedAt: Date | string;
}

interface ProvisionedPersonalOrganizationRow {
  organizationMembershipId: string;
  organizationTenantId: string;
  organizationSubjectId: string;
  organizationRole: OrganizationRole;
  organizationStatus: MembershipStatus;
  organizationCreatedAt: Date | string;
  organizationUpdatedAt: Date | string;
  workspaceMembershipId: string;
  workspaceTenantId: string;
  workspaceId: string;
  workspaceSubjectId: string;
  workspaceRole: WorkspaceRole;
  workspaceStatus: MembershipStatus;
  workspaceCreatedAt: Date | string;
  workspaceUpdatedAt: Date | string;
}

interface InvitationRow {
  id: string;
  tenantId: string;
  emailNormalized: string;
  organizationRole: OrganizationRole;
  issuedBySubjectId: string;
  acceptedBySubjectId: string | null;
  expiresAt: Date | string;
  acceptedAt: Date | string | null;
  revokedAt: Date | string | null;
  idempotencyKey: string;
  createdAt: Date | string;
  updatedAt: Date | string;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function nullableIso(value: Date | string | null): string | null {
  return value === null ? null : iso(value);
}

function mapMembership(row: MembershipRow): OrganizationMembershipRecord {
  return { ...row, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) };
}

function mapWorkspaceMembership(row: WorkspaceMembershipRow): WorkspaceMembershipRecord {
  return { ...row, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) };
}

function normalizeEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320) {
    throw new GovernanceValidationError('A syntactically valid verified email address is required.');
  }
  return email;
}

function requireIdentifier(value: string, label: string, max = 255): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max || [...normalized].some((character) => character.charCodeAt(0) < 32)) {
    throw new GovernanceValidationError(`${label} is invalid.`);
  }
  return normalized;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function deterministicPersonalWorkspaceId(tenantId: string, subjectId: string): string {
  const material = `${tenantId.length}:${tenantId}${subjectId.length}:${subjectId}`;
  return `workspace_personal_${createHash('sha256').update(material).digest('hex').slice(0, 32)}`;
}

async function transaction<T>(pool: GovernanceSqlPool, work: (client: GovernanceSqlClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    client.release();
    return result;
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    let releaseError: Error | undefined;
    try { await client.query('ROLLBACK'); } catch { releaseError = error; }
    client.release(releaseError);
    throw error;
  }
}

async function requireOrganizationAdmin(
  client: GovernanceSqlClient,
  actor: GovernanceActor,
  options: { ownerOnly?: boolean } = {},
): Promise<OrganizationRole> {
  const result = await client.query<{ role: OrganizationRole }>(
    `SELECT "role" FROM "OrganizationMembership"
     WHERE "tenantId" = $1 AND "subjectId" = $2 AND "status" = 'ACTIVE'
     FOR SHARE`,
    [actor.tenantId, actor.subjectId],
  );
  const role = result.rows[0]?.role;
  if (!role || (options.ownerOnly ? role !== 'OWNER' : role !== 'OWNER' && role !== 'ADMIN')) {
    throw new GovernanceAuthorizationError();
  }
  return role;
}

async function requireActiveMember(client: GovernanceSqlClient, actor: GovernanceActor): Promise<OrganizationRole> {
  const result = await client.query<{ role: OrganizationRole }>(
    `SELECT "role" FROM "OrganizationMembership"
     WHERE "tenantId" = $1 AND "subjectId" = $2 AND "status" = 'ACTIVE'`,
    [actor.tenantId, actor.subjectId],
  );
  const role = result.rows[0]?.role;
  if (!role) throw new GovernanceAuthorizationError();
  return role;
}

async function invitationRecord(client: GovernanceSqlClient, row: InvitationRow): Promise<OrganizationInvitationRecord> {
  const grants = await client.query<{ workspaceId: string; role: WorkspaceRole }>(
    `SELECT "workspaceId", "role" FROM "InvitationWorkspaceGrant"
     WHERE "tenantId" = $1 AND "invitationId" = $2 ORDER BY "workspaceId"`,
    [row.tenantId, row.id],
  );
  return {
    ...row,
    expiresAt: iso(row.expiresAt),
    acceptedAt: nullableIso(row.acceptedAt),
    revokedAt: nullableIso(row.revokedAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    workspaceGrants: grants.rows,
  };
}

/**
 * PostgreSQL implementation with authorization evaluated inside the same transaction as each
 * mutation. Callers can depend on narrow reader/admin/acceptor interfaces rather than receiving a
 * general SQL client or a cross-tenant list operation.
 */
export class PostgresOrganizationRepository implements
  OrganizationProvisioner,
  PersonalOrganizationProvisioner,
  MembershipReader,
  MembershipAdministrator,
  InvitationAdministrator,
  InvitationAcceptor,
  WorkspaceAccessAuthorizer {
  constructor(
    private readonly pool: GovernanceSqlPool,
    /** KMS-backed in production; prevents first-login from resurrecting an erased tenant. */
    private readonly tenantPseudonymizer?: Pick<TenantPseudonymizer, 'pseudonym'>,
  ) {}

  async provisionPersonalOrganization(
    tenantIdValue: string,
    subjectIdValue: string,
  ): Promise<PersonalOrganizationProvisioningResult> {
    const tenantId = requireIdentifier(tenantIdValue, 'tenantId');
    const subjectId = requireIdentifier(subjectIdValue, 'subjectId');
    if (tenantId !== subjectId) {
      throw new GovernanceAuthorizationError('Personal organization provisioning requires the verified home tenant to equal the OIDC subject.');
    }
    const workspaceId = deterministicPersonalWorkspaceId(tenantId, subjectId);

    // First login is write-heavy, while every later request should be a single indexed read. This
    // fast path avoids BEGIN/FOR UPDATE and tenant-row serialization once the complete invariant
    // already exists. The transactional path below remains the only writer and repairs/rejects
    // partial or conflicting state.
    const reader = await this.pool.connect();
    try {
      const activeErasure = await reader.query(
        `SELECT 1 FROM "TenantErasureRequest" WHERE "tenantId" = $1 LIMIT 1`,
        [tenantId],
      );
      if ((activeErasure.rowCount ?? activeErasure.rows.length) > 0) {
        throw new GovernanceConflictError('Personal organization provisioning is blocked by a tenant-erasure request.');
      }
      const existing = await reader.query<ProvisionedPersonalOrganizationRow>(
        `SELECT
           om."id" AS "organizationMembershipId",
           om."tenantId" AS "organizationTenantId",
           om."subjectId" AS "organizationSubjectId",
           om."role" AS "organizationRole",
           om."status" AS "organizationStatus",
           om."createdAt" AS "organizationCreatedAt",
           om."updatedAt" AS "organizationUpdatedAt",
           wm."id" AS "workspaceMembershipId",
           wm."tenantId" AS "workspaceTenantId",
           wm."workspaceId" AS "workspaceId",
           wm."subjectId" AS "workspaceSubjectId",
           wm."role" AS "workspaceRole",
           wm."status" AS "workspaceStatus",
           wm."createdAt" AS "workspaceCreatedAt",
           wm."updatedAt" AS "workspaceUpdatedAt"
         FROM "OrganizationMembership" om
         JOIN "Workspace" w
           ON w."tenantId" = om."tenantId" AND w."id" = $3
         JOIN "WorkspaceMembership" wm
           ON wm."tenantId" = w."tenantId" AND wm."workspaceId" = w."id"
              AND wm."subjectId" = om."subjectId"
         WHERE om."tenantId" = $1 AND om."subjectId" = $2`,
        [tenantId, subjectId, workspaceId],
      );
      const row = existing.rows[0];
      if (row
        && row.organizationRole === 'OWNER'
        && row.organizationStatus === 'ACTIVE'
        && row.workspaceRole === 'OWNER'
        && row.workspaceStatus === 'ACTIVE') {
        return {
          tenantId,
          workspaceId,
          created: false,
          organizationMembership: mapMembership({
            id: row.organizationMembershipId,
            tenantId: row.organizationTenantId,
            subjectId: row.organizationSubjectId,
            role: row.organizationRole,
            status: row.organizationStatus,
            createdAt: row.organizationCreatedAt,
            updatedAt: row.organizationUpdatedAt,
          }),
          workspaceMembership: mapWorkspaceMembership({
            id: row.workspaceMembershipId,
            tenantId: row.workspaceTenantId,
            workspaceId: row.workspaceId,
            subjectId: row.workspaceSubjectId,
            role: row.workspaceRole,
            status: row.workspaceStatus,
            createdAt: row.workspaceCreatedAt,
            updatedAt: row.workspaceUpdatedAt,
          }),
        };
      }
    } finally {
      reader.release();
    }
    // Completed erasure receipts deliberately retain only a KMS-HMAC tenant pseudonym. Compute
    // it only when the ordinary existing-organization fast path misses.
    const tenantHash = this.tenantPseudonymizer
      ? await this.tenantPseudonymizer.pseudonym('tenant', tenantId)
      : null;
    return transaction(this.pool, async (client) => {
      // Serialize creation with erasure requests for the same tenant. This hash check closes the
      // post-erasure resurrection path without retaining the deleted tenant identifier.
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`tenant-erasure:${tenantId}`]);
      const erasureBlock = tenantHash
        ? await client.query(
          `SELECT 1 FROM "TenantErasureRequest"
           WHERE "tenantId" = $1 OR "tenantHash" = $2 LIMIT 1`,
          [tenantId, tenantHash],
        )
        : await client.query(
          `SELECT 1 FROM "TenantErasureRequest" WHERE "tenantId" = $1 LIMIT 1`,
          [tenantId],
        );
      if ((erasureBlock.rowCount ?? erasureBlock.rows.length) > 0) {
        throw new GovernanceConflictError('Personal organization provisioning is blocked by a tenant-erasure request.');
      }
      let created = false;
      const tenant = await client.query<{ id: string }>(
        `INSERT INTO "Tenant" ("id", "name", "plan", "createdAt", "updatedAt")
         VALUES ($1, 'Personal organization', 'free', clock_timestamp(), clock_timestamp())
         ON CONFLICT ("id") DO NOTHING RETURNING "id"`,
        [tenantId],
      );
      created ||= (tenant.rowCount ?? tenant.rows.length) === 1;
      const lockedTenant = await client.query(
        `SELECT 1 FROM "Tenant" WHERE "id" = $1 FOR UPDATE`,
        [tenantId],
      );
      if ((lockedTenant.rowCount ?? 0) !== 1) throw new GovernanceConflictError('Personal organization provisioning could not lock its tenant.');

      const otherOwner = await client.query<{ subjectId: string }>(
        `SELECT "subjectId" FROM "OrganizationMembership"
         WHERE "tenantId" = $1 AND "role" = 'OWNER' AND "status" = 'ACTIVE' AND "subjectId" <> $2
         FOR UPDATE`,
        [tenantId, subjectId],
      );
      if (otherOwner.rows.length > 0) {
        throw new GovernanceConflictError('The verified home tenant is already owned by another subject.');
      }
      const insertedOrganizationMembership = await client.query<MembershipRow>(
        `INSERT INTO "OrganizationMembership"
           ("id", "tenantId", "subjectId", "role", "status", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, 'OWNER', 'ACTIVE', clock_timestamp(), clock_timestamp())
         ON CONFLICT ("tenantId", "subjectId") DO NOTHING RETURNING *`,
        [`orgmem_${randomUUID()}`, tenantId, subjectId],
      );
      created ||= (insertedOrganizationMembership.rowCount ?? insertedOrganizationMembership.rows.length) === 1;
      const organizationMembershipResult = insertedOrganizationMembership.rows[0]
        ? insertedOrganizationMembership
        : await client.query<MembershipRow>(
          `SELECT * FROM "OrganizationMembership" WHERE "tenantId" = $1 AND "subjectId" = $2 FOR UPDATE`,
          [tenantId, subjectId],
        );
      const organizationMembership = organizationMembershipResult.rows[0];
      if (!organizationMembership || organizationMembership.role !== 'OWNER' || organizationMembership.status !== 'ACTIVE') {
        throw new GovernanceConflictError('Personal organization owner membership is not active.');
      }

      const workspace = await client.query<{ id: string }>(
        `INSERT INTO "Workspace" ("id", "tenantId", "name", "createdAt", "updatedAt")
         VALUES ($1, $2, 'Personal catalog', clock_timestamp(), clock_timestamp())
         ON CONFLICT ("id") DO NOTHING RETURNING "id"`,
        [workspaceId, tenantId],
      );
      created ||= (workspace.rowCount ?? workspace.rows.length) === 1;
      const existingWorkspace = await client.query<{ tenantId: string }>(
        `SELECT "tenantId" FROM "Workspace" WHERE "id" = $1 FOR UPDATE`,
        [workspaceId],
      );
      if (existingWorkspace.rows[0]?.tenantId !== tenantId) {
        throw new GovernanceConflictError('Personal workspace identifier is already bound to another tenant.');
      }

      const insertedWorkspaceMembership = await client.query<WorkspaceMembershipRow>(
        `INSERT INTO "WorkspaceMembership"
           ("id", "tenantId", "workspaceId", "subjectId", "role", "status", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, 'OWNER', 'ACTIVE', clock_timestamp(), clock_timestamp())
         ON CONFLICT ("tenantId", "workspaceId", "subjectId") DO NOTHING RETURNING *`,
        [`wsmem_${randomUUID()}`, tenantId, workspaceId, subjectId],
      );
      created ||= (insertedWorkspaceMembership.rowCount ?? insertedWorkspaceMembership.rows.length) === 1;
      const workspaceMembershipResult = insertedWorkspaceMembership.rows[0]
        ? insertedWorkspaceMembership
        : await client.query<WorkspaceMembershipRow>(
          `SELECT * FROM "WorkspaceMembership"
           WHERE "tenantId" = $1 AND "workspaceId" = $2 AND "subjectId" = $3 FOR UPDATE`,
          [tenantId, workspaceId, subjectId],
        );
      const workspaceMembership = workspaceMembershipResult.rows[0];
      if (!workspaceMembership || workspaceMembership.role !== 'OWNER' || workspaceMembership.status !== 'ACTIVE') {
        throw new GovernanceConflictError('Personal workspace owner membership is not active.');
      }

      if (created) {
        await client.query(
          `INSERT INTO security_audit_events
             (id, occurred_at, tenant_id, workspace_id, actor_user_id, action, target_type, target_id, metadata)
           VALUES ($1, clock_timestamp(), $2, $3, $4, 'organization.personal.provisioned',
                   'Organization', $2, $5::jsonb)`,
          [`audit_${randomUUID()}`, tenantId, workspaceId, subjectId, JSON.stringify({ source: 'verified_oidc_first_login' })],
        );
      }
      return {
        tenantId,
        workspaceId,
        created,
        organizationMembership: mapMembership(organizationMembership),
        workspaceMembership: mapWorkspaceMembership(workspaceMembership),
      };
    });
  }

  async bootstrapOwner(tenantIdValue: string, subjectIdValue: string): Promise<OrganizationMembershipRecord> {
    const tenantId = requireIdentifier(tenantIdValue, 'tenantId');
    const subjectId = requireIdentifier(subjectIdValue, 'subjectId');
    return transaction(this.pool, async (client) => {
      const tenant = await client.query(`SELECT 1 FROM "Tenant" WHERE "id" = $1 FOR UPDATE`, [tenantId]);
      if ((tenant.rowCount ?? 0) !== 1) throw new GovernanceValidationError('Organization not found.');
      const existingOwners = await client.query<{ subjectId: string }>(
        `SELECT "subjectId" FROM "OrganizationMembership"
         WHERE "tenantId" = $1 AND "role" = 'OWNER' AND "status" = 'ACTIVE' FOR UPDATE`,
        [tenantId],
      );
      if (existingOwners.rows.length > 0 && !existingOwners.rows.some((row) => row.subjectId === subjectId)) {
        throw new GovernanceConflictError('This organization already has an active owner.');
      }
      const result = await client.query<MembershipRow>(
        `INSERT INTO "OrganizationMembership"
           ("id", "tenantId", "subjectId", "role", "status", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, 'OWNER', 'ACTIVE', clock_timestamp(), clock_timestamp())
         ON CONFLICT ("tenantId", "subjectId") DO UPDATE
           SET "role" = 'OWNER', "status" = 'ACTIVE', "updatedAt" = clock_timestamp()
         RETURNING *`,
        [`orgmem_${randomUUID()}`, tenantId, subjectId],
      );
      return mapMembership(result.rows[0]!);
    });
  }

  async listOrganizationMembers(actor: GovernanceActor): Promise<OrganizationMembershipRecord[]> {
    return transaction(this.pool, async (client) => {
      const role = await requireActiveMember(client, actor);
      if (!['OWNER', 'ADMIN', 'AUDITOR'].includes(role)) throw new GovernanceAuthorizationError();
      const result = await client.query<MembershipRow>(
        `SELECT * FROM "OrganizationMembership" WHERE "tenantId" = $1
         ORDER BY "createdAt", "id"`,
        [actor.tenantId],
      );
      return result.rows.map(mapMembership);
    });
  }

  async listWorkspaceMemberships(actor: GovernanceActor, workspaceId?: string): Promise<WorkspaceMembershipRecord[]> {
    return transaction(this.pool, async (client) => {
      const role = await requireActiveMember(client, actor);
      const elevated = ['OWNER', 'ADMIN', 'AUDITOR'].includes(role);
      if (!elevated && workspaceId) {
        const workspaceAuthority = await client.query<{ role: WorkspaceRole }>(
          `SELECT "role" FROM "WorkspaceMembership"
           WHERE "tenantId" = $1 AND "workspaceId" = $2 AND "subjectId" = $3 AND "status" = 'ACTIVE'`,
          [actor.tenantId, workspaceId, actor.subjectId],
        );
        if (!['OWNER', 'MANAGER'].includes(workspaceAuthority.rows[0]?.role ?? '')) {
          const own = await client.query<WorkspaceMembershipRow>(
            `SELECT * FROM "WorkspaceMembership"
             WHERE "tenantId" = $1 AND "workspaceId" = $2 AND "subjectId" = $3 AND "status" = 'ACTIVE'`,
            [actor.tenantId, workspaceId, actor.subjectId],
          );
          return own.rows.map(mapWorkspaceMembership);
        }
      }
      const result = await client.query<WorkspaceMembershipRow>(
        `SELECT * FROM "WorkspaceMembership"
         WHERE "tenantId" = $1 AND ($2::text IS NULL OR "workspaceId" = $2)
           AND ($3::boolean OR "subjectId" = $4)
         ORDER BY "workspaceId", "createdAt", "id"`,
        [actor.tenantId, workspaceId ?? null, elevated || Boolean(workspaceId), actor.subjectId],
      );
      return result.rows.map(mapWorkspaceMembership);
    });
  }

  async hasWorkspaceCapability(actor: GovernanceActor, workspaceIdValue: string, capability: WorkspaceCapability): Promise<boolean> {
    const workspaceId = requireIdentifier(workspaceIdValue, 'workspaceId');
    return transaction(this.pool, async (client) => {
      const access = await client.query<{ organizationRole: OrganizationRole; workspaceRole: WorkspaceRole | null }>(
        `SELECT organization."role" AS "organizationRole", workspace."role" AS "workspaceRole"
         FROM "OrganizationMembership" AS organization
         INNER JOIN "Workspace" AS target ON target."tenantId" = organization."tenantId" AND target."id" = $3
         LEFT JOIN "WorkspaceMembership" AS workspace
           ON workspace."tenantId" = organization."tenantId" AND workspace."workspaceId" = target."id"
          AND workspace."subjectId" = organization."subjectId" AND workspace."status" = 'ACTIVE'
         WHERE organization."tenantId" = $1 AND organization."subjectId" = $2 AND organization."status" = 'ACTIVE'`,
        [actor.tenantId, actor.subjectId, workspaceId],
      );
      const row = access.rows[0];
      if (!row) return false;
      if (row.organizationRole === 'OWNER') return true;
      if (row.organizationRole === 'ADMIN') return capability !== 'DELETE';
      const grants: Record<WorkspaceRole, readonly WorkspaceCapability[]> = {
        OWNER: ['READ', 'EDIT', 'MANAGE_MEMBERS', 'DELETE'],
        MANAGER: ['READ', 'EDIT', 'MANAGE_MEMBERS'],
        EDITOR: ['READ', 'EDIT'],
        VIEWER: ['READ'],
      };
      return row.workspaceRole ? grants[row.workspaceRole].includes(capability) : false;
    });
  }

  async issueInvitation(actor: GovernanceActor, input: {
    email: string;
    organizationRole: OrganizationRole;
    workspaceGrants: WorkspaceInvitationGrant[];
    expiresAt: string;
    idempotencyKey: string;
  }): Promise<IssuedInvitation> {
    const email = normalizeEmail(input.email);
    const idempotencyKey = requireIdentifier(input.idempotencyKey, 'idempotencyKey', 200);
    const expiresAt = new Date(input.expiresAt);
    const now = Date.now();
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= now || expiresAt.getTime() > now + 30 * 86_400_000) {
      throw new GovernanceValidationError('Invitation expiry must be in the future and no more than 30 days away.');
    }
    const uniqueGrants = new Map<string, WorkspaceRole>();
    for (const grant of input.workspaceGrants) {
      const workspaceId = requireIdentifier(grant.workspaceId, 'workspaceId');
      if (uniqueGrants.has(workspaceId)) throw new GovernanceValidationError('A workspace may appear only once per invitation.');
      uniqueGrants.set(workspaceId, grant.role);
    }
    const bearerToken = randomBytes(32).toString('base64url');
    const tokenHash = hashToken(bearerToken);

    return transaction(this.pool, async (client) => {
      const issuerRole = await requireOrganizationAdmin(client, actor);
      if (input.organizationRole === 'OWNER' && issuerRole !== 'OWNER') throw new GovernanceAuthorizationError();
      if (issuerRole !== 'OWNER' && [...uniqueGrants.values()].includes('OWNER')) throw new GovernanceAuthorizationError();

      if (uniqueGrants.size > 0) {
        const workspaces = await client.query<{ id: string }>(
          `SELECT "id" FROM "Workspace" WHERE "tenantId" = $1 AND "id" = ANY($2::text[]) FOR SHARE`,
          [actor.tenantId, [...uniqueGrants.keys()]],
        );
        if (workspaces.rows.length !== uniqueGrants.size) {
          throw new GovernanceValidationError('Every invitation workspace must belong to the actor tenant.');
        }
      }

      const invitationId = `invite_${randomUUID()}`;
      const inserted = await client.query<InvitationRow>(
        `INSERT INTO "OrganizationInvitation"
           ("id", "tenantId", "emailNormalized", "tokenHash", "organizationRole",
            "issuedBySubjectId", "expiresAt", "idempotencyKey", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, $5::"OrganizationRole", $6, $7::timestamptz, $8,
                 clock_timestamp(), clock_timestamp())
         ON CONFLICT ("tenantId", "idempotencyKey") DO NOTHING
         RETURNING *`,
        [invitationId, actor.tenantId, email, tokenHash, input.organizationRole,
          actor.subjectId, expiresAt.toISOString(), idempotencyKey],
      );
      let row = inserted.rows[0];
      const created = Boolean(row);
      if (!row) {
        const existing = await client.query<InvitationRow>(
          `SELECT * FROM "OrganizationInvitation"
           WHERE "tenantId" = $1 AND "idempotencyKey" = $2 FOR UPDATE`,
          [actor.tenantId, idempotencyKey],
        );
        row = existing.rows[0];
        if (!row || row.emailNormalized !== email || row.organizationRole !== input.organizationRole) {
          throw new GovernanceConflictError('The idempotency key is already bound to a different invitation.');
        }
      }

      if (created) {
        for (const [workspaceId, role] of uniqueGrants) {
          await client.query(
            `INSERT INTO "InvitationWorkspaceGrant" ("id", "tenantId", "invitationId", "workspaceId", "role")
             VALUES ($1, $2, $3, $4, $5::"WorkspaceRole")`,
            [`invitegrant_${randomUUID()}`, actor.tenantId, row!.id, workspaceId, role],
          );
        }
      } else {
        const existingGrants = await client.query<{ workspaceId: string; role: WorkspaceRole }>(
          `SELECT "workspaceId", "role" FROM "InvitationWorkspaceGrant" WHERE "tenantId" = $1 AND "invitationId" = $2`,
          [actor.tenantId, row.id],
        );
        const existing = new Map(existingGrants.rows.map((grant) => [grant.workspaceId, grant.role]));
        if (existing.size !== uniqueGrants.size || [...uniqueGrants].some(([id, role]) => existing.get(id) !== role)) {
          throw new GovernanceConflictError('The idempotency key is already bound to different workspace grants.');
        }
      }
      return { invitation: await invitationRecord(client, row), bearerToken: created ? bearerToken : null };
    });
  }

  async acceptInvitation(input: { bearerToken: string; subjectId: string; verifiedEmail: string }): Promise<AcceptedInvitation> {
    const token = requireIdentifier(input.bearerToken, 'bearerToken', 512);
    const subjectId = requireIdentifier(input.subjectId, 'subjectId');
    const email = normalizeEmail(input.verifiedEmail);
    return transaction(this.pool, async (client) => {
      const invitationResult = await client.query<InvitationRow>(
        `SELECT * FROM "OrganizationInvitation" WHERE "tokenHash" = $1 FOR UPDATE`,
        [hashToken(token)],
      );
      const invitation = invitationResult.rows[0];
      if (!invitation || invitation.emailNormalized !== email || invitation.revokedAt !== null || new Date(invitation.expiresAt).getTime() <= Date.now()) {
        throw new GovernanceAuthorizationError('The invitation is invalid, expired, revoked, or does not match the verified email.');
      }
      if (invitation.acceptedBySubjectId && invitation.acceptedBySubjectId !== subjectId) {
        throw new GovernanceConflictError('The invitation was already accepted by another identity.');
      }
      if (invitation.acceptedBySubjectId === subjectId) {
        const existingMembership = await client.query<MembershipRow>(
          `SELECT * FROM "OrganizationMembership" WHERE "tenantId" = $1 AND "subjectId" = $2`,
          [invitation.tenantId, subjectId],
        );
        const existingWorkspaces = await client.query<WorkspaceMembershipRow>(
          `SELECT membership.* FROM "WorkspaceMembership" AS membership
           INNER JOIN "InvitationWorkspaceGrant" AS invite_grant
             ON invite_grant."tenantId" = membership."tenantId" AND invite_grant."workspaceId" = membership."workspaceId"
           WHERE invite_grant."invitationId" = $1 AND membership."subjectId" = $2
           ORDER BY membership."workspaceId"`,
          [invitation.id, subjectId],
        );
        if (!existingMembership.rows[0]) {
          throw new GovernanceConflictError('Accepted invitation is missing its organization membership.');
        }
        return {
          invitationId: invitation.id,
          tenantId: invitation.tenantId,
          organizationMembership: mapMembership(existingMembership.rows[0]),
          workspaceMemberships: existingWorkspaces.rows.map(mapWorkspaceMembership),
        };
      }

      const membershipResult = await client.query<MembershipRow>(
        `INSERT INTO "OrganizationMembership"
           ("id", "tenantId", "subjectId", "role", "status", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4::"OrganizationRole", 'ACTIVE', clock_timestamp(), clock_timestamp())
         ON CONFLICT ("tenantId", "subjectId") DO UPDATE SET
           "role" = CASE
             WHEN "OrganizationMembership"."role" = 'OWNER' THEN 'OWNER'::"OrganizationRole"
             WHEN "OrganizationMembership"."role" = 'ADMIN' AND EXCLUDED."role" <> 'OWNER' THEN 'ADMIN'::"OrganizationRole"
             ELSE EXCLUDED."role"
           END,
           "status" = 'ACTIVE', "updatedAt" = clock_timestamp()
         RETURNING *`,
        [`orgmem_${randomUUID()}`, invitation.tenantId, subjectId, invitation.organizationRole],
      );

      const grants = await client.query<{ workspaceId: string; role: WorkspaceRole }>(
        `SELECT "workspaceId", "role" FROM "InvitationWorkspaceGrant"
         WHERE "tenantId" = $1 AND "invitationId" = $2 ORDER BY "workspaceId"`,
        [invitation.tenantId, invitation.id],
      );
      const workspaceMemberships: WorkspaceMembershipRecord[] = [];
      for (const grant of grants.rows) {
        const result = await client.query<WorkspaceMembershipRow>(
          `INSERT INTO "WorkspaceMembership"
             ("id", "tenantId", "workspaceId", "subjectId", "role", "status", "createdAt", "updatedAt")
           VALUES ($1, $2, $3, $4, $5::"WorkspaceRole", 'ACTIVE', clock_timestamp(), clock_timestamp())
           ON CONFLICT ("tenantId", "workspaceId", "subjectId") DO UPDATE SET
             "role" = CASE
               WHEN "WorkspaceMembership"."role" = 'OWNER' THEN 'OWNER'::"WorkspaceRole"
               WHEN "WorkspaceMembership"."role" = 'MANAGER' AND EXCLUDED."role" IN ('EDITOR', 'VIEWER') THEN 'MANAGER'::"WorkspaceRole"
               WHEN "WorkspaceMembership"."role" = 'EDITOR' AND EXCLUDED."role" = 'VIEWER' THEN 'EDITOR'::"WorkspaceRole"
               ELSE EXCLUDED."role"
             END,
             "status" = 'ACTIVE', "updatedAt" = clock_timestamp()
           RETURNING *`,
          [`wsmem_${randomUUID()}`, invitation.tenantId, grant.workspaceId, subjectId, grant.role],
        );
        workspaceMemberships.push(mapWorkspaceMembership(result.rows[0]!));
      }
      await client.query(
        `UPDATE "OrganizationInvitation"
         SET "acceptedBySubjectId" = $2, "acceptedAt" = COALESCE("acceptedAt", clock_timestamp()), "updatedAt" = clock_timestamp()
         WHERE "id" = $1`,
        [invitation.id, subjectId],
      );
      return {
        invitationId: invitation.id,
        tenantId: invitation.tenantId,
        organizationMembership: mapMembership(membershipResult.rows[0]!),
        workspaceMemberships,
      };
    });
  }

  async revokeInvitation(actor: GovernanceActor, invitationIdValue: string): Promise<boolean> {
    const invitationId = requireIdentifier(invitationIdValue, 'invitationId');
    return transaction(this.pool, async (client) => {
      await requireOrganizationAdmin(client, actor);
      const result = await client.query(
        `UPDATE "OrganizationInvitation" SET "revokedAt" = clock_timestamp(), "updatedAt" = clock_timestamp()
         WHERE "tenantId" = $1 AND "id" = $2 AND "acceptedAt" IS NULL AND "revokedAt" IS NULL`,
        [actor.tenantId, invitationId],
      );
      return (result.rowCount ?? 0) === 1;
    });
  }

  async setOrganizationMembership(
    actor: GovernanceActor,
    subjectIdValue: string,
    change: { role: OrganizationRole; status: MembershipStatus },
  ): Promise<OrganizationMembershipRecord> {
    const subjectId = requireIdentifier(subjectIdValue, 'subjectId');
    return transaction(this.pool, async (client) => {
      const actorRole = await requireOrganizationAdmin(client, actor);
      const targetResult = await client.query<MembershipRow>(
        `SELECT * FROM "OrganizationMembership" WHERE "tenantId" = $1 AND "subjectId" = $2 FOR UPDATE`,
        [actor.tenantId, subjectId],
      );
      const target = targetResult.rows[0];
      if (!target) throw new GovernanceValidationError('Organization member not found.');
      if ((target.role === 'OWNER' || change.role === 'OWNER') && actorRole !== 'OWNER') throw new GovernanceAuthorizationError();
      if (target.role === 'OWNER' && (change.role !== 'OWNER' || change.status !== 'ACTIVE')) {
        await this.requireAnotherOwner(client, actor.tenantId, subjectId);
      }
      const updated = await client.query<MembershipRow>(
        `UPDATE "OrganizationMembership" SET "role" = $3::"OrganizationRole", "status" = $4::"MembershipStatus",
           "updatedAt" = clock_timestamp()
         WHERE "tenantId" = $1 AND "subjectId" = $2 RETURNING *`,
        [actor.tenantId, subjectId, change.role, change.status],
      );
      return mapMembership(updated.rows[0]!);
    });
  }

  async removeOrganizationMember(actor: GovernanceActor, subjectIdValue: string): Promise<boolean> {
    const subjectId = requireIdentifier(subjectIdValue, 'subjectId');
    return transaction(this.pool, async (client) => {
      const actorRole = await requireOrganizationAdmin(client, actor);
      const target = await client.query<{ role: OrganizationRole }>(
        `SELECT "role" FROM "OrganizationMembership" WHERE "tenantId" = $1 AND "subjectId" = $2 FOR UPDATE`,
        [actor.tenantId, subjectId],
      );
      if (!target.rows[0]) return false;
      if (target.rows[0].role === 'OWNER') {
        if (actorRole !== 'OWNER') throw new GovernanceAuthorizationError();
        await this.requireAnotherOwner(client, actor.tenantId, subjectId);
      }
      const result = await client.query(
        `DELETE FROM "OrganizationMembership" WHERE "tenantId" = $1 AND "subjectId" = $2`,
        [actor.tenantId, subjectId],
      );
      return (result.rowCount ?? 0) === 1;
    });
  }

  async grantWorkspaceMembership(
    actor: GovernanceActor,
    input: { workspaceId: string; subjectId: string; role: WorkspaceRole },
  ): Promise<WorkspaceMembershipRecord> {
    const workspaceId = requireIdentifier(input.workspaceId, 'workspaceId');
    const subjectId = requireIdentifier(input.subjectId, 'subjectId');
    return transaction(this.pool, async (client) => {
      const org = await client.query<{ role: OrganizationRole }>(
        `SELECT "role" FROM "OrganizationMembership"
         WHERE "tenantId" = $1 AND "subjectId" = $2 AND "status" = 'ACTIVE'`,
        [actor.tenantId, actor.subjectId],
      );
      const workspace = await client.query<{ role: WorkspaceRole }>(
        `SELECT "role" FROM "WorkspaceMembership"
         WHERE "tenantId" = $1 AND "workspaceId" = $2 AND "subjectId" = $3 AND "status" = 'ACTIVE'`,
        [actor.tenantId, workspaceId, actor.subjectId],
      );
      const orgRole = org.rows[0]?.role;
      const workspaceRole = workspace.rows[0]?.role;
      const mayAdmin = orgRole === 'OWNER' || orgRole === 'ADMIN';
      const mayManage = workspaceRole === 'OWNER' || workspaceRole === 'MANAGER';
      if (!mayAdmin && !mayManage) throw new GovernanceAuthorizationError();
      if (input.role === 'OWNER' && orgRole !== 'OWNER') throw new GovernanceAuthorizationError();
      if (input.role === 'MANAGER' && !mayAdmin && workspaceRole !== 'OWNER') throw new GovernanceAuthorizationError();

      const target = await client.query(
        `SELECT 1 FROM "OrganizationMembership"
         WHERE "tenantId" = $1 AND "subjectId" = $2 AND "status" = 'ACTIVE' FOR SHARE`,
        [actor.tenantId, subjectId],
      );
      if ((target.rowCount ?? 0) !== 1) throw new GovernanceValidationError('Workspace access requires an active organization membership.');
      const result = await client.query<WorkspaceMembershipRow>(
        `INSERT INTO "WorkspaceMembership"
           ("id", "tenantId", "workspaceId", "subjectId", "role", "status", "createdAt", "updatedAt")
         SELECT $1, $2, "id", $4, $5::"WorkspaceRole", 'ACTIVE', clock_timestamp(), clock_timestamp()
         FROM "Workspace" WHERE "tenantId" = $2 AND "id" = $3
         ON CONFLICT ("tenantId", "workspaceId", "subjectId") DO UPDATE SET
           "role" = EXCLUDED."role", "status" = 'ACTIVE', "updatedAt" = clock_timestamp()
         RETURNING *`,
        [`wsmem_${randomUUID()}`, actor.tenantId, workspaceId, subjectId, input.role],
      );
      if (!result.rows[0]) throw new GovernanceValidationError('Workspace not found in this tenant.');
      return mapWorkspaceMembership(result.rows[0]);
    });
  }

  async removeWorkspaceMembership(actor: GovernanceActor, workspaceIdValue: string, subjectIdValue: string): Promise<boolean> {
    const workspaceId = requireIdentifier(workspaceIdValue, 'workspaceId');
    const subjectId = requireIdentifier(subjectIdValue, 'subjectId');
    return transaction(this.pool, async (client) => {
      const org = await client.query<{ role: OrganizationRole }>(
        `SELECT "role" FROM "OrganizationMembership"
         WHERE "tenantId" = $1 AND "subjectId" = $2 AND "status" = 'ACTIVE'`,
        [actor.tenantId, actor.subjectId],
      );
      const workspace = await client.query<{ role: WorkspaceRole }>(
        `SELECT "role" FROM "WorkspaceMembership"
         WHERE "tenantId" = $1 AND "workspaceId" = $2 AND "subjectId" = $3 AND "status" = 'ACTIVE'`,
        [actor.tenantId, workspaceId, actor.subjectId],
      );
      if (!['OWNER', 'ADMIN'].includes(org.rows[0]?.role ?? '') && !['OWNER', 'MANAGER'].includes(workspace.rows[0]?.role ?? '')) {
        throw new GovernanceAuthorizationError();
      }
      const target = await client.query<{ role: WorkspaceRole }>(
        `SELECT "role" FROM "WorkspaceMembership"
         WHERE "tenantId" = $1 AND "workspaceId" = $2 AND "subjectId" = $3 FOR UPDATE`,
        [actor.tenantId, workspaceId, subjectId],
      );
      if (!target.rows[0]) return false;
      if (target.rows[0].role === 'OWNER') {
        const other = await client.query(
          `SELECT 1 FROM "WorkspaceMembership"
           WHERE "tenantId" = $1 AND "workspaceId" = $2 AND "subjectId" <> $3
             AND "role" = 'OWNER' AND "status" = 'ACTIVE' FOR SHARE`,
          [actor.tenantId, workspaceId, subjectId],
        );
        if ((other.rowCount ?? 0) === 0) throw new GovernanceConflictError('A workspace must retain at least one active owner.');
      }
      const result = await client.query(
        `DELETE FROM "WorkspaceMembership" WHERE "tenantId" = $1 AND "workspaceId" = $2 AND "subjectId" = $3`,
        [actor.tenantId, workspaceId, subjectId],
      );
      return (result.rowCount ?? 0) === 1;
    });
  }

  private async requireAnotherOwner(client: GovernanceSqlClient, tenantId: string, excludedSubject: string): Promise<void> {
    const owners = await client.query(
      `SELECT 1 FROM "OrganizationMembership"
       WHERE "tenantId" = $1 AND "subjectId" <> $2 AND "role" = 'OWNER' AND "status" = 'ACTIVE'
       FOR SHARE`,
      [tenantId, excludedSubject],
    );
    if ((owners.rowCount ?? 0) === 0) throw new GovernanceConflictError('An organization must retain at least one active owner.');
  }
}
