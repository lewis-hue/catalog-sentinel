# Customer-readiness report

## Current verdict: **NOT YET CERTIFIED**

The previous report in this file described a development Compose run as
customer-ready and included point-in-time pass counts. That conclusion is
withdrawn. Development health, fixtures, and selected integration tests do not
establish production security, legal approval, tenant isolation, disaster
recovery, or the real Steel→DistroKid session lifecycle.

The repository now contains:

- a Steel-only, fail-closed production configuration;
- a non-root production image without local Chromium/VNC/Browserless;
- mandatory Keycloak, Redis, Postgres, pipeline, HTTPS, encryption, and legal
  startup gates;
- truthful adapter handling for partial/capped/degraded evidence;
- an explicit evidence checklist.

Those controls improve readiness but do not certify a deployment. Known blockers
and the authoritative approval record are in
[Production acceptance](production-acceptance.md). No customer or real distributor
account should be onboarded until that checklist is completed for an immutable
image digest and the target environment.

Historical test output belongs in immutable CI artifacts tied to a revision, not
in this evergreen document. A future signed approval may replace this verdict only
when it includes engineering, security, privacy/compliance, and legal sign-off.
