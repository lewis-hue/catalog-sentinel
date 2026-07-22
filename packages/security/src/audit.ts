import { randomUUID } from 'node:crypto';
import { redact } from './redaction';

/**
 * Audit logging. Every account connection, scan, export, and report generation
 * MUST be recorded (PRD §K). Metadata is redacted before storage so audit rows
 * can never leak secrets/PII.
 */
export interface AuditEvent {
  tenantId: string;
  workspaceId?: string | null;
  actorUserId?: string | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface AuditRecord extends Required<Omit<AuditEvent, 'metadata'>> {
  id: string;
  at: string;
  metadata: Record<string, unknown>;
}

export interface AuditLogger {
  log(event: AuditEvent): Promise<AuditRecord>;
  list(): Promise<AuditRecord[]>;
}

export class InMemoryAuditLogger implements AuditLogger {
  private records: AuditRecord[] = [];
  private counter = 0;

  constructor(private readonly clockIso: () => string = () => new Date().toISOString()) {}

  async log(event: AuditEvent): Promise<AuditRecord> {
    const record = auditRecord(event, `audit_${++this.counter}`, this.clockIso());
    this.records.push(record);
    return record;
  }

  async list(): Promise<AuditRecord[]> {
    return [...this.records];
  }
}

export interface AuditSqlClient {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }>;
}

/** Append-only production audit sink backed by the migration-owned canonical database. */
export class PostgresAuditLogger implements AuditLogger {
  constructor(
    private readonly client: AuditSqlClient,
    private readonly clockIso: () => string = () => new Date().toISOString(),
  ) {}

  async log(event: AuditEvent): Promise<AuditRecord> {
    const record = auditRecord(event, `audit_${randomUUID()}`, this.clockIso());
    await this.client.query(
      `INSERT INTO security_audit_events
       (id, occurred_at, tenant_id, workspace_id, actor_user_id, action, target_type, target_id, metadata)
       VALUES ($1, $2::timestamptz, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
      [record.id, record.at, record.tenantId, record.workspaceId, record.actorUserId,
        record.action, record.targetType, record.targetId, JSON.stringify(record.metadata)],
    );
    return record;
  }

  async list(): Promise<AuditRecord[]> {
    const result = await this.client.query<{
      id: string;
      at: Date | string;
      tenantId: string;
      workspaceId: string | null;
      actorUserId: string | null;
      action: string;
      targetType: string;
      targetId: string | null;
      metadata: Record<string, unknown>;
    }>(
      `SELECT id, occurred_at AS "at", tenant_id AS "tenantId", workspace_id AS "workspaceId",
              actor_user_id AS "actorUserId", action, target_type AS "targetType",
              target_id AS "targetId", metadata
       FROM security_audit_events ORDER BY occurred_at ASC, id ASC`,
    );
    return result.rows.map((row) => ({
      ...row,
      at: row.at instanceof Date ? row.at.toISOString() : row.at,
      metadata: row.metadata ?? {},
    }));
  }
}

function auditRecord(event: AuditEvent, id: string, at: string): AuditRecord {
  return {
    id,
    at,
    tenantId: event.tenantId,
    workspaceId: event.workspaceId ?? null,
    actorUserId: event.actorUserId ?? null,
    action: event.action,
    targetType: event.targetType,
    targetId: event.targetId ?? null,
    metadata: (redact(event.metadata ?? {}) as Record<string, unknown>) ?? {},
  };
}
