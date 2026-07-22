import type {
  Artist,
  AuditLog,
  CatalogSnapshot,
  ConsentGrant,
  DistributorAccount,
  DSPAccount,
  Issue,
  IssueEvidence,
  Release,
  ScanRun,
  SupportPacket,
  Track,
  Workspace,
} from '@sentinel/core';

/** A tiny typed collection port. The Postgres/Prisma impl mirrors this shape. */
export interface Collection<T extends { id: string }> {
  put(item: T): T;
  get(id: string): T | undefined;
  all(): T[];
  find(pred: (item: T) => boolean): T[];
  delete(id: string): void;
  clear(): void;
}

/**
 * Persistence port. Runtime composition binds it to durable PostgreSQL storage;
 * isolated tests may bind a process-local test adapter.
 */
export interface Repository {
  workspaces: Collection<Workspace>;
  artists: Collection<Artist>;
  distributorAccounts: Collection<DistributorAccount>;
  dspAccounts: Collection<DSPAccount>;
  consentGrants: Collection<ConsentGrant>;
  snapshots: Collection<CatalogSnapshot>;
  releases: Collection<Release>;
  tracks: Collection<Track>;
  issues: Collection<Issue>;
  evidence: Collection<IssueEvidence>;
  packets: Collection<SupportPacket>;
  scanRuns: Collection<ScanRun>;
  auditLogs: Collection<AuditLog>;

  /** Delete ALL data for a workspace (tenant data deletion — PRD §K/§U). */
  deleteWorkspace(workspaceId: string): void;
  /** Wipe everything (test isolation). */
  reset(): void;
}
