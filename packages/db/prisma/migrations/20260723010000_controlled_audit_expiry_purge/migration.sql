-- Finite audit retention needs a deletion path, but ordinary UPDATE/DELETE remains forbidden.
-- Only this SECURITY DEFINER function may create a transaction/backend-bound guard row that the
-- append-only trigger accepts. Production must grant EXECUTE to a dedicated governance role;
-- application/API roles receive no direct mutation grant on audit tables or guard/receipt tables.

CREATE TABLE "audit_erasure_receipts" (
  "id" TEXT PRIMARY KEY,
  "request_id" TEXT NOT NULL UNIQUE,
  "tenant_hash" TEXT NOT NULL,
  "tenant_digest" TEXT NOT NULL,
  "hold_until" TIMESTAMPTZ NOT NULL,
  "purged_at" TIMESTAMPTZ NOT NULL,
  "security_event_count" BIGINT NOT NULL,
  "last_chain_sequence" BIGINT NOT NULL,
  "last_event_hash" TEXT NOT NULL,
  "external_anchor_count" BIGINT NOT NULL,
  "external_anchor_digest" TEXT NOT NULL,
  "signed_payload" TEXT NOT NULL,
  "signer_key_id" TEXT NOT NULL,
  "signature" TEXT NOT NULL,
  CONSTRAINT "audit_erasure_receipts_hashes" CHECK (
    "tenant_hash" ~ '^[0-9a-f]{64}$'
    AND "tenant_digest" ~ '^[0-9a-f]{64}$'
    AND ("last_event_hash" = '' OR "last_event_hash" ~ '^[0-9a-f]{64}$')
    AND "external_anchor_digest" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "audit_erasure_receipts_counts" CHECK (
    "security_event_count" >= 0 AND "last_chain_sequence" >= 0 AND "external_anchor_count" >= 0
  )
);

CREATE TABLE "audit_purge_guards" (
  "token" UUID PRIMARY KEY,
  "transaction_id" BIGINT NOT NULL,
  "backend_pid" INTEGER NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "request_id" TEXT NOT NULL
);

-- Persist the exact (possibly nondeterministic ECDSA) signature before the S3 write. If S3
-- succeeds and the process dies before audit_chain_anchors is committed, retry reuses these bytes.
CREATE TABLE "audit_anchor_outbox" (
  "tenant_id" TEXT NOT NULL,
  "chain_sequence" BIGINT NOT NULL,
  "event_hash" TEXT NOT NULL,
  "payload" TEXT NOT NULL,
  "signer_key_id" TEXT NOT NULL,
  "signature" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY ("tenant_id", "chain_sequence"),
  CONSTRAINT "audit_anchor_outbox_hash" CHECK ("event_hash" ~ '^[0-9a-f]{64}$')
);

-- Phase-one purge state. Its creation freezes this tenant's audit chain while preserving the
-- exact immutable-object inventory across worker/process crashes. It intentionally stores only a
-- one-way tenant digest; the already encrypted subjectRef remains in TenantErasureStep.
CREATE TABLE "audit_purge_manifests" (
  "request_id" TEXT PRIMARY KEY,
  "tenant_digest" TEXT NOT NULL UNIQUE,
  "hold_until" TIMESTAMPTZ NOT NULL,
  "security_event_count" BIGINT NOT NULL,
  "last_chain_sequence" BIGINT NOT NULL,
  "last_event_hash" TEXT NOT NULL,
  "external_anchor_count" BIGINT NOT NULL,
  "external_anchor_digest" TEXT NOT NULL,
  "external_anchor_refs" JSONB NOT NULL,
  "prepared_at" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "audit_purge_manifests_hashes" CHECK (
    "tenant_digest" ~ '^[0-9a-f]{64}$'
    AND ("last_event_hash" = '' OR "last_event_hash" ~ '^[0-9a-f]{64}$')
    AND "external_anchor_digest" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "audit_purge_manifests_counts" CHECK (
    "security_event_count" >= 0 AND "last_chain_sequence" >= 0 AND "external_anchor_count" >= 0
  ),
  CONSTRAINT "audit_purge_manifests_refs" CHECK (jsonb_typeof("external_anchor_refs") = 'array')
);

REVOKE ALL ON "audit_erasure_receipts" FROM PUBLIC;
REVOKE ALL ON "audit_purge_guards" FROM PUBLIC;
REVOKE ALL ON "audit_anchor_outbox" FROM PUBLIC;
REVOKE ALL ON "audit_purge_manifests" FROM PUBLIC;

-- Every append takes the same transaction-scoped tenant lock as anchor publication and purge
-- preparation. Once a purge manifest/receipt exists, accepting another event would recreate a
-- chain for an erased tenant, so the insert is rejected permanently and atomically.
CREATE OR REPLACE FUNCTION sentinel_chain_audit_event() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  head_sequence BIGINT;
  head_hash TEXT;
  digest_hex TEXT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW."tenant_id", 749187231));
  digest_hex := encode(digest(convert_to(NEW."tenant_id", 'UTF8'), 'sha256'), 'hex');
  IF EXISTS (SELECT 1 FROM public."audit_purge_manifests" WHERE "tenant_digest" = digest_hex)
    OR EXISTS (SELECT 1 FROM public."audit_erasure_receipts" WHERE "tenant_digest" = digest_hex) THEN
    RAISE EXCEPTION 'audit chain is frozen for controlled tenant erasure';
  END IF;

  INSERT INTO public."audit_chain_heads" ("tenant_id", "last_sequence", "last_hash", "updated_at")
  VALUES (NEW."tenant_id", 0, '', clock_timestamp())
  ON CONFLICT ("tenant_id") DO NOTHING;

  SELECT "last_sequence", "last_hash" INTO head_sequence, head_hash
  FROM public."audit_chain_heads"
  WHERE "tenant_id" = NEW."tenant_id"
  FOR UPDATE;

  NEW."canonical_version" := 1;
  NEW."chain_sequence" := head_sequence + 1;
  NEW."previous_hash" := head_hash;
  NEW."canonical_payload" := jsonb_build_object(
    'action', NEW."action",
    'actorUserId', NEW."actor_user_id",
    'canonicalVersion', 1,
    'id', NEW."id",
    'metadata', NEW."metadata",
    'occurredAt', to_char(NEW."occurred_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'targetId', NEW."target_id",
    'targetType', NEW."target_type",
    'tenantId', NEW."tenant_id",
    'workspaceId', NEW."workspace_id"
  )::text;
  NEW."event_hash" := encode(digest(convert_to(head_hash || E'\n' || NEW."canonical_payload", 'UTF8'), 'sha256'), 'hex');

  UPDATE public."audit_chain_heads"
  SET "last_sequence" = NEW."chain_sequence", "last_hash" = NEW."event_hash", "updated_at" = clock_timestamp()
  WHERE "tenant_id" = NEW."tenant_id";
  RETURN NEW;
END
$function$;

CREATE FUNCTION sentinel_guard_audit_anchor_insert() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  digest_hex TEXT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW."tenant_id", 749187231));
  digest_hex := encode(digest(convert_to(NEW."tenant_id", 'UTF8'), 'sha256'), 'hex');
  IF EXISTS (SELECT 1 FROM public."audit_purge_manifests" WHERE "tenant_digest" = digest_hex)
    OR EXISTS (SELECT 1 FROM public."audit_erasure_receipts" WHERE "tenant_digest" = digest_hex) THEN
    RAISE EXCEPTION 'audit anchors are frozen for controlled tenant erasure';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER audit_chain_anchors_freeze_before_insert
  BEFORE INSERT ON "audit_chain_anchors"
  FOR EACH ROW EXECUTE FUNCTION sentinel_guard_audit_anchor_insert();
CREATE TRIGGER audit_anchor_outbox_freeze_before_insert
  BEFORE INSERT ON "audit_anchor_outbox"
  FOR EACH ROW EXECUTE FUNCTION sentinel_guard_audit_anchor_insert();

CREATE OR REPLACE FUNCTION sentinel_reject_audit_mutation() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  guard_token TEXT;
  guarded BOOLEAN := false;
BEGIN
  IF TG_OP = 'DELETE' AND TG_LEVEL = 'ROW' THEN
    guard_token := current_setting('sentinel.audit_purge_guard', true);
    IF guard_token IS NOT NULL AND guard_token <> '' THEN
      SELECT EXISTS (
        SELECT 1 FROM public."audit_purge_guards" AS guard
        WHERE guard."token"::text = guard_token
          AND guard."transaction_id" = txid_current()
          AND guard."backend_pid" = pg_backend_pid()
          AND guard."tenant_id" = (to_jsonb(OLD)->>'tenant_id')
      ) INTO guarded;
    END IF;
    IF guarded THEN RETURN OLD; END IF;
  END IF;
  RAISE EXCEPTION 'audit records are append-only outside the controlled expiry purge';
END
$function$;

CREATE TRIGGER audit_erasure_receipts_no_update_or_delete
  BEFORE UPDATE OR DELETE ON "audit_erasure_receipts"
  FOR EACH ROW EXECUTE FUNCTION sentinel_reject_audit_mutation();
CREATE TRIGGER audit_erasure_receipts_no_truncate
  BEFORE TRUNCATE ON "audit_erasure_receipts"
  FOR EACH STATEMENT EXECUTE FUNCTION sentinel_reject_audit_mutation();

-- Phase one is the only supported way to take an audit purge inventory. The advisory lock is
-- shared with event/anchor insertion, so the committed manifest is an atomic, durable freeze.
CREATE FUNCTION sentinel_prepare_expired_audit_purge(
  p_request_id TEXT,
  p_tenant_id TEXT,
  p_tenant_digest TEXT
) RETURNS TABLE (
  "eventCount" BIGINT,
  "lastSequence" BIGINT,
  "lastHash" TEXT,
  "anchorCount" BIGINT,
  "anchorDigest" TEXT,
  "anchorRefs" JSONB,
  "holdUntil" TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  request_row public."TenantErasureRequest"%ROWTYPE;
  step_row public."TenantErasureStep"%ROWTYPE;
  manifest_row public."audit_purge_manifests"%ROWTYPE;
  digest_hex TEXT;
BEGIN
  IF p_tenant_digest !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid controlled audit purge tenant digest';
  END IF;
  digest_hex := encode(digest(convert_to(p_tenant_id, 'UTF8'), 'sha256'), 'hex');
  IF digest_hex <> p_tenant_digest THEN RAISE EXCEPTION 'audit purge tenant binding mismatch'; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id, 749187231));
  SELECT * INTO request_row FROM public."TenantErasureRequest"
  WHERE "id" = p_request_id AND "status" = 'SUCCEEDED'
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'eligible tenant erasure request not found'; END IF;

  SELECT * INTO step_row FROM public."TenantErasureStep"
  WHERE "requestId" = p_request_id AND "resourceKind" = 'audit_legal_record'
    AND "status" = 'SKIPPED_LEGAL_HOLD'
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'eligible audit legal hold not found'; END IF;
  IF NULLIF(step_row."checkpoint"->>'holdUntil', '')::timestamptz > clock_timestamp() THEN
    RAISE EXCEPTION 'audit legal hold has not expired';
  END IF;
  IF step_row."checkpoint"->>'tenantDigest' IS DISTINCT FROM p_tenant_digest THEN
    RAISE EXCEPTION 'audit purge checkpoint binding mismatch';
  END IF;

  SELECT * INTO manifest_row FROM public."audit_purge_manifests"
  WHERE "request_id" = p_request_id FOR UPDATE;
  IF FOUND THEN
    IF manifest_row."tenant_digest" <> p_tenant_digest THEN
      RAISE EXCEPTION 'existing audit purge manifest binding mismatch';
    END IF;
  ELSE
    INSERT INTO public."audit_purge_manifests" (
      "request_id", "tenant_digest", "hold_until", "security_event_count",
      "last_chain_sequence", "last_event_hash", "external_anchor_count",
      "external_anchor_digest", "external_anchor_refs", "prepared_at"
    )
    SELECT p_request_id, p_tenant_digest,
      (step_row."checkpoint"->>'holdUntil')::timestamptz,
      (SELECT count(*) FROM public."security_audit_events" WHERE "tenant_id" = p_tenant_id),
      COALESCE((SELECT max("chain_sequence") FROM public."security_audit_events" WHERE "tenant_id" = p_tenant_id), 0),
      COALESCE((SELECT "event_hash" FROM public."security_audit_events"
        WHERE "tenant_id" = p_tenant_id ORDER BY "chain_sequence" DESC LIMIT 1), ''),
      (SELECT count(*) FROM public."audit_chain_anchors" WHERE "tenant_id" = p_tenant_id),
      encode(digest(convert_to(COALESCE((SELECT string_agg("external_ref", E'\n' ORDER BY "chain_sequence")
        FROM public."audit_chain_anchors" WHERE "tenant_id" = p_tenant_id), ''), 'UTF8'), 'sha256'), 'hex'),
      COALESCE((SELECT jsonb_agg("external_ref" ORDER BY "chain_sequence")
        FROM public."audit_chain_anchors" WHERE "tenant_id" = p_tenant_id), '[]'::jsonb),
      clock_timestamp()
    RETURNING * INTO manifest_row;
    -- A signature prepared for an anchor that never reached S3 is not part of the frozen inventory.
    DELETE FROM public."audit_anchor_outbox" WHERE "tenant_id" = p_tenant_id;
  END IF;

  RETURN QUERY SELECT
    manifest_row."security_event_count", manifest_row."last_chain_sequence",
    manifest_row."last_event_hash", manifest_row."external_anchor_count",
    manifest_row."external_anchor_digest", manifest_row."external_anchor_refs",
    to_char(manifest_row."hold_until" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
END
$function$;

REVOKE ALL ON FUNCTION sentinel_prepare_expired_audit_purge(TEXT, TEXT, TEXT) FROM PUBLIC;

CREATE FUNCTION sentinel_purge_expired_audit_chain(
  p_request_id TEXT,
  p_tenant_id TEXT,
  p_tenant_digest TEXT,
  p_external_anchor_count BIGINT,
  p_external_anchor_digest TEXT,
  p_purged_at TEXT,
  p_signed_payload TEXT,
  p_signer_key_id TEXT,
  p_signature TEXT
) RETURNS TABLE ("receiptId" TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  request_row public."TenantErasureRequest"%ROWTYPE;
  step_row public."TenantErasureStep"%ROWTYPE;
  manifest_row public."audit_purge_manifests"%ROWTYPE;
  event_count BIGINT;
  last_sequence BIGINT;
  last_hash TEXT;
  anchor_count BIGINT;
  anchor_digest TEXT;
  expected_payload TEXT;
  guard_token UUID := gen_random_uuid();
  receipt_id TEXT := 'auditpurge_' || gen_random_uuid()::text;
  existing_receipt_id TEXT;
  purge_time TIMESTAMPTZ;
BEGIN
  IF p_tenant_digest !~ '^[0-9a-f]{64}$' OR p_external_anchor_digest !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid controlled audit purge digest';
  END IF;
  purge_time := p_purged_at::timestamptz;
  IF purge_time > clock_timestamp() + interval '5 minutes' THEN
    RAISE EXCEPTION 'controlled audit purge time is in the future';
  END IF;

  IF encode(digest(convert_to(p_tenant_id, 'UTF8'), 'sha256'), 'hex') <> p_tenant_digest THEN
    RAISE EXCEPTION 'audit purge tenant binding mismatch';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id, 749187231));
  SELECT "id" INTO existing_receipt_id FROM public."audit_erasure_receipts"
  WHERE "request_id" = p_request_id AND "tenant_digest" = p_tenant_digest;
  IF FOUND THEN RETURN QUERY SELECT existing_receipt_id; RETURN; END IF;

  SELECT * INTO request_row FROM public."TenantErasureRequest"
  WHERE "id" = p_request_id AND "status" = 'SUCCEEDED'
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'eligible tenant erasure request not found'; END IF;

  SELECT * INTO step_row FROM public."TenantErasureStep"
  WHERE "requestId" = p_request_id AND "resourceKind" = 'audit_legal_record'
    AND "status" = 'SKIPPED_LEGAL_HOLD'
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'eligible audit legal hold not found'; END IF;
  IF NULLIF(step_row."checkpoint"->>'holdUntil', '')::timestamptz > purge_time THEN
    RAISE EXCEPTION 'audit legal hold has not expired';
  END IF;
  IF step_row."checkpoint"->>'tenantDigest' IS DISTINCT FROM p_tenant_digest THEN
    RAISE EXCEPTION 'audit purge tenant binding mismatch';
  END IF;

  SELECT * INTO manifest_row FROM public."audit_purge_manifests"
  WHERE "request_id" = p_request_id AND "tenant_digest" = p_tenant_digest
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'prepared audit purge manifest not found'; END IF;
  IF manifest_row."external_anchor_count" <> p_external_anchor_count
    OR manifest_row."external_anchor_digest" <> p_external_anchor_digest THEN
    RAISE EXCEPTION 'signed audit purge does not match the prepared manifest';
  END IF;

  SELECT count(*), COALESCE(max("chain_sequence"), 0)
  INTO event_count, last_sequence
  FROM public."security_audit_events" WHERE "tenant_id" = p_tenant_id;
  SELECT COALESCE("event_hash", '') INTO last_hash
  FROM public."security_audit_events"
  WHERE "tenant_id" = p_tenant_id ORDER BY "chain_sequence" DESC LIMIT 1;
  last_hash := COALESCE(last_hash, '');

  SELECT count(*), encode(digest(convert_to(COALESCE(string_agg("external_ref", E'\n' ORDER BY "chain_sequence"), ''), 'UTF8'), 'sha256'), 'hex')
  INTO anchor_count, anchor_digest
  FROM public."audit_chain_anchors" WHERE "tenant_id" = p_tenant_id;
  IF event_count <> manifest_row."security_event_count"
    OR last_sequence <> manifest_row."last_chain_sequence"
    OR last_hash <> manifest_row."last_event_hash"
    OR anchor_count <> manifest_row."external_anchor_count"
    OR anchor_digest <> manifest_row."external_anchor_digest" THEN
    RAISE EXCEPTION 'audit inventory changed after the durable purge freeze';
  END IF;

  expected_payload := 'sentinel-audit-erasure-v1' || E'\n'
    || p_request_id || E'\n' || p_tenant_digest || E'\n'
    || to_char(manifest_row."hold_until" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') || E'\n'
    || event_count::text || E'\n' || last_sequence::text || E'\n' || last_hash || E'\n'
    || anchor_count::text || E'\n' || anchor_digest || E'\n' || p_purged_at;
  IF expected_payload <> p_signed_payload OR length(p_signer_key_id) = 0 OR length(p_signature) = 0 THEN
    RAISE EXCEPTION 'signed audit purge receipt payload mismatch';
  END IF;

  INSERT INTO public."audit_purge_guards" ("token", "transaction_id", "backend_pid", "tenant_id", "request_id")
  VALUES (guard_token, txid_current(), pg_backend_pid(), p_tenant_id, p_request_id);
  PERFORM set_config('sentinel.audit_purge_guard', guard_token::text, true);

  DELETE FROM public."audit_chain_anchors" WHERE "tenant_id" = p_tenant_id;
  DELETE FROM public."security_audit_events" WHERE "tenant_id" = p_tenant_id;
  DELETE FROM public."audit_chain_heads" WHERE "tenant_id" = p_tenant_id;
  DELETE FROM public."audit_anchor_outbox" WHERE "tenant_id" = p_tenant_id;

  UPDATE public."TenantErasureStep"
  SET "checkpoint" = ("checkpoint" - 'subjectRef') || jsonb_build_object('purgedAt', p_purged_at, 'receiptId', receipt_id),
      "updatedAt" = clock_timestamp()
  WHERE "requestId" = p_request_id AND "resourceKind" = 'audit_legal_record';

  INSERT INTO public."audit_erasure_receipts" (
    "id", "request_id", "tenant_hash", "tenant_digest", "hold_until", "purged_at",
    "security_event_count", "last_chain_sequence", "last_event_hash", "external_anchor_count",
    "external_anchor_digest", "signed_payload", "signer_key_id", "signature"
  ) VALUES (
    receipt_id, p_request_id, request_row."tenantHash", p_tenant_digest,
    manifest_row."hold_until", purge_time,
    event_count, last_sequence, last_hash, anchor_count, anchor_digest,
    p_signed_payload, p_signer_key_id, p_signature
  );

  DELETE FROM public."audit_purge_manifests" WHERE "request_id" = p_request_id;

  DELETE FROM public."audit_purge_guards" WHERE "token" = guard_token;
  PERFORM set_config('sentinel.audit_purge_guard', '', true);
  RETURN QUERY SELECT receipt_id;
END
$function$;

REVOKE ALL ON FUNCTION sentinel_purge_expired_audit_chain(TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;

-- Grant only when the deployment has pre-created the non-login capability role. The governance
-- database user must be granted this role by the database bootstrap process.
DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sentinel_governance_executor') THEN
    GRANT EXECUTE ON FUNCTION sentinel_purge_expired_audit_chain(TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT, TEXT, TEXT)
      TO sentinel_governance_executor;
    GRANT EXECUTE ON FUNCTION sentinel_prepare_expired_audit_purge(TEXT, TEXT, TEXT)
      TO sentinel_governance_executor;
    GRANT SELECT ON "audit_erasure_receipts" TO sentinel_governance_executor;
    GRANT SELECT, INSERT, DELETE ON "audit_anchor_outbox" TO sentinel_governance_executor;
    GRANT SELECT ON "audit_purge_manifests" TO sentinel_governance_executor;
  END IF;
END
$grant$;
