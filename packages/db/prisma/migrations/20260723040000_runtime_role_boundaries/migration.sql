-- Runtime database capability roles are deliberately separate from the schema-owning migration
-- credential. Deployment creates/rotates LOGIN roles through its privileged secret workflow and
-- grants each login exactly one of these NOLOGIN roles.
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sentinel_api_runtime') THEN
    CREATE ROLE sentinel_api_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sentinel_worker_runtime') THEN
    CREATE ROLE sentinel_worker_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sentinel_governance_executor') THEN
    CREATE ROLE sentinel_governance_executor NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
END
$roles$;

GRANT USAGE ON SCHEMA public TO sentinel_api_runtime, sentinel_worker_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO sentinel_api_runtime, sentinel_worker_runtime;

-- API access covers customer-facing operational tables only. Governance execution state,
-- durable pipeline checkpoints, and audit internals are intentionally excluded.
DO $api_grants$
DECLARE
  relation_name TEXT;
BEGIN
  FOR relation_name IN
    SELECT tablename
      FROM pg_tables
     WHERE schemaname = 'public'
       AND tablename NOT IN (
         'security_audit_events', 'audit_chain_heads', 'audit_chain_anchors',
         'audit_erasure_receipts', 'audit_anchor_outbox', 'audit_purge_manifests',
         'audit_purge_guards', 'RetentionPolicy', 'RetentionRun', 'TenantErasureStep',
         'TenantErasureRequest',
         'DistroKidSnapshotCheckpoint', 'DistroKidCheckpointIndex',
         'DistroKidCheckpointOutcome', 'DistroKidCheckpointProgress',
         'DistroKidCheckpointChunk', 'DistroKidCheckpointPassPlanChunk',
         'DistroKidCheckpointTerminal'
       )
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO sentinel_api_runtime', relation_name);
  END LOOP;
END
$api_grants$;
GRANT SELECT, INSERT ON security_audit_events TO sentinel_api_runtime;
GRANT SELECT ON audit_chain_anchors, audit_erasure_receipts TO sentinel_api_runtime;
GRANT SELECT, INSERT ON "TenantErasureRequest", "TenantErasureStep" TO sentinel_api_runtime;

-- The worker owns queue projections, durable checkpoints, retention, and erasure orchestration.
-- Audit mutation remains trigger/function controlled even for this role.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO sentinel_worker_runtime;
REVOKE UPDATE, DELETE, TRUNCATE ON security_audit_events FROM sentinel_worker_runtime;
REVOKE ALL ON audit_chain_heads, audit_purge_guards FROM sentinel_worker_runtime;
GRANT SELECT ON audit_chain_heads TO sentinel_worker_runtime;
REVOKE UPDATE, DELETE, TRUNCATE ON audit_chain_anchors FROM sentinel_worker_runtime;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON audit_erasure_receipts FROM sentinel_worker_runtime;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON audit_purge_manifests FROM sentinel_worker_runtime;
GRANT SELECT, INSERT, DELETE ON audit_anchor_outbox TO sentinel_worker_runtime;

GRANT EXECUTE ON FUNCTION sentinel_prepare_expired_audit_purge(TEXT, TEXT, TEXT)
  TO sentinel_governance_executor;
GRANT EXECUTE ON FUNCTION sentinel_purge_expired_audit_chain(TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT, TEXT, TEXT)
  TO sentinel_governance_executor;
GRANT SELECT ON audit_erasure_receipts, audit_purge_manifests TO sentinel_governance_executor;
GRANT SELECT, INSERT, DELETE ON audit_anchor_outbox TO sentinel_governance_executor;
GRANT sentinel_governance_executor TO sentinel_worker_runtime;

-- PUBLIC receives no runtime capability through these objects or guarded functions.
REVOKE ALL ON audit_chain_heads, audit_purge_guards, audit_erasure_receipts,
  audit_anchor_outbox, audit_purge_manifests FROM PUBLIC;
REVOKE ALL ON FUNCTION sentinel_prepare_expired_audit_purge(TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION sentinel_purge_expired_audit_chain(TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
