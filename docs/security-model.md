# Security model - attended DistroKid access

## Trust boundaries

1. The user authenticates through Keycloak OIDC Authorization Code + PKCE. The
   BFF validates tokens before storing or forwarding them; browser tokens remain
   in secure, HTTP-only cookies.
2. The API derives the home tenant from the verified token. A requested active
   organization is accepted only after a current PostgreSQL membership check.
3. The API creates an isolated Steel session and returns the attended live view
   only to that authenticated principal. The user signs in to DistroKid and
   completes MFA/CAPTCHA directly in Steel.
4. After confirmation, BullMQ workers attach to that session over CDP and perform
   a bounded, read-only, network-first catalogue extraction.
5. PostgreSQL is the durable authority for consent, ownership, catalogue state,
   checkpoints, governance, and audit. Redis contains queues, hot state, claims,
   and leases that may be reconstructed.
6. Terminal success, cancellation, failure, revocation, or expiry releases the
   Steel session. Governance workers separately enforce retention, erasure,
   audit anchoring, and cleanup.

Steel is the only runtime browser provider. There is no runtime mock/demo,
Browserless, local Chromium/VNC, Hyperbeam, Kasm, legacy DOM, or inline scan path.
Deterministic test doubles are test-only and excluded from the production image.

## Credential and attended-viewer policy

Sentinel never displays a distributor password form, receives or types a
password/MFA code, stores raw cookies/storage state, solves CAPTCHAs, or bypasses
an access control. The user interacts with DistroKid directly inside Steel.

Steel API keys, CDP endpoints, remote session IDs, and live-view URLs are secrets
or bearer capabilities. They must not enter browser bundles, analytics, support
tickets, logs, traces, report artifacts, referrers, or audit payloads. Viewer
origins use an exact HTTPS allowlist and responses use no-store/no-referrer
controls.

The live viewer is a real signed-in account session. Application read-only
consent constrains Sentinel automation, not the user's authority inside that
viewer. Short provider TTL is a final backstop, not proof of successful release.

## Authorization and tenancy

- Production requires Keycloak. JWT signature, issuer, audience, expiry, roles,
  and tenant claim are validated server-side.
- The home tenant claim is not authority for another organization. A selected
  organization header is syntactic input only; current active membership must be
  loaded from PostgreSQL for every request context.
- Personal organizations are provisioned transactionally on first login.
  Completed-erasure KMS-HMAC tombstones prevent accidental re-creation.
- Organizations implement owner, admin, member, auditor, and billing roles plus
  explicit workspace grants. Invitations are bounded, hashed, idempotent, and
  revocable. Membership removal immediately removes repository authority.
- Every scan binds tenant, immutable OIDC subject, and a server-authorized
  workspace. Queue messages, checkpoints, projections, reviews, downloads, and
  history operations preserve that boundary.
- Organization erasure is owner-only. Status receipts remain accessible to the
  verified original requester after membership rows are destroyed and expose no
  tenant hash, HMAC, or worker lease material.

These source controls still require independent target-environment IDOR and
penetration testing before release.

## Automation read boundary

- Navigation and requests are restricted to approved DistroKid HTTPS origins.
- Automation-issued mutation methods are blocked. GraphQL POST is permitted only
  when recognized as a query; redirects are revalidated.
- Response ownership is fenced by release and epoch. Capture sizes, aggregate
  memory, body-read concurrency, page/release counts, request rate, and total
  duration are bounded.
- The six-stage pipeline serializes DistroKid access per account, persists
  release checkpoints, and refuses successful finalization while indexed
  releases or independently expected tracks remain unresolved.
- Raw network debug artifacts and screenshots are disabled in production.

These controls do not establish that distributor terms permit the workflow.
Legal and DPA approval remain mandatory.

## Stored data and result integrity

Expected production data includes consent/connection records, encrypted Steel
handoffs, organization/workspace membership, catalogue metadata and identifiers,
field-level provenance/completeness, DSP evidence, durable job/checkpoint state,
review decisions, retention/erasure records, and redacted audit events.

The application must not store unrelated account pages, payment/tax/bank data,
personal addresses, messages, passwords/MFA data, or plaintext session material.

Only a successfully captured explicit source null/empty is
`ABSENT_AT_SOURCE`. An omitted, malformed, capped, truncated, degraded, timed-
out, unauthorized, or identity-ambiguous field/provider is not an absence and
cannot prove `not-live`. YouTube and web search are confirmation-only.

## Cryptography and key separation

- Every active session handoff uses a fresh AES-256-GCM data key wrapped by AWS
  KMS with a pinned key ID and stable encryption context.
- Tenant pseudonyms and erasure tombstones use an AWS KMS HMAC key. The API role
  receives only `GenerateMac`/key-description access needed to create requests;
  worker verification and destructive orchestration remain separate.
- Audit anchors use a distinct asymmetric AWS KMS signing key and KMS-encrypted
  S3 Object Lock storage.
- Production rejects local master keys and custom AWS/KMS/S3 endpoints and runs
  data-plane readiness operations. A KMS key backed by an AWS CloudHSM custom key
  store can be selected without changing the application API.

Checked-in configuration is not evidence that target key policies, rotation,
disable/recovery, throttling, CloudTrail alerts, or multi-replica access passed.

## Retention and tenant erasure

Retention policies create durable scheduled runs. Workers claim runs using
database time, bounded leases, checkpoints, and compare-and-set completion.
Concrete adapters delete eligible PostgreSQL rows, Redis/BullMQ jobs and keys,
and every version/delete marker of governed S3 objects before metadata removal.

Owner-requested tenant erasure additionally covers Steel sessions, Keycloak
identity, Secrets Manager material, observability backends, memberships, backup
expiry tracking, and audit/legal treatment. Adapters fail closed on unknown
inventory or incomplete deletion. Only backup expiry and audit legal records may
finish under a documented legal basis; ordinary customer data cannot be silently
retained as a “legal hold.”

Target credentials, deletion timing, backup expiry, cross-region object erasure,
restored-data handling, and legal approval must be observed in the deployed
environment before this control is accepted.

## Audit model

Security and governance events form a per-tenant hash chain with canonical
payloads, sequence numbers, previous hashes, and chain heads. Tenant audit export
requires an authorized owner/admin/auditor role. Anchors are signed by AWS KMS,
written to S3 Object Lock in compliance mode, and independently verifiable.

Application roles cannot arbitrarily update/delete audit rows. Controlled audit
expiry requires an authorized retention policy/run, a purge guard, and the
governed legal-record step. Target WORM configuration, external anchor
verification, retrieval/export, alerting, and approved retention still require
production evidence.

## Infrastructure and supply-chain boundary

The reference AWS topology defines private two-AZ application/data networks,
Aurora PostgreSQL, multi-AZ encrypted Redis, ECS/Fargate, TLS ALB, WAF,
autoscaling, alarms, PITR, locked backups, cross-region copies, and object
replication. Runtime database capabilities are split from schema ownership.

Only a digest-addressed image is accepted by production IaC. The release workflow
must build one reviewed commit, run blocking Trivy scans, publish SBOM/provenance,
sign the registry digest with Cosign, and verify the workflow identity. Templates
and workflow definitions alone do not satisfy deployment, restore, load, or
artifact-signing acceptance.

## Required external acceptance

Before customer use, record legal/privacy/security/DPA approval, a specifically
authorized 1,000+ track attended DistroKid run, deployed Google and enabled-DSP
credential tests, KMS/HA/PITR/DR/load exercises, capability/IDOR penetration
testing, and a signed immutable image evidence bundle. See
[Production acceptance](production-acceptance.md).
