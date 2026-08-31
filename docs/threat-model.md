# Threat Model - Secure Distributor Link

| # | Threat | Mitigation(s) |
| --- | --- | --- |
| 1 | **Credential theft** | No raw password storage; no hosted password form (startup hard-block); user logs in inside the isolated remote browser only. |
| 2 | **Session theft** | Session/state refs envelope-encrypted at rest; live-view URL treated as a full-account bearer capability and restricted to exact approved origins; short TTLs; provider secrets server-side only; explicit termination with durable retry/recovery. A process-death window between remote creation and durable registration remains a production gate, bounded only by Steel TTL. |
| 3 | **Malicious insider access** | RBAC; tenant scoping on every record + query; audited access; least-privilege IAM (prod); encrypted refs (insider DB read yields ciphertext). |
| 4 | **Cross-tenant data leakage** | `tenantId` on every entity; all reads filtered by tenant; consent/session bound to `tenantId` + `artistWorkspaceId`. |
| 5 | **Provider token leakage** | `providerAdminToken` / connect URL stored **encrypted, backend-only**; API responses never include them (test asserts session payload has no token/cookie/storageState). |
| 6 | **Screenshot leakage** | Screenshots are disabled. Login/2FA/billing/payment/tax/settings routes are blocked, but pixel redaction and production screenshot storage are not implemented; enabling screenshot capture is therefore a release-blocking change. |
| 7 | **Overbroad data extraction** | Scanner extracts catalog-management fields only; never payment/tax/bank/personal data; unknown fields → UNKNOWN, not guessed. |
| 8 | **Account lockout due to automation** | Per-account distributed locking, sequential release chunks, queue rate limiting, catalogue caps/deadlines, and stop-on-challenge behavior prevent aggressive parallelism. `DISTRIBUTOR_SCAN_MIN_DELAY_MS` configures the BullMQ limiter, but a proven live pacing/capacity policy remains an acceptance gate. |
| 9 | **Platform ToS violation** | Attended login (no automated auth); risky modes feature-flagged off by default; legal review gate before enabling providers. |
| 10 | **Scan job replay** | Idempotent jobs (resume checkpoints, stable ids); consent + state re-validated at run time; expired/revoked refs rejected. |
| 11 | **Stale cookies / state** | Steel leases and Redis ownership/claim records are time-bounded; workers reject expired or revoked consent and terminal work. Scheduled retention and owner-requested cross-store erasure are implemented with durable leases/checkpoints and concrete PostgreSQL, Redis/BullMQ, S3, Steel, Keycloak, Secrets Manager, observability, backup-expiry, membership, and controlled-audit adapters. Target-system deletion/backup-expiry evidence remains a release gate. |
| 12 | **Browser session hijacking or misuse** | The attended viewer has the user's full signed-in account authority. Deliver its bearer URL only to the authenticated owner; never log/share it; use short TTL, explicit revocation, and verified terminal release. Sentinel's read-only extraction guard does not constrain user-controlled viewer actions. |
| 13 | **Frontend token exposure** | Frontend receives the required short-lived live-view capability plus safe status, never Steel API keys, CDP URLs, cookies, or storage state. CSP/referrer/no-store controls and redaction protect the live-view capability. |

## Additional controls

CSP + security headers, HMAC signed URLs for downloads, default-off risky modes,
startup config assertions, expiring operational ownership records, and durable
redacted audit events are active. Events form a per-tenant hash chain; AWS KMS
signatures and KMS-encrypted S3 Object Lock anchors are the required production
sink, with role-restricted export and guarded expiry. Consent is explicit,
scoped, time-limited, and revocable; workers check it at browser-bound
checkpoints and cleanup is retried, with Steel TTL as the final backstop. Target
retention/erasure execution and external WORM/export/access verification remain
production acceptance gates.
