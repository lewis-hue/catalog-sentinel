# Keycloak authentication

## Production contract

Keycloak authentication is mandatory in production. Set both
`NODE_ENV=production` and `DEPLOYMENT_ENV=production`; the API and web gateway
fail closed when OIDC configuration is incomplete. Tenant identity comes from a
verified token claim, never a caller-supplied header/body/query value.

The browser flow is OIDC Authorization Code with PKCE (`S256`) through the Next.js
BFF:

1. `/auth/login` creates state, nonce, and a PKCE verifier;
2. Keycloak authenticates the user;
3. `/auth/callback` validates state and exchanges the code server-side;
4. tokens remain in secure, HTTP-only cookies;
5. browser API calls use same-origin BFF routes, which add the bearer token
   server-side;
6. the API validates signature, issuer, audience, expiry, roles, and `tenant_id`.

Configure the canonical endpoints and clients:

```dotenv
WEB_AUTH_MODE=keycloak
ENABLE_KEYCLOAK_AUTH=true
KEYCLOAK_BASE_URL=https://keycloak.private.example
KEYCLOAK_PUBLIC_BASE_URL=https://login.example.com
KEYCLOAK_ISSUER=https://login.example.com/realms/sentinel
KEYCLOAK_REALM=sentinel
KEYCLOAK_WEB_CLIENT_ID=sentinel-web
KEYCLOAK_WEB_CLIENT_SECRET=<secret-manager-reference>
KEYCLOAK_API_CLIENT_ID=sentinel-api
KEYCLOAK_API_AUDIENCE=sentinel-api
APP_BASE_URL=https://sentinel.example.com
```

Use a confidential BFF web client with PKCE and exact redirect/logout origins. Inject its
secret only into the server-side web container through the deployment secret manager; never put
it in browser code or a `NEXT_PUBLIC_*` variable. The browser still receives no client secret or
OAuth token because the BFF performs the code exchange and stores tokens in HttpOnly cookies.

## Realm requirements

- RS256/approved asymmetric signing with rotation and overlap tested.
- Exact HTTPS hostname/issuer; no `start-dev`, hostname relaxation, HTTP, wildcard
  redirect URIs, or wildcard web origins.
- Required `tenant_id` claim and reviewed role mapping.
- Separate API audience and least-privilege administrative/service clients.
- Brute-force protection, MFA/session policy, admin audit, backups, monitoring,
  and break-glass procedure appropriate to the deployment.

The API accepts a token only for the configured audience. A token valid for an
unrelated client is not sufficient. A token must also contain at least one recognized
Sentinel realm role; arbitrary-only or missing role claims are rejected.

The development realm's Google broker maps Google's stable `sub` into the home
`tenant_id` user attribute and grants `artist_manager`. On first authenticated
access, the API transactionally provisions that subject's isolated personal
organization in PostgreSQL. Shared organizations are never inferred from email
domains or a caller-supplied identifier: they use explicit invitations, active
organization membership, roles, and workspace grants from the database. The
`sentinel-web` client maps the home attribute into the `tenant_id` token claim;
selecting another organization still requires current database membership.
Existing imported development realms are not rewritten by `--import-realm`;
apply the mapper through managed realm configuration or recreate only the
disposable development Keycloak volume before testing it.

Route authorization is least-privilege:

- `user` may read tenant-scoped searches, review queues, and Steel readiness;
- `artist_manager` and `tenant_admin` may additionally grant/revoke consent, create/cancel
  attended Steel sessions, start scans/searches/imports, and resolve manual reviews;
- `tenant_admin` and `platform_admin` may access explicitly listed dependency/configuration
  operations endpoints. `platform_admin` is not an implicit customer-data role;
- `service_worker` is not an interactive role and is rejected from user/catalog endpoints.

Keycloak built-in roles may coexist with these mappings, but do not grant Sentinel access.

## CSP and browser origins

The web gateway constructs a restrictive CSP. Set Steel and any additional
origins as exact origins, not wildcards or paths:

```dotenv
STEEL_VIEWER_ORIGINS=https://approved-live-view.example
WEB_CSP_CONNECT_ORIGINS=
WEB_CSP_FORM_ACTION_ORIGINS=
WEB_CSP_IMAGE_ORIGINS=
```

The Keycloak public origin is added for the required login/form flow. Validate
the final headers at the external HTTPS edge because a proxy/CDN can overwrite
them.

## Development realm

`docker-compose.yml` starts Keycloak in `start-dev` mode for local infrastructure
testing. The shared realm definition deliberately imports no interactive users and
no user credentials. Sign in through the configured Google broker, or have a local
administrator create a disposable test user with a managed `tenant_id`; there is no
built-in username/password fallback. The only user-shaped realm entry is Keycloak's
credentialless `sentinel-worker` service principal, retained solely to assign the
least-privilege `service_worker` role.

Never promote a local `start-dev` database, bootstrap admin credentials, HTTP
hostname settings, or generated development secrets into production. Production
must deploy the reviewed realm configuration through managed identity infrastructure
and inject every client secret from a secret manager.

Local development uses the same Keycloak Authorization Code + PKCE flow as a
deployed runtime. Anonymous web mode is not supported; create a disposable
Keycloak user with a managed `tenant_id` when exercising the local stack.

## Acceptance tests

- login, logout, refresh, expired/revoked session, state/nonce mismatch, and PKCE
  failure;
- wrong issuer/audience/signature/algorithm and unknown signing key;
- signing-key rotation and temporary Keycloak outage;
- missing/malformed `tenant_id` and unauthorized role;
- cross-tenant API, stream, cancellation, artifact, Redis/job, and Postgres access;
- cookie flags, CSRF protections, CSP, open redirects, callback allowlist, and BFF
  token leakage;
- admin/service-account least privilege and secret rotation.

Record the results for the exact release image in
[Production acceptance](production-acceptance.md).
