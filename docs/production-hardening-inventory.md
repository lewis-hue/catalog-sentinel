# Production-hardening inventory

## Verdict

**NOT YET CERTIFIED.** This is an implementation inventory, not a release
approval. External evidence is governed by
[Production acceptance](production-acceptance.md).

| Area | Current implementation | Remaining release evidence |
| --- | --- | --- |
| Real browser | Steel is the only runtime provider. Playwright attaches remotely over CDP; the user enters credentials and MFA directly. Alternate/local browser routes and legacy dispatch are removed. | Authorized attended lifecycle, lease/capacity, capability URL, crash, and orphan-session tests. |
| Runtime code | Runtime composition contains no mock/demo stores, providers, jobs, credentials, or data modes. Test doubles live only in test-support/test files. | Repeat source/image inventory against the immutable revision. |
| Authentication | Keycloak JWT enforcement and a confidential OIDC Authorization Code + PKCE BFF are implemented. Tokens are validated before storage or forwarding. | Deployed Google broker, issuer/key rotation, outage, secret rotation, and penetration evidence. |
| Organizations | PostgreSQL-backed personal provisioning, organizations, invitations, active memberships, roles, workspace grants, selection validation, removal, and erasure tombstones are enforced. | Target-PostgreSQL multi-tenant/IDOR exercise and operational membership recovery procedure. |
| Catalogue pipeline | The sole runtime route is a six-stage BullMQ pipeline with per-account locking, immutable deadlines, durable PostgreSQL checkpoints, retries, and exact reconciliation. | Authorized 1,000+ DistroKid run and production concurrency/soak. |
| Result truth | Field status/provenance is preserved. Explicit expected track counts fail reconciliation on mismatch; unknown counts remain unknown. DSP pagination/caps fail closed. | Credentialed schema/quota/identity validation for every enabled provider. |
| Scan history | Principal/workspace-bound cursor history supports open, rename, terminal delete, saved-snapshot recheck, and a separate fresh attended refresh. | Authenticated browser UX/accessibility acceptance. |
| Session crypto | Active session handoffs use AES-256-GCM data keys wrapped by AWS KMS; local keys and endpoint overrides fail in production. | Target key/IAM/CloudHSM decision, rotation, recovery, CloudTrail, throttle, and replica evidence. |
| Retention | Leased, checkpointed scheduled retention has concrete PostgreSQL, Redis/BullMQ, S3/version, and operational-resource adapters. Governance readiness is mandatory. | Target credentials, approved schedules, S3 replica/object expiry, backup expiry, SLA, and recovery exercise. |
| Tenant erasure | Owners can create idempotent erasure requests and retrieve redacted receipts. Adapters cover database rows, cache/queues, objects/replicas, Steel, Keycloak, Secrets Manager, observability, memberships, backup expiry, and controlled audit treatment. | End-to-end target deletion proof, documented legal holds, backup expiry observation, restored-data handling, and DPA approval. |
| Audit | API/worker events are tenant hash-chained. Audit-reader roles are restricted; anchors are KMS-signed and written to encrypted S3 Object Lock. Database guards control expiry. | Target WORM/KMS proof, independent verification/export, retrieval, alarms, retention approval, and incident exercise. |
| Database roles | Migration-owned roles separate API, worker, governance, and schema-change capabilities. Thirteen ordered migrations define the current schema. | Run all migrations and readiness in target account using actual restricted login roles. |
| Cloud | AWS templates define two-AZ ECS, Aurora writer/reader/PITR, multi-AZ Redis, private networking, TLS ALB, WAF, autoscaling, alarms, AWS Backup/Vault Lock, artifact replication, and a secondary-region DR stack. | Deploy, fail over, restore, load/soak, measure RPO/RTO, and retain approved evidence. |
| Container | Production image is compiled, non-root, read-only/capability-drop compatible, and contains no local browser or TypeScript/test runner. | Build the reviewed commit, push by digest, and re-run runtime assertions on that digest. |
| Supply chain | Protected release workflow performs Trivy source/config/image scans, BuildKit SBOM/provenance, immutable ECR publication, keyless Cosign signing, and identity verification. | Actual reviewed commit, registry digest, scan, SBOM/provenance, signature, and verification artifacts. |
| Legal/compliance | Startup verifies a signed, bounded approval bundle with independent legal, privacy, and security signers. | Genuine DPA/terms/privacy/legal approval and authorized account reference; flags are not approval. |

## Runtime surface

The supported customer surface is the authenticated web/API application, the
six DistroKid queues, governance worker, PostgreSQL, Redis, AWS services, Keycloak,
and Steel. There is no supported production mock, demo, inline catalogue,
legacy-DOM, local-Chromium, VNC/noVNC, Browserless, Hyperbeam, Kasm, Tor, or proxy-
evasion path.

Test-support modules may construct deterministic fakes inside isolated tests.
They are excluded from the production image and are not selectable by runtime
configuration.
