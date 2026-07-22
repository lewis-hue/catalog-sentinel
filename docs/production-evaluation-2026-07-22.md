# Production evaluation — updated 2026-07-23

## Verdict

**NO-SHIP — NOT YET PRODUCTION CERTIFIED.**

The working tree now contains the production control paths requested in this
review: durable organization membership, cross-store retention and tenant
erasure, tamper-evident audit anchoring, AWS KMS integrations, a six-stage
BullMQ catalogue pipeline, and an AWS HA/PITR/DR topology. Those controls do not
manufacture the external evidence needed to release them. No customer account
should be onboarded until the remaining live, legal, target-cloud, and immutable
supply-chain gates below are completed for one reviewed revision and image
digest.

No real DistroKid account was accessed and no Steel-to-DistroKid scan was run in
this review. The local Steel capability probe reached the configured service and
returned `READY`; it did not create a session, open DistroKid, or exercise login
or MFA.

## Release-gate summary

| Gate | Implemented evidence | Release status |
| --- | --- | --- |
| Steel-only browser path | Production requires Steel and Playwright-over-CDP. Hosted credential capture, alternate browser providers, local browser routes, and legacy scan dispatch are absent from the runtime surface. | Source controls pass; authorized attended lifecycle and orphan-session evidence pending. |
| Catalogue scale and recovery | The only runtime path is the six-stage BullMQ pipeline. Durable PostgreSQL checkpoints recover after Redis loss; bounded release/DSP pagination and concurrency fail closed on caps. Synthetic tests cover more than 1,000 records without duplicates. | Local scale evidence passes; an authorized real 1,000+ DistroKid catalogue run remains mandatory. |
| Metadata truthfulness | Per-field status and provenance distinguish source absence from capture, parse, request, timeout, and authorization failures. Release-index expected track counts are propagated when DistroKid exposes them and reconciliation fails on mismatch. | Source/tests pass; live endpoint/schema and real-catalogue completeness proof pending. |
| Authentication and tenancy | Keycloak/OIDC BFF validation, durable PostgreSQL organizations, first-login personal organization provisioning, invitation acceptance/revocation, organization/workspace roles, selected-organization validation, and owner-only erasure requests are implemented. | Local authorization tests pass; deployed Google broker, Keycloak rotation/outage, and independent IDOR testing pending. |
| Retention and tenant erasure | Scheduled, leased retention and owner-requested tenant erasure have concrete PostgreSQL, Redis/BullMQ, Steel, Keycloak, Secrets Manager, observability, versioned S3, backup-expiry, and governed audit-record adapters. Progress is checkpointed and fail-closed. | Implemented and locally/infrastructure tested; target-service credentials, deletion SLA, backup expiry, legal-hold, and restore evidence pending. |
| Tamper-evident audit | Tenant audit events form a verifiable hash chain. Reader access is role-bound, anchors are KMS-signed and exported to KMS-encrypted S3 Object Lock storage, and audit expiry requires a controlled purge guard. | Implemented and locally/infrastructure tested; target KMS/S3 deployment, external anchor verification, retrieval, alert, and legal-retention evidence pending. |
| Key management | Session envelope encryption, tenant pseudonymization, erasure receipts, and audit anchors use explicit AWS KMS keys. Production rejects endpoint overrides/local keys and performs data-plane readiness checks. IAM is split between API and worker. | Implemented in source/IaC; target-account KMS/HSM policy, rotation, recovery, throttling, and replica proof pending. |
| Cloud operations | CloudFormation defines two-AZ ECS, Aurora writer/reader with 35-day PITR, multi-AZ Redis, private networking, TLS ingress, WAF, autoscaling, alarms, AWS Backup/Vault Lock, cross-region copies, artifact replication, and a separate DR stack. Runtime database roles are migration-managed. | IaC validates locally; no target stack, restore/failover/DR exercise, or production load/soak evidence exists. |
| Supply chain | The release workflow builds by digest, produces SBOM/provenance, blocks on Trivy source/config/image findings, signs with keyless Cosign, and verifies the signer identity. Production IaC accepts digest references only. A clean committed revision was rebuilt locally as a non-root image and its API/worker bundles loaded with networking disabled, a read-only root filesystem, all capabilities dropped, and `no-new-privileges`. | Local source/image reproducibility passes; no registry-pushed digest, registry scan, signature, or attestation bundle has been produced. |
| Legal/privacy/live providers | Signed compliance-bundle verification is fail-closed and binds legal, privacy, security, account-authorization, retention, catalogue-size, and session-duration claims. | **Failed / no-ship:** no genuine approval bundle, DPA/legal approval, authorized real catalogue run, full DSP validation, or deployed Google flow. |

## Material controls now present

- Runtime code has no mock/demo provider or data path. Test doubles are confined
  to test-support files and test processes.
- The removed legacy single-job catalogue route cannot be selected by an
  environment flag; API and worker use the same six-stage contract.
- Index and release stages persist durable checkpoints in PostgreSQL, use Redis
  only as recoverable orchestration state, and reconcile exact release/track
  counts before finalization.
- DSP catalogues are fetched once per platform/artist, with bounded concurrency,
  pagination, and explicit maximum-capacity failures instead of silent clipping.
- Every selected organization is authorized from current database membership.
  Organization headers do not grant access. Invitations are hashed/idempotent,
  roles and workspace grants are enforced, and membership removal takes effect
  at the repository boundary.
- Tenant erasure is owner-requested, idempotent, checkpointed, and irreversible.
  The public receipt omits tenant hashes and lease material. Only documented
  backup-expiry and audit-legal-record steps may terminate under legal hold.
- Governance workers are required for readiness. Retention, erasure, audit
  anchoring, and revocation cleanup run with leases and compare-and-set
  completion rather than process-local timers as authority.
- Audit data is append-only to application roles, hash chained per tenant,
  KMS-signed, and anchored to S3 Object Lock. Controlled expiry is database
  guarded and requires an authorized retention run.
- The 13 ordered Prisma migrations include governance tables, controlled audit
  expiry, durable DistroKid checkpoints, split runtime database capabilities,
  and expected-track counts.
- The production image uses compiled API/worker entrypoints and Next standalone,
  runs as non-root, and excludes a local browser and TypeScript/test runtime.

## Verification evidence

Evidence confirmed in this working tree:

- The default repository run completed **85 passing test files plus 8 expected
  infrastructure-gated files (93 total)**, with **685 passing tests and 50
  expected infrastructure-gated skips (735 total)**.
- The disposable PostgreSQL/Redis run applied all **13 ordered migrations** to a
  fresh database and completed **93/93 files and 735/735 tests with zero skips**.
  It includes the post-erasure receipt assertion, 1,100-release recovery after a
  Redis flush, and the 1,200-track six-stage BullMQ path.
- Repository TypeScript validation, ESLint, focused security/auth/organization/
  governance/catalogue/DSP suites, and real-Chromium network-first tests passed.
- Synthetic catalogue tests exceed the requested size, including exact
  1,100-release durable-checkpoint recovery after Redis loss and a 1,001-item DSP
  regression. This is application-scale evidence only.
- `cfn-lint` accepts `bootstrap.yaml`, `dr-region.yaml`, and `production.yaml`.
  Template validation is not target-account deployment or recovery evidence.
- The configured Steel API capability probe returned `READY`. A YouTube Data API
  request succeeded, and Google's token endpoint recognized the configured OAuth
  client pair while rejecting a deliberately invalid grant. This does not prove a
  Google broker login or the other DSP credentials.
- The current environment does not contain the complete AWS governance, KMS,
  backup-inventory, DSP, authorized-account, or signed-approval inputs. Missing
  values were not invented and production startup is expected to fail closed.

These results apply to the clean committed source revision and its locally built
image. They must still be reproduced by the protected release workflow for the
registry digest before they become deployable release evidence.

Do not cite a local mutable image ID as release evidence. The release artifact is
valid only after a reviewed commit is built, pushed, registry-scanned, signed,
and verified by digest.

## Remaining release blockers

1. Obtain independent legal, privacy/DPA, security, and authorized-test-account
   approvals and inject their genuine signed compliance bundle.
2. Run the complete attended Steel scenario against the authorized 1,000+ track
   DistroKid account, including MFA by the user, exact count reconciliation,
   cancellation, timeout, API/worker restart, provider failure, revocation, and
   provider-side orphan-session verification.
3. Validate the deployed Keycloak/Google broker and every enabled DSP with real,
   authorized credentials, quotas, pagination, and failure cases.
4. Deploy the target AWS stacks and prove KMS/HSM policy and rotation, least-
   privilege runtime identities, HA/failover, PITR and cross-region restores,
   backup/object expiry, audit-anchor retrieval, alarms, and incident procedures.
5. Run authenticated concurrent load/soak tests against that topology and record
   capacity, queue lag, error rate, completeness, RPO, and RTO.
6. Create and review an immutable source revision, then publish its digest through
   the protected release workflow with retrievable Trivy, SBOM, provenance,
   Cosign signature, and verification evidence.

The authoritative sign-off checklist is
[Production acceptance](production-acceptance.md). This report describes
engineering state; it grants no legal, privacy, security, or release approval.
