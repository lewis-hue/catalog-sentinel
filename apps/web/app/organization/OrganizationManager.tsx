'use client';

import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import {
  activeOrganizationId,
  apiFetch,
  selectActiveOrganization,
} from '@/lib/api-client';

type OrganizationRole = 'OWNER' | 'ADMIN' | 'MEMBER' | 'AUDITOR' | 'BILLING';
type WorkspaceRole = 'OWNER' | 'MANAGER' | 'EDITOR' | 'VIEWER';
type MembershipStatus = 'ACTIVE' | 'SUSPENDED';

interface OrganizationMember {
  id: string;
  subjectId: string;
  role: OrganizationRole;
  status: MembershipStatus;
  updatedAt: string;
}

interface WorkspaceMembership {
  id: string;
  workspaceId: string;
  subjectId: string;
  role: WorkspaceRole;
  status: MembershipStatus;
}

interface WorkspaceSummary {
  id: string;
  canRead: boolean;
  canEdit: boolean;
  canManageMembers: boolean;
}

interface OrganizationCapabilities {
  role: OrganizationRole | null;
  manageOrganizationMembers: boolean;
  manageOwners: boolean;
  issueInvitations: boolean;
  requestTenantErasure: boolean;
}

const NO_ORGANIZATION_CAPABILITIES: OrganizationCapabilities = {
  role: null,
  manageOrganizationMembers: false,
  manageOwners: false,
  issueInvitations: false,
  requestTenantErasure: false,
};

interface IssuedInvitation {
  invitation: { id: string; tenantId: string; emailNormalized: string; expiresAt: string };
  bearerToken: string | null;
}

interface ErasureRequest {
  id: string;
  status: string;
  reason: string;
  createdAt: string;
  completedAt: string | null;
  steps: Array<{ resource: string; status: string; deletedCount: string; legalBasis: string | null; lastError: string | null }>;
}

async function responseError(response: Response, fallback: string): Promise<string> {
  const body = (await response.json().catch(() => ({}))) as { error?: unknown };
  return typeof body.error === 'string' && body.error.trim() ? body.error : `${fallback} (HTTP ${response.status}).`;
}

export function OrganizationManager() {
  const [members, setMembers] = useState<OrganizationMember[] | null>(null);
  const [membersNotice, setMembersNotice] = useState('');
  const [workspaceMemberships, setWorkspaceMemberships] = useState<WorkspaceMembership[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [organizationId, setOrganizationId] = useState('');
  const [capabilities, setCapabilities] = useState<OrganizationCapabilities>(NO_ORGANIZATION_CAPABILITIES);

  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteOrgRole, setInviteOrgRole] = useState<OrganizationRole>('MEMBER');
  const [inviteWorkspaceId, setInviteWorkspaceId] = useState('');
  const [inviteWorkspaceRole, setInviteWorkspaceRole] = useState<WorkspaceRole>('VIEWER');
  const [issuedInvitation, setIssuedInvitation] = useState<IssuedInvitation | null>(null);
  const invitationIdempotencyKey = useRef<string | null>(null);

  const [acceptToken, setAcceptToken] = useState('');
  const [grantWorkspaceId, setGrantWorkspaceId] = useState('');
  const [grantSubjectId, setGrantSubjectId] = useState('');
  const [grantRole, setGrantRole] = useState<WorkspaceRole>('VIEWER');
  const [erasureReason, setErasureReason] = useState('');
  const [erasureConfirmation, setErasureConfirmation] = useState('');
  const [erasureRequest, setErasureRequest] = useState<ErasureRequest | null>(null);
  const erasureIdempotencyKey = useRef<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const workspaceResponse = await apiFetch('/api/organization/workspace-memberships');
      if (!workspaceResponse.ok) throw new Error(await responseError(workspaceResponse, 'Workspace memberships could not be loaded'));
      // apiFetch may have recovered from a revoked/stale stored selector. Keep the visible form in
      // sync so the user cannot accidentally reopen the discarded value.
      setOrganizationId(activeOrganizationId());
      const workspacePayload = (await workspaceResponse.json()) as {
        memberships?: WorkspaceMembership[];
        workspaces?: WorkspaceSummary[];
      };
      setWorkspaceMemberships(workspacePayload.memberships ?? []);
      setWorkspaces(workspacePayload.workspaces ?? []);
      const firstManageable = (workspacePayload.workspaces ?? []).find((workspace) => workspace.canManageMembers)?.id ?? '';
      setGrantWorkspaceId((current) => current || firstManageable);
      setInviteWorkspaceId((current) => current || firstManageable);

      const memberResponse = await apiFetch('/api/organization/members');
      if (memberResponse.ok) {
        const memberPayload = (await memberResponse.json()) as {
          members?: OrganizationMember[];
          capabilities?: OrganizationCapabilities;
        };
        setMembers(memberPayload.members ?? []);
        setCapabilities(memberPayload.capabilities ?? NO_ORGANIZATION_CAPABILITIES);
        setMembersNotice('');
      } else if (memberResponse.status === 403) {
        setMembers(null);
        setCapabilities(NO_ORGANIZATION_CAPABILITIES);
        setMembersNotice('Your role can use assigned workspaces but cannot list organization-wide membership.');
      } else {
        throw new Error(await responseError(memberResponse, 'Organization members could not be loaded'));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Organization access could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setOrganizationId(activeOrganizationId());
    void load();
  }, [load]);

  async function activateOrganization(event: FormEvent) {
    event.preventDefault();
    const candidate = organizationId.trim();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      if (candidate) {
        // Validate membership with the candidate as a request-only override. Persisting it first
        // would let a typo or revoked membership poison every subsequent application request.
        const response = await apiFetch('/api/organization/workspace-memberships', {
          organizationId: candidate,
        });
        if (!response.ok) {
          throw new Error(await responseError(response, 'This organization could not be opened'));
        }
      }
      selectActiveOrganization(candidate);
      setMembers(null);
      setCapabilities(NO_ORGANIZATION_CAPABILITIES);
      setWorkspaceMemberships([]);
      setWorkspaces([]);
      await load();
      setNotice(candidate ? 'Organization opened.' : 'Using your personal workspace.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'This organization could not be opened.');
    } finally {
      setBusy(false);
    }
  }

  async function mutate(path: string, init: RequestInit, success: string): Promise<Response | null> {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await apiFetch(path, init);
      if (!response.ok) throw new Error(await responseError(response, 'The access change was not applied'));
      setNotice(success);
      return response;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The access change was not applied.');
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function saveMember(member: OrganizationMember) {
    const response = await mutate(`/api/organization/members/${encodeURIComponent(member.subjectId)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: member.role, status: member.status }),
    }, 'Organization membership updated.');
    if (response) await load();
  }

  async function removeMember(subjectId: string) {
    if (!window.confirm('Remove this subject from the organization and its workspaces?')) return;
    const response = await mutate(`/api/organization/members/${encodeURIComponent(subjectId)}`, {
      method: 'DELETE',
    }, 'Organization access removed.');
    if (response) await load();
  }

  async function grantWorkspace(event: FormEvent) {
    event.preventDefault();
    if (!grantWorkspaceId || !grantSubjectId.trim()) return;
    const response = await mutate(
      `/api/organization/workspaces/${encodeURIComponent(grantWorkspaceId)}/members/${encodeURIComponent(grantSubjectId.trim())}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: grantRole }),
      },
      'Workspace membership updated.',
    );
    if (response) {
      setGrantSubjectId('');
      await load();
    }
  }

  async function removeWorkspaceMembership(membership: WorkspaceMembership) {
    if (!window.confirm(`Remove this subject from workspace ${membership.workspaceId}?`)) return;
    const response = await mutate(
      `/api/organization/workspaces/${encodeURIComponent(membership.workspaceId)}/members/${encodeURIComponent(membership.subjectId)}`,
      { method: 'DELETE' },
      'Workspace access removed.',
    );
    if (response) await load();
  }

  async function issueInvitation(event: FormEvent) {
    event.preventDefault();
    if (!inviteEmail.trim()) return;
    invitationIdempotencyKey.current ??= crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const workspaceGrants = inviteWorkspaceId
      ? [{ workspaceId: inviteWorkspaceId, role: inviteWorkspaceRole }]
      : [];
    const response = await mutate('/api/organization/invitations', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': invitationIdempotencyKey.current,
      },
      body: JSON.stringify({
        email: inviteEmail.trim(),
        organizationRole: inviteOrgRole,
        workspaceGrants,
        expiresAt,
      }),
    }, 'Invitation issued. Transfer the one-time token through an approved secure channel.');
    if (!response) return;
    const issued = (await response.json()) as IssuedInvitation;
    setIssuedInvitation(issued);
    if (issued.bearerToken) {
      invitationIdempotencyKey.current = null;
      setInviteEmail('');
    }
  }

  async function revokeInvitation() {
    if (!issuedInvitation) return;
    const response = await mutate(
      `/api/organization/invitations/${encodeURIComponent(issuedInvitation.invitation.id)}/revoke`,
      { method: 'POST' },
      'Invitation revoked.',
    );
    if (response) setIssuedInvitation(null);
  }

  async function acceptInvitation(event: FormEvent) {
    event.preventDefault();
    if (!acceptToken.trim()) return;
    const response = await mutate('/api/organization/invitations/accept', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bearerToken: acceptToken.trim() }),
    }, 'Invitation accepted. Sign out and back in if your active organization claim changed.');
    if (response) {
      const accepted = (await response.json()) as { tenantId?: unknown };
      if (typeof accepted.tenantId === 'string' && accepted.tenantId.trim()) {
        selectActiveOrganization(accepted.tenantId);
        setOrganizationId(accepted.tenantId);
      }
      setAcceptToken('');
      await load();
    }
  }

  async function requestErasure(event: FormEvent) {
    event.preventDefault();
    if (erasureConfirmation !== 'DELETE MY ORGANIZATION' || !erasureReason.trim()) return;
    if (!window.confirm('This queues permanent erasure across database, object storage, queues, identity links, secrets, telemetry, and Steel sessions. Continue?')) return;
    erasureIdempotencyKey.current ??= crypto.randomUUID();
    const response = await mutate('/api/organization/erasure-requests', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': erasureIdempotencyKey.current,
      },
      body: JSON.stringify({ reason: erasureReason.trim() }),
    }, 'Permanent erasure has been queued. Keep this page open to monitor its progress.');
    if (!response) return;
    const request = (await response.json()) as ErasureRequest;
    setErasureRequest(request);
    setErasureReason('');
    setErasureConfirmation('');
  }

  async function refreshErasure() {
    if (!erasureRequest) return;
    const response = await mutate(
      `/api/organization/erasure-requests/${encodeURIComponent(erasureRequest.id)}`,
      { method: 'GET' },
      'Erasure status refreshed.',
    );
    if (response) setErasureRequest((await response.json()) as ErasureRequest);
  }

  if (loading) return <div className="cat-empty"><p><span className="spinner" style={{ marginRight: 8 }} />Loading organization access…</p></div>;

  const manageableWorkspaces = workspaces.filter((workspace) => workspace.canManageMembers);

  return (
    <div className="org-stack">
      {error && <div className="notice-banner" role="alert" style={{ borderColor: 'var(--wrong-edge)', background: 'var(--wrong-tint)', color: 'var(--wrong)' }}>{error}</div>}
      {notice && <div className="notice-banner" role="status" style={{ borderColor: 'var(--live-edge)', background: 'var(--live-tint)', color: 'var(--live)' }}>{notice}</div>}

      <section className="card" aria-labelledby="active-organization-title">
        <div className="eyebrow">Active data boundary</div>
        <h2 id="active-organization-title">Switch organization (optional)</h2>
        <p className="rail-sub">
          The organization identifier selects a workspace boundary; it grants no access by itself.
          Every request is checked against your signed identity and durable membership.
        </p>
        <form className="org-form-grid" onSubmit={(event) => void activateOrganization(event)}>
          <label style={{ gridColumn: '1 / -2' }}><span className="field-label">Organization ID</span><input className="field mono" value={organizationId} onChange={(event) => setOrganizationId(event.target.value)} placeholder="Use blank for your identity home organization" /></label>
          <button className="btn" disabled={busy}>Open organization</button>
        </form>
      </section>

      <section className="card" aria-labelledby="workspace-access-title">
        <div className="section-header">
          <div>
            <div className="eyebrow">Workspace isolation</div>
            <h2 id="workspace-access-title">Assigned access</h2>
          </div>
          <span className="status live">{workspaces.length} visible</span>
        </div>
        {workspaceMemberships.length === 0 ? (
          <p className="rail-sub">No workspace membership is assigned to this identity.</p>
        ) : (
          <div className="covmx"><div className="covmx-scroll"><table>
            <thead><tr><th className="track-col">Workspace</th><th>Subject</th><th>Role</th><th>Status</th><th>Action</th></tr></thead>
            <tbody>{workspaceMemberships.map((membership) => {
              const manageable = workspaces.some((workspace) => workspace.id === membership.workspaceId && workspace.canManageMembers);
              return (
                <tr key={membership.id}>
                  <td className="track-col"><span className="tk-title">{membership.workspaceId}</span></td>
                  <td className="mono">{membership.subjectId}</td>
                  <td>{membership.role}</td><td>{membership.status}</td>
                  <td>{manageable && <button className="btn ghost" type="button" disabled={busy} onClick={() => void removeWorkspaceMembership(membership)}>Remove</button>}</td>
                </tr>
              );
            })}</tbody>
          </table></div></div>
        )}
      </section>

      {manageableWorkspaces.length > 0 && (
        <section className="card" aria-labelledby="workspace-grant-title">
          <div className="eyebrow">Workspace administrator</div>
          <h2 id="workspace-grant-title">Grant workspace access</h2>
          <form className="org-form-grid" onSubmit={(event) => void grantWorkspace(event)}>
            <label><span className="field-label">Workspace</span><select className="field" value={grantWorkspaceId} onChange={(event) => setGrantWorkspaceId(event.target.value)}>{manageableWorkspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.id}</option>)}</select></label>
            <label><span className="field-label">OIDC subject</span><input className="field" required value={grantSubjectId} onChange={(event) => setGrantSubjectId(event.target.value)} autoComplete="off" /></label>
            <label><span className="field-label">Role</span><select className="field" value={grantRole} onChange={(event) => setGrantRole(event.target.value as WorkspaceRole)}>{(['OWNER', 'MANAGER', 'EDITOR', 'VIEWER'] as const).map((role) => <option key={role}>{role}</option>)}</select></label>
            <button className="btn" disabled={busy || !grantSubjectId.trim()}>Grant access</button>
          </form>
        </section>
      )}

      <section className="card" aria-labelledby="organization-members-title">
        <div className="eyebrow">Organization membership</div>
        <h2 id="organization-members-title">Members</h2>
        {membersNotice && <p className="rail-sub">{membersNotice}</p>}
        {members && members.length === 0 && <p className="rail-sub">No organization memberships were returned.</p>}
        {members && members.length > 0 && <div className="covmx"><div className="covmx-scroll"><table>
          <thead><tr><th className="track-col">Subject</th><th>Role</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody>{members.map((member) => {
            const canManageMember = capabilities.manageOrganizationMembers && (member.role !== 'OWNER' || capabilities.manageOwners);
            const allowedRoles: OrganizationRole[] = capabilities.manageOwners
              ? ['OWNER', 'ADMIN', 'MEMBER', 'AUDITOR', 'BILLING']
              : member.role === 'OWNER' ? ['OWNER'] : ['ADMIN', 'MEMBER', 'AUDITOR', 'BILLING'];
            return (
              <tr key={member.id}>
                <td className="track-col"><span className="tk-title">{member.subjectId}</span></td>
                <td>{canManageMember ? <select className="field compact" value={member.role} disabled={busy} onChange={(event) => setMembers((current) => current?.map((item) => item.id === member.id ? { ...item, role: event.target.value as OrganizationRole } : item) ?? null)}>{allowedRoles.map((role) => <option key={role}>{role}</option>)}</select> : member.role}</td>
                <td>{canManageMember ? <select className="field compact" value={member.status} disabled={busy} onChange={(event) => setMembers((current) => current?.map((item) => item.id === member.id ? { ...item, status: event.target.value as MembershipStatus } : item) ?? null)}><option>ACTIVE</option><option>SUSPENDED</option></select> : member.status}</td>
                <td>{canManageMember && <div className="org-actions"><button className="btn ghost" type="button" disabled={busy} onClick={() => void saveMember(member)}>Save</button><button className="btn ghost" type="button" disabled={busy} onClick={() => void removeMember(member.subjectId)}>Remove</button></div>}</td>
              </tr>
            );
          })}</tbody>
        </table></div></div>}
      </section>

      <div className="org-grid">
        {capabilities.issueInvitations && <section className="card" aria-labelledby="issue-invitation-title">
          <div className="eyebrow">Verified-email invitation</div>
          <h2 id="issue-invitation-title">Invite a member</h2>
          <form className="org-form" onSubmit={(event) => void issueInvitation(event)}>
            <label><span className="field-label">Email</span><input className="field" type="email" required autoComplete="email" value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} /></label>
            <label><span className="field-label">Organization role</span><select className="field" value={inviteOrgRole} onChange={(event) => setInviteOrgRole(event.target.value as OrganizationRole)}>{(['ADMIN', 'MEMBER', 'AUDITOR', 'BILLING'] as const).map((role) => <option key={role}>{role}</option>)}</select></label>
            <label><span className="field-label">Workspace grant (optional)</span><select className="field" value={inviteWorkspaceId} onChange={(event) => setInviteWorkspaceId(event.target.value)}><option value="">No workspace grant</option>{manageableWorkspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.id}</option>)}</select></label>
            {inviteWorkspaceId && <label><span className="field-label">Workspace role</span><select className="field" value={inviteWorkspaceRole} onChange={(event) => setInviteWorkspaceRole(event.target.value as WorkspaceRole)}>{(['MANAGER', 'EDITOR', 'VIEWER'] as const).map((role) => <option key={role}>{role}</option>)}</select></label>}
            <button className="btn" disabled={busy || !inviteEmail.trim()}>Issue 7-day invitation</button>
          </form>
          {issuedInvitation && <div className="org-token" role="status">
            <strong>{issuedInvitation.bearerToken ? 'Copy this token now. It cannot be retrieved again.' : 'This idempotent request was already processed; no token was reissued.'}</strong>
            <span className="mono">Organization: {issuedInvitation.invitation.tenantId}</span>
            {issuedInvitation.bearerToken && <textarea className="field mono" readOnly rows={3} value={issuedInvitation.bearerToken} aria-label="One-time invitation token" />}
            <div className="org-actions">
              {issuedInvitation.bearerToken && <button className="btn ghost" type="button" onClick={() => void navigator.clipboard.writeText(issuedInvitation.bearerToken!)}>Copy token</button>}
              <button className="btn ghost" type="button" disabled={busy} onClick={() => void revokeInvitation()}>Revoke invitation</button>
            </div>
          </div>}
        </section>}

        <section className="card" aria-labelledby="accept-invitation-title">
          <div className="eyebrow">Join an organization</div>
          <h2 id="accept-invitation-title">Accept an invitation</h2>
          <p className="rail-sub">Acceptance succeeds only when the signed-in OIDC identity has a verified email matching the invitation.</p>
          <form className="org-form" onSubmit={(event) => void acceptInvitation(event)}>
            <label><span className="field-label">One-time invitation token</span><textarea className="field mono" required rows={3} autoComplete="off" value={acceptToken} onChange={(event) => setAcceptToken(event.target.value)} /></label>
            <button className="btn" disabled={busy || !acceptToken.trim()}>Accept invitation</button>
          </form>
        </section>
      </div>

      {capabilities.requestTenantErasure && <section className="card" aria-labelledby="organization-erasure-title">
        <div className="eyebrow">Privacy control</div>
        <h2 id="organization-erasure-title">Permanent organization erasure</h2>
        <p className="rail-sub">
          Active organization owners can queue a comprehensive, irreversible deletion. Legal-hold
          records remain only where an approved retention basis requires them, and the status below
          identifies every resource class processed.
        </p>
        {erasureRequest ? (
          <div className="org-token" role="status">
            <strong>Request {erasureRequest.id}: {erasureRequest.status}</strong>
            <span>Queued {new Date(erasureRequest.createdAt).toLocaleString()}</span>
            <div className="covmx"><div className="covmx-scroll"><table>
              <thead><tr><th className="track-col">Resource</th><th>Status</th><th>Deleted</th><th>Legal basis</th></tr></thead>
              <tbody>{erasureRequest.steps.map((step) => <tr key={step.resource}>
                <td className="track-col"><span className="tk-title">{step.resource}</span></td>
                <td>{step.status}</td><td>{step.deletedCount}</td><td>{step.legalBasis ?? ''}</td>
              </tr>)}</tbody>
            </table></div></div>
            <button className="btn ghost" type="button" disabled={busy} onClick={() => void refreshErasure()}>Refresh status</button>
          </div>
        ) : (
          <form className="org-form" onSubmit={(event) => void requestErasure(event)}>
            <label><span className="field-label">Reason</span><textarea className="field" required maxLength={1000} rows={3} value={erasureReason} onChange={(event) => setErasureReason(event.target.value)} /></label>
            <label><span className="field-label">Type DELETE MY ORGANIZATION to confirm</span><input className="field mono" required autoComplete="off" value={erasureConfirmation} onChange={(event) => setErasureConfirmation(event.target.value)} /></label>
            <button className="btn" disabled={busy || !erasureReason.trim() || erasureConfirmation !== 'DELETE MY ORGANIZATION'}>Queue permanent erasure</button>
          </form>
        )}
      </section>}
    </div>
  );
}
