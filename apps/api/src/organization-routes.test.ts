import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { generateKeyPair, SignJWT } from 'jose';
import { InMemorySearchStore } from '@sentinel/search-store';
import { InMemoryAuditLogger } from '@sentinel/security';
import {
  GovernanceAuthorizationError,
  GovernanceConflictError,
  GovernanceValidationError,
  type AcceptedInvitation,
  type IssuedInvitation,
  type OrganizationMembershipRecord,
  type TenantErasureRequestRecord,
  type WorkspaceMembershipRecord,
} from '@sentinel/db';
import { buildApp, type AppDeps } from './app';
import { createAppTestServices } from './app.test-support';
import type { CatalogScanResult } from './catalog-scan';

const ISSUER = 'https://identity.example/realms/sentinel';
const AUDIENCE = 'sentinel-api';
type KeyPair = Awaited<ReturnType<typeof generateKeyPair>>;
let privateKey: KeyPair['privateKey'];
let publicKey: KeyPair['publicKey'];

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  publicKey = pair.publicKey;
});

const organizationMember: OrganizationMembershipRecord = {
  id: 'orgmem-1', tenantId: 'tenant-a', subjectId: 'admin-1', role: 'OWNER', status: 'ACTIVE',
  createdAt: '2026-07-23T00:00:00.000Z', updatedAt: '2026-07-23T00:00:00.000Z',
};
const workspaceMembership: WorkspaceMembershipRecord = {
  id: 'wsmem-1', tenantId: 'tenant-a', workspaceId: 'workspace-1', subjectId: 'admin-1', role: 'OWNER', status: 'ACTIVE',
  createdAt: '2026-07-23T00:00:00.000Z', updatedAt: '2026-07-23T00:00:00.000Z',
};
const issuedInvitation: IssuedInvitation = {
  invitation: {
    id: 'invite-1', tenantId: 'tenant-a', emailNormalized: 'new@example.com', organizationRole: 'MEMBER',
    issuedBySubjectId: 'admin-1', acceptedBySubjectId: null, expiresAt: '2026-07-30T00:00:00.000Z',
    acceptedAt: null, revokedAt: null, idempotencyKey: 'request-key-1', workspaceGrants: [],
    createdAt: '2026-07-23T00:00:00.000Z', updatedAt: '2026-07-23T00:00:00.000Z',
  },
  bearerToken: 'one-time-bearer',
};
const acceptedInvitation: AcceptedInvitation = {
  invitationId: 'invite-1', tenantId: 'tenant-a', organizationMembership: organizationMember,
  workspaceMemberships: [workspaceMembership],
};
const erasureRequest: TenantErasureRequestRecord = {
  id: 'erase-1', tenantId: 'tenant-a', tenantHash: 'private-tenant-hash',
  requestedBySubjectHash: 'private-subject-hash', pseudonymKeyVersion: 'kms-key-arn',
  idempotencyKey: 'erase-request-001', reason: 'Close this organization account.',
  status: 'PENDING', attempts: 0, leaseToken: null, leaseExpiresAt: null, lastError: null,
  createdAt: '2026-07-23T00:00:00.000Z', completedAt: null,
  steps: [{
    id: 'step-1', requestId: 'erase-1', resourceKind: 'steel_sessions', status: 'PENDING',
    deletedCount: 0n, checkpoint: {}, legalBasis: null, lastError: null,
    startedAt: null, completedAt: null,
  }],
};

const catalogResult = (artist: string): CatalogScanResult => ({
  artist,
  stores: ['spotify'],
  profiles: [],
  tracks: [],
  summary: { tracks: 0, live: 0, notLive: 0, wrongProfile: 0, needsReview: 0 },
  generatedAt: '2026-07-23T00:00:00.000Z',
  warnings: [],
  note: '',
});

function organizationService(overrides: Partial<NonNullable<AppDeps['organization']>> = {}) {
  let issueCount = 0;
  return {
    provisionPersonalOrganization: vi.fn(async (tenantId: string, subjectId: string) => ({
      tenantId,
      workspaceId: workspaceMembership.workspaceId,
      created: false,
      organizationMembership: { ...organizationMember, tenantId, subjectId },
      workspaceMembership: { ...workspaceMembership, tenantId, subjectId },
    })),
    listOrganizationMembers: vi.fn(async () => [organizationMember]),
    listWorkspaceMemberships: vi.fn(async () => [workspaceMembership]),
    hasWorkspaceCapability: vi.fn(async () => true),
    setOrganizationMembership: vi.fn(async () => organizationMember),
    removeOrganizationMember: vi.fn(async () => true),
    grantWorkspaceMembership: vi.fn(async () => workspaceMembership),
    removeWorkspaceMembership: vi.fn(async () => true),
    issueInvitation: vi.fn(async (actor) => {
      if (actor.subjectId !== 'admin-1') throw new GovernanceAuthorizationError();
      return {
        ...issuedInvitation,
        bearerToken: issueCount++ === 0 ? issuedInvitation.bearerToken : null,
      };
    }),
    revokeInvitation: vi.fn(async () => true),
    acceptInvitation: vi.fn(async () => acceptedInvitation),
    ...overrides,
  } as NonNullable<AppDeps['organization']>;
}

async function bearer(
  roles: string[],
  claims: { sub?: string; email?: string; emailVerified?: boolean; tenantId?: string; omitTenantId?: boolean } = {},
): Promise<string> {
  return new SignJWT({
    ...(!claims.omitTenantId ? { tenant_id: claims.tenantId ?? 'tenant-a' } : {}),
    realm_access: { roles },
    ...(claims.email ? { email: claims.email, email_verified: claims.emailVerified === true } : {}),
  })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(claims.sub ?? 'admin-1')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}

async function testApp(organization: NonNullable<AppDeps['organization']>, extras: Partial<AppDeps> = {}) {
  const app = buildApp({
    ...createAppTestServices(),
    organization,
    authConfig: { enabled: true, issuer: ISSUER, audience: AUDIENCE, keyInput: publicKey },
    ...extras,
  });
  await app.ready();
  return app;
}

const openApps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

describe('organization membership API', () => {
  it('returns role-derived UI capabilities without trusting token roles', async () => {
    const auditorMembership = { ...organizationMember, subjectId: 'auditor-1', role: 'AUDITOR' as const };
    const organization = organizationService({
      listOrganizationMembers: vi.fn(async () => [organizationMember, auditorMembership]),
    });
    const app = await testApp(organization);
    openApps.push(app);
    const response = await app.inject({
      method: 'GET', url: '/api/organization/members',
      headers: { authorization: `Bearer ${await bearer(['tenant_admin'], { sub: 'auditor-1' })}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      capabilities: {
        role: 'AUDITOR',
        manageOrganizationMembers: false,
        manageOwners: false,
        issueInvitations: false,
        requestTenantErasure: false,
      },
    });
  });

  it('invokes trusted idempotent personal provisioning only for a verified home tenant equal to subject', async () => {
    const organization = organizationService();
    const app = await testApp(organization);
    openApps.push(app);
    const response = await app.inject({
      method: 'GET', url: '/api/organization/workspace-memberships',
      headers: { authorization: `Bearer ${await bearer(['artist_manager'], { sub: 'google-sub-1', tenantId: 'google-sub-1' })}` },
    });
    expect(response.statusCode).toBe(200);
    expect(organization.provisionPersonalOrganization).toHaveBeenCalledWith('google-sub-1', 'google-sub-1');

    await app.inject({
      method: 'GET', url: '/api/organization/workspace-memberships',
      headers: { authorization: `Bearer ${await bearer(['artist_manager'], { sub: 'subject-2', tenantId: 'managed-org' })}` },
    });
    expect(organization.provisionPersonalOrganization).toHaveBeenCalledTimes(1);
  });

  it('falls back from an unauthorized broker tenant claim to a personal workspace keyed by Keycloak subject', async () => {
    const listWorkspaceMemberships = vi.fn(async (actor: { tenantId: string; subjectId: string }) => {
      if (actor.tenantId === 'google-external-subject') throw new GovernanceAuthorizationError();
      return [{ ...workspaceMembership, tenantId: actor.tenantId, subjectId: actor.subjectId }];
    });
    const organization = organizationService({ listWorkspaceMemberships });
    const app = await testApp(organization);
    openApps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: '/api/organization/workspace-memberships',
      headers: {
        authorization: `Bearer ${await bearer(['artist_manager'], {
          sub: 'keycloak-user-id',
          tenantId: 'google-external-subject',
        })}`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(organization.provisionPersonalOrganization).toHaveBeenCalledWith(
      'keycloak-user-id',
      'keycloak-user-id',
    );
    expect(listWorkspaceMemberships).toHaveBeenCalledWith({
      tenantId: 'google-external-subject',
      subjectId: 'keycloak-user-id',
    });
    expect(listWorkspaceMemberships).toHaveBeenCalledWith(
      { tenantId: 'keycloak-user-id', subjectId: 'keycloak-user-id' },
      undefined,
    );
  });

  it('provisions a personal workspace for a signed token without a custom tenant claim', async () => {
    const organization = organizationService();
    const app = await testApp(organization);
    openApps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: '/api/organization/workspace-memberships',
      headers: {
        authorization: `Bearer ${await bearer(['user'], {
          sub: 'self-registered-user',
          omitTenantId: true,
        })}`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(organization.provisionPersonalOrganization).toHaveBeenCalledWith(
      'self-registered-user',
      'self-registered-user',
    );
  });

  it('lets an ordinary user grant scan consent in the provisioned personal workspace without an organization field', async () => {
    const organization = organizationService();
    const app = await testApp(organization);
    openApps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/api/consent',
      headers: {
        authorization: `Bearer ${await bearer(['user'], {
          sub: 'personal-scan-user',
          omitTenantId: true,
        })}`,
      },
      payload: {
        distributor: 'distrokid',
        scope: 'distributor:read-catalog',
        provider: 'steel',
      },
    });

    expect(response.statusCode).toBe(201);
    expect(organization.hasWorkspaceCapability).toHaveBeenCalledWith(
      { tenantId: 'personal-scan-user', subjectId: 'personal-scan-user' },
      'workspace-1',
      'EDIT',
    );
  });

  it('uses only the verified tenant and subject when listing membership and capabilities', async () => {
    const organization = organizationService();
    const app = await testApp(organization);
    openApps.push(app);
    const response = await app.inject({
      method: 'GET', url: '/api/organization/workspace-memberships',
      headers: { authorization: `Bearer ${await bearer(['user'], { sub: 'user-7' })}`, 'x-tenant-id': 'attacker' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.json()).toMatchObject({
      memberships: [{ workspaceId: 'workspace-1' }],
      workspaces: [{ id: 'workspace-1', canRead: true, canEdit: true, canManageMembers: true }],
    });
    expect(organization.listWorkspaceMemberships).toHaveBeenCalledWith(
      { tenantId: 'tenant-a', subjectId: 'user-7' }, undefined,
    );
    expect(organization.hasWorkspaceCapability).toHaveBeenCalledWith(
      { tenantId: 'tenant-a', subjectId: 'user-7' }, 'workspace-1', 'EDIT',
    );
  });

  it('lets an owner request and monitor comprehensive erasure without exposing pseudonym or lease data', async () => {
    const tenantErasure: NonNullable<AppDeps['tenantErasure']> = {
      request: vi.fn(async () => erasureRequest),
      get: vi.fn(async () => erasureRequest),
    };
    const app = await testApp(organizationService(), { tenantErasure });
    openApps.push(app);
    const authorization = `Bearer ${await bearer(['tenant_admin'])}`;
    const created = await app.inject({
      method: 'POST',
      url: '/api/organization/erasure-requests',
      headers: { authorization, 'idempotency-key': 'erase-request-001' },
      payload: { reason: 'Close this organization account.' },
    });
    expect(created.statusCode).toBe(202);
    expect(tenantErasure.request).toHaveBeenCalledWith(
      { tenantId: 'tenant-a', subjectId: 'admin-1' },
      { idempotencyKey: 'erase-request-001', reason: 'Close this organization account.' },
    );
    expect(created.json()).toMatchObject({
      id: 'erase-1', status: 'PENDING', steps: [{ resource: 'steel_sessions', deletedCount: '0' }],
    });
    expect(created.body).not.toContain('private-tenant-hash');
    expect(created.body).not.toContain('private-subject-hash');
    expect(created.body).not.toContain('leaseToken');

    const status = await app.inject({
      method: 'GET', url: '/api/organization/erasure-requests/erase-1', headers: { authorization },
    });
    expect(status.statusCode).toBe(200);
    expect(tenantErasure.get).toHaveBeenCalledWith(
      { tenantId: 'tenant-a', subjectId: 'admin-1' }, 'erase-1',
    );
  });

  it('does not recreate an erased personal tenant while its original requester reads the retained receipt', async () => {
    const organization = organizationService();
    const completed = { ...erasureRequest, tenantId: null, status: 'SUCCEEDED' as const };
    const tenantErasure: NonNullable<AppDeps['tenantErasure']> = {
      request: vi.fn(async () => completed),
      get: vi.fn(async () => completed),
    };
    const app = await testApp(organization, { tenantErasure });
    openApps.push(app);
    const authorization = `Bearer ${await bearer(['tenant_admin'], {
      sub: 'erased-personal-owner', tenantId: 'erased-personal-owner',
    })}`;

    const status = await app.inject({
      method: 'GET', url: '/api/organization/erasure-requests/erase-1', headers: { authorization },
    });

    expect(status.statusCode).toBe(200);
    expect(organization.provisionPersonalOrganization).not.toHaveBeenCalled();
    expect(tenantErasure.get).toHaveBeenCalledWith(
      { tenantId: 'erased-personal-owner', subjectId: 'erased-personal-owner' }, 'erase-1',
    );
  });

  it('does not provision a personal tenant when the caller explicitly selects an existing organization', async () => {
    const organization = organizationService();
    const app = await testApp(organization);
    openApps.push(app);
    const response = await app.inject({
      method: 'GET',
      url: '/api/organization/workspace-memberships',
      headers: {
        authorization: `Bearer ${await bearer(['user'], { sub: 'same-subject', tenantId: 'same-subject' })}`,
        'x-sentinel-organization-id': 'shared-org',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(organization.provisionPersonalOrganization).not.toHaveBeenCalled();
    expect(organization.listWorkspaceMemberships).toHaveBeenCalledWith(
      { tenantId: 'shared-org', subjectId: 'same-subject' },
    );
  });

  it('defers exact OWNER/ADMIN authority to the repository and returns the bearer only once', async () => {
    const organization = organizationService();
    const app = await testApp(organization);
    openApps.push(app);
    const payload = {
      email: 'new@example.com', organizationRole: 'MEMBER', workspaceGrants: [],
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    };
    const manager = await app.inject({
      method: 'POST', url: '/api/organization/invitations', payload,
      headers: { authorization: `Bearer ${await bearer(['artist_manager'], { sub: 'member-1' })}`, 'idempotency-key': 'request-key-1' },
    });
    expect(manager.statusCode).toBe(403);
    expect(organization.issueInvitation).toHaveBeenCalledWith(
      { tenantId: 'tenant-a', subjectId: 'member-1' }, expect.any(Object),
    );

    const headers = { authorization: `Bearer ${await bearer(['user'])}`, 'idempotency-key': 'request-key-1' };
    const created = await app.inject({ method: 'POST', url: '/api/organization/invitations', payload, headers });
    const replay = await app.inject({ method: 'POST', url: '/api/organization/invitations', payload, headers });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ bearerToken: 'one-time-bearer' });
    expect(created.headers['cache-control']).toContain('no-store');
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ bearerToken: null });
  });

  it('never binds an invitation to an unverified email claim', async () => {
    const organization = organizationService();
    const app = await testApp(organization);
    openApps.push(app);
    const unverified = await app.inject({
      method: 'POST', url: '/api/organization/invitations/accept', payload: { bearerToken: 'secret-token' },
      headers: { authorization: `Bearer ${await bearer(['user'], { email: 'new@example.com', emailVerified: false, sub: 'new-user' })}` },
    });
    expect(unverified.statusCode).toBe(403);
    expect(organization.acceptInvitation).not.toHaveBeenCalled();

    const verified = await app.inject({
      method: 'POST', url: '/api/organization/invitations/accept', payload: { bearerToken: 'secret-token' },
      headers: { authorization: `Bearer ${await bearer(['user'], { email: 'New@Example.com', emailVerified: true, sub: 'new-user' })}` },
    });
    expect(verified.statusCode).toBe(200);
    expect(organization.acceptInvitation).toHaveBeenCalledWith({
      bearerToken: 'secret-token', subjectId: 'new-user', verifiedEmail: 'new@example.com',
    });
  });

  it('allows an accepted subject to select the invited organization only through DB membership checks', async () => {
    const organization = organizationService({
      acceptInvitation: vi.fn(async () => ({ ...acceptedInvitation, tenantId: 'shared-org' })),
    });
    const app = await testApp(organization);
    openApps.push(app);
    const authorization = `Bearer ${await bearer(['user'], {
      email: 'new@example.com', emailVerified: true, sub: 'new-user', tenantId: 'personal-home',
    })}`;
    const accepted = await app.inject({
      method: 'POST', url: '/api/organization/invitations/accept',
      payload: { bearerToken: 'secret-token' }, headers: { authorization },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ tenantId: 'shared-org' });

    const selected = await app.inject({
      method: 'GET', url: '/api/organization/workspace-memberships',
      headers: { authorization, 'x-sentinel-organization-id': 'shared-org' },
    });
    expect(selected.statusCode).toBe(200);
    expect(organization.listWorkspaceMemberships).toHaveBeenLastCalledWith(
      { tenantId: 'shared-org', subjectId: 'new-user' }, undefined,
    );
    expect(organization.hasWorkspaceCapability).toHaveBeenCalledWith(
      { tenantId: 'shared-org', subjectId: 'new-user' }, 'workspace-1', 'READ',
    );
  });

  it('maps governance conflicts to a safe HTTP response without exposing repository detail', async () => {
    const organization = organizationService({
      setOrganizationMembership: vi.fn(async () => {
        throw new GovernanceConflictError('internal owner invariant detail');
      }),
    });
    const app = await testApp(organization);
    openApps.push(app);
    const response = await app.inject({
      method: 'PATCH', url: '/api/organization/members/member-2',
      payload: { role: 'MEMBER', status: 'ACTIVE' },
      headers: { authorization: `Bearer ${await bearer(['tenant_admin'])}` },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'organization change conflicts with current state' });
    expect(response.body).not.toContain('internal owner invariant detail');
  });

  it.each([
    [new GovernanceValidationError('internal validation detail'), 400, 'invalid organization request'],
    [new GovernanceAuthorizationError('internal authorization detail'), 403, 'organization access denied'],
    [new Error('database endpoint detail'), 503, 'organization service unavailable'],
  ])('maps %s without reflecting repository detail', async (failure, status, message) => {
    const organization = organizationService({
      listOrganizationMembers: vi.fn(async () => { throw failure; }),
    });
    const app = await testApp(organization);
    openApps.push(app);
    const response = await app.inject({
      method: 'GET', url: '/api/organization/members',
      headers: { authorization: `Bearer ${await bearer(['user'])}` },
    });
    expect(response.statusCode).toBe(status);
    expect(response.json()).toEqual({ error: message });
    expect(response.body).not.toContain(failure.message);
  });

  it('denies a client-selected workspace before consent or search creation', async () => {
    const organization = organizationService({ hasWorkspaceCapability: vi.fn(async () => false) });
    const scan = vi.fn();
    const app = await testApp(organization, { runFastCatalogScan: scan });
    openApps.push(app);
    const authorization = `Bearer ${await bearer(['artist_manager'], { sub: 'manager-1' })}`;
    const consent = await app.inject({
      method: 'POST', url: '/api/consent', headers: { authorization },
      payload: {
        artistWorkspaceId: 'workspace-denied', distributor: 'distrokid',
        scope: 'distributor:read-catalog', provider: 'steel',
      },
    });
    const search = await app.inject({
      method: 'POST', url: '/api/searches', headers: { authorization },
      payload: { artistWorkspaceId: 'workspace-denied', artist: 'Authorized Artist' },
    });
    expect(consent.statusCode).toBe(403);
    expect(search.statusCode).toBe(403);
    expect(scan).not.toHaveBeenCalled();
    expect(organization.hasWorkspaceCapability).toHaveBeenCalledWith(
      { tenantId: 'tenant-a', subjectId: 'manager-1' }, 'workspace-denied', 'EDIT',
    );
  });

  it('rejects an arbitrary selected organization before any customer operation uses its tenant id', async () => {
    const organization = organizationService({
      listWorkspaceMemberships: vi.fn(async (actor) => {
        if (actor.tenantId === 'victim-org') throw new GovernanceAuthorizationError();
        return [workspaceMembership];
      }),
    });
    const app = await testApp(organization);
    openApps.push(app);
    const response = await app.inject({
      method: 'POST', url: '/api/consent',
      headers: {
        authorization: `Bearer ${await bearer(['tenant_admin'], { sub: 'attacker', tenantId: 'attacker-home' })}`,
        'x-sentinel-organization-id': 'victim-org',
      },
      payload: {
        artistWorkspaceId: 'victim-workspace', distributor: 'distrokid',
        scope: 'distributor:read-catalog', provider: 'steel',
      },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'organization access denied' });
    expect(response.headers['x-sentinel-organization-selection']).toBe('invalid');
    expect(organization.hasWorkspaceCapability).not.toHaveBeenCalled();
  });

  it('keeps Steel readiness independent from an unauthorized optional organization selector', async () => {
    const organization = organizationService({
      listWorkspaceMemberships: vi.fn(async () => {
        throw new GovernanceAuthorizationError();
      }),
    });
    const app = await testApp(organization);
    openApps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: '/api/integrations/steel/status',
      headers: {
        authorization: `Bearer ${await bearer(['user'], { sub: 'personal-user' })}`,
        'x-sentinel-organization-id': 'revoked-team',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(organization.listWorkspaceMemberships).not.toHaveBeenCalled();
  });

  it('keeps selected-organization history, queue jobs, and audit records in one tenant context', async () => {
    const store = new InMemorySearchStore();
    const audit = new InMemoryAuditLogger();
    const enqueue = vi.fn(async () => {});
    const createShared = (artist: string) => store.save({
      tenantId: 'shared-org',
      ownerUserId: 'catalog-owner',
      artistWorkspaceId: 'workspace-1',
      artist,
      distributor: 'distrokid',
    }, catalogResult(artist));
    const renameSource = await createShared('Rename artist');
    const deleteSource = await createShared('Delete artist');
    const rescanSource = await createShared('Rescan artist');
    const organization = organizationService({
      listWorkspaceMemberships: vi.fn(async (actor) => [{
        ...workspaceMembership,
        tenantId: actor.tenantId,
        subjectId: actor.subjectId,
        role: 'EDITOR' as const,
      }]),
      listOrganizationMembers: vi.fn(async (actor) => [{
        ...organizationMember,
        tenantId: actor.tenantId,
        subjectId: actor.subjectId,
        role: 'MEMBER' as const,
      }]),
    });
    const app = await testApp(organization, {
      searchStore: store,
      auditLogger: audit,
      enqueueDeepScan: enqueue,
      runFastCatalogScan: vi.fn(async (artist: string) => catalogResult(artist)),
    });
    openApps.push(app);
    const headers = {
      authorization: `Bearer ${await bearer(['artist_manager'], { sub: 'invited-editor', tenantId: 'personal-home' })}`,
      'x-sentinel-organization-id': 'shared-org',
    };

    const renamed = await app.inject({
      method: 'PATCH', url: `/api/searches/${renameSource.id}`, headers, payload: { name: 'Team scan' },
    });
    const removed = await app.inject({
      method: 'DELETE', url: `/api/searches/${deleteSource.id}`, headers,
    });
    const rescanned = await app.inject({
      method: 'POST', url: `/api/searches/${rescanSource.id}/rescan`, headers, payload: {},
    });

    expect([renamed.statusCode, removed.statusCode, rescanned.statusCode]).toEqual([200, 204, 201]);
    expect(enqueue).toHaveBeenCalledWith(rescanned.json().id, 'shared-org');
    const relevantAudits = (await audit.list()).filter((record) => [
      'catalog.search.renamed',
      'catalog.search.deleted',
      'catalog.search.platform-recheck.created',
    ].includes(record.action));
    expect(relevantAudits).toHaveLength(3);
    expect(relevantAudits.every((record) =>
      record.tenantId === 'shared-org' && record.workspaceId === 'workspace-1')).toBe(true);
  });
});
