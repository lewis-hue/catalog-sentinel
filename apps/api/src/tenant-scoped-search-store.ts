import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  SEARCH_HISTORY_MAX_PAGE_SIZE,
  type SearchPageCursor,
  type SearchRecord,
  type SearchStore,
  type SearchSummary,
  type SearchInput,
  type CatalogResultLike,
  type ReleasedTrackLike,
} from '@sentinel/search-store';

export const SEARCH_HISTORY_DEFAULT_PAGE_SIZE = 50;
export const SEARCH_HISTORY_NEXT_CURSOR_HEADER = 'x-sentinel-next-cursor';

export class InvalidSearchHistoryPageError extends Error {
  constructor(message = 'invalid search history pagination') {
    super(message);
    this.name = 'InvalidSearchHistoryPageError';
  }
}

export function parseSearchHistoryPageLimit(value: unknown): number {
  if (value === undefined) return SEARCH_HISTORY_DEFAULT_PAGE_SIZE;
  if (typeof value !== 'string' || !/^[1-9]\d{0,2}$/.test(value)) throw new InvalidSearchHistoryPageError();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > SEARCH_HISTORY_MAX_PAGE_SIZE) throw new InvalidSearchHistoryPageError();
  return parsed;
}

/**
 * A view of the search store restricted to ONE user.
 *
 * The vulnerability this closes: the API read searches by id alone (`searchStore.get(id)`) and
 * listed them with no filter at all (`searchStore.list()`). Any authenticated caller could read
 * another user's scan, their artists, their unreleased catalogue, their ISRCs, by knowing or
 * guessing a search id, and `GET /api/searches` returned every user's scans to everyone.
 *
 * Why a wrapper rather than a `userId` parameter on every store method: a parameter is a rule
 * that every call site must remember, and the one that forgets is invisible, it looks like
 * working code and returns data. Here the user is bound ONCE, and a route physically cannot ask
 * for another user's record: there is no argument for it.
 *
 * The WORKER deliberately keeps the unscoped store. It legitimately processes jobs for every
 * user and gets its userId from the job, not from a request.
 */
export class UserBoundSearchStore {
  constructor(private readonly inner: SearchStore, private readonly userId: string) {}

  /** Stamps the owning user so the record can be scoped on every later read. */
  async save(input: SearchInput, result: CatalogResultLike, released?: ReleasedTrackLike[]): Promise<SearchRecord> {
    return this.inner.save(input, result, released, { userId: this.userId });
  }

  /**
   * Returns null, NOT 403, for another user's record.
   *
   * A 403 confirms the id exists, which turns id-guessing into a working enumeration oracle for
   * other users' scans. "Not found" is both true from this user's perspective and silent.
   */
  async get(id: string): Promise<SearchRecord | null> {
    const rec = await this.inner.get(id);
    if (!rec || rec.userId !== this.userId) return null;
    return rec;
  }

  async list(): Promise<SearchSummary[]> {
    return this.inner.listForUser(this.userId);
  }

  async listPage(limit: number, after?: SearchPageCursor) {
    return this.inner.pageForUser(this.userId, { limit, ...(after ? { after } : {}) });
  }

  /** Refuses to mutate another user's record, and cannot be tricked into re-owning it. */
  async update(id: string, mutate: (r: SearchRecord) => SearchRecord): Promise<SearchRecord | null> {
    const existing = await this.inner.get(id);
    if (!existing || existing.userId !== this.userId) return null;
    return this.inner.update(id, mutate);
  }

  /** Delete only a record owned by this user; another user observes the same false as absent. */
  async delete(id: string): Promise<boolean> {
    const existing = await this.inner.get(id);
    if (!existing || existing.userId !== this.userId) return false;
    return this.inner.delete(id, this.userId);
  }
}

export interface SearchPrincipal {
  sub: string;
  roles: string[];
  authenticated: boolean;
}

/** A create call bundled with the resulting scan so a derived record can be saved in one step. */
export interface DerivedSearchPatch extends SearchInput {
  result: CatalogResultLike;
  released?: ReleasedTrackLike[];
}

/** Platform operations credentials do not silently double as customer-data credentials. */
export function hasCustomerScanAccess(principal: SearchPrincipal): boolean {
  if (!principal.authenticated) return true;
  return principal.roles.includes('user');
}

/**
 * Request-bound search-store view.
 *
 * The ONLY scoping rule: a record is visible/writable iff the caller has customer scan access
 * AND `record.userId === principal.sub`. There is no admin override, no shared workspace, and
 * no cross-user visibility of any kind, every user's search history is theirs alone.
 */
export class UserScopedSearchStore {
  private readonly cursorSigningKey: Buffer;

  constructor(
    private readonly inner: SearchStore,
    private readonly principal: SearchPrincipal,
    cursorSigningSecret = process.env.HISTORY_CURSOR_SIGNING_KEY
      ?? process.env.ENCRYPTION_MASTER_KEY
      ?? HISTORY_DEVELOPMENT_CURSOR_SECRET,
  ) {
    // Domain-separated derivation avoids using the encryption key bytes directly as an HMAC key.
    this.cursorSigningKey = createHmac('sha256', cursorSigningSecret).update(HISTORY_CURSOR_CONTEXT).digest();
  }

  private owns(record: SearchRecord | null): record is SearchRecord {
    return record !== null && hasCustomerScanAccess(this.principal) && record.userId === this.principal.sub;
  }

  private assertCanCreate(): void {
    if (!hasCustomerScanAccess(this.principal)) {
      const error = new Error('customer scan access requires a customer role');
      error.name = 'CustomerScanAccessError';
      throw error;
    }
  }

  /** Create a new personal scan; no client-provided owner can override this scope. */
  async save(input: SearchInput, result: CatalogResultLike, released?: ReleasedTrackLike[]): Promise<SearchRecord> {
    this.assertCanCreate();
    return this.inner.save(input, result, released, { userId: this.principal.sub });
  }

  /** Create a child history entry while preserving the source's immutable owner. */
  async saveDerived(source: SearchRecord, patch: DerivedSearchPatch): Promise<SearchRecord> {
    this.assertCanCreate();
    if (!this.owns(source)) throw new Error('search source is outside the editable principal scope');
    const { result, released, ...input } = patch;
    return this.inner.save(input, result, released, { userId: source.userId });
  }

  async get(id: string): Promise<SearchRecord | null> {
    const record = await this.inner.get(id);
    return this.owns(record) ? record : null;
  }

  async list(): Promise<SearchSummary[]> {
    if (!hasCustomerScanAccess(this.principal)) return [];
    return this.inner.listForUser(this.principal.sub);
  }

  /**
   * Principal-bound seek pagination. The cursor is deliberately opaque and tamper-evident, but
   * authorization never depends on it: the storage query is independently fixed to this exact
   * OIDC subject.
   */
  async listPage(limit: number, cursor?: string): Promise<{ items: SearchSummary[]; nextCursor?: string }> {
    if (!hasCustomerScanAccess(this.principal)) return { items: [] };
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > SEARCH_HISTORY_MAX_PAGE_SIZE) {
      throw new InvalidSearchHistoryPageError();
    }
    const scope = historyCursorScope(this.principal);
    const after = cursor === undefined ? undefined : decodeHistoryCursor(cursor, scope, this.cursorSigningKey);
    const page = await this.inner.pageForUser(this.principal.sub, { limit, ...(after ? { after } : {}) });
    return {
      items: page.items,
      ...(page.nextCursor ? { nextCursor: encodeHistoryCursor(page.nextCursor, scope, this.cursorSigningKey) } : {}),
    };
  }

  async update(id: string, mutate: (record: SearchRecord) => SearchRecord): Promise<SearchRecord | null> {
    const existing = await this.inner.get(id);
    if (!this.owns(existing)) return null;
    return this.inner.update(id, mutate);
  }

  async delete(id: string): Promise<boolean> {
    const existing = await this.inner.get(id);
    return this.owns(existing) ? this.inner.delete(id, this.principal.sub) : false;
  }
}

const HISTORY_CURSOR_VERSION = 1;
const HISTORY_CURSOR_CONTEXT = 'sentinel:search-history:v1\0';
const HISTORY_CURSOR_MAX_LENGTH = 768;
const HISTORY_DEVELOPMENT_CURSOR_SECRET = 'sentinel-local-history-cursors-not-for-production';

function historyCursorScope(principal: SearchPrincipal): string {
  const raw = `user:${principal.sub.length}:${principal.sub}`;
  return createHash('sha256').update(raw).digest('base64url');
}

function cursorChecksum(body: string, signingKey: Buffer): string {
  return createHmac('sha256', signingKey).update(body).digest('base64url').slice(0, 22);
}

function encodeHistoryCursor(position: SearchPageCursor, scope: string, signingKey: Buffer): string {
  const body = Buffer.from(JSON.stringify({
    v: HISTORY_CURSOR_VERSION,
    s: scope,
    a: position.createdAt,
    i: position.id,
  }), 'utf8').toString('base64url');
  return `${body}.${cursorChecksum(body, signingKey)}`;
}

function decodeHistoryCursor(cursor: string, scope: string, signingKey: Buffer): SearchPageCursor {
  try {
    if (!cursor || cursor.length > HISTORY_CURSOR_MAX_LENGTH) throw new Error('invalid length');
    const segments = cursor.split('.');
    if (segments.length !== 2 || !segments[0] || !/^[A-Za-z0-9_-]{22}$/.test(segments[1]!)) {
      throw new Error('invalid shape');
    }
    const [body, suppliedChecksum] = segments as [string, string];
    const expectedChecksum = cursorChecksum(body, signingKey);
    if (!timingSafeEqual(Buffer.from(suppliedChecksum), Buffer.from(expectedChecksum))) throw new Error('checksum mismatch');
    const decoded = Buffer.from(body, 'base64url');
    if (!decoded.length || decoded.toString('base64url') !== body) throw new Error('non-canonical encoding');
    const value = JSON.parse(decoded.toString('utf8')) as Record<string, unknown>;
    const keys = Object.keys(value).sort().join(',');
    if (keys !== 'a,i,s,v' || value.v !== HISTORY_CURSOR_VERSION || value.s !== scope) throw new Error('scope mismatch');
    if (typeof value.a !== 'string' || value.a.length > 40) throw new Error('invalid timestamp');
    const date = new Date(value.a);
    if (Number.isNaN(date.getTime()) || date.toISOString() !== value.a) throw new Error('non-canonical timestamp');
    if (typeof value.i !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value.i)) throw new Error('invalid id');
    return { createdAt: value.a, id: value.i };
  } catch {
    throw new InvalidSearchHistoryPageError();
  }
}
