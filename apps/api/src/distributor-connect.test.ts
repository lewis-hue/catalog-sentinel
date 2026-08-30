import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type {
  BrowserLinkProvider,
  BrowserLinkProviderName,
  CreateBrowserSessionInput,
} from '@sentinel/browser-link';
import { InMemorySearchStore } from '@sentinel/search-store';
import { EnvelopeEncryptor } from '@sentinel/security';
import { signedComplianceTestEnv } from '@sentinel/security/test-support';
import {
  DistributorConnect,
  InMemoryConnectSessionRegistry,
  RedisConnectSessionRegistry,
  sessionReuseEnabled,
  type ConnectSessionRedis,
  type DistributorConnectProviderFactory,
} from './distributor-connect';

function fakeProvider(name: BrowserLinkProviderName = 'steel'): BrowserLinkProvider & {
  createSession: ReturnType<typeof vi.fn>;
  detachLocalSession: ReturnType<typeof vi.fn>;
  terminateSession: ReturnType<typeof vi.fn>;
  releaseRemoteSession: ReturnType<typeof vi.fn>;
} {
  return {
    provider: name,
    createSession: vi.fn(async (_input: CreateBrowserSessionInput) => ({
      sessionId: 'local-steel-1',
      status: 'CREATED' as const,
      expiresAt: new Date(Date.now() + 20 * 60_000).toISOString(),
      providerSessionRef: 'encrypted-ref',
    })),
    getSessionStatus: vi.fn(async () => ({ sessionId: 'local-steel-1', status: 'USER_ACTIVE' as const, expiresAt: new Date(Date.now() + 20 * 60_000).toISOString(), loggedInHint: null })),
    createUserAccessUrl: vi.fn(async () => ({ url: 'https://steel.test/player?interactive=true&showControls=true', expiresAt: new Date(Date.now() + 20 * 60_000).toISOString() })),
    attachAutomation: vi.fn(async () => { throw new Error('live Steel must not scan in the API process'); }),
    terminateSession: vi.fn(async () => undefined),
    getRemoteSessionId: vi.fn(async () => 'steel-remote-1'),
    detachLocalSession: vi.fn(async () => undefined),
    releaseRemoteSession: vi.fn(async () => undefined),
  };
}

const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');

class FakeConnectRedis implements ConnectSessionRedis {
  readonly values = new Map<string, string>();
  readonly sets = new Map<string, Set<string>>();
  readonly sorted = new Map<string, Map<string, number>>();
  readonly ttls: number[] = [];

  async set(key: string, value: string, _mode: 'PX', ttlMs: number): Promise<string> {
    this.values.set(key, value);
    this.ttls.push(ttlMs);
    return 'OK';
  }

  async eval(script: string, numberOfKeys: number, ...args: string[]): Promise<unknown> {
    const keys = args.slice(0, numberOfKeys);
    const argv = args.slice(numberOfKeys);
    if (script.includes('put-indexed-connect-session')) {
      const [key, indexKey, tombstoneKey] = keys;
      if (tombstoneKey && this.values.has(tombstoneKey)) return '__consent_revoked__';
      const [value, ttlMs, member] = argv;
      this.values.set(key!, value!);
      this.addSet(indexKey!, member!);
      this.ttls.push(Number(ttlMs));
      return 'OK';
    }
    if (script.includes('begin-consent-revocation')) {
      const [tombstoneKey, workKey, workIndex] = keys;
      const [ttlMs, value, digest, nowRaw] = argv;
      this.values.set(tombstoneKey!, '1');
      if (!this.values.has(workKey!)) this.values.set(workKey!, value!);
      if (!this.sorted.get(workIndex!)?.has(digest!)) this.addSorted(workIndex!, digest!, Number(nowRaw));
      this.ttls.push(Number(ttlMs));
      return 'OK';
    }
    if (script.includes('restore-cancel-connect-session')) {
      const [key, claimsKey] = keys;
      const [serialized, token, nowRaw, _ttlRaw, connectId] = argv;
      const value = JSON.parse(serialized!) as Record<string, unknown>;
      value.cancelRequested = true;
      value.claimToken = token;
      value.claimAction = 'cancel';
      value.claimUntil = Number(nowRaw);
      this.values.set(key!, JSON.stringify(value));
      this.addSorted(claimsKey!, connectId!, Number(nowRaw));
      return 'OK';
    }
    if (script.includes('claim-consent-revocation')) {
      const [workKey, workIndex] = keys;
      const [digest, nowRaw, token, untilRaw] = argv;
      const raw = this.values.get(workKey!);
      if (!raw) { this.removeSorted(workIndex!, digest!); return null; }
      const value = JSON.parse(raw) as Record<string, unknown>;
      if (value.workToken && Number(value.workUntil ?? 0) > Number(nowRaw)) return '__busy__';
      value.workToken = token;
      value.workUntil = Number(untilRaw);
      this.values.set(workKey!, JSON.stringify(value));
      this.addSorted(workIndex!, digest!, Number(untilRaw));
      return JSON.stringify(value);
    }
    if (script.includes('advance-consent-revocation')) {
      const [workKey, workIndex] = keys;
      const [token, cursor, dueRaw, digest] = argv;
      const raw = this.values.get(workKey!);
      if (!raw) return 0;
      const value = JSON.parse(raw) as Record<string, unknown>;
      if (value.workToken !== token) return 0;
      value.cursor = cursor;
      delete value.workToken;
      delete value.workUntil;
      this.values.set(workKey!, JSON.stringify(value));
      this.addSorted(workIndex!, digest!, Number(dueRaw));
      return 1;
    }
    if (script.includes('settle-consent-revocation')) {
      const [consentIndex, workKey, workIndex] = keys;
      const [digest, nowRaw] = argv;
      if ((this.sets.get(consentIndex!)?.size ?? 0) === 0) {
        this.values.delete(workKey!);
        this.removeSorted(workIndex!, digest!);
        return 1;
      }
      this.addSorted(workIndex!, digest!, Number(nowRaw));
      return 0;
    }
    if (script.includes('claim-connect-session')) {
      const [key, claimsKey] = keys;
      const [tenantId, requestedAction, token, nowRaw, untilRaw, searchId, createdAt, connectId, callerDigest, allowTenantAdmin, isSystem] = argv;
      const raw = this.values.get(key!);
      if (!raw) return null;
      const value = JSON.parse(raw) as Record<string, unknown>;
      if (value.tenantId !== tenantId) return '__ownership_mismatch__';
      const isOwner = value.ownerDigest === callerDigest;
      const adminCancel = requestedAction === 'cancel' && allowTenantAdmin === '1';
      if (isSystem !== '1' && !isOwner && !adminCancel) return '__ownership_mismatch__';
      if (requestedAction === 'cancel') value.cancelRequested = true;
      if (value.handedOff && requestedAction === 'confirm') return '__handed_off__';
      if (typeof value.claimToken === 'string' && Number(value.claimUntil ?? 0) > Number(nowRaw)) {
        this.values.set(key!, JSON.stringify(value));
        return '__busy__';
      }
      const action = value.cancelRequested ? 'cancel' : requestedAction;
      if (action === 'confirm' && !value.confirmSearchId) {
        if (!searchId || !createdAt) return '__missing_confirmation_work__';
        value.confirmSearchId = searchId;
        value.confirmCreatedAt = createdAt;
      }
      value.claimToken = token;
      value.claimAction = action;
      value.claimUntil = Number(untilRaw);
      this.values.set(key!, JSON.stringify(value));
      this.addSorted(claimsKey!, connectId!, Number(untilRaw));
      return JSON.stringify(value);
    }
    if (script.includes('ack-connect-session')) {
      const [key, claimsKey, consentKey] = keys;
      const [tenantId, token, connectId, action, nowRaw] = argv;
      const raw = this.values.get(key!);
      if (!raw) { this.removeSorted(claimsKey!, connectId!); return 0; }
      const value = JSON.parse(raw) as Record<string, unknown>;
      if (value.tenantId !== tenantId || value.claimToken !== token) return 0;
      if (action === 'confirm') {
        value.handedOff = true;
        if (value.cancelRequested) {
          value.claimAction = 'cancel';
          value.claimUntil = Number(nowRaw);
          this.addSorted(claimsKey!, connectId!, Number(nowRaw));
        } else {
          delete value.claimToken;
          delete value.claimAction;
          delete value.claimUntil;
          this.removeSorted(claimsKey!, connectId!);
        }
        this.values.set(key!, JSON.stringify(value));
        return 1;
      }
      this.values.delete(key!);
      this.removeSorted(claimsKey!, connectId!);
      if (consentKey) this.sets.get(consentKey)?.delete(connectId!);
      return 1;
    }
    if (script.includes('defer-connect-session')) {
      const [key, claimsKey] = keys;
      const [tenantId, token, nowRaw, connectId] = argv;
      const raw = this.values.get(key!);
      if (!raw) return 0;
      const value = JSON.parse(raw) as Record<string, unknown>;
      if (value.tenantId !== tenantId || value.claimToken !== token) return 0;
      value.claimUntil = Number(nowRaw);
      this.values.set(key!, JSON.stringify(value));
      this.addSorted(claimsKey!, connectId!, Number(nowRaw));
      return 1;
    }
    if (script.includes('check-connect-claim-state')) {
      const [key] = keys;
      const [tenantId, token] = argv;
      const raw = this.values.get(key!);
      if (!raw) return -1;
      const value = JSON.parse(raw) as Record<string, unknown>;
      if (value.tenantId !== tenantId) return -1;
      if (value.cancelRequested) return 1;
      return value.claimToken === token ? 0 : -1;
    }
    if (script.includes('renew-connect-session')) {
      const [key, claimsKey] = keys;
      const [tenantId, token, untilRaw, connectId, action] = argv;
      const raw = this.values.get(key!);
      if (!raw) return -1;
      const value = JSON.parse(raw) as Record<string, unknown>;
      if (value.tenantId !== tenantId || value.claimToken !== token) return -1;
      value.claimUntil = Number(untilRaw);
      this.values.set(key!, JSON.stringify(value));
      this.addSorted(claimsKey!, connectId!, Number(untilRaw));
      return value.cancelRequested && action === 'confirm' ? 1 : 0;
    }
    if (script.includes('reclaim-expired-connect-session')) {
      const [key, claimsKey] = keys;
      const [connectId, nowRaw, token, untilRaw] = argv;
      const raw = this.values.get(key!);
      if (!raw) { this.removeSorted(claimsKey!, connectId!); return null; }
      const value = JSON.parse(raw) as Record<string, unknown>;
      if (typeof value.claimToken !== 'string' || Number(value.claimUntil ?? 0) > Number(nowRaw)) return null;
      if (value.cancelRequested) value.claimAction = 'cancel';
      value.claimToken = token;
      value.claimUntil = Number(untilRaw);
      this.values.set(key!, JSON.stringify(value));
      this.addSorted(claimsKey!, connectId!, Number(untilRaw));
      return JSON.stringify(value);
    }
    throw new Error('unexpected Lua script in test fake');
  }

  async smembers(key: string): Promise<string[]> { return [...(this.sets.get(key) ?? [])]; }
  async srem(key: string, member: string): Promise<number> { return this.sets.get(key)?.delete(member) ? 1 : 0; }
  async scard(key: string): Promise<number> { return this.sets.get(key)?.size ?? 0; }
  async sscan(key: string, cursor: string, _count: 'COUNT', limit: number): Promise<[string, string[]]> {
    const members = [...(this.sets.get(key) ?? [])].sort();
    const offset = Number(cursor) || 0;
    const page = members.slice(offset, offset + limit);
    const next = offset + page.length >= members.length ? '0' : String(offset + page.length);
    return [next, page];
  }
  async zrangebyscore(
    key: string,
    _min: string | number,
    max: string | number,
    _limit: 'LIMIT',
    offset: number,
    count: number,
  ): Promise<string[]> {
    return [...(this.sorted.get(key) ?? [])]
      .filter(([, score]) => score <= Number(max))
      .sort((a, b) => a[1] - b[1])
      .slice(offset, offset + count)
      .map(([member]) => member);
  }

  private addSet(key: string, member: string): void {
    const values = this.sets.get(key) ?? new Set<string>();
    values.add(member);
    this.sets.set(key, values);
  }
  private addSorted(key: string, member: string, score: number): void {
    const values = this.sorted.get(key) ?? new Map<string, number>();
    values.set(member, score);
    this.sorted.set(key, values);
  }
  private removeSorted(key: string, member: string): void { this.sorted.get(key)?.delete(member); }
}

const liveEnv = (): NodeJS.ProcessEnv => ({
  ...signedComplianceTestEnv(),
  NODE_ENV: 'production',
  ENCRYPTION_MASTER_KEY: TEST_ENCRYPTION_KEY,
  ENABLE_DISTROKID_LIVE_SCANNER: 'true',
  LEGAL_REVIEW_DISTROKID_SCANNER_APPROVED: 'true',
  STEEL_CONNECTOR_MODE: 'external',
  STEEL_API_URL: 'http://steel.internal:3000',
});

function factory(steel: BrowserLinkProvider | null): DistributorConnectProviderFactory {
  return {
    steel: vi.fn(() => steel),
    encryptor: new EnvelopeEncryptor(TEST_ENCRYPTION_KEY),
  };
}

const ALICE = { tenantId: 'tenant-1', actorUserId: 'alice', allowTenantAdmin: false } as const;
const ALICE_BINDING = {
  tenantId: 'tenant-1',
  ownerUserId: 'alice',
  consentId: 'consent-1',
  artistWorkspaceId: 'workspace-1',
} as const;
const BOB = { tenantId: 'tenant-1', actorUserId: 'bob', allowTenantAdmin: false } as const;
const TENANT_ADMIN = { tenantId: 'tenant-1', actorUserId: 'tenant-admin', allowTenantAdmin: true } as const;
const VALIDATE_ACTIVE_CONSENT = async (): Promise<void> => {};

describe('DistributorConnect Steel-only flow', () => {
  it('restricts attended connections to DistroKid', async () => {
    const providers = factory(fakeProvider());
    const connect = new DistributorConnect(new InMemorySearchStore(), liveEnv(), undefined, undefined, undefined, vi.fn(), new InMemoryConnectSessionRegistry(), providers, VALIDATE_ACTIVE_CONSENT);
    await expect(connect.start('tunecore', ['Artist'], ALICE_BINDING)).rejects.toThrow(/Only DistroKid/i);
    expect(providers.steel).not.toHaveBeenCalled();
  });

  it('fails closed in production without Steel', async () => {
    const providers = factory(null);
    const connect = new DistributorConnect(
      new InMemorySearchStore(),
      liveEnv(),
      undefined, undefined, undefined, vi.fn(), new InMemoryConnectSessionRegistry(), providers, VALIDATE_ACTIVE_CONSENT,
    );
    await expect(connect.start('distrokid', ['Artist'], ALICE_BINDING)).rejects.toThrow(/Steel is required/i);
  });

  it('requires both live-scanner and legal-review gates before creating Steel', async () => {
    const steel = fakeProvider();
    const connect = new DistributorConnect(
      new InMemorySearchStore(),
      { NODE_ENV: 'production', STEEL_CONNECTOR_MODE: 'external', STEEL_API_URL: 'http://steel:3000' },
      undefined, undefined, undefined, vi.fn(), new InMemoryConnectSessionRegistry(), factory(steel), VALIDATE_ACTIVE_CONSENT,
    );
    await expect(connect.start('distrokid', ['Artist'], ALICE_BINDING)).rejects.toThrow(/Live DistroKid scanning is disabled/i);
    expect(steel.createSession).not.toHaveBeenCalled();
  });

  it('survives an API replica/restart and atomically consumes the Steel handoff once', async () => {
    const registry = new InMemoryConnectSessionRegistry();
    const steel = fakeProvider();
    const providers = factory(steel);
    const startSnapshot = vi.fn(async () => ({ jobId: 'job-1', accepted: true as const }));
    const store = new InMemorySearchStore();
    const firstReplica = new DistributorConnect(store, liveEnv(), undefined, undefined, undefined, startSnapshot, registry, providers, VALIDATE_ACTIVE_CONSENT);
    const started = await firstReplica.start('distrokid', ['Lewis KE'], ALICE_BINDING);
    expect(started.provider).toBe('steel');
    expect(steel.detachLocalSession).toHaveBeenCalledWith('local-steel-1');

    const secondReplica = new DistributorConnect(store, liveEnv(), undefined, undefined, undefined, startSnapshot, registry, providers, VALIDATE_ACTIVE_CONSENT);
    const accepted = await secondReplica.confirmAndScan(started.connectId, ALICE);
    expect(accepted.reading).toBe(true);
    expect(startSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-1',
      distributor: 'distrokid',
      artists: ['Lewis KE'],
    }));
    const queued = (startSnapshot.mock.calls as unknown as Array<[{ steelSessionId?: string }]>)[0]?.[0];
    expect(queued?.steelSessionId).toMatch(/^v1\./);
    expect(new EnvelopeEncryptor(TEST_ENCRYPTION_KEY).decrypt(queued!.steelSessionId!)).toBe('steel-remote-1');
    await expect(secondReplica.confirmAndScan(started.connectId, ALICE)).rejects.toThrow(/unknown or expired/i);
  });

  it('keeps same-tenant confirmation owner-only and stamps the owner/workspace on the scan', async () => {
    const registry = new InMemoryConnectSessionRegistry();
    const steel = fakeProvider();
    const store = new InMemorySearchStore();
    const startSnapshot = vi.fn(async () => ({ jobId: 'job-owner', accepted: true as const }));
    const connect = new DistributorConnect(
      store, liveEnv(), undefined, undefined, undefined, startSnapshot, registry, factory(steel), VALIDATE_ACTIVE_CONSENT,
    );
    const started = await connect.start('distrokid', ['Alice Artist'], ALICE_BINDING);

    await expect(connect.confirmAndScan(started.connectId, BOB)).rejects.toMatchObject({ name: 'ConnectSessionOwnershipError' });
    await expect(connect.confirmAndScan(started.connectId, TENANT_ADMIN)).rejects.toMatchObject({ name: 'ConnectSessionOwnershipError' });
    await expect(connect.confirmAndScan(started.connectId, ALICE)).resolves.toEqual(expect.objectContaining({ reading: true }));

    const [record] = await store.listForUser('alice');
    expect(record).toMatchObject({ userId: 'alice' });
  });

  it('re-checks workspace edit authority before creating a scan and terminates a revoked handoff', async () => {
    const registry = new InMemoryConnectSessionRegistry();
    const steel = fakeProvider();
    const store = new InMemorySearchStore();
    const startSnapshot = vi.fn(async () => ({ jobId: 'job-denied', accepted: true as const }));
    const authorizeWorkspace = vi.fn(async () => false);
    const connect = new DistributorConnect(
      store,
      { ...liveEnv(), NODE_ENV: 'test' },
      undefined,
      undefined,
      undefined,
      startSnapshot,
      registry,
      factory(steel),
      VALIDATE_ACTIVE_CONSENT,
      undefined,
      authorizeWorkspace,
    );
    const started = await connect.start('distrokid', ['Alice Artist'], ALICE_BINDING);

    await expect(connect.confirmAndScan(started.connectId, ALICE)).rejects.toMatchObject({
      name: 'ConnectWorkspaceAuthorizationError',
    });
    expect(authorizeWorkspace).toHaveBeenCalledWith({
      tenantId: 'tenant-1', subjectId: 'alice', workspaceId: 'workspace-1',
    });
    expect(await store.listForUser('alice')).toEqual([]);
    expect(startSnapshot).not.toHaveBeenCalled();
    expect(steel.releaseRemoteSession).toHaveBeenCalledWith('steel-remote-1');
  });

  it('lets only the owner or exact tenant admin cancel a same-tenant attended login', async () => {
    const registry = new InMemoryConnectSessionRegistry();
    const steel = fakeProvider();
    const connect = new DistributorConnect(
      new InMemorySearchStore(), liveEnv(), undefined, undefined, undefined,
      vi.fn(async () => ({ jobId: 'job-cancel', accepted: true as const })), registry, factory(steel), VALIDATE_ACTIVE_CONSENT,
    );
    const started = await connect.start('distrokid', ['Alice Artist'], ALICE_BINDING);

    await expect(connect.cancel(started.connectId, BOB)).rejects.toMatchObject({ name: 'ConnectSessionOwnershipError' });
    await expect(connect.cancel(started.connectId, TENANT_ADMIN)).resolves.toBeUndefined();
    expect(steel.releaseRemoteSession).toHaveBeenCalledWith('steel-remote-1');
  });

  it('requests the configured Steel lease instead of silently capping a pipeline at 20 minutes', async () => {
    const steel = fakeProvider();
    const connect = new DistributorConnect(
      new InMemorySearchStore(),
      { ...liveEnv(), STEEL_SESSION_TIMEOUT_MS: '21600000' },
      undefined, undefined, undefined, vi.fn(async () => ({ jobId: 'job-1', accepted: true as const })),
      new InMemoryConnectSessionRegistry(), factory(steel), VALIDATE_ACTIVE_CONSENT,
    );

    await connect.start('distrokid', ['Large Catalogue'], ALICE_BINDING);

    expect(steel.createSession).toHaveBeenCalledWith(expect.objectContaining({ ttlMinutes: 360 }));
    expect(steel.createUserAccessUrl).toHaveBeenCalledWith('local-steel-1', { ttlMinutes: 360 });
  });

  it('cancels from another replica and explicitly releases the remote Steel session', async () => {
    const registry = new InMemoryConnectSessionRegistry();
    const steel = fakeProvider();
    const providers = factory(steel);
    const startSnapshot = vi.fn(async () => ({ jobId: 'job-1', accepted: true as const }));
    const started = await new DistributorConnect(
      new InMemorySearchStore(), liveEnv(), undefined, undefined, undefined, startSnapshot, registry, providers, VALIDATE_ACTIVE_CONSENT,
    ).start('distrokid', ['Artist'], ALICE_BINDING);

    const otherReplica = new DistributorConnect(
      new InMemorySearchStore(), liveEnv(), undefined, undefined, undefined, startSnapshot, registry, providers, VALIDATE_ACTIVE_CONSENT,
    );
    await otherReplica.cancel(started.connectId, ALICE);
    expect(steel.releaseRemoteSession).toHaveBeenCalledWith('steel-remote-1');
    await expect(otherReplica.confirmAndScan(started.connectId, ALICE)).rejects.toThrow(/unknown or expired/i);
  });

  it('restores a consumed cancellation handoff when Steel release transiently fails', async () => {
    const registry = new InMemoryConnectSessionRegistry();
    const steel = fakeProvider();
    steel.releaseRemoteSession.mockRejectedValueOnce(new Error('temporary Steel outage'));
    const providers = factory(steel);
    const startSnapshot = vi.fn(async () => ({ jobId: 'job-1', accepted: true as const }));
    const connect = new DistributorConnect(
      new InMemorySearchStore(), liveEnv(), undefined, undefined, undefined, startSnapshot, registry, providers, VALIDATE_ACTIVE_CONSENT,
    );
    const started = await connect.start('distrokid', ['Artist'], ALICE_BINDING);

    await expect(connect.cancel(started.connectId, ALICE)).rejects.toThrow(/temporary Steel outage/);
    await expect(connect.cancel(started.connectId, ALICE)).resolves.toBeUndefined();
    expect(steel.releaseRemoteSession).toHaveBeenCalledTimes(2);
  });

  it('refuses to start Steel when the durable pipeline is absent', async () => {
    const steel = fakeProvider();
    const connect = new DistributorConnect(new InMemorySearchStore(), liveEnv(), undefined, undefined, undefined, undefined, new InMemoryConnectSessionRegistry(), factory(steel), VALIDATE_ACTIVE_CONSENT);
    await expect(connect.start('distrokid', ['Artist'], ALICE_BINDING)).rejects.toThrow(/durable DistroKid pipeline/i);
    expect(steel.createSession).not.toHaveBeenCalled();
  });

  it('refuses to create Steel when the durable consent validator is absent', async () => {
    const steel = fakeProvider();
    const connect = new DistributorConnect(
      new InMemorySearchStore(), liveEnv(), undefined, undefined, undefined,
      vi.fn(async () => ({ jobId: 'job-1', accepted: true as const })),
      new InMemoryConnectSessionRegistry(), factory(steel),
    );
    await expect(connect.start('distrokid', ['Artist'], ALICE_BINDING)).rejects.toThrow(/consent validator/i);
    expect(steel.createSession).not.toHaveBeenCalled();
  });

  it('does not fall back to an API-process read when pipeline enqueue fails', async () => {
    const registry = new InMemoryConnectSessionRegistry();
    const steel = fakeProvider();
    const store = new InMemorySearchStore();
    const connect = new DistributorConnect(
      store,
      liveEnv(),
      undefined, undefined, undefined,
      vi.fn(async () => { throw new Error('redis unavailable'); }),
      registry,
      factory(steel),
      VALIDATE_ACTIVE_CONSENT,
    );
    const started = await connect.start('distrokid', ['Artist'], ALICE_BINDING);
    await expect(connect.confirmAndScan(started.connectId, ALICE)).rejects.toThrow(/Could not enqueue the durable Steel scan/i);
    expect(steel.attachAutomation).not.toHaveBeenCalled();
    expect((await store.list())[0]?.summary.tracks).toBe(0);
  });

  it('replays the same durable search and snapshot after a crash-window enqueue error', async () => {
    const registry = new InMemoryConnectSessionRegistry();
    const steel = fakeProvider();
    const store = new InMemorySearchStore();
    const submitted: Array<{ snapshotId: string; sessionExpiresAt?: string }> = [];
    const startSnapshot = vi.fn(async (job: { snapshotId: string; sessionExpiresAt?: string }) => {
      submitted.push(job);
      if (submitted.length === 1) throw new Error('response lost after queue accepted the job');
      return { jobId: `job-${job.snapshotId}`, accepted: true as const };
    });
    const connect = new DistributorConnect(
      store, liveEnv(), undefined, undefined, undefined, startSnapshot, registry, factory(steel), VALIDATE_ACTIVE_CONSENT,
    );
    const started = await connect.start('distrokid', ['Artist'], ALICE_BINDING);

    await expect(connect.confirmAndScan(started.connectId, ALICE)).rejects.toThrow(/Could not enqueue/i);
    expect(await store.list()).toHaveLength(1);
    await expect(connect.recoverAbandoned()).resolves.toEqual({ claimed: 1, completed: 1, failed: 0 });
    expect(submitted).toHaveLength(2);
    expect(submitted[1]?.snapshotId).toBe(submitted[0]?.snapshotId);
    expect(submitted[1]?.sessionExpiresAt).toBeTruthy();
    expect(await store.list()).toHaveLength(1);
  });

  it('allows only one concurrent confirmation claim', async () => {
    const registry = new InMemoryConnectSessionRegistry();
    const steel = fakeProvider();
    let finish!: () => void;
    const blocked = new Promise<void>((resolve) => { finish = resolve; });
    const startSnapshot = vi.fn(async () => {
      await blocked;
      return { jobId: 'job-1', accepted: true as const };
    });
    const connect = new DistributorConnect(
      new InMemorySearchStore(), liveEnv(), undefined, undefined, undefined, startSnapshot, registry, factory(steel), VALIDATE_ACTIVE_CONSENT,
    );
    const started = await connect.start('distrokid', ['Artist'], ALICE_BINDING);
    const first = connect.confirmAndScan(started.connectId, ALICE);
    await vi.waitFor(() => expect(startSnapshot).toHaveBeenCalledOnce());
    await expect(connect.confirmAndScan(started.connectId, ALICE)).rejects.toMatchObject({ name: 'ConnectSessionBusyError' });
    finish();
    await expect(first).resolves.toEqual(expect.objectContaining({ reading: true }));
    expect(startSnapshot).toHaveBeenCalledOnce();
  });

  it('fails closed when a confirmer loses its leased claim token', async () => {
    let now = Date.now();
    const registry = new InMemoryConnectSessionRegistry(() => now);
    await registry.put('handoff-1', {
      tenantId: 'tenant-1',
      ownerUserId: 'alice',
      artists: ['Artist'],
      distributor: 'distrokid',
      steelSessionId: 'remote-1',
      consentId: 'consent-1',
      artistWorkspaceId: 'workspace-1',
      expiresAt: new Date(now + 60_000).toISOString(),
    });
    const first = await registry.claim('handoff-1', ALICE, 'confirm', 1_000, {
      searchId: 'stable-search', createdAt: new Date(now).toISOString(),
    });
    if (first.status !== 'claimed') throw new Error('expected first claim');
    now += 1_001;
    const recovered = await registry.claimExpired(1, 1_000);

    expect(recovered).toHaveLength(1);
    expect(await registry.claimState(first.claim)).toBe('lost');
    expect(await registry.claimState(recovered[0]!)).toBe('active');
  });

  it('sessionReuseEnabled reads DISTRIBUTOR_SESSION_REUSE (default off)', () => {
    expect(sessionReuseEnabled({})).toBe(false);
    expect(sessionReuseEnabled({ DISTRIBUTOR_SESSION_REUSE: 'true' })).toBe(true);
    expect(sessionReuseEnabled({ DISTRIBUTOR_SESSION_REUSE: '1' })).toBe(true);
    expect(sessionReuseEnabled({ DISTRIBUTOR_SESSION_REUSE: 'off' })).toBe(false);
  });

  it('warm reuse ON: re-confirms a handed-off session and adopts a FRESH search, reusing the same Steel session', async () => {
    const now = Date.now();
    const registry = new InMemoryConnectSessionRegistry(() => now, true);
    await registry.put('warm-1', {
      tenantId: 'tenant-1', ownerUserId: 'alice', artists: ['Artist'], distributor: 'distrokid',
      steelSessionId: 'remote-1', consentId: 'consent-1', artistWorkspaceId: 'workspace-1',
      expiresAt: new Date(now + 60_000).toISOString(),
    });
    const first = await registry.claim('warm-1', ALICE, 'confirm', 1_000, { searchId: 'search-1', createdAt: new Date(now).toISOString() });
    if (first.status !== 'claimed') throw new Error('expected first claim');
    expect(await registry.ack(first.claim)).toBe(true);
    // Rescan: a NEW confirm claim succeeds (not one-shot) and adopts the new searchId.
    const second = await registry.claim('warm-1', ALICE, 'confirm', 1_000, { searchId: 'search-2', createdAt: new Date(now).toISOString() });
    if (second.status !== 'claimed') throw new Error('expected warm reuse claim');
    expect(second.claim.session.steelSessionId).toBe('remote-1');
    expect(second.claim.confirmation?.searchId).toBe('search-2');
  });

  it('warm reuse OFF (default): a handed-off session stays one-shot (not-found on re-confirm)', async () => {
    const now = Date.now();
    const registry = new InMemoryConnectSessionRegistry(() => now);
    await registry.put('once-1', {
      tenantId: 'tenant-1', ownerUserId: 'alice', artists: ['Artist'], distributor: 'distrokid',
      steelSessionId: 'remote-1', consentId: 'consent-1', artistWorkspaceId: 'workspace-1',
      expiresAt: new Date(now + 60_000).toISOString(),
    });
    const first = await registry.claim('once-1', ALICE, 'confirm', 1_000, { searchId: 'search-1', createdAt: new Date(now).toISOString() });
    if (first.status !== 'claimed') throw new Error('expected first claim');
    expect(await registry.ack(first.claim)).toBe(true);
    const second = await registry.claim('once-1', ALICE, 'confirm', 1_000, { searchId: 'search-2', createdAt: new Date(now).toISOString() });
    expect(second.status).toBe('not-found');
  });

  it('warm reuse still enforces ownership: a different principal cannot reuse a handed-off session', async () => {
    const now = Date.now();
    const registry = new InMemoryConnectSessionRegistry(() => now, true);
    await registry.put('warm-2', {
      tenantId: 'tenant-1', ownerUserId: 'alice', artists: ['Artist'], distributor: 'distrokid',
      steelSessionId: 'remote-1', consentId: 'consent-1', artistWorkspaceId: 'workspace-1',
      expiresAt: new Date(now + 60_000).toISOString(),
    });
    const first = await registry.claim('warm-2', ALICE, 'confirm', 1_000, { searchId: 'search-1', createdAt: new Date(now).toISOString() });
    if (first.status !== 'claimed') throw new Error('expected first claim');
    await registry.ack(first.claim);
    const second = await registry.claim('warm-2', BOB, 'confirm', 1_000, { searchId: 'search-2', createdAt: new Date(now).toISOString() });
    expect(second.status).toBe('ownership-mismatch');
  });

  it('reclaims an abandoned cancellation and releases Steel after its visibility window', async () => {
    let now = Date.now();
    const registry = new InMemoryConnectSessionRegistry(() => now);
    const steel = fakeProvider();
    const connect = new DistributorConnect(
      new InMemorySearchStore(), liveEnv(), undefined, undefined, undefined,
      vi.fn(async () => ({ jobId: 'job-1', accepted: true as const })), registry, factory(steel), VALIDATE_ACTIVE_CONSENT,
    );
    const started = await connect.start('distrokid', ['Artist'], ALICE_BINDING);
    const abandoned = await registry.claim(started.connectId, ALICE, 'cancel', 1_000);
    expect(abandoned.status).toBe('claimed');
    now += 1_001;

    await expect(connect.recoverAbandoned()).resolves.toEqual({ claimed: 1, completed: 1, failed: 0 });
    expect(steel.releaseRemoteSession).toHaveBeenCalledWith('steel-remote-1');
    await expect(connect.confirmAndScan(started.connectId, ALICE)).rejects.toThrow(/unknown or expired/i);
  });

  it('retains the active consent index after enqueue so later revocation releases Steel', async () => {
    const registry = new InMemoryConnectSessionRegistry();
    const steel = fakeProvider();
    const connect = new DistributorConnect(
      new InMemorySearchStore(), liveEnv(), undefined, undefined, undefined,
      vi.fn(async () => ({ jobId: 'job-1', accepted: true as const })), registry, factory(steel), VALIDATE_ACTIVE_CONSENT,
    );
    const started = await connect.start('distrokid', ['Artist'], ALICE_BINDING);
    await connect.confirmAndScan(started.connectId, ALICE);

    await expect(connect.cancelByConsent('consent-1', 'tenant-1')).resolves.toBe(1);
    expect(steel.releaseRemoteSession).toHaveBeenCalledWith('steel-remote-1');
  });

  it('rejects confirmation without the configured catalogue budget plus cleanup grace', async () => {
    const registry = new InMemoryConnectSessionRegistry();
    const steel = fakeProvider();
    steel.createSession.mockResolvedValueOnce({
      sessionId: 'local-steel-1',
      status: 'CREATED' as const,
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      providerSessionRef: 'encrypted-ref',
    });
    const startSnapshot = vi.fn(async () => ({ jobId: 'job-1', accepted: true as const }));
    const connect = new DistributorConnect(
      new InMemorySearchStore(), liveEnv(), undefined, undefined, undefined,
      startSnapshot, registry, factory(steel), VALIDATE_ACTIVE_CONSENT,
    );
    const started = await connect.start('distrokid', ['Artist'], ALICE_BINDING);

    await expect(connect.confirmAndScan(started.connectId, ALICE)).rejects.toThrow(/too little lease remaining/i);
    expect(startSnapshot).not.toHaveBeenCalled();
    expect(steel.releaseRemoteSession).toHaveBeenCalledWith('steel-remote-1');
  });
});

describe('RedisConnectSessionRegistry', () => {
  it('preserves the exact owner across an encrypted registry restart', async () => {
    const redis = new FakeConnectRedis();
    const now = Date.now();
    const encryptor = new EnvelopeEncryptor(TEST_ENCRYPTION_KEY);
    const firstReplica = new RedisConnectSessionRegistry(redis, 'test:restart', () => now, encryptor);
    await firstReplica.put('owned', {
      tenantId: 'tenant-1', ownerUserId: 'alice', artists: ['Artist'], distributor: 'distrokid',
      steelSessionId: 'remote-owned', consentId: 'consent-1', artistWorkspaceId: 'workspace-1',
      expiresAt: new Date(now + 60_000).toISOString(),
    });
    const serialized = redis.values.get('test:restart:owned')!;
    expect(serialized).not.toContain('alice');
    expect(serialized).not.toContain('remote-owned');

    const restarted = new RedisConnectSessionRegistry(redis, 'test:restart', () => now, encryptor);
    await expect(restarted.claim('owned', BOB, 'confirm', 10_000, {
      searchId: 'bob-search', createdAt: new Date(now).toISOString(),
    })).resolves.toEqual({ status: 'ownership-mismatch' });
    await expect(restarted.claim('owned', ALICE, 'confirm', 10_000, {
      searchId: 'alice-search', createdAt: new Date(now).toISOString(),
    })).resolves.toEqual(expect.objectContaining({ status: 'claimed' }));
  });

  it('rejects an encrypted record when its plaintext owner binding is tampered', async () => {
    const redis = new FakeConnectRedis();
    const now = Date.now();
    const registry = new RedisConnectSessionRegistry(
      redis, 'test:tamper', () => now, new EnvelopeEncryptor(TEST_ENCRYPTION_KEY),
    );
    await registry.put('owned', {
      tenantId: 'tenant-1', ownerUserId: 'alice', artists: ['Artist'], distributor: 'distrokid',
      steelSessionId: 'remote-owned', consentId: 'consent-1', artistWorkspaceId: 'workspace-1',
      expiresAt: new Date(now + 60_000).toISOString(),
    });
    const key = 'test:tamper:owned';
    const outer = JSON.parse(redis.values.get(key)!) as Record<string, unknown>;
    outer.ownerDigest = createHash('sha256').update('tenant-1\u0000bob').digest('hex');
    redis.values.set(key, JSON.stringify(outer));

    await expect(registry.claim('owned', BOB, 'confirm', 10_000, {
      searchId: 'stolen-search', createdAt: new Date(now).toISOString(),
    })).rejects.toThrow(/authorization binding mismatch/i);
  });

  it('atomically restores failed post-create cleanup as immediately due cancellation work', async () => {
    const redis = new FakeConnectRedis();
    const now = Date.now();
    const registry = new RedisConnectSessionRegistry(
      redis, 'test:connect', () => now, new EnvelopeEncryptor(TEST_ENCRYPTION_KEY),
    );
    await registry.restoreCancellation('orphan-1', {
      tenantId: 'tenant-1', ownerUserId: 'alice', artists: ['Artist'], distributor: 'distrokid', steelSessionId: 'remote-1',
      consentId: 'consent-1', artistWorkspaceId: 'workspace-1', expiresAt: new Date(now + 60_000).toISOString(),
    });

    const recovered = await registry.claimExpired(10, 1_000);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toEqual(expect.objectContaining({ connectId: 'orphan-1', action: 'cancel' }));
    expect(JSON.stringify([...redis.values.values()])).not.toContain('remote-1');
  });

  it('leases encrypted TTL storage, retains active ownership, and tenant-checks every claim', async () => {
    const redis = new FakeConnectRedis();
    const now = Date.now();
    const registry = new RedisConnectSessionRegistry(
      redis, 'test:connect', () => now, new EnvelopeEncryptor(TEST_ENCRYPTION_KEY),
    );
    await registry.put('id-1', {
      tenantId: 'tenant-1', ownerUserId: 'alice', artists: ['Artist'], distributor: 'distrokid', steelSessionId: 'remote-1',
      consentId: 'consent-1', artistWorkspaceId: 'workspace-1',
      expiresAt: new Date(now + 60_000).toISOString(),
    });
    expect(redis.ttls[0]).toBe(60_000);
    expect([...redis.values.values()][0]).not.toContain('remote-1');
    expect(await registry.claim('id-1', { tenantId: 'tenant-2', actorUserId: 'alice', allowTenantAdmin: false }, 'cancel', 10_000)).toEqual({ status: 'ownership-mismatch' });
    const result = await registry.claim('id-1', ALICE, 'confirm', 10_000, {
      searchId: 'search-1', createdAt: new Date(now).toISOString(),
    });
    expect(result).toEqual(expect.objectContaining({ status: 'claimed' }));
    if (result.status !== 'claimed') throw new Error('expected claim');
    expect(await registry.claim('id-1', ALICE, 'confirm', 10_000, {
      searchId: 'search-2', createdAt: new Date(now).toISOString(),
    })).toEqual({ status: 'busy' });
    await registry.ack(result.claim);
    // Confirmation transfers ownership to the pipeline but retains the consent-indexed,
    // encrypted handle so later consent revocation can still release Steel immediately.
    expect(redis.values.size).toBeGreaterThan(0);
    expect(await registry.claim('id-1', ALICE, 'confirm', 10_000, {
      searchId: 'search-2', createdAt: new Date(now).toISOString(),
    })).toEqual({ status: 'not-found' });
    await registry.markConsentRevoked('consent-1', 'tenant-1', 60_000);
    const cancellation = await registry.claimByConsent('consent-1', 'tenant-1', 10_000);
    expect(cancellation.claims).toHaveLength(1);
    await registry.ack(cancellation.claims[0]!);
  });

  it('claims every handoff for only the tenant-scoped consent', async () => {
    const redis = new FakeConnectRedis();
    const now = Date.now();
    const registry = new RedisConnectSessionRegistry(redis, 'test:connect', () => now, new EnvelopeEncryptor(TEST_ENCRYPTION_KEY));
    for (const [connectId, tenantId] of [['one', 'tenant-1'], ['two', 'tenant-1'], ['other', 'tenant-2']] as const) {
      await registry.put(connectId, {
        tenantId,
        ownerUserId: 'alice',
        artists: ['Artist'],
        distributor: 'distrokid',
        steelSessionId: `remote-${connectId}`,
        consentId: 'same-consent-label',
        artistWorkspaceId: 'workspace-1',
        expiresAt: new Date(now + 60_000).toISOString(),
      });
    }
    await registry.markConsentRevoked('same-consent-label', 'tenant-1', 60_000);
    const claimed = await registry.claimByConsent('same-consent-label', 'tenant-1', 10_000);
    expect(claimed.claims.map((item) => item.connectId).sort()).toEqual(['one', 'two']);
    expect(await registry.claim('other', { tenantId: 'tenant-2', actorUserId: 'alice', allowTenantAdmin: false }, 'confirm', 10_000, {
      searchId: 'search-other', createdAt: new Date(now).toISOString(),
    })).toEqual(expect.objectContaining({ status: 'claimed' }));
  });

  it('reclaims an expired Redis claim with its original idempotency work', async () => {
    const redis = new FakeConnectRedis();
    let now = Date.now();
    const registry = new RedisConnectSessionRegistry(redis, 'test:connect', () => now, new EnvelopeEncryptor(TEST_ENCRYPTION_KEY));
    await registry.put('id-1', {
      tenantId: 'tenant-1', ownerUserId: 'alice', artists: ['Artist'], distributor: 'distrokid', steelSessionId: 'remote-1',
      consentId: 'consent-1', artistWorkspaceId: 'workspace-1', expiresAt: new Date(now + 60_000).toISOString(),
    });
    const first = await registry.claim('id-1', ALICE, 'confirm', 1_000, {
      searchId: 'stable-search', createdAt: new Date(now).toISOString(),
    });
    if (first.status !== 'claimed') throw new Error('expected claim');
    now += 1_001;

    const recovered = await registry.claimExpired(10, 1_000);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toEqual(expect.objectContaining({
      action: 'confirm',
      confirmation: expect.objectContaining({ searchId: 'stable-search' }),
    }));
    expect(recovered[0]?.token).not.toBe(first.claim.token);
    expect(await registry.claimState(first.claim)).toBe('lost');
    expect(await registry.claimState(recovered[0]!)).toBe('active');
  });

  it('turns an expired confirmation into cancellation after consent revocation', async () => {
    const redis = new FakeConnectRedis();
    let now = Date.now();
    const registry = new RedisConnectSessionRegistry(redis, 'test:connect', () => now, new EnvelopeEncryptor(TEST_ENCRYPTION_KEY));
    await registry.put('id-1', {
      tenantId: 'tenant-1', ownerUserId: 'alice', artists: ['Artist'], distributor: 'distrokid', steelSessionId: 'remote-1',
      consentId: 'consent-1', artistWorkspaceId: 'workspace-1', expiresAt: new Date(now + 60_000).toISOString(),
    });
    await registry.claim('id-1', ALICE, 'confirm', 1_000, {
      searchId: 'stable-search', createdAt: new Date(now).toISOString(),
    });
    await registry.markConsentRevoked('consent-1', 'tenant-1', 60_000);
    expect(await registry.claimByConsent('consent-1', 'tenant-1', 1_000)).toEqual(expect.objectContaining({ claims: [], pending: 1 }));
    now += 1_001;

    const recovered = await registry.claimExpired(10, 1_000);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.action).toBe('cancel');
  });

  it('recovers cancellation work after a crash immediately after the tombstone', async () => {
    const redis = new FakeConnectRedis();
    const now = Date.now();
    const registry = new RedisConnectSessionRegistry(redis, 'test:connect', () => now, new EnvelopeEncryptor(TEST_ENCRYPTION_KEY));
    for (const connectId of ['one', 'two']) {
      await registry.put(connectId, {
        tenantId: 'tenant-1', ownerUserId: 'alice', artists: ['Artist'], distributor: 'distrokid', steelSessionId: `remote-${connectId}`,
        consentId: 'consent-1', artistWorkspaceId: 'workspace-1', expiresAt: new Date(now + 60_000).toISOString(),
      });
    }

    // Simulate death after the atomic tombstone/outbox write and before reverse-index scanning.
    await registry.markConsentRevoked('consent-1', 'tenant-1', 60_000);
    const recovered = await registry.claimDueConsentRevocations(10, 10, 1_000);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.claims.map((claim) => claim.connectId).sort()).toEqual(['one', 'two']);
    for (const claim of recovered[0]!.claims) await registry.ack(claim);
    expect(await registry.settleConsentRevocation(recovered[0]!.work!)).toBe(true);
  });

  it('continues bounded revocation pages after a partial-loop crash', async () => {
    const redis = new FakeConnectRedis();
    const now = Date.now();
    const registry = new RedisConnectSessionRegistry(redis, 'test:connect', () => now, new EnvelopeEncryptor(TEST_ENCRYPTION_KEY));
    for (const connectId of ['one', 'two', 'three']) {
      await registry.put(connectId, {
        tenantId: 'tenant-1', ownerUserId: 'alice', artists: ['Artist'], distributor: 'distrokid', steelSessionId: `remote-${connectId}`,
        consentId: 'consent-1', artistWorkspaceId: 'workspace-1', expiresAt: new Date(now + 60_000).toISOString(),
      });
    }
    await registry.markConsentRevoked('consent-1', 'tenant-1', 60_000);

    const firstPage = await registry.claimByConsent('consent-1', 'tenant-1', 1_000, 1);
    expect(firstPage.claims).toHaveLength(1);
    // The process dies here: page one is leased but neither released nor acknowledged.
    const secondPage = (await registry.claimDueConsentRevocations(1, 1, 1_000))[0]!;
    const thirdPage = (await registry.claimDueConsentRevocations(1, 1, 1_000))[0]!;
    const allIds = [...firstPage.claims, ...secondPage.claims, ...thirdPage.claims]
      .map((claim) => claim.connectId)
      .sort();
    expect(allIds).toEqual(['one', 'three', 'two']);
  });
});
