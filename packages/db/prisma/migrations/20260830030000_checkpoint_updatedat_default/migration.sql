-- The DistroKid checkpoint tables are written via raw upserts (distrokid-recovery.ts) that omit the
-- Prisma-managed @updatedAt column. That column is NOT NULL with no DB default, so a raw INSERT fails
-- with: null value in column "updatedAt" of relation "DistroKidSnapshotCheckpoint" violates not-null
-- constraint. Give every DistroKid* @updatedAt/createdAt column a now() default so raw inserts
-- succeed; Prisma still overwrites updatedAt on its own updates. Idempotent: only columns without a
-- default are altered.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name LIKE 'DistroKid%'
      AND column_name IN ('updatedAt', 'createdAt')
      AND column_default IS NULL
  LOOP
    EXECUTE format('ALTER TABLE %I ALTER COLUMN %I SET DEFAULT now()', r.table_name, r.column_name);
  END LOOP;
END $$;
