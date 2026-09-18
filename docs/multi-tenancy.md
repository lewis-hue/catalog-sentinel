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

## Status

Implemented and unit-tested (28 tests): the `Membership` model + `MembershipStore` + personal-tenant
bootstrap; `resolveTenant` + per-tenant RBAC (including the cross-user isolation invariant, "A cannot
act in B's personal tenant"); and the membership-management service with its authorization rules.

Remaining (next slice):
1. **Postgres `MembershipStore` adapter** (runtime persistence; only the in-memory test adapter
   exists today) and a Prisma model + migration.
2. **HTTP routes** under `/api/tenants` wiring the service, guarded by `requireAuth` +
   `requireTenantRole`, added to the production route allowlist, with signed-token integration tests.
3. **Register `registerTenantResolution`** in `buildApp` once a runtime `MembershipStore` is composed.
4. On login, ensure the personal membership (`ensurePersonalMembership`) and optionally auto-claim
   pending invites that match the verified email.
