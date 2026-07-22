# Steel sessions in production

## Contract

Steel is the sole real-browser/session path. Production accepts only:

| Mode | Required configuration | Ownership |
| --- | --- | --- |
| `cloud` | `STEEL_API_KEY` | Steel Cloud |
| `external` | private `STEEL_API_URL` | operator/approved provider |
| `self_hosted` | private `STEEL_API_URL` | operator |

All modes also require `BROWSER_LINK_PROVIDER=steel` and
`STEEL_REQUIRED=true`. Production composition has no selectable mock/demo or
fallback provider. Deterministic Steel doubles exist only in test-support code
and cannot be selected by a deployed runtime. Browserless, local Chromium,
VNC/noVNC, Hyperbeam, and Kasm are not production fallbacks.

The application creates the session through Steel, gives the authenticated user
the attended login view, and attaches Playwright to that same session over CDP.
Steel's official Playwright pattern uses `connectOverCDP`; do not launch a local
browser in the API or worker image:

- https://docs.steel.dev/integrations/playwright
- https://docs.steel.dev/overview/sessions-api/session-lifecycle

## Configuration

Cloud:

```dotenv
NODE_ENV=production
BROWSER_LINK_PROVIDER=steel
STEEL_REQUIRED=true
STEEL_CONNECTOR_MODE=cloud
STEEL_API_KEY=<secret-manager-reference>
STEEL_VIEWER_ORIGINS=https://api.steel.dev https://app.steel.dev
STEEL_SESSION_TIMEOUT_MS=<tested-positive-lease-ms>
CATALOG_READ_MAX_RELEASES=<tested-per-lease-capacity>
```

Private external or self-hosted Steel:

```dotenv
NODE_ENV=production
BROWSER_LINK_PROVIDER=steel
STEEL_REQUIRED=true
STEEL_CONNECTOR_MODE=self_hosted
STEEL_API_URL=https://steel.internal.example
STEEL_VIEWER_ORIGINS=https://steel-viewer.example
STEEL_SESSION_TIMEOUT_MS=<tested-positive-lease-ms>
CATALOG_READ_MAX_RELEASES=<tested-per-lease-capacity>
```

`STEEL_API_URL` is the control-plane base URL and must be absolute HTTPS without
embedded credentials in production. `STEEL_VIEWER_ORIGINS` is the exact,
HTTPS-only browser-facing allowlist; the provider releases a newly created
session instead of returning a viewer on any other origin. If a self-hosted deployment
returns a CDP hostname that is resolvable only from a different network namespace,
set `STEEL_CDP_INTERNAL` to the private host/port used by API and workers.

[`docker-compose.production.yml`](../docker-compose.production.yml) does not run
Steel. Supply an approved external/private service. The older
[`docker-compose.steel.yml`](../docker-compose.steel.yml) publishes a development
live-view port and uses an unpinned image; it is evaluation-only.

## Live-view security

Steel documents the session `debugUrl` as usable without an authorization header.
Treat it as a short-lived bearer capability, not as an ordinary public URL:

- https://docs.steel.dev/overview/sessions-api/embed-sessions/live-sessions

The attended viewer is a real signed-in browser with the user's full DistroKid
account authority. It is **not** network-enforced read-only. Sentinel's consent
scope and request guard constrain only requests issued by Sentinel automation;
they do not intercept or neutralize actions the user takes in the live viewer.
The user must not share the capability or use the viewer for account mutations.

Before release:

- deliver the URL only after application authentication and tenant ownership
  checks;
- do not log it, store it in analytics, put it in support tickets, or allow it in
  referrers;
- enforce HTTPS, restrictive CSP/framing policy, no-store responses, and the
  shortest practical session timeout;
- show the full-authority warning before launch and beside the active viewer;
- ensure control API and CDP endpoints remain private;
- verify that another tenant, a signed-out user, and an expired/replayed URL
  cannot access the session under the chosen Steel deployment model.

If the chosen Steel mode cannot meet those controls, production acceptance is
blocked. Do not substitute a different browser provider.

## Session lifecycle

Every terminal path must release the remote session: successful finalization,
user cancellation, unrecoverable failure, and consent/connection revocation.
Steel's server-side timeout is a final backstop, not the primary cleanup method.

Steel does not support extending an already-live session timeout. Sentinel sends
the configured `STEEL_SESSION_TIMEOUT_MS` when creating the session, and production
startup also requires an explicit `CATALOG_READ_MAX_RELEASES`. Choose the pair only
from a worst-case load/soak test for the selected Steel plan, catalogue shape,
network latency, and worker concurrency, with safety margin.

A configured cap does **not** prove that arbitrary large catalogues are supported.
Until continuation across a new attended session (or a reviewed renewal/re-auth
design) exists, catalogues larger than the tested single-lease envelope remain a
production acceptance blocker and must never be reported as completely captured.

Steel REST create/release calls are bounded by
`STEEL_API_REQUEST_TIMEOUT_MS` (default 10 seconds, allowed 100–60,000 ms).

Required tests:

1. create and attend a session;
2. confirm login and attach from a worker;
3. restart API and worker during a scan and resume the same session;
4. cancel and verify immediate release;
5. force a terminal job failure and verify release;
6. allow a session to expire and verify re-attachment is rejected;
7. check Steel usage for orphan sessions after every case.
8. load-test the maximum configured release count at adverse but supported latency
   and prove completion/release before the configured lease expires.

See Steel's lifecycle documentation for explicit release and timeout behavior:
https://docs.steel.dev/overview/sessions-api/session-lifecycle.

## Network and secret boundaries

- Steel API keys exist only in API/worker server environments and the secret
  manager. They never enter `NEXT_PUBLIC_*`, browser JavaScript, images, or logs.
- Cloud queue handoffs contain an encrypted remote session id, not a CDP URL or
  Steel API key. Workers reconstruct CDP using their own process-local secret.
- For private Steel, allow API/worker egress to its control/CDP endpoints and
  deny public ingress to both. Expose only the minimum browser-facing live view
  through the approved access-control design.
- Use separate credentials/projects per environment; rotate and revoke them
  through a rehearsed incident procedure.
- Apply outbound allowlists so attached pages navigate only to the approved
  DistroKid HTTPS origins when driven by Sentinel extraction. Do not present that
  automation guard as a read-only sandbox for the attended viewer.

## Deployment gate

Run a redacted reachability probe from the same network identity as both API and
worker, then require `GET /health/ready` to be healthy. Do not print the API key,
CDP URL, session id, or debug URL in CI output.

Neither probe is production certification. Complete the Steel section of
[Production acceptance](production-acceptance.md) with an authorized account and
attach the evidence to the release record.
