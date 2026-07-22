import { createHash, randomUUID } from 'node:crypto';
import type { GovernanceActor, GovernanceSqlClient, GovernanceSqlPool } from './governance-types';
import { GovernanceAuthorizationError, GovernanceConflictError, GovernanceValidationError } from './governance-types';

export interface AuditChainEventInput {
  tenantId: string;
  workspaceId?: string | null;
  actorUserId?: string | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
  occurredAt?: string;
}

export interface AuditChainRecord {
  id: string;
  occurredAt: string;
  tenantId: string;
  workspaceId: string | null;
  actorUserId: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  metadata: Record<string, unknown>;
  chainSequence: bigint;
  previousHash: string;
  eventHash: string;
  canonicalPayload: string;
  canonicalVersion: number;
}

export interface AuditChainAppender {
  append(event: AuditChainEventInput): Promise<AuditChainRecord>;
}

export interface TenantAuditChainReader {
  export(actor: GovernanceActor, input?: { afterSequence?: bigint; limit?: number }): Promise<AuditChainRecord[]>;
}

interface AuditRow {
  id: string;
  occurredAt: Date | string;
  tenantId: string;
  workspaceId: string | null;
  actorUserId: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  metadata: Record<string, unknown> | null;
  chainSequence: bigint | number | string;
  previousHash: string;
  eventHash: string;
  canonicalPayload: string;
  canonicalVersion: number;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapAudit(row: AuditRow): AuditChainRecord {
  return { ...row, occurredAt: iso(row.occurredAt), metadata: row.metadata ?? {}, chainSequence: BigInt(row.chainSequence) };
}

function validateText(value: string, label: string, max = 255): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max || [...normalized].some((character) => character.charCodeAt(0) < 32)) {
    throw new GovernanceValidationError(`${label} is invalid.`);
  }
  return normalized;
}

const SENSITIVE_AUDIT_KEY = /(authorization|cookie|password|passwd|secret|token|credential|storage.?state|session.?state|api.?key|private.?key)/i;

function assertSafeMetadata(metadata: Record<string, unknown>): string {
  const visit = (value: unknown, depth: number): void => {
    if (depth > 8) throw new GovernanceValidationError('Audit metadata nesting exceeds the allowed depth.');
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      if (value.length > 200) throw new GovernanceValidationError('Audit metadata arrays may contain at most 200 items.');
      value.forEach((entry) => visit(entry, depth + 1));
      return;
    }
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_AUDIT_KEY.test(key)) throw new GovernanceValidationError(`Sensitive audit metadata key is forbidden: ${key}.`);
      visit(entry, depth + 1);
    }
  };
  visit(metadata, 0);
  let encoded: string;
  try {
    encoded = JSON.stringify(metadata);
  } catch {
    throw new GovernanceValidationError('Audit metadata must be JSON serializable.');
  }
  if (Buffer.byteLength(encoded, 'utf8') > 32_768) throw new GovernanceValidationError('Audit metadata exceeds 32 KiB.');
  return encoded;
}

async function withClient<T>(pool: GovernanceSqlPool, work: (client: GovernanceSqlClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    const result = await work(client);
    client.release();
    return result;
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    client.release();
    throw error;
  }
}

const AUDIT_SELECT = `
  SELECT id, occurred_at AS "occurredAt", tenant_id AS "tenantId", workspace_id AS "workspaceId",
         actor_user_id AS "actorUserId", action, target_type AS "targetType", target_id AS "targetId",
         metadata, chain_sequence AS "chainSequence", previous_hash AS "previousHash",
         event_hash AS "eventHash", canonical_payload AS "canonicalPayload",
         canonical_version AS "canonicalVersion"
  FROM security_audit_events`;

/** The database trigger assigns the sequence and digest while locking the tenant chain head. */
export class PostgresAuditChainAppender implements AuditChainAppender {
  constructor(private readonly pool: GovernanceSqlPool) {}

  async append(event: AuditChainEventInput): Promise<AuditChainRecord> {
    const tenantId = validateText(event.tenantId, 'tenantId');
    const action = validateText(event.action, 'action');
    const targetType = validateText(event.targetType, 'targetType');
    const metadataJson = assertSafeMetadata(event.metadata ?? {});
    const occurredAt = event.occurredAt ? new Date(event.occurredAt) : new Date();
    if (!Number.isFinite(occurredAt.getTime()) || occurredAt.getTime() > Date.now() + 300_000) {
      throw new GovernanceValidationError('Audit occurredAt is invalid or unreasonably far in the future.');
    }
    return withClient(this.pool, async (client) => {
      const result = await client.query<AuditRow>(
        `INSERT INTO security_audit_events
           (id, occurred_at, tenant_id, workspace_id, actor_user_id, action, target_type, target_id, metadata)
         VALUES ($1, $2::timestamptz, $3, $4, $5, $6, $7, $8, $9::jsonb)
         RETURNING id, occurred_at AS "occurredAt", tenant_id AS "tenantId", workspace_id AS "workspaceId",
           actor_user_id AS "actorUserId", action, target_type AS "targetType", target_id AS "targetId",
           metadata, chain_sequence AS "chainSequence", previous_hash AS "previousHash",
           event_hash AS "eventHash", canonical_payload AS "canonicalPayload", canonical_version AS "canonicalVersion"`,
        [`audit_${randomUUID()}`, occurredAt.toISOString(), tenantId, event.workspaceId ?? null,
          event.actorUserId ?? null, action, targetType, event.targetId ?? null, metadataJson],
      );
      return mapAudit(result.rows[0]!);
    });
  }
}

export class PostgresTenantAuditChainReader implements TenantAuditChainReader {
  constructor(private readonly pool: GovernanceSqlPool) {}

  async export(actor: GovernanceActor, input: { afterSequence?: bigint; limit?: number } = {}): Promise<AuditChainRecord[]> {
    const limit = Math.max(1, Math.min(10_000, Math.floor(input.limit ?? 1_000)));
    const after = input.afterSequence ?? 0n;
    if (after < 0n) throw new GovernanceValidationError('afterSequence cannot be negative.');
    return withClient(this.pool, async (client) => {
      const allowed = await client.query(
        `SELECT 1 FROM "OrganizationMembership"
         WHERE "tenantId" = $1 AND "subjectId" = $2 AND "status" = 'ACTIVE'
           AND "role" IN ('OWNER', 'ADMIN', 'AUDITOR')`,
        [actor.tenantId, actor.subjectId],
      );
      if ((allowed.rowCount ?? 0) !== 1) throw new GovernanceAuthorizationError();
      const result = await client.query<AuditRow>(
        `${AUDIT_SELECT} WHERE tenant_id = $1 AND chain_sequence > $2::bigint
         ORDER BY chain_sequence LIMIT $3`,
        [actor.tenantId, after.toString(), limit],
      );
      return result.rows.map(mapAudit);
    });
  }
}

export interface AuditVerificationResult {
  valid: boolean;
  verifiedEvents: number;
  finalSequence: bigint;
  finalHash: string;
  error?: string;
}

/** Verify an export from genesis, or a page using an independently trusted predecessor anchor. */
export function verifyAuditChain(
  records: readonly AuditChainRecord[],
  predecessor: { sequence: bigint; hash: string } = { sequence: 0n, hash: '' },
): AuditVerificationResult {
  let sequence = predecessor.sequence;
  let hash = predecessor.hash;
  for (const record of records) {
    const expectedSequence = sequence + 1n;
    if (record.chainSequence !== expectedSequence) {
      return { valid: false, verifiedEvents: Number(sequence - predecessor.sequence), finalSequence: sequence, finalHash: hash, error: `Expected sequence ${expectedSequence}, received ${record.chainSequence}.` };
    }
    if (record.previousHash !== hash) {
      return { valid: false, verifiedEvents: Number(sequence - predecessor.sequence), finalSequence: sequence, finalHash: hash, error: `Previous hash mismatch at sequence ${record.chainSequence}.` };
    }
    const expectedHash = createHash('sha256').update(`${hash}\n${record.canonicalPayload}`, 'utf8').digest('hex');
    if (record.eventHash !== expectedHash) {
      return { valid: false, verifiedEvents: Number(sequence - predecessor.sequence), finalSequence: sequence, finalHash: hash, error: `Digest mismatch at sequence ${record.chainSequence}.` };
    }
    try {
      const payload = JSON.parse(record.canonicalPayload) as Record<string, unknown>;
      if (payload.id !== record.id || payload.tenantId !== record.tenantId || payload.action !== record.action || payload.targetType !== record.targetType || payload.canonicalVersion !== record.canonicalVersion) {
        return { valid: false, verifiedEvents: Number(sequence - predecessor.sequence), finalSequence: sequence, finalHash: hash, error: `Canonical payload mismatch at sequence ${record.chainSequence}.` };
      }
    } catch {
      return { valid: false, verifiedEvents: Number(sequence - predecessor.sequence), finalSequence: sequence, finalHash: hash, error: `Invalid canonical payload at sequence ${record.chainSequence}.` };
    }
    sequence = record.chainSequence;
    hash = record.eventHash;
  }
  return { valid: true, verifiedEvents: records.length, finalSequence: sequence, finalHash: hash };
}

export interface AuditAnchorSigner {
  sign(payload: Uint8Array): Promise<{ keyId: string; signature: string }>;
}

export interface ImmutableAuditAnchorStore {
  /** Must be idempotent for (tenantId, sequence); retries may follow an ambiguous network result. */
  put(input: { tenantId: string; sequence: bigint; eventHash: string; payload: string; signature: string; keyId: string }): Promise<{ immutableRef: string }>;
}

export interface AuditAnchorRecord {
  id: string;
  tenantId: string;
  chainSequence: bigint;
  eventHash: string;
  signerKeyId: string;
  signature: string;
  externalRef: string;
  anchoredAt: string;
}

export function auditAnchorPayload(tenantId: string, sequence: bigint, eventHash: string): string {
  return `sentinel-audit-anchor-v1\n${tenantId}\n${sequence}\n${eventHash}`;
}

export interface AuditAnchorSignatureVerifier {
  verify(input: { keyId: string; payload: Uint8Array; signature: string }): Promise<boolean>;
}

export async function verifyAnchoredAuditExport(
  records: readonly AuditChainRecord[],
  anchor: AuditAnchorRecord,
  signatureVerifier: AuditAnchorSignatureVerifier,
): Promise<AuditVerificationResult> {
  const chain = verifyAuditChain(records);
  if (!chain.valid) return chain;
  if (chain.finalSequence !== anchor.chainSequence || chain.finalHash !== anchor.eventHash) {
    return { ...chain, valid: false, error: 'Audit export does not terminate at the signed anchor.' };
  }
  const payload = Buffer.from(auditAnchorPayload(anchor.tenantId, anchor.chainSequence, anchor.eventHash), 'utf8');
  if (!await signatureVerifier.verify({ keyId: anchor.signerKeyId, payload, signature: anchor.signature })) {
    return { ...chain, valid: false, error: 'Audit anchor signature is invalid.' };
  }
  return chain;
}

/** Signs the current head and writes it to immutable external storage before recording the ref. */
export class AuditChainAnchorPublisher {
  constructor(
    private readonly pool: GovernanceSqlPool,
    private readonly signer: AuditAnchorSigner,
    private readonly immutableStore: ImmutableAuditAnchorStore,
  ) {}

  async anchorLatest(tenantIdValue: string): Promise<AuditAnchorRecord | null> {
    const tenantId = validateText(tenantIdValue, 'tenantId');
    type AnchorRow = {
      id: string; tenantId: string; chainSequence: bigint | string | number; eventHash: string;
      signerKeyId: string; signature: string; externalRef: string; anchoredAt: Date | string;
    };
    type PendingRow = {
      tenantId: string; chainSequence: bigint | string | number; eventHash: string;
      payload: string; signerKeyId: string; signature: string;
    };
    type Prepared = {
      sequence: bigint; eventHash: string; payload: string; pending: PendingRow;
    };
    const prepared = await withClient(this.pool, async (client): Promise<Prepared | AuditAnchorRecord | null> => {
      await client.query('BEGIN');
      try {
        await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 749187231))`, [tenantId]);
        const frozen = await client.query<{ frozen: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM audit_purge_manifests
             WHERE tenant_digest = encode(digest(convert_to($1, 'UTF8'), 'sha256'), 'hex')
             UNION ALL
             SELECT 1 FROM audit_erasure_receipts
             WHERE tenant_digest = encode(digest(convert_to($1, 'UTF8'), 'sha256'), 'hex')
           ) AS frozen`,
          [tenantId],
        );
        if (frozen.rows[0]?.frozen === true) throw new GovernanceConflictError('Audit chain is frozen for controlled tenant erasure.');
        const oldestPending = (await client.query<PendingRow>(
          `SELECT tenant_id AS "tenantId", chain_sequence AS "chainSequence", event_hash AS "eventHash",
                  payload, signer_key_id AS "signerKeyId", signature
           FROM audit_anchor_outbox WHERE tenant_id = $1
           ORDER BY chain_sequence LIMIT 1`,
          [tenantId],
        )).rows[0];
        if (oldestPending) {
          const sequence = BigInt(oldestPending.chainSequence);
          const payload = auditAnchorPayload(tenantId, sequence, oldestPending.eventHash);
          if (oldestPending.payload !== payload) {
            throw new GovernanceConflictError('Durable pending audit signature has an invalid canonical payload.');
          }
          const event = await client.query(
            `SELECT 1 FROM security_audit_events
             WHERE tenant_id = $1 AND chain_sequence = $2::bigint AND event_hash = $3`,
            [tenantId, sequence.toString(), oldestPending.eventHash],
          );
          if ((event.rowCount ?? event.rows.length) !== 1) {
            throw new GovernanceConflictError('Durable pending audit signature has no matching immutable event.');
          }
          const existing = await client.query<AnchorRow>(
            `SELECT id, tenant_id AS "tenantId", chain_sequence AS "chainSequence", event_hash AS "eventHash",
               signer_key_id AS "signerKeyId", signature, external_ref AS "externalRef", anchored_at AS "anchoredAt"
             FROM audit_chain_anchors WHERE tenant_id = $1 AND chain_sequence = $2::bigint`,
            [tenantId, sequence.toString()],
          );
          if (existing.rows[0]) {
            const prior = existing.rows[0];
            if (prior.eventHash !== oldestPending.eventHash || prior.signature !== oldestPending.signature) {
              throw new GovernanceConflictError('Stored audit anchor does not match its durable pending signature.');
            }
            await client.query(`DELETE FROM audit_anchor_outbox WHERE tenant_id = $1 AND chain_sequence = $2::bigint`, [tenantId, sequence.toString()]);
            await client.query('COMMIT');
            return { ...prior, chainSequence: BigInt(prior.chainSequence), anchoredAt: iso(prior.anchoredAt) };
          }
          await client.query('COMMIT');
          return { sequence, eventHash: oldestPending.eventHash, payload, pending: oldestPending };
        }
        const head = await client.query<{ sequence: bigint | string | number; eventHash: string }>(
          `SELECT "last_sequence" AS sequence, "last_hash" AS "eventHash"
           FROM audit_chain_heads WHERE "tenant_id" = $1`,
          [tenantId],
        );
        const row = head.rows[0];
        if (!row || BigInt(row.sequence) === 0n) {
          await client.query('COMMIT');
          return null;
        }
        const sequence = BigInt(row.sequence);
        const payload = auditAnchorPayload(tenantId, sequence, row.eventHash);
        const existing = await client.query<AnchorRow>(
          `SELECT id, tenant_id AS "tenantId", chain_sequence AS "chainSequence", event_hash AS "eventHash",
             signer_key_id AS "signerKeyId", signature, external_ref AS "externalRef", anchored_at AS "anchoredAt"
           FROM audit_chain_anchors WHERE tenant_id = $1 AND chain_sequence = $2::bigint`,
          [tenantId, sequence.toString()],
        );
        if (existing.rows[0]) {
          const prior = existing.rows[0];
          if (prior.eventHash !== row.eventHash) throw new GovernanceConflictError('Stored audit anchor does not match the chain head.');
          await client.query(`DELETE FROM audit_anchor_outbox WHERE tenant_id = $1 AND chain_sequence = $2::bigint`, [tenantId, sequence.toString()]);
          await client.query('COMMIT');
          return { ...prior, chainSequence: BigInt(prior.chainSequence), anchoredAt: iso(prior.anchoredAt) };
        }
        let pending = (await client.query<PendingRow>(
          `SELECT tenant_id AS "tenantId", chain_sequence AS "chainSequence", event_hash AS "eventHash",
                  payload, signer_key_id AS "signerKeyId", signature
           FROM audit_anchor_outbox WHERE tenant_id = $1 AND chain_sequence = $2::bigint`,
          [tenantId, sequence.toString()],
        )).rows[0];
        if (!pending) {
          const signed = await this.signer.sign(Buffer.from(payload, 'utf8'));
          pending = (await client.query<PendingRow>(
            `INSERT INTO audit_anchor_outbox
               (tenant_id, chain_sequence, event_hash, payload, signer_key_id, signature, created_at)
             VALUES ($1, $2::bigint, $3, $4, $5, $6, clock_timestamp())
             ON CONFLICT (tenant_id, chain_sequence) DO NOTHING
             RETURNING tenant_id AS "tenantId", chain_sequence AS "chainSequence", event_hash AS "eventHash",
                       payload, signer_key_id AS "signerKeyId", signature`,
            [tenantId, sequence.toString(), row.eventHash, payload, signed.keyId, signed.signature],
          )).rows[0] ?? (await client.query<PendingRow>(
            `SELECT tenant_id AS "tenantId", chain_sequence AS "chainSequence", event_hash AS "eventHash",
                    payload, signer_key_id AS "signerKeyId", signature
             FROM audit_anchor_outbox WHERE tenant_id = $1 AND chain_sequence = $2::bigint`,
            [tenantId, sequence.toString()],
          )).rows[0];
        }
        if (!pending || pending.eventHash !== row.eventHash || pending.payload !== payload) {
          throw new GovernanceConflictError('Pending audit anchor does not match the selected chain head.');
        }
        await client.query('COMMIT');
        return { sequence, eventHash: row.eventHash, payload, pending };
      } catch (cause) {
        await client.query('ROLLBACK');
        throw cause;
      }
    });
    if (!prepared || 'id' in prepared) return prepared;

    // The signature is already committed. Hold the tenant advisory lock across the idempotent S3
    // put and DB finalization so purge preparation can occur entirely before or after publication,
    // never between the immutable write and its database reference.
    return withClient(this.pool, async (client) => {
      await client.query('BEGIN');
      try {
        await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 749187231))`, [tenantId]);
        const frozen = await client.query<{ frozen: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM audit_purge_manifests
             WHERE tenant_digest = encode(digest(convert_to($1, 'UTF8'), 'sha256'), 'hex')
             UNION ALL
             SELECT 1 FROM audit_erasure_receipts
             WHERE tenant_digest = encode(digest(convert_to($1, 'UTF8'), 'sha256'), 'hex')
           ) AS frozen`,
          [tenantId],
        );
        if (frozen.rows[0]?.frozen === true) throw new GovernanceConflictError('Audit chain is frozen for controlled tenant erasure.');
        const pending = (await client.query<PendingRow>(
          `SELECT tenant_id AS "tenantId", chain_sequence AS "chainSequence", event_hash AS "eventHash",
                  payload, signer_key_id AS "signerKeyId", signature
           FROM audit_anchor_outbox WHERE tenant_id = $1 AND chain_sequence = $2::bigint`,
          [tenantId, prepared.sequence.toString()],
        )).rows[0];
        if (
          !pending || pending.eventHash !== prepared.eventHash || pending.payload !== prepared.payload
          || pending.signature !== prepared.pending.signature || pending.signerKeyId !== prepared.pending.signerKeyId
        ) {
          throw new GovernanceConflictError('Durable pending audit signature changed before publication.');
        }
        const event = await client.query(
          `SELECT 1 FROM security_audit_events
           WHERE tenant_id = $1 AND chain_sequence = $2::bigint AND event_hash = $3`,
          [tenantId, prepared.sequence.toString(), prepared.eventHash],
        );
        if ((event.rowCount ?? event.rows.length) !== 1) throw new GovernanceConflictError('Audit event disappeared before anchor publication.');
        const stored = await this.immutableStore.put({
          tenantId,
          sequence: prepared.sequence,
          eventHash: prepared.eventHash,
          payload: prepared.payload,
          signature: pending.signature,
          keyId: pending.signerKeyId,
        });
        if (!stored.immutableRef.trim()) throw new GovernanceValidationError('Immutable anchor store returned an empty reference.');
        const finalized = await client.query<AnchorRow>(
          `INSERT INTO audit_chain_anchors
             (id, tenant_id, chain_sequence, event_hash, signer_key_id, signature, external_ref, anchored_at)
           VALUES ($1, $2, $3::bigint, $4, $5, $6, $7, clock_timestamp())
           ON CONFLICT (tenant_id, chain_sequence) DO NOTHING
           RETURNING id, tenant_id AS "tenantId", chain_sequence AS "chainSequence", event_hash AS "eventHash",
                     signer_key_id AS "signerKeyId", signature, external_ref AS "externalRef", anchored_at AS "anchoredAt"`,
          [`anchor_${randomUUID()}`, tenantId, prepared.sequence.toString(), prepared.eventHash,
            pending.signerKeyId, pending.signature, stored.immutableRef],
        );
        const anchor = finalized.rows[0] ?? (await client.query<AnchorRow>(
          `SELECT id, tenant_id AS "tenantId", chain_sequence AS "chainSequence", event_hash AS "eventHash",
                  signer_key_id AS "signerKeyId", signature, external_ref AS "externalRef", anchored_at AS "anchoredAt"
           FROM audit_chain_anchors WHERE tenant_id = $1 AND chain_sequence = $2::bigint`,
          [tenantId, prepared.sequence.toString()],
        )).rows[0];
        if (
          !anchor || anchor.eventHash !== prepared.eventHash || anchor.signature !== pending.signature
          || anchor.externalRef !== stored.immutableRef
        ) {
          throw new GovernanceConflictError('Stored audit anchor does not match the durable pending signature and immutable object.');
        }
        await client.query(`DELETE FROM audit_anchor_outbox WHERE tenant_id = $1 AND chain_sequence = $2::bigint`, [tenantId, prepared.sequence.toString()]);
        await client.query('COMMIT');
        return { ...anchor, chainSequence: BigInt(anchor.chainSequence), anchoredAt: iso(anchor.anchoredAt) };
      } catch (cause) {
        await client.query('ROLLBACK');
        throw cause;
      }
    });
  }

  async anchorDue(limitValue = 100): Promise<AuditAnchorRecord[]> {
    const limit = Math.max(1, Math.min(1_000, Math.floor(limitValue)));
    const due = await withClient(this.pool, (client) => client.query<{ tenantId: string }>(
      `SELECT head.tenant_id AS "tenantId"
       FROM audit_chain_heads AS head
       LEFT JOIN (
         SELECT tenant_id, max(chain_sequence) AS anchored_sequence
         FROM audit_chain_anchors GROUP BY tenant_id
       ) AS anchor ON anchor.tenant_id = head.tenant_id
       WHERE head.last_sequence > COALESCE(anchor.anchored_sequence, 0)
       ORDER BY head.updated_at, head.tenant_id
       LIMIT $1`,
      [limit],
    ));
    const anchors: AuditAnchorRecord[] = [];
    for (const row of due.rows) {
      const anchored = await this.anchorLatest(row.tenantId);
      if (anchored) anchors.push(anchored);
    }
    return anchors;
  }
}
