# Production acceptance

Last reconciled: 2026-07-23.

## Current verdict

**NO-SHIP — NOT YET CERTIFIED.**

This checklist is the release gate. Source code, CloudFormation, passing local
tests, a Steel capability probe, or one successful scan cannot substitute for an
owner, timestamp, environment, immutable commit/image digest, and retrievable
artifact for every applicable acceptance item.

## Implemented baseline (not release approval)

The current working tree contains:

- Steel-only user-attended browser access and a six-stage BullMQ catalogue path;
  runtime mock/demo, alternate-browser, legacy-DOM, inline, and single-job
  catalogue routes are removed;
- durable PostgreSQL catalogue checkpoints and exact reconciliation, including
  expected track counts when independently exposed by the release index;
- truthful field-level status/provenance and fail-closed DSP pagination/capacity;
- Keycloak/OIDC BFF enforcement plus durable organizations, personal first-login
  provisioning, invitation/member/workspace roles, selected-organization checks,
  and membership removal;
- principal/workspace-bound scan history with open, rename, terminal deletion,
  cursor pagination, saved-snapshot platform recheck, and separate fresh Steel
  refresh;
- owner-requested, idempotent tenant erasure and scheduled retention with
  checkpointed PostgreSQL, Redis/BullMQ, S3, Steel, Keycloak, Secrets Manager,
  observability, backup-expiry, membership, and governed audit adapters;
- hash-chained audit events, restricted readers, AWS KMS signatures, encrypted S3
  Object Lock anchors, and guarded audit expiry;
- AWS KMS session envelope encryption, HMAC pseudonymization/receipts, distinct
  audit signing, endpoint-override rejection, and least-privilege API/worker IAM;
- 13 ordered Prisma migrations, including split runtime database capabilities;
- AWS CloudFormation for two-AZ ECS/Aurora/Redis, WAF/TLS, autoscaling, alarms,
  PITR, locked backups, cross-region restore inputs, artifact replication, and a
  secondary-region DR stack; and
- a compiled non-root runtime image definition plus a protected workflow for
  digest publication, Trivy scanning, SBOM/provenance, Cosign signing, and signer
  verification.

These controls are described in
[Production evaluation](production-evaluation-2026-07-22.md) and
[Requirements traceability](requirements-traceability-2026-07-22.md).

## Current hard blockers

- No specifically authorized real DistroKid account has completed the attended
  1,000+ track acceptance scenario.
- No genuine legal, privacy/DPA, security, or test-account approval bundle is
  recorded. Flags and test signatures are not approval.
- No deployed Google/Keycloak login flow or complete credentialed validation for
  every enabled DSP is recorded.
- KMS/governance code and IAM definitions exist, but their approved target AWS
  keys, policies, rotation, recovery, throttling, and optional HSM backing have
  not been proven.
- Retention, tenant erasure, backup expiry, audit WORM/export, and restored-data
  handling have not been observed end-to-end in the target services.
- Cloud IaC exists, but no target deployment, failover, PITR/cross-region restore,
  authenticated production load/soak, alert, rollback, or incident drill has
  produced acceptance evidence.
- A clean committed revision has produced a locally hardened image, but no
  registry-pushed, Trivy-passing, signed, digest-addressed image with retrievable
  SBOM/provenance and Cosign verification exists yet.
- Steel lease/capacity and the bounded pre-registration orphan-session window
  have not been accepted against the selected production service.

## Current local evidence

- The default repository run completed **85 passing files plus 8 expected
  infrastructure-gated files (93 total)**, with **685 passing tests and 50
  expected infrastructure-gated skips (735 total)**.
- The disposable PostgreSQL/Redis run applied all **13 current migrations** to a
  fresh database and completed **93/93 files and 735/735 tests with zero skips**.
  It includes post-erasure receipt access, exact 1,100-release recovery after a
  Redis flush, and the 1,200-track six-stage BullMQ path.
- TypeScript, lint, focused security/auth/organization/governance/catalogue/DSP,
  and real-Chromium network-first suites passed during this review.
- Synthetic tests cover more than 1,000 catalogue records, including exact
  1,100-release checkpoint recovery after Redis loss and a 1,001-item DSP case.
  This is not a real DistroKid/Steel throughput result.
- The Steel capability probe returned `READY`; YouTube Data API accepted a live
  request; Google's OAuth endpoint recognized the configured client pair while
  rejecting a deliberately invalid grant. These probes did not validate a Google
  broker login, DistroKid session, or the full DSP set.
- The AWS templates pass local CloudFormation lint. This is not deployment,
  backup, restore, DR, or load evidence.

These counts describe the clean committed source revision. The protected release
workflow and published digest must reproduce them before release.

## Approval record

| Field | Required value |
| --- | --- |
| Source commit | |
| Registry image digest | |
| Trivy / SBOM / provenance / Cosign evidence | |
| Environment, account, and regions | |
| Migration task/log reference | |
| Engineering owner | |
| Security approver | |
| Privacy/DPA approver | |
| Legal approver for DistroKid access | |
| Authorized test-account reference | |
| Live acceptance evidence bundle | |
| Load/soak report | |
| Restore/DR report and measured RPO/RTO | |
| Approval date and expiry | |

## Governance and data handling

- [ ] Legal approved the exact DistroKid pages, passive network observations,
  request cadence, retention, and support workflow for this release.
- [ ] Any direct authenticated JSON reader has separate written approval; if it
  does not, both direct-reader gates are disabled in the deployed environment.
- [ ] The Steel terms/DPA, subprocessors, data region, deletion, and retention meet
  the approved deployment policy.
- [ ] Privacy notice, consent, revocation, legal holds, retention schedule,
  deletion SLA, restored-data handling, and breach notification are approved.
- [ ] A production log/trace/artifact review finds no password, MFA secret,
  cookie, API key, CDP endpoint, session ID, or live-view URL.
- [ ] Named incident, privacy, security, revocation, and customer-support owners
  have exercised the runbooks.

## Identity and organization isolation

- [ ] Keycloak uses the canonical HTTPS issuer, production hostname/TLS, protected
  administration, and rehearsed signing-key rotation.
- [ ] The confidential BFF client uses exact redirect URIs, `S256` PKCE, secure
  cookies, and a secret supplied/rotated through the approved secret manager.
- [ ] A real Google broker first login provisions the personal organization once;
  logout/relogin, refresh, revoked identity, and post-erasure behavior pass.
- [ ] Invitation issue/accept/revoke, organization selection, owner/admin/member/
  auditor/billing roles, workspace grants, and membership removal pass against
  the target PostgreSQL service.
- [ ] Real PostgreSQL/Redis tests prove that another tenant or same-organization
  unauthorized subject cannot read, mutate, queue, cancel, resume, stream,
  download, erase, or audit another subject/workspace resource.
- [ ] Organization headers/body/query fields never grant authority; every customer
  and governance operation uses the verified token plus current membership.
- [ ] Keycloak outage, JWKS rotation/cache, token replay, invitation replay, and
  organization-removal races fail closed.

## Steel session path

- [ ] Deployed API/workers require `BROWSER_LINK_PROVIDER=steel`,
  `STEEL_REQUIRED=true`, and the approved `cloud`, `external`, or `self_hosted`
  connector mode.
- [ ] Image/source/task inspection finds no alternate/local/mock/demo browser,
  legacy scan, inline dispatch, VNC/noVNC, Tor/proxy evasion, stealth, CAPTCHA
  solving, or credential-capture path.
- [ ] Steel control/CDP endpoints are reachable only from private workloads and
  are absent from public ingress, DNS, logs, metrics, traces, and artifacts.
- [ ] Live-view capability delivery, exact origin checks, expiry, replay,
  referrer/no-store behavior, and cross-tenant access pass penetration testing.
- [ ] The user completes login/MFA directly; application components never receive
  or type credentials and do not bypass challenges.
- [ ] Create, confirm, cancel, timeout, failure, API crash, worker crash,
  revocation, and normal completion release the Steel session, with provider-side
  orphan inventory reconciled.
- [ ] The selected Steel quotas, concurrency, regional capacity, and lease duration
  support the authorized maximum catalogue with adverse-latency safety margin.
- [ ] Redis/application/WAF rate limits prevent a principal from exhausting paid
  sessions and return verified retry guidance.

## Catalogue and DSP truthfulness

- [ ] The exact release revision passes the >1,000 synthetic, real Redis/BullMQ,
  PostgreSQL checkpoint/persistence, parser, and reconciliation suites.
- [ ] The separately authorized 1,000+ track account completes with exact indexed,
  expected-when-known, captured, failed, duplicate, and final counts.
- [ ] The live case set includes pagination, collaborations, multi-disc releases,
  duplicate titles, re-releases, missing identifiers, optional metadata, and
  Unicode.
- [ ] Only an explicit captured source absence becomes `ABSENT_AT_SOURCE`; omitted,
  malformed, timeout, request, parse, authorization, and legacy-unknown values
  remain not captured/failed.
- [ ] Every enabled DSP proves identity, pagination, quotas, caps, retry behavior,
  and completeness using authorized credentials.
- [ ] Truncation, cap, quota, timeout, provider error, missing credential, degraded
  evidence, or identity ambiguity yields `unverifiable`/manual review, never a
  definitive absence. YouTube/web search remain confirmation-only.
- [ ] Reconciliation refuses success while any indexed release or independent
  expected track count remains unresolved.

## History, retention, and erasure

- [ ] Authenticated UI acceptance covers history open, pagination, rename,
  terminal delete, saved-snapshot platform recheck, and fresh attended DistroKid
  refresh, including error/accessibility states.
- [ ] Scheduled retention deletes only eligible records, resumes from checkpoints,
  tolerates worker restarts, and records exact resource counts.
- [ ] An owner-requested tenant erasure removes PostgreSQL, Redis/BullMQ, all S3
  versions/replicas, Steel sessions, Keycloak identity, Secrets Manager data,
  observability data, and memberships within the approved SLA.
- [ ] Erasure receipts stay accessible only to their verified requester, contain
  no raw tenant/HMAC/lease secret, and remain verifiable after membership deletion.
- [ ] Backup expiry and restored-data re-erasure are observed; legal holds are
  limited to approved backup/audit records with a recorded legal basis.
- [ ] Idempotency, partial provider failure, lease loss, retry, concurrent request,
  cross-tenant denial, and post-erasure personal-tenant recreation all pass.

## Cryptography, database, and storage

- [ ] Target workload identities have only the documented KMS encryption/HMAC/
  signing permissions and encryption contexts; endpoint overrides are absent.
- [ ] KMS/HSM key creation, rotation, disable/recovery, throttling, CloudTrail
  alerting, and multi-replica behavior are rehearsed.
- [ ] Migration, API, worker, and governance login roles target one database; only
  migration owns schema changes and all **13 migrations** apply cleanly.
- [ ] Aurora TLS, writer/reader behavior, PITR, encrypted backups, restricted
  runtime roles, saturation alerts, and a timed restore pass.
- [ ] Redis TLS/auth, private networking, multi-AZ failover, persistence/eviction,
  queue recovery, and outage behavior pass.
- [ ] S3 version encryption, tenant scoping, short-lived access, lifecycle,
  replication, exact-version erasure, restore, and Object Lock controls pass.
- [ ] Audit-chain verification, KMS signature verification, WORM anchor retrieval,
  least-privilege export, controlled expiry, and tamper alerting pass.

## Cloud, supply chain, and operations

- [ ] Bootstrap, DR, and production stacks deploy from reviewed change sets in the
  approved accounts/regions without broad public or IAM exposure.
- [ ] ECS readiness, governance/queue worker heartbeats, queue lag, Steel sessions,
  auth denials, completeness, database/Redis saturation, backup, and error-rate
  alarms route to tested responders.
- [ ] Authenticated concurrent load/soak covers maximum catalogues, connects,
  retries, deploys, Keycloak/Steel/DSP outages, database/Redis failover, and
  governance workloads.
- [ ] PITR and cross-region restores reconcile rows/objects and application health;
  measured RPO/RTO meet the approved objectives.
- [ ] The exact reviewed commit passes typecheck, lint, unit, browser, migration,
  infrastructure, acceptance, and clean-image assertions.
- [ ] The protected release workflow pushes an immutable digest, blocks on Trivy
  high/critical findings, publishes SBOM/provenance, signs with Cosign, and records
  successful identity verification.
- [ ] Rollback/forward migration compatibility, credential/key rotation, tenant
  erasure, restore, DR, incident, and break-glass procedures are exercised.
- [ ] Independent threat-model and penetration reviews cover SSRF, OIDC/BFF,
  IDOR/tenancy, invitation and erasure flows, Steel capabilities, CSP/framing,
  audit integrity, and supply chain.

## Final acceptance scenario

- [ ] A specifically authorized non-customer account completes consent → attended
  Steel login/MFA → DistroKid index → release chunks → reconciliation → DSP checks
  → report → revocation with more than 1,000 tracks and exact truthful totals.
- [ ] The scenario is repeated with API restart, worker restart, Redis loss, Steel
  timeout, DSP quota failure, user cancellation, and provider failure; results
  remain tenant-safe, resumable, truthful, and free of leaked sessions/secrets.
- [ ] Engineering, security, privacy/DPA, and legal sign the approval record for
  the exact source commit, image digest, environment, and evidence bundle.
