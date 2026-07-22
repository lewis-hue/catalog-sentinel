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
import type { Collection, Repository } from './repository';

class InMemoryCollection<T extends { id: string }> implements Collection<T> {
  private readonly map = new Map<string, T>();

  put(item: T): T {
    // Structured clone keeps stored data immutable w.r.t. the caller's object.
    const copy = structuredClone(item);
    this.map.set(item.id, copy);
    return copy;
  }
  get(id: string): T | undefined {
    const v = this.map.get(id);
    return v ? structuredClone(v) : undefined;
  }
  all(): T[] {
    return [...this.map.values()].map((v) => structuredClone(v));
  }
  find(pred: (item: T) => boolean): T[] {
    return this.all().filter(pred);
  }
  delete(id: string): void {
    this.map.delete(id);
  }
  clear(): void {
    this.map.clear();
  }
}

/**
 * Process-local repository for isolated automated tests only. Runtime
 * composition must use the PostgreSQL repositories.
 * @internal
 */
export class InMemoryRepository implements Repository {
  workspaces = new InMemoryCollection<Workspace>();
  artists = new InMemoryCollection<Artist>();
  distributorAccounts = new InMemoryCollection<DistributorAccount>();
  dspAccounts = new InMemoryCollection<DSPAccount>();
  consentGrants = new InMemoryCollection<ConsentGrant>();
  snapshots = new InMemoryCollection<CatalogSnapshot>();
  releases = new InMemoryCollection<Release>();
  tracks = new InMemoryCollection<Track>();
  issues = new InMemoryCollection<Issue>();
  evidence = new InMemoryCollection<IssueEvidence>();
  packets = new InMemoryCollection<SupportPacket>();
  scanRuns = new InMemoryCollection<ScanRun>();
  auditLogs = new InMemoryCollection<AuditLog>();

  constructor() {
    if (process.env.NODE_ENV !== 'test') {
      throw new Error('InMemoryRepository is test-only; configure DATABASE_URL for runtime persistence.');
    }
  }

  private get workspaceScoped(): Array<InMemoryCollection<{ id: string; workspaceId: string }>> {
    return [
      this.artists,
      this.distributorAccounts,
      this.dspAccounts,
      this.consentGrants,
      this.snapshots,
      this.releases,
      this.tracks,
      this.issues,
      this.evidence,
      this.packets,
      this.scanRuns,
    ] as unknown as Array<InMemoryCollection<{ id: string; workspaceId: string }>>;
  }

  deleteWorkspace(workspaceId: string): void {
    for (const col of this.workspaceScoped) {
      for (const item of col.find((i) => i.workspaceId === workspaceId)) col.delete(item.id);
    }
    for (const a of this.auditLogs.find((l) => l.workspaceId === workspaceId)) this.auditLogs.delete(a.id);
    this.workspaces.delete(workspaceId);
  }

  reset(): void {
    for (const col of [
      this.workspaces,
      ...this.workspaceScoped,
      this.auditLogs,
    ] as Array<InMemoryCollection<{ id: string }>>) {
      col.clear();
    }
  }
}

export function createInMemoryRepository(): Repository {
  return new InMemoryRepository();
}
