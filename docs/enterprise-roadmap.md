# Enterprise Roadmap

Sentinel's architecture is designed to grow from a single-artist tool into a
platform offered to distributors (DistroKid, UnitedMasters, TuneCore, CD Baby)
and labels/managers as a catalog-QA and support-triage product.

## Product offerings this enables

- **Catalog QA dashboard** - proactive metadata/coverage health per artist.
- **Artist support triage platform** - auto-classify inbound issues, attach
  evidence, and draft responses (the support-packet engine, in reverse).
- **Delivery health monitor** - continuous reconciliation of distributor
  deliveries vs. DSP reality; alert on drift.
- **Missing-platform detector / DSP delivery reconciliation layer** - the
  Audiomack audit, generalized to every integrated DSP.
- **Artist-profile issue detector** - wrong/duplicate/foreign-content profiles.
- **Metadata validation engine** - ISRC/UPC, credits, artwork, explicit flags.
- **Royalty/statistics anomaly monitor** - missing/dropped/inconsistent stats.
- **White-label distributor portal** + **API product** for labels/managers.

## Integration roadmap

| Track | Items |
| --- | --- |
| **Official distributor APIs** | DistroKid/UM/TuneCore/CD Baby partner APIs; replace CSV where available |
| **DSP partnerships** | Spotify, Apple Music, YouTube, Amazon, Deezer, TIDAL, Audiomack Data API |
| **Delivery status** | Webhook-based delivery/ingestion status; email ingestion of distributor status emails |
| **Support tooling** | Zendesk / Intercom / Freshdesk / Jira ticket creation from packets |
| **Notifications** | Slack alerts for new critical issues / delivery failures |
| **Exports** | Google Sheets / Excel; distributor-ready spreadsheets |

## Multi-artist & organizations

- **Label/manager multi-artist workspaces** - the `Tenant → Workspace → Artist`
  model already supports this; add roster views, roll-up dashboards, and
  cross-artist SLA reporting.
- **RBAC** is in place (`owner/admin/manager/analyst/viewer`); extend with
  custom roles and per-artist scoping.

## Security & compliance track

- **SOC 2 Type II** - formalize controls already designed in: encryption
  (KMS/TLS), audit logging, access control, change management (CI/CD),
  vulnerability + secret scanning, backup/restore, data-deletion procedure.
- **SSO / SAML** and **SCIM** provisioning for enterprise identity.
- **Audit exports** - signed, tamper-evident audit-log exports for customers.
- **Data residency** - per-tenant region pinning; row-level security in Postgres.

## Data & analytics track

- **Data warehouse integration** - stream snapshots/issues/royalties to
  Snowflake/BigQuery/Redshift.
- **BI dashboards** - coverage trends, delivery SLAs, issue MTTR.
- **Anomaly detection** - statistical baselines for royalty/stream drops
  (deterministic + statistical; no DSP content used to train models).
- **SLA dashboards** - delivery-time and reinstatement-time tracking per
  distributor/DSP.

## Scale & reliability

- **Workers**: BullMQ on Redis (or Temporal) for durable, resumable scans; the
  job contract (`enqueue`, idempotency keys, retry/backoff) is already the shape.
- **Rate governance**: central per-platform budgets; adaptive backoff on 429s.
- **Multi-region**: stateless api/web + regional RDS read replicas + S3 CRR.

## Sequencing (suggested)

1. Harden the Audiomack + one major-DSP integration end to end (official APIs).
2. Multi-artist label workspaces + roll-up dashboards.
3. Webhook delivery status + email ingestion + Slack/Zendesk.
4. SOC 2 Type II + SSO/SCIM.
5. Warehouse + BI + anomaly detection.
6. White-label distributor portal + public API product.
