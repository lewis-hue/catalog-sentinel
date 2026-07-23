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
| Catalogue scale and recovery | The only runtime path is the six-stage BullMQ pipeline. PostgreSQL checkpoints plus an application-envelope-encrypted recovery record preserve the tenant/principal, connection, consent, workspace, session lease, and immutable scan deadline needed to reconstruct BullMQ work after API/worker/CDP interruption or total Redis loss. A worker sweep runs every 15 seconds. Bounded release/DSP pagination and concurrency fail closed on caps. | Docker-backed scale and recovery evidence passes. Recovery is valid only while the original Steel lease and immutable scan deadline remain valid; it does not renew an expired authenticated session. An authorized real 1,000+ DistroKid catalogue run remains mandatory. |
| Metadata truthfulness | The post-scan audit checks UPC, artwork URL, release date, upload date, label, and every track ISRC. Retryable gaps are retried only at their owning release because DistroKid track metadata is obtained in release-scoped reads, and finalization cannot become `COMPLETE` until those gaps close. Artwork is accepted only from distributor `NETWORK_JSON` evidence; there is no DSP substitution or synthesized artwork URL. Explicit `ABSENT_AT_SOURCE` remains truthful terminal evidence. | Source/Docker-backed tests pass; live endpoint/schema, artwork, and real-catalogue completeness proof pending. |
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
- Before queue publication, the API persists an application-envelope-encrypted
  PostgreSQL recovery record. A 15-second worker sweep reconstructs missing work
  after API/worker restarts, CDP transport loss, or a complete Redis/BullMQ loss,
  resuming from the first unfinished checkpoint. This authority ends at the
  original Steel lease or immutable scan deadline; neither is extended.
- Reconciliation audits UPC, distributor artwork, release/upload dates, label,
  and every ISRC. It retries only releases with retryable field gaps, merges
  stronger evidence without discarding previously verified data, and refuses
  `COMPLETE` until those gaps close. Artwork remains distributor-only
  `NETWORK_JSON`; explicit `ABSENT_AT_SOURCE` is not converted into a retry or a
  fabricated value.
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
- The 14 ordered Prisma migrations include governance tables, controlled audit
  expiry, durable DistroKid checkpoints, split runtime database capabilities,
  expected-track counts, and the encrypted DistroKid recovery envelope.
- The production image uses compiled API/worker entrypoints and Next standalone,
  runs as non-root, and excludes a local browser and TypeScript/test runtime.

## Verification evidence

Evidence confirmed in this working tree:

- The full Docker-backed run applied all **14 ordered migrations** to a fresh
  PostgreSQL database and completed **95/95 files and 752/752 tests with zero
  skips** against real local PostgreSQL, Redis, and BullMQ services.
- That suite includes the post-erasure receipt assertion, 1,200-track six-stage
  BullMQ completion, exact 1,100-release resume after total Redis/BullMQ state
  loss, and release-targeted metadata retry without rereading complete releases.
- Repository TypeScript validation, ESLint, focused security/auth/organization/
  governance/catalogue/DSP suites, and real-Chromium network-first tests passed.
- Synthetic catalogue tests exceed the requested size, including exact
  1,100-release durable-checkpoint recovery after Redis loss, 1,200-track queue
  completion, targeted field-gap repair, and a 1,001-item DSP regression. This
  is application-scale evidence only, not an authorized DistroKid result.
- `cfn-lint` accepts `bootstrap.yaml`, `dr-region.yaml`, and `production.yaml`.
  Template validation is not target-account deployment or recovery evidence.
- The configured Steel API capability probe returned `READY`. A YouTube Data API
  request succeeded, and Google's token endpoint recognized the configured OAuth
  client pair while rejecting a deliberately invalid grant. This does not prove a
  Google broker login or the other DSP credentials.
- The current environment does not contain the complete AWS governance, KMS,
  backup-inventory, DSP, authorized-account, or signed-approval inputs. Missing
  values were not invented and production startup is expected to fail closed.

These results apply to the reviewed working tree. They must be reproduced from
the eventual reviewed commit by the protected release workflow for the registry
digest before they become deployable release evidence.

Do not cite a local mutable image ID as release evidence. The release artifact is
valid only after a reviewed commit is built, pushed, registry-scanned, signed,
and verified by digest.

## Remaining release blockers

1. Obtain independent legal, privacy/DPA, security, and authorized-test-account
   approvals and inject their genuine signed compliance bundle.
2. Run the complete attended Steel scenario against the authorized 1,000+ track
   DistroKid account, including MFA by the user, exact count reconciliation,
   cancellation, API/worker/CDP interruption, total Redis loss, provider failure,
   revocation, and provider-side orphan-session verification. Prove completion
   within the configured Steel lease; an expired lease requires a new attended
   session and is not covered by the recovery guarantee.
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
