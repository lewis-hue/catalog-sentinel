import type {
  CatalogResultLike,
  ReleasedTrackLike,
  SearchInput,
  SearchPage,
  SearchPageOptions,
  SearchRecord,
  SearchStore,
  SearchSummary,
} from './search-store';
import type { PostgresSearchStore } from './postgres-search-store';

/**
 * Two-tier store: Redis is the HOT tier (fast reads, frequent progress writes for the
 * live UI); Postgres is the DURABLE source of truth. Every acknowledged save and
 * mutation commits to Postgres first. Redis is refreshed as a version-aware cache
 * and can never become authoritative after a database failure or cache flush.
 */
export class TieredSearchStore implements SearchStore {
  constructor(
    private readonly hot: SearchStore,
    private readonly durable: PostgresSearchStore,
    private readonly log: (msg: string, extra?: Record<string, unknown>) => void = () => {},
  ) {}

  async save(input: SearchInput, result: CatalogResultLike, released?: ReleasedTrackLike[], owner?: { userId: string }): Promise<SearchRecord> {
    const rec = await this.durable.save(input, result, released, owner);
    await this.warm(rec);
    return rec;
  }

  async get(recordId: string): Promise<SearchRecord | null> {
    const authoritative = await this.durable.get(recordId);
    if (authoritative) await this.warm(authoritative);
    return authoritative;
  }

  async put(rec: SearchRecord): Promise<void> {
    await this.durable.put(rec);
    const authoritative = await this.durable.get(rec.id);
    if (authoritative) await this.warm(authoritative);
  }

  async list(): Promise<SearchSummary[]> {
    try {
      return await this.durable.list();
    } catch {
      throw new Error('durable search store unavailable');
    }
  }

  async listForUser(userId: string): Promise<SearchSummary[]> {
    try {
      return await this.durable.listForUser(userId);
    } catch {
      throw new Error('durable search store unavailable');
    }
  }

  async pageForUser(userId: string, options: SearchPageOptions): Promise<SearchPage> {
    try {
      return await this.durable.pageForUser(userId, options);
    } catch {
      throw new Error('durable search store unavailable');
    }
  }

  async update(recordId: string, mutate: (r: SearchRecord) => SearchRecord): Promise<SearchRecord | null> {
    const next = await this.durable.update(recordId, mutate);
    if (next) await this.warm(next);
    return next;
  }

  async delete(recordId: string, userId?: string): Promise<boolean> {
    // Delete from the durable source first. If that fails, keep the cache intact so a record can
    // never appear deleted and then re-emerge from Postgres after a Redis flush/restart.
    const durableRecord = await this.durable.get(recordId);
    if (durableRecord && userId && durableRecord.userId !== userId) return false;
    const owner = userId ?? durableRecord?.userId;
    const durableDeleted = await this.durable.delete(recordId, owner);
    const hotDeleted = await this.hot.delete(recordId, owner).catch((err) => {
      this.log('hot search-store cache delete failed', { err: String(err) });
      return false;
    });
    return durableDeleted || hotDeleted;
  }

  private async warm(record: SearchRecord): Promise<void> {
    try {
      await this.hot.put(record);
    } catch (err) {
      // The durable commit is authoritative. Do not report it as failed and invite a duplicate
      // retry just because the cache could not be refreshed.
      this.log('hot search-store cache write failed', { err: String(err) });
    }
  }
}
