import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { MembershipStore } from '@sentinel/db';
import { requireAuth, requireRole } from './auth';
import {
  acceptInvite,
  changeRole,
  createTenant,
  inviteMember,
  listMembers,
  removeMember,
  type Actor,
} from './membership-service';

const nowIso = () => new Date().toISOString();

function actorFrom(req: FastifyRequest): Actor {
  return { sub: req.auth.sub, tenantId: req.auth.tenantId, tenantRole: req.auth.tenantRole };
}

/**
 * Tenant + membership management routes.
 *
 * Tenant-scoped actions (invite, roster, role, remove) require the caller to be ACTING IN that
 * tenant: the client selects it with the `X-Sentinel-Tenant` header, the resolution hook validates
 * membership and pins `req.auth.tenantId`/`tenantRole`, and each service call re-checks that the
 * resolved tenant matches the path. Accepting an invite is the one action that does NOT require
 * prior membership; it binds to the caller's verified email, so the tenant header must be omitted.
 */
export function registerTenantRoutes(app: FastifyInstance, store: MembershipStore): void {
  // The tenants the caller is an active member of.
  app.get('/api/tenants', { preHandler: requireAuth() }, async (req) => {
    const memberships = await store.listActiveForUser(req.auth.sub);
    return {
      tenants: memberships.map((m) => ({
        tenantId: m.tenantId,
        role: m.role,
        personal: m.tenantId === req.auth.sub,
      })),
    };
  });

  // Create a new shared tenant; the caller becomes its owner.
  app.post('/api/tenants', { preHandler: requireRole('user') }, async (req, reply) => {
    const r = await createTenant(store, actorFrom(req), nowIso);
    if (!r.ok) return reply.status(r.status).send({ error: r.error });
    return reply.status(201).send({ tenantId: r.value.tenantId, role: r.value.role });
  });

  // Invite a member by email. Requires acting in :id (send X-Sentinel-Tenant: :id) as admin or higher.
  app.post('/api/tenants/:id/invites', { preHandler: requireAuth() }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { email?: string; role?: string };
    const r = await inviteMember(store, actorFrom(req), id, String(body.email ?? ''), String(body.role ?? 'viewer'), nowIso);
    if (!r.ok) return reply.status(r.status).send({ error: r.error });
    return reply.status(201).send({
      id: r.value.id,
      invitedEmail: r.value.invitedEmail,
      role: r.value.role,
      status: r.value.status,
    });
  });

  // Accept a pending invitation. Uses the caller's VERIFIED email; do NOT send the tenant header.
  app.post('/api/tenants/:id/accept', { preHandler: requireAuth() }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = await acceptInvite(store, req.auth.sub, req.auth.email, id, nowIso);
    if (!r.ok) return reply.status(r.status).send({ error: r.error });
    return reply.send({ tenantId: r.value.tenantId, role: r.value.role, status: r.value.status });
  });

  // Roster of a tenant the caller is acting in.
  app.get('/api/tenants/:id/members', { preHandler: requireAuth() }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = await listMembers(store, actorFrom(req), id);
    if (!r.ok) return reply.status(r.status).send({ error: r.error });
    return {
      members: r.value.map((m) => ({ userId: m.userId, role: m.role, status: m.status, invitedEmail: m.invitedEmail })),
    };
  });

  // Change a member's role. Requires acting in :id as admin or higher.
  app.patch('/api/tenants/:id/members/:userId', { preHandler: requireAuth() }, async (req, reply) => {
    const { id, userId } = req.params as { id: string; userId: string };
    const body = (req.body ?? {}) as { role?: string };
    const r = await changeRole(store, actorFrom(req), id, userId, String(body.role ?? ''), nowIso);
    if (!r.ok) return reply.status(r.status).send({ error: r.error });
    return { userId: r.value.userId, role: r.value.role };
  });

  // Remove a member. Requires acting in :id as admin or higher.
  app.delete('/api/tenants/:id/members/:userId', { preHandler: requireAuth() }, async (req, reply) => {
    const { id, userId } = req.params as { id: string; userId: string };
    const r = await removeMember(store, actorFrom(req), id, userId);
    if (!r.ok) return reply.status(r.status).send({ error: r.error });
    return { removed: r.value.removed };
  });
}
