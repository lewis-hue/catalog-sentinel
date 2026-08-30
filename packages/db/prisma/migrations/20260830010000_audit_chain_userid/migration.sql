-- Finish the per-user column rename inside the audit-chain trigger function.
--
-- 20260830000000_per_user_isolation renamed every security_audit_events and
-- audit_chain_heads column from tenant_id to user_id and dropped workspace_id.
-- A plpgsql function body is stored as text and is NOT rewritten by RENAME COLUMN,
-- so the BEFORE INSERT chain trigger still referenced NEW."tenant_id",
-- NEW."workspace_id" and audit_chain_heads."tenant_id" -- which made EVERY audit
-- write (a live, awaited API path: consent grants, scans, exports) fail with
-- `record "new" has no field "tenant_id"`. Re-point the function to user_id and
-- drop the removed workspace field from the canonical payload. Behavior is
-- otherwise identical: the append-only hash chain is preserved, now keyed by the
-- owning subject.
CREATE OR REPLACE FUNCTION sentinel_chain_audit_event() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  head_sequence BIGINT;
  head_hash TEXT;
BEGIN
  INSERT INTO public."audit_chain_heads" ("user_id", "last_sequence", "last_hash", "updated_at")
  VALUES (NEW."user_id", 0, '', clock_timestamp())
  ON CONFLICT ("user_id") DO NOTHING;

  SELECT "last_sequence", "last_hash" INTO head_sequence, head_hash
  FROM public."audit_chain_heads"
  WHERE "user_id" = NEW."user_id"
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
    'userId', NEW."user_id"
  )::text;
  NEW."event_hash" := encode(digest(convert_to(head_hash || E'\n' || NEW."canonical_payload", 'UTF8'), 'sha256'), 'hex');

  UPDATE public."audit_chain_heads"
  SET "last_sequence" = NEW."chain_sequence", "last_hash" = NEW."event_hash", "updated_at" = clock_timestamp()
  WHERE "user_id" = NEW."user_id";
  RETURN NEW;
END
$function$;
