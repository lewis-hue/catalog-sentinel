# AWS production deployment

These templates are the supported production topology. They deliberately do not
start the application until the immutable image, runtime secret, migrations, DR
targets, and approval gates are ready.

## Topology

- `bootstrap.yaml` creates the retained configuration KMS key, empty runtime
  secret, immutable encrypted ECR repository, and a repository/environment-bound
  GitHub OIDC release role.
- `dr-region.yaml` creates the retained secondary-region KMS key, replica bucket,
  and Vault-Locked AWS Backup vault.
- `production.yaml` creates a two-AZ VPC, isolated data subnets, two NAT gateways,
  VPC flow logs, customer-managed KMS keys, Aurora PostgreSQL writer/reader,
  encrypted multi-AZ Redis with automatic failover, WORM audit storage, AWS
  Backup Vault Lock and cross-region copies, ECS/Fargate services, Service
  Connect, autoscaling, an ALB, WAF, TLS-only ingress, alarms, and cross-region
  artifact replication.

This is a materially billable AWS deployment. Use an approved account, budgets,
quotas, domain/certificate, incident contacts, and a secondary Region chosen by
the organization's residency and recovery policy.

## Required runtime secret keys

The Secrets Manager value is a JSON object. Every referenced key must exist
before services are enabled; an empty or partially populated secret causes task
startup to fail closed.

| Area | Keys |
| --- | --- |
| Application | `APP_BASE_URL`, `API_DATABASE_URL`, `WORKER_DATABASE_URL`, `MIGRATION_DATABASE_URL`, `REDIS_URL`, `HISTORY_CURSOR_SIGNING_KEY` |
| Keycloak API | `KEYCLOAK_BASE_URL`, `KEYCLOAK_ISSUER`, `KEYCLOAK_REALM`, `KEYCLOAK_API_CLIENT_ID`, `KEYCLOAK_API_AUDIENCE` |
| Keycloak BFF | `KEYCLOAK_PUBLIC_BASE_URL`, `KEYCLOAK_WEB_CLIENT_ID`, `KEYCLOAK_WEB_CLIENT_SECRET` |
| Steel | `STEEL_CONNECTOR_MODE`, `STEEL_API_KEY`, `STEEL_API_URL`, `STEEL_CDP_INTERNAL`, `STEEL_VIEWER_ORIGINS`, `STEEL_SESSION_TIMEOUT_MS` |
| Catalogue limits | `CATALOG_READ_MAX_RELEASES`, `CATALOG_READ_MAX_DURATION_MS` |
| Governed live access | `ENABLE_DISTROKID_LIVE_SCANNER`, `LEGAL_REVIEW_DISTROKID_SCANNER_APPROVED`, `COMPLIANCE_APPROVAL_BUNDLE`, `COMPLIANCE_APPROVAL_KEY_ID`, `COMPLIANCE_APPROVAL_PUBLIC_KEY_PEM`, `COMPLIANCE_APPROVAL_ISSUER` |
| Official DSP APIs | `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `YOUTUBE_API_KEY`, `AUDIOMACK_CONSUMER_KEY`, `AUDIOMACK_CONSUMER_SECRET`, `AUDIOMACK_PROFILE_URL`, `SOUNDCLOUD_CLIENT_ID`, `SOUNDCLOUD_CLIENT_SECRET`, `SOUNDCLOUD_PROFILE_URL`, `TIDAL_CLIENT_ID`, `TIDAL_CLIENT_SECRET`, `TIDAL_PROFILE_URL` |
| Governance inventory | `GOVERNANCE_BACKUP_VAULTS`, `GOVERNANCE_ARTIFACT_BUCKETS`, `BACKUP_RETENTION_DAYS`, `BACKUP_LEGAL_BASIS_REFERENCE`, `AUDIT_LEGAL_BASIS_REFERENCE` |
| Erasure integrations | `KEYCLOAK_ADMIN_BASE_URL`, `KEYCLOAK_ERASURE_CLIENT_ID`, `OBSERVABILITY_ERASURE_URL`, `OBSERVABILITY_ERASURE_READINESS_URL` |

Production must use `STEEL_CONNECTOR_MODE=cloud`, `external`, or `self_hosted` and
the Steel session path. Do not place distributor credentials, cookies, MFA
secrets, or live-view URLs in this secret. Users enter credentials only into the
attended Steel browser session.

All three database URLs target the same migrated database. `API_DATABASE_URL` must be a member of
`sentinel_api_runtime`, `WORKER_DATABASE_URL` must be a member of
`sentinel_worker_runtime`, and only `MIGRATION_DATABASE_URL` may own or alter schema objects. The
runtime capability roles are migration-managed; provision LOGIN roles and grant those memberships
through the organization's privileged database/secret workflow. `REDIS_URL` must use TLS
(`rediss://`) and the generated Redis auth secret. Never copy credentials into source, shell
history, or a CloudFormation parameter.

## Deployment order

1. Validate locally with
   `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/aws/validate.ps1`
   (or the equivalent `pwsh` command on PowerShell 7).
2. Deploy `bootstrap.yaml` once in the primary Region. Configure the protected
   GitHub `production-release` environment with the output role and ECR URI.
3. Merge a reviewed commit and publish an immutable digest through
   `.github/workflows/release.yml`. The workflow tests the exact revision, scans
   source/config/image, signs the digest, and publishes provenance.
4. Deploy `dr-region.yaml` in the approved secondary Region and retain its three
   outputs.
5. Deploy `production.yaml` in the primary Region with `DeployServices=false`,
   the digest reference, bootstrap secret/key ARNs, ACM certificate, and all DR
   output ARNs. This creates foundations and task definitions only.
6. Populate the runtime secret through the approved secret-management workflow.
   Validate the deployed Keycloak/Google broker, Steel, and DSP credentials
   without recording secret values.
7. Run the one-off migration task with `scripts/aws/run-migration.ps1`; require a
   zero container exit code and retain the CloudWatch log reference.
8. Execute a point-in-time restore and cross-region backup restore drill into an
   isolated recovery target. Record measured RPO/RTO and destroy test resources
   only through the approved change process after evidence is retained.
9. Update the same primary stack with `DeployServices=true`. Wait for ECS service
   stability and require `/health/ready` to pass through HTTPS.
10. Run the authenticated load/soak gate and the separately authorized attended
    1,000+ track DistroKid acceptance. Release only when all evidence is bound to
    the same commit and image digest.

The compliance bundle is a compact RS256 JWS with a maximum 90-day lifetime. It
must carry distinct legal, privacy, and security approvals plus exact policy,
account-authorization, retention, session-duration, and catalogue-size limits.
The API and worker verify its signature and limits at startup; the public key is
controlled separately from the workload. Do not create a self-approved key or
bundle inside the application release process.

CloudFormation template deployment is not evidence that restore, capacity, live
identity, Steel, Google, DSP, or legal gates passed. Those require recorded tests
in the target account. Never set approval flags or manufacture an approval bundle
to make startup pass.

## Recovery requirements

- Aurora point-in-time retention is 35 days, with daily and monthly AWS Backup
  recovery points copied to the locked DR vault when its ARN is supplied.
- The primary artifact bucket is versioned and asynchronously replicated to the
  DR bucket with KMS encryption when both destination parameters are supplied.
- Redis is a three-node multi-AZ replication group with automatic failover and
  seven days of snapshots. Treat queued jobs as recoverable orchestration state;
  PostgreSQL remains the system of record for scan and governance state.
- Audit objects use S3 Object Lock in compliance mode. Application audit records
  also form a verifiable hash chain; chain verification and WORM export are part
  of the operational acceptance gate.

Run quarterly restore exercises and after material schema/topology changes. A
successful drill records source recovery point, destination, start/end time,
row/object reconciliation, application smoke result, RPO, RTO, and approvers.

## Supply-chain controls

Only `repository@sha256:<64 hex>` image references are accepted by
`production.yaml`. ECR tag mutability is disabled. The release workflow uses
immutable action SHAs, OIDC rather than static AWS keys, BuildKit SBOM/provenance,
Trivy high/critical blocking scans, Sigstore keyless signing, and post-signature
identity verification. The protected GitHub environment must require human
review and restrict deployment branches/tags.

Before promotion, record the commit, digest, Trivy result, SBOM/provenance,
Cosign verification output, CloudFormation change set, migration task ARN,
restore evidence, load report, and acceptance approvals in the release record.
