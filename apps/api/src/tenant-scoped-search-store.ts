import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  ownerOf,
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
 * A view of the search store restricted to ONE tenant.
 *
 * The vulnerability this closes: the API read searches by id alone (`searchStore.get(id)`) and
 * listed them with no filter at all (`searchStore.list()`). With multi-tenant auth enabled, any
 * authenticated caller could read another tenant's scan, their artists, their unreleased
 * catalogue, their ISRCs, by knowing or guessing a search id, and `GET /api/searches` returned
 * every tenant's scans to everyone. The record type didn't even carry a `tenantId`, so there was
 * nothing to filter on.
 *
 * Why a wrapper rather than a `tenantId` parameter on every store method: a parameter is a rule
 * that 50 call sites must each remember, and the one that forgets is invisible, it looks like
 * working code and returns data. Here the tenant is bound ONCE, and a route physically cannot ask
 * for another tenant's record: there is no argument for it.
 *
 * The WORKER deliberately keeps the unscoped store. It legitimately processes jobs for every
 * tenant and gets its tenant from the job, not from a request.
 */
export class TenantScopedSearchStore {
  constructor(private readonly inner: SearchStore, private readonly tenantId: string) {}

  /** Stamps the owning tenant so the record can be scoped on every later read. */
  async save(input: Omit<SearchInput, 'tenantId'>, result: CatalogResultLike, released?: ReleasedTrackLike[]): Promise<SearchRecord> {
    return this.inner.save({ ...input, tenantId: this.tenantId }, result, released);
  }

  /**
   * Returns null, NOT 403, for another tenant's record.
   *
   * A 403 confirms the id exists, which turns id-guessing into a working enumeration oracle for
   * other tenants' scans. "Not found" is both true from this tenant's perspective and silent.
   */
  async get(id: string): Promise<SearchRecord | null> {
    const rec = await this.inner.get(id);
    if (!rec || ownerOf(rec) !== this.tenantId) return null;
    return rec;
  }

  async list(): Promise<SearchSummary[]> {
    return this.inner.listForTenant(this.tenantId);
  }

  async listPage(limit: number, after?: SearchPageCursor) {
    return this.inner.pageForTenant(this.tenantId, { limit, ...(after ? { after } : {}) });
  }

  /** Refuses to mutate another tenant's record, and cannot be tricked into re-owning it. */
  async update(id: string, mutate: (r: SearchRecord) => SearchRecord): Promise<SearchRecord | null> {
    const existing = await this.inner.get(id);
    if (!existing || ownerOf(existing) !== this.tenantId) return null;
    return this.inner.update(id, (r) => ({ ...mutate(r), tenantId: ownerOf(existing) }));
  }

  /** Delete only a record owned by this tenant; another tenant observes the same false as absent. */
  async delete(id: string): Promise<boolean> {
    const existing = await this.inner.get(id);
    if (!existing || ownerOf(existing) !== this.tenantId) return false;
    return this.inner.delete(id, this.tenantId);
  }
}

export interface SearchPrincipal {
  tenantId: string;
  sub: string;
  roles: string[];
  authenticated: boolean;
}

type NewPrincipalSearchInput = Omit<SearchInput, 'tenantId' | 'ownerUserId' | 'artistWorkspaceId'>;

function withoutClientScope(input: NewPrincipalSearchInput): NewPrincipalSearchInput {
  // TypeScript's Omit is not a runtime boundary. Strip these keys explicitly so a plain JSON
  // object (or an `as` cast in future route code) cannot smuggle scope into a derived legacy row.
  const {
    tenantId: _ignoredTenant,
    ownerUserId: _ignoredOwner,
    artistWorkspaceId: _ignoredWorkspace,
    ...safe
  } = input as SearchInput;
  return safe;
}

/**
 * Stable personal workspace used for scans that are not attached to a consent-bound artist
 * workspace. The length-prefixed hash avoids leaking a tenant id or OIDC subject into URLs and
 * prevents ambiguous string concatenation from producing the same scope.
 */
export function personalArtistWorkspaceId(tenantId: string, subject: string): string {
  const material = `${tenantId.length}:${tenantId}${subject.length}:${subject}`;
  return `aw-personal-${createHash('sha256').update(material).digest('hex').slice(0, 32)}`;
}

/** Platform operations credentials do not silently double as customer-data credentials. */
export function hasCustomerScanAccess(principal: SearchPrincipal): boolean {
  if (!principal.authenticated) return true;
  return principal.roles.some((role) => role === 'user' || role === 'artist_manager' || role === 'tenant_admin');
}

export interface PrincipalWorkspaceAccess {
  /** Workspace identifiers proven through the durable organization repository for this request. */
  read: readonly string[];
  /** Subset for which the principal may mutate catalog history or create derived scans. */
  edit: readonly string[];
}

/**
 * Request-bound search-store view.
 *
 * Regular users and artist managers see only rows whose tenant AND immutable OIDC subject match.
 * Tenant administrators may operate on any row in their own tenant. A platform-admin-only token
 * has no customer-data access. Legacy ownerless rows remain available to tenant administrators
 * for migration/cleanup but are invisible to authenticated ordinary users.
 */
export class PrincipalScopedSearchStore {
  private readonly tenantAdmin: boolean;
  private readonly unverifiedTestIdentity: boolean;
  private readonly cursorSigningKey: Buffer;
  private readonly readableWorkspaces: ReadonlySet<string> | null;
  private readonly editableWorkspaces: ReadonlySet<string> | null;

  constructor(
    private readonly inner: SearchStore,
    private readonly principal: SearchPrincipal,
    workspaceAccess?: PrincipalWorkspaceAccess,
    cursorSigningSecret = process.env.HISTORY_CURSOR_SIGNING_KEY
      ?? process.env.ENCRYPTION_MASTER_KEY
      ?? HISTORY_DEVELOPMENT_CURSOR_SECRET,
  ) {
    // Once DB-backed workspace grants are supplied they are authoritative. A coarse Keycloak
    // tenant_admin role must not silently expand access in another selected organization.
    this.tenantAdmin = !workspaceAccess && principal.roles.includes('tenant_admin');
    this.unverifiedTestIdentity = !principal.authenticated;
    this.readableWorkspaces = workspaceAccess ? new Set(workspaceAccess.read) : null;
    this.editableWorkspaces = workspaceAccess ? new Set(workspaceAccess.edit) : null;
    // Domain-separated derivation avoids using the encryption key bytes directly as an HMAC key.
    this.cursorSigningKey = createHmac('sha256', cursorSigningSecret).update(HISTORY_CURSOR_CONTEXT).digest();
  }

  private canRead(record: SearchRecord): boolean {
    if (!hasCustomerScanAccess(this.principal) || ownerOf(record) !== this.principal.tenantId) return false;
    if (this.readableWorkspaces) {
      return Boolean(record.artistWorkspaceId && this.readableWorkspaces.has(record.artistWorkspaceId));
    }
    if (this.unverifiedTestIdentity || this.tenantAdmin) return true;
    return Boolean(record.ownerUserId) && record.ownerUserId === this.principal.sub;
  }

  private canWrite(record: SearchRecord): boolean {
    if (!this.canRead(record)) return false;
    if (this.editableWorkspaces) {
      return Boolean(record.artistWorkspaceId && this.editableWorkspaces.has(record.artistWorkspaceId));
    }
    return true;
  }

  private assertCanCreate(): void {
    if (!hasCustomerScanAccess(this.principal)) {
      const error = new Error('customer scan access requires a customer role');
      error.name = 'CustomerScanAccessError';
      throw error;
    }
  }

  /** Create a new personal scan; no client-provided owner or workspace can override this scope. */
  async save(
    input: NewPrincipalSearchInput,
    result: CatalogResultLike,
    released?: ReleasedTrackLike[],
  ): Promise<SearchRecord> {
    this.assertCanCreate();
    return this.inner.save({
      ...withoutClientScope(input),
      tenantId: this.principal.tenantId,
      ownerUserId: this.principal.sub,
      artistWorkspaceId: personalArtistWorkspaceId(this.principal.tenantId, this.principal.sub),
    }, result, released);
  }

  /**
   * Create a scan in a workspace that the API has already authorized through the durable
   * organization repository. Client scope fields are still stripped; the trusted workspace is a
   * separate argument so an untyped request object cannot overwrite it by property ordering.
   */
  async saveInAuthorizedWorkspace(
    workspaceId: string,
    input: NewPrincipalSearchInput,
    result: CatalogResultLike,
    released?: ReleasedTrackLike[],
  ): Promise<SearchRecord> {
    this.assertCanCreate();
    const normalizedWorkspaceId = workspaceId.trim();
    if (!normalizedWorkspaceId) throw new Error('an authorized artist workspace is required');
    if (this.editableWorkspaces && !this.editableWorkspaces.has(normalizedWorkspaceId)) {
      throw new Error('workspace is outside the editable principal scope');
    }
    return this.inner.save({
      ...withoutClientScope(input),
      tenantId: this.principal.tenantId,
      ownerUserId: this.principal.sub,
      artistWorkspaceId: normalizedWorkspaceId,
    }, result, released);
  }

  /** Create a child history entry while preserving the source's immutable principal/workspace. */
  async saveDerived(
    source: SearchRecord,
    input: NewPrincipalSearchInput,
    result: CatalogResultLike,
    released?: ReleasedTrackLike[],
  ): Promise<SearchRecord> {
    this.assertCanCreate();
    if (!this.canWrite(source)) throw new Error('search source is outside the editable principal scope');
    return this.inner.save({
      ...withoutClientScope(input),
      tenantId: ownerOf(source),
      ...(source.ownerUserId ? { ownerUserId: source.ownerUserId } : {}),
      ...(source.artistWorkspaceId ? { artistWorkspaceId: source.artistWorkspaceId } : {}),
    }, result, released);
  }

  async get(id: string): Promise<SearchRecord | null> {
    const record = await this.inner.get(id);
    return record && this.canRead(record) ? record : null;
  }

  async list(): Promise<SearchSummary[]> {
    if (!hasCustomerScanAccess(this.principal)) return [];
    if (this.readableWorkspaces) {
      return (await this.inner.listForTenant(this.principal.tenantId)).filter((record) =>
        Boolean(record.artistWorkspaceId && this.readableWorkspaces!.has(record.artistWorkspaceId)));
    }
    if (this.unverifiedTestIdentity || this.tenantAdmin) return this.inner.listForTenant(this.principal.tenantId);
    return this.inner.listForOwner(this.principal.tenantId, this.principal.sub);
  }

  /**
   * Principal-bound seek pagination. The cursor is deliberately opaque and tamper-evident, but
   * authorization never depends on it: the storage query is independently fixed to this tenant
   * and, for ordinary users, this exact OIDC subject.
   */
  async listPage(limit: number, cursor?: string): Promise<{ searches: SearchSummary[]; nextCursor?: string }> {
    if (!hasCustomerScanAccess(this.principal)) return { searches: [] };
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > SEARCH_HISTORY_MAX_PAGE_SIZE) {
      throw new InvalidSearchHistoryPageError();
    }
    const scope = historyCursorScope(
      this.principal,
      this.unverifiedTestIdentity || this.tenantAdmin,
      this.readableWorkspaces ? [...this.readableWorkspaces] : undefined,
    );
    const after = cursor === undefined ? undefined : decodeHistoryCursor(cursor, scope, this.cursorSigningKey);
    if (this.readableWorkspaces) {
      let position = after;
      const searches: SearchSummary[] = [];
      // Page the tenant index in bounded chunks and filter before returning. This keeps cursors
      // stable without exposing another workspace row while storage gains a native workspace page.
      while (searches.length < limit) {
        const page = await this.inner.pageForTenant(this.principal.tenantId, {
          limit: SEARCH_HISTORY_MAX_PAGE_SIZE,
          ...(position ? { after: position } : {}),
        });
        let stoppedInsidePage = false;
        for (let index = 0; index < page.items.length; index += 1) {
          const item = page.items[index]!;
          position = { createdAt: item.createdAt, id: item.id };
          if (item.artistWorkspaceId && this.readableWorkspaces.has(item.artistWorkspaceId)) searches.push(item);
          if (searches.length === limit) {
            stoppedInsidePage = index < page.items.length - 1;
            break;
          }
        }
        if (searches.length === limit) {
          const hasMore = stoppedInsidePage || Boolean(page.nextCursor);
          return {
            searches,
            ...(hasMore && position
              ? { nextCursor: encodeHistoryCursor(position, scope, this.cursorSigningKey) }
              : {}),
          };
        }
        if (!page.nextCursor) return { searches };
        position = page.nextCursor;
      }
      return { searches };
    }
    const options = { limit, ...(after ? { after } : {}) };
    const page = this.unverifiedTestIdentity || this.tenantAdmin
      ? await this.inner.pageForTenant(this.principal.tenantId, options)
      : await this.inner.pageForOwner(this.principal.tenantId, this.principal.sub, options);
    return {
      searches: page.items,
      ...(page.nextCursor ? { nextCursor: encodeHistoryCursor(page.nextCursor, scope, this.cursorSigningKey) } : {}),
    };
  }

  async update(id: string, mutate: (record: SearchRecord) => SearchRecord): Promise<SearchRecord | null> {
    const existing = await this.inner.get(id);
    if (!existing || !this.canWrite(existing)) return null;
    return this.inner.update(id, mutate);
  }

  async delete(id: string): Promise<boolean> {
    const existing = await this.inner.get(id);
    if (!existing || !this.canWrite(existing)) return false;
    return this.inner.delete(id, ownerOf(existing), existing.ownerUserId);
  }
}

const HISTORY_CURSOR_VERSION = 1;
const HISTORY_CURSOR_CONTEXT = 'sentinel:search-history:v1\0';
const HISTORY_CURSOR_MAX_LENGTH = 768;
const HISTORY_DEVELOPMENT_CURSOR_SECRET = 'sentinel-local-history-cursors-not-for-production';

function historyCursorScope(
  principal: SearchPrincipal,
  tenantWide: boolean,
  workspaceIds?: readonly string[],
): string {
  const raw = workspaceIds
    ? `workspace:${principal.tenantId.length}:${principal.tenantId}:${[...workspaceIds].sort().join('\0')}`
    : tenantWide
    ? `tenant:${principal.tenantId.length}:${principal.tenantId}`
    : `owner:${principal.tenantId.length}:${principal.tenantId}:${principal.sub.length}:${principal.sub}`;
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
