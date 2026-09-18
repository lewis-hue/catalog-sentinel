# Multi-tenancy and tenant authorization

## Principle

The verified Keycloak token proves **who** the caller is (`sub`). It never proves **which tenant**
they may act in. Access to a tenant comes only from a durable **Membership** record the app owns.
A `tenant_id` claim, if present, is not trusted on its own.

## Model

- **Tenant**: an isolation boundary. Every persisted row is scoped by `tenantId`, and
  `TenantStore` refuses any read/write whose row `tenantId` does not match the request context
  (structural isolation, the backstop).
- **Personal tenant**: every user has one, with `tenantId === sub`. It is always theirs as `owner`,
  needs no membership lookup, and means existing per-user data (already keyed by the subject) keeps
  resolving with **no migration**.
- **Shared tenant** (organization / label / team): identified by a minted `org_…` id. Users join it
  through an active `Membership`.
- **Membership** `{ id, tenantId, userId, role, status, invitedEmail, invitedByUserId }`:
  - `role`: `owner | admin | manager | analyst | viewer` (hierarchical; higher grants lower).
  - `status`: `active` (grants access) | `invited` (pending email invite, `userId` null) | `suspended`.

## Request flow

1. `registerAuth` verifies the bearer token (RS256, issuer + audience) and sets `req.auth`
   (`sub`, `tenantId = sub` default, `tenantRole = owner` default, global `roles`). Fails closed.
2. `registerTenantResolution` (post-auth hook) reads the chosen tenant from the
   `X-Sentinel-Tenant` header (default: the personal tenant), then `resolveTenant`:
   - personal tenant (`requested === sub`) → allowed as `owner`, no lookup;
   - any other tenant → allowed only if `MembershipStore.getActive(sub, tenant)` returns an active
     membership, carrying its role; otherwise **403** (never silently downgraded to the caller's own
     data).
   It pins `req.auth.tenantId` / `req.auth.tenantRole` to the validated tenant.
3. Handlers build their `TenantContext` from `req.auth.tenantId` (the validated tenant), never from a
   request param.

## RBAC

- Global Keycloak roles (`user`, `platform_admin`) gate app access. `platform_admin` is an
  operational role, **not** an implicit customer super-user.
- `requireTenantRole(minimum)` gates tenant actions on the caller's role *within the resolved tenant*
  using the `owner > admin > manager > analyst > viewer` hierarchy (unknown roles fail closed).

## Membership management (`membership-service.ts`)

- `createTenant` — mint a shared tenant, caller becomes `owner`.
- `inviteMember` — admin+; only an owner may grant `owner`; no invites to a personal tenant;
  email validated; idempotent re-invite.
- `acceptInvite` — binds a pending invite to the caller, keyed on their **verified** OIDC email
  (never a request-body email), so an invite cannot be claimed by someone who does not control the
  address.
- `listMembers`, `changeRole`, `removeMember` — admin+; `changeRole`/`removeMember` refuse to
  demote or remove the **last owner**, so a tenant is never orphaned.

## HTTP surface (`/api/tenants`)

- `GET /api/tenants` — the caller's active tenants. Doubles as the login-time bootstrap: it
  idempotently ensures the personal membership, so per-user data always resolves as a tenant of one.
- `POST /api/tenants` — create a shared tenant (caller becomes `owner`).
- `POST /api/tenants/:id/invites` — invite by email; act in `:id` via `X-Sentinel-Tenant`, admin+.
- `POST /api/tenants/:id/accept` — claim a pending invite by verified email; send **no** tenant header.
- `GET /api/tenants/:id/members` — roster; act in `:id`.
- `PATCH /api/tenants/:id/members/:userId` / `DELETE …` — change role / remove; act in `:id`, admin+.

## Status

Implemented, unit- and integration-tested (57 tests): the `Membership` model + `MembershipStore`
port + personal-tenant bootstrap; the **Postgres adapter** (`PostgresMembershipStore`, raw SQL with a
migrated-schema assertion) + Prisma model + migration; `resolveTenant` + per-tenant RBAC (including
the cross-user isolation invariant, "A cannot act in B's personal tenant"); the membership-management
service; and the `/api/tenants` HTTP routes wired into `buildApp` (tenant resolution + routes turn on
only when a `MembershipStore` is composed; `main.ts` composes the Postgres adapter over the shared
pool), covered by signed-token integration tests.

Deferred (not required for the feature): auto-claiming pending invites on login for a matching
verified email (today acceptance is an explicit `POST /accept`), and a per-tenant audit-log scope.
