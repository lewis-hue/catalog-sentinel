/** Immutable authentication identity supplied by the verified OIDC principal. */
export interface GovernanceActor {
  tenantId: string;
  subjectId: string;
}

export type OrganizationRole = 'OWNER' | 'ADMIN' | 'MEMBER' | 'AUDITOR' | 'BILLING';
export type WorkspaceRole = 'OWNER' | 'MANAGER' | 'EDITOR' | 'VIEWER';
export type MembershipStatus = 'ACTIVE' | 'SUSPENDED';
export type GovernanceJobStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
export type GovernanceStepStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'SKIPPED_LEGAL_HOLD';

export interface OrganizationMembershipRecord {
  id: string;
  tenantId: string;
  subjectId: string;
  role: OrganizationRole;
  status: MembershipStatus;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceMembershipRecord {
  id: string;
  tenantId: string;
  workspaceId: string;
  subjectId: string;
  role: WorkspaceRole;
  status: MembershipStatus;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceInvitationGrant {
  workspaceId: string;
  role: WorkspaceRole;
}

export interface OrganizationInvitationRecord {
  id: string;
  tenantId: string;
  emailNormalized: string;
  organizationRole: OrganizationRole;
  issuedBySubjectId: string;
  acceptedBySubjectId: string | null;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
  idempotencyKey: string;
  workspaceGrants: WorkspaceInvitationGrant[];
  createdAt: string;
  updatedAt: string;
}

export interface IssuedInvitation {
  invitation: OrganizationInvitationRecord;
  /** Present only for the transaction that created the invitation. Never persisted. */
  bearerToken: string | null;
}

export interface AcceptedInvitation {
  invitationId: string;
  tenantId: string;
  organizationMembership: OrganizationMembershipRecord;
  workspaceMemberships: WorkspaceMembershipRecord[];
}

export interface TenantErasureStepRecord {
  id: string;
  requestId: string;
  resourceKind: string;
  status: GovernanceStepStatus;
  deletedCount: bigint;
  checkpoint: Record<string, unknown>;
  legalBasis: string | null;
  lastError: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface TenantErasureRequestRecord {
  id: string;
  tenantId: string | null;
  tenantHash: string;
  requestedBySubjectHash: string;
  pseudonymKeyVersion: string;
  idempotencyKey: string;
  reason: string;
  status: GovernanceJobStatus;
  attempts: number;
  leaseToken: string | null;
  leaseExpiresAt: string | null;
  lastError: string | null;
  steps: TenantErasureStepRecord[];
  createdAt: string;
  completedAt: string | null;
}

export interface RetentionPolicyRecord {
  id: string;
  tenantId: string | null;
  resourceKind: string;
  retentionDays: number;
  deletionGraceDays: number;
  enabled: boolean;
  version: number;
  nextRunAt: string;
  updatedBySubjectId: string;
}

export interface RetentionRunRecord {
  id: string;
  policyId: string;
  tenantId: string | null;
  resourceKind: string;
  status: GovernanceJobStatus;
  cutoffAt: string;
  cursor: Record<string, unknown>;
  deletedCount: bigint;
  attempts: number;
  leaseToken: string | null;
  leaseExpiresAt: string | null;
  lastError: string | null;
}

export interface GovernanceSqlResult<Row> {
  rows: Row[];
  rowCount?: number | null;
}

export interface GovernanceSqlClient {
  query<Row = Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<GovernanceSqlResult<Row>>;
  release(error?: Error): void;
}

export interface GovernanceSqlPool {
  connect(): Promise<GovernanceSqlClient>;
}

export class GovernanceAuthorizationError extends Error {
  constructor(message = 'The authenticated subject is not authorized for this tenant resource.') {
    super(message);
    this.name = 'GovernanceAuthorizationError';
  }
}

export class GovernanceConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GovernanceConflictError';
  }
}

export class GovernanceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GovernanceValidationError';
  }
}
