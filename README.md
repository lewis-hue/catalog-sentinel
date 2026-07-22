# Artist Catalog Sentinel

Artist Catalog Sentinel is a multi-tenant catalogue operations platform. A user authenticates through Keycloak, opens a user-attended Steel browser session, signs in to DistroKid directly, and authorizes a read-only catalogue extraction. The system persists normalized release and track metadata, reconciles completeness, checks DSP presence, and retains manageable scan history.

## Production architecture

- **Web:** Next.js BFF; browser tokens remain server-side.
- **Identity:** Keycloak OIDC with Google federation, verified issuer/audience, and organization membership enforced in PostgreSQL.
- **Browser:** Steel sessions only. The application never collects distributor passwords or bypasses account controls.
- **API:** Fastify with authenticated, organization-scoped routes and least-privilege workspace checks.
- **Workers:** BullMQ/Redis queues with release-chunked, resumable DistroKid extraction and bounded per-account concurrency.
- **Data:** PostgreSQL is the durable system of record; Redis holds queues, hot state, leases, and checkpoints.
- **Security:** AWS KMS envelope encryption, signed compliance approval gates, append-only hash-chained audit records, and S3 Object Lock anchors.
- **Cloud:** Two-AZ ECS/Aurora/ElastiCache infrastructure, PITR/backups, DR inputs, WAF, autoscaling, and digest-only images are defined under `infra/aws/`.

The network-first DistroKid reader attaches Playwright over CDP to the user-authorized Steel session. It captures only allowlisted catalogue responses, records field-level provenance, distinguishes source absence from extraction failure, checkpoints by release chunk, and refuses to finalize while indexed releases remain unresolved.

## Required production gates

Production startup fails closed unless durable PostgreSQL and Redis, Keycloak, Steel, KMS, exact viewer origins, tested session/capacity limits, and a current signed legal/privacy/security approval are configured. The definitive environment inventory is in `.env.example`; cloud secret and deployment inputs are in `infra/aws/README.md`.

Human and external evidence cannot be manufactured by this repository. Before release, authorized owners must complete:

1. legal/DPA and retention approval, represented by the signed compliance bundle;
2. live Google/Keycloak, Steel, and DSP credential acceptance;
3. an authorized read-only 1,000+ track DistroKid run using `npm run accept:distrokid`;
4. target-account AWS readiness, restore/DR exercises, and the authenticated production soak;
5. the protected release workflow that pushes, scans, signs, attests, and verifies the digest-addressed image.

## Verification

```bash
npm ci
npm run typecheck
npm run lint
npm test
npm run test:infra
npm audit --audit-level=high
npm run accept:credentials
npm run accept:distrokid
npm run loadtest:production
```

The three acceptance commands require explicit real endpoints, authorization, and credentials. They fail when evidence is absent; a skipped integration is never treated as a production pass.

Validate the cloud templates locally on Windows:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/aws/validate.ps1
```

Build the hardened runtime image:

```bash
docker build --file Dockerfile.production --tag artist-catalog-sentinel:local .
```

Do not use a mutable local tag for release. `.github/workflows/release.yml` publishes an immutable ECR digest with vulnerability/secret scanning, SBOM and provenance, Sigstore signing, and verification bound to the protected workflow identity.

## Operations and evidence

- `docs/production-acceptance.md` — release checklist and evidence rules
- `docs/distrokid-network-first-extractor.md` — extraction and reconciliation design
- `docs/security-model.md` — trust boundaries and data handling
- `infra/aws/README.md` — AWS bootstrap, deployment, backup, and recovery procedure

No real credentials, raw browser state, distributor responses, or customer catalogue exports belong in source control.
