/**
 * @sentinel/db — persistence. The canonical Postgres model lives in
 * `prisma/schema.prisma`; at runtime the engine/API depend on the {@link Repository}
 * port. Runtime composition uses PostgreSQL; process-local adapters exist only
 * for isolated automated tests.
 */
export * from './repository';
export * from './in-memory';
export * from './tenant-repo';
export * from './distributor-link-repo';
export * from './prisma-distributor-link-repo';
export * from './distributor-link-repo-factory';
export * from './governance-types';
export * from './organization-repository';
export * from './tenant-erasure';
export * from './retention';
export * from './audit-chain';
export * from './governance-runtime';
export * from './governance-service';
export * from './governance-adapters';
