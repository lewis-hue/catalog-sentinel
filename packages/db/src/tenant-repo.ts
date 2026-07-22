/**
 * Tenant-scoped repository primitives. Cross-tenant data leakage is a top threat
 * (docs/threat-model.md #4), so isolation is enforced STRUCTURALLY: every
 * read/write requires a {@link TenantContext} and can only touch rows whose
 * `tenantId` matches it. The port is async so the same interface backs both the
 * PostgreSQL runtime adapter and an isolated test adapter.
 */
export interface TenantContext {
  tenantId: string;
}

export interface TenantEntity {
  id: string;
  tenantId: string;
}

export class CrossTenantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CrossTenantError';
  }
}

/** Async, tenant-scoped store. Implemented by PostgreSQL and isolated-test adapters. */
export interface TenantStore<T extends TenantEntity> {
  put(ctx: TenantContext, item: T): Promise<T>;
  get(ctx: TenantContext, id: string): Promise<T | null>;
  update(ctx: TenantContext, id: string, patch: Partial<T>): Promise<T | null>;
  delete(ctx: TenantContext, id: string): Promise<boolean>;
  /** Delete ALL rows for a tenant (tenant data deletion). */
  deleteAllForTenant(tenantId: string): Promise<number>;
}

/**
 * Process-local implementation for isolated automated tests only.
 * @internal
 */
export class InMemoryTenantStore<T extends TenantEntity> implements TenantStore<T> {
  private readonly map = new Map<string, T>();

  constructor() {
    if (process.env.NODE_ENV !== 'test') {
      throw new Error('InMemoryTenantStore is test-only; configure DATABASE_URL for runtime persistence.');
    }
  }

  async put(ctx: TenantContext, item: T): Promise<T> {
    if (item.tenantId !== ctx.tenantId) {
      throw new CrossTenantError(`Refusing to write entity for tenant ${item.tenantId} under context ${ctx.tenantId}.`);
    }
    this.map.set(item.id, structuredClone(item));
    return structuredClone(item);
  }

  async get(ctx: TenantContext, id: string): Promise<T | null> {
    const v = this.map.get(id);
    return v && v.tenantId === ctx.tenantId ? structuredClone(v) : null;
  }

  async update(ctx: TenantContext, id: string, patch: Partial<T>): Promise<T | null> {
    const v = this.map.get(id);
    if (!v || v.tenantId !== ctx.tenantId) return null;
    const next = { ...v, ...patch, id: v.id, tenantId: v.tenantId };
    this.map.set(id, next);
    return structuredClone(next);
  }

  async delete(ctx: TenantContext, id: string): Promise<boolean> {
    const v = this.map.get(id);
    if (!v || v.tenantId !== ctx.tenantId) return false;
    return this.map.delete(id);
  }

  async deleteAllForTenant(tenantId: string): Promise<number> {
    let n = 0;
    for (const [id, v] of this.map) if (v.tenantId === tenantId) { this.map.delete(id); n++; }
    return n;
  }

  /** Test/maintenance helpers (not part of the port). */
  async find(ctx: TenantContext, pred: (item: T) => boolean): Promise<T[]> {
    return [...this.map.values()].filter((v) => v.tenantId === ctx.tenantId && pred(v)).map((v) => structuredClone(v));
  }
  async all(ctx: TenantContext): Promise<T[]> {
    return this.find(ctx, () => true);
  }
}
