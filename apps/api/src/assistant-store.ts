import type { PgPoolLike } from '@sentinel/db';

/**
 * Durable store for the catalogue assistant, on its OWN database (separate from the main catalogue
 * Postgres). Every row is tenant-scoped: (tenant_id, user_id), the same membership-validated
 * tenancy the rest of the app uses, so one workspace never sees another's conversations.
 *
 * This database is dedicated to the assistant and is not part of the Prisma-owned migration chain,
 * so the store bootstraps its own single table idempotently on first use.
 */
export interface AssistantInteraction {
  tenantId: string;
  userId: string;
  question: string;
  answer: string;
  model: string;
}

export interface AssistantConversationStore {
  logInteraction(interaction: AssistantInteraction): Promise<void>;
  recentForUser(tenantId: string, userId: string, limit: number): Promise<Array<{ question: string; answer: string; createdAt: string }>>;
}

export class PostgresAssistantConversationStore implements AssistantConversationStore {
  private ready: Promise<void> | null = null;
  constructor(private readonly pool: PgPoolLike) {}

  private async init(): Promise<void> {
    this.ready ??= this.pool
      .query(
        `CREATE TABLE IF NOT EXISTS assistant_conversations (
           id         BIGSERIAL PRIMARY KEY,
           tenant_id  TEXT NOT NULL,
           user_id    TEXT NOT NULL,
           question   TEXT NOT NULL,
           answer     TEXT NOT NULL,
           model      TEXT NOT NULL,
           created_at TIMESTAMPTZ NOT NULL DEFAULT now()
         );
         CREATE INDEX IF NOT EXISTS assistant_conversations_tenant_user_idx
           ON assistant_conversations (tenant_id, user_id, created_at DESC);`,
      )
      .then(() => undefined);
    await this.ready;
  }

  async logInteraction(interaction: AssistantInteraction): Promise<void> {
    await this.init();
    await this.pool.query(
      `INSERT INTO assistant_conversations (tenant_id, user_id, question, answer, model)
       VALUES ($1, $2, $3, $4, $5)`,
      [interaction.tenantId, interaction.userId, interaction.question, interaction.answer, interaction.model],
    );
  }

  async recentForUser(
    tenantId: string,
    userId: string,
    limit: number,
  ): Promise<Array<{ question: string; answer: string; createdAt: string }>> {
    await this.init();
    const { rows } = await this.pool.query(
      `SELECT question, answer, created_at FROM assistant_conversations
        WHERE tenant_id = $1 AND user_id = $2
        ORDER BY created_at DESC LIMIT $3`,
      [tenantId, userId, Math.max(1, Math.min(limit, 50))],
    );
    return rows.map((row) => ({
      question: String(row.question),
      answer: String(row.answer),
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    }));
  }
}
