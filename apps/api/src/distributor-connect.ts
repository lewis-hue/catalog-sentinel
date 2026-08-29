import { createHash } from 'node:crypto';
import { id } from '@sentinel/core';
import {
  envelopeEncryptorFromEnv,
  type EnvelopeCrypto,
  assertDistroKidLiveScannerAllowed,
} from '@sentinel/security';
import {
  BrowserLinkUnavailableError,
  createCloudLiveProvider,
  type BrowserLinkProvider,
} from '@sentinel/browser-link';
import type { CandidateSink } from '@sentinel/browser-assist';
import type { CatalogScanResult } from './catalog-scan';
import { DISTROKID_SESSION_CLEANUP_GRACE_MS, type CatalogIndexJob } from '@sentinel/contracts';
import type { SearchRecord, SearchStore } from '@sentinel/search-store';

export interface DurableConnectSession {
  tenantId: string;
  ownerUserId: string;
  artists: string[];
  distributor: 'distrokid';
  steelSessionId: string;
  consentId?: string;
  artistWorkspaceId: string;
  expiresAt: string;
}

export type ConnectSessionAction = 'confirm' | 'cancel';
export type ConnectClaimState = 'active' | 'cancelled' | 'lost';

export interface ConnectConfirmationWork {
  /** Stable across retries so BullMQ's deterministic snapshot job id stays idempotent. */
  searchId: string;
  createdAt: string;
}

export interface ConnectSessionClaim {
  connectId: string;
  token: string;
  action: ConnectSessionAction;
  session: DurableConnectSession;
  confirmation?: ConnectConfirmationWork;
}

export type ConnectSessionClaimResult =
  | { status: 'claimed'; claim: ConnectSessionClaim }
  | { status: 'busy' }
  | { status: 'not-found' }
  | { status: 'ownership-mismatch' };

export interface ConsentConnectClaims {
  claims: ConnectSessionClaim[];
  /** Claims still inside another replica's visibility window. They are marked cancel-requested. */
  pending: number;
  /** Durable outbox work claimed for this bounded reverse-index page. */
  work?: ConsentRevocationWorkClaim;
}

export interface ConsentRevocationWorkClaim {
  digest: string;
  token: string;
  tenantId: string;
  consentId: string;
  cursor: string;
}

function consentRevokedError(): Error {
  const error = new Error('consent was revoked while the Steel session was being created');
  error.name = 'ConnectConsentRevokedError';
  return error;
}

export interface ConnectConsentBinding {
  tenantId: string;
  ownerUserId: string;
  consentId: string;
  artistWorkspaceId: string;
  distributor: 'distrokid';
  sessionExpiresAt: string;
}

/** Server-derived authorization for an interactive session operation. */
export interface ConnectSessionPrincipal {
  tenantId: string;
  actorUserId: string;
  /** Exact customer tenant-admin role; platform operators are deliberately excluded. */
  allowTenantAdmin: boolean;
}

/** Safe attended-login handoff storage. Never stores cookies, tokens, or browser state. */
export interface ConnectSessionRegistry {
  put(connectId: string, session: DurableConnectSession): Promise<void>;
  /** Atomically persist a cancel-only handoff and make it immediately recoverable. */
  restoreCancellation(connectId: string, session: DurableConnectSession): Promise<void>;
  /** Atomically tenant-check and lease work. The record is retained until `ack`. */
  claim(
    connectId: string,
    principal: ConnectSessionPrincipal,
    action: ConnectSessionAction,
    visibilityTimeoutMs: number,
    confirmation?: ConnectConfirmationWork,
  ): Promise<ConnectSessionClaimResult>;
  /** Internal recovery/revocation path, deliberately separate from principal authorization. */
  claimForSystem(
    connectId: string,
    tenantId: string,
    action: ConnectSessionAction,
    visibilityTimeoutMs: number,
    confirmation?: ConnectConfirmationWork,
  ): Promise<ConnectSessionClaimResult>;
  /** Delete only when the same claim token still owns the handoff. */
  ack(claim: ConnectSessionClaim): Promise<boolean>;
  /** Make a failed claim immediately retryable while retaining it for recovery sweeps. */
  defer(claim: ConnectSessionClaim): Promise<boolean>;
  /** Extend the same token's visibility lease and report cancellation/lost ownership atomically. */
  renew(claim: ConnectSessionClaim, visibilityTimeoutMs: number): Promise<ConnectClaimState>;
  /** Distinguish an active lease from cancellation and loss of token ownership. */
  claimState(claim: ConnectSessionClaim): Promise<ConnectClaimState>;
  /** Install a bounded tombstone before revocation scans the reverse index. */
  markConsentRevoked(consentId: string, tenantId: string, ttlMs: number): Promise<void>;
  /** Atomically claim, or mark cancellation on, every session bound to a revoked consent. */
  claimByConsent(
    consentId: string,
    tenantId: string,
    visibilityTimeoutMs: number,
    batchLimit?: number,
  ): Promise<ConsentConnectClaims>;
  /** Claim bounded durable revocation-outbox pages left by crashed API replicas. */
  claimDueConsentRevocations(
    workLimit: number,
    sessionBatchLimit: number,
    visibilityTimeoutMs: number,
  ): Promise<ConsentConnectClaims[]>;
  /** Remove outbox work only after its reverse index is empty. */
  settleConsentRevocation(work: ConsentRevocationWorkClaim): Promise<boolean>;
  /** Re-claim a bounded batch whose owner died or exceeded its visibility window. */
  claimExpired(limit: number, visibilityTimeoutMs: number): Promise<ConnectSessionClaim[]>;
}

/** Dev/test fallback. Production should inject RedisConnectSessionRegistry. */
export class InMemoryConnectSessionRegistry implements ConnectSessionRegistry {
  private readonly records = new Map<string, {
    session: DurableConnectSession;
    claim?: { token: string; action: ConnectSessionAction; until: number };
    confirmation?: ConnectConfirmationWork;
    cancelRequested?: boolean;
    handedOff?: boolean;
  }>();
  private readonly revokedConsents = new Map<string, number>();
  private readonly revocationWork = new Map<string, {
    tenantId: string;
    consentId: string;
    cursor: string;
    dueAt: number;
    expiresAt: number;
    token?: string;
    claimUntil?: number;
  }>();

  constructor(private readonly nowMs: () => number = () => Date.now(), private readonly reuseWarmSessions = false) {}

  async put(connectId: string, session: DurableConnectSession): Promise<void> {
    if (session.consentId && this.consentRevoked(session.tenantId, session.consentId)) {
      throw consentRevokedError();
    }
    this.records.set(connectId, { session: structuredClone(session) });
  }

  async restoreCancellation(connectId: string, session: DurableConnectSession): Promise<void> {
    this.records.set(connectId, {
      session: structuredClone(session),
      cancelRequested: true,
      claim: { token: id('claim'), action: 'cancel', until: this.nowMs() },
    });
  }

  async claim(
    connectId: string,
    principal: ConnectSessionPrincipal,
    action: ConnectSessionAction,
    visibilityTimeoutMs: number,
    confirmation?: ConnectConfirmationWork,
  ): Promise<ConnectSessionClaimResult> {
    return this.claimAuthorized(connectId, principal.tenantId, action, visibilityTimeoutMs, confirmation, principal);
  }

  async claimForSystem(
    connectId: string,
    tenantId: string,
    action: ConnectSessionAction,
    visibilityTimeoutMs: number,
    confirmation?: ConnectConfirmationWork,
  ): Promise<ConnectSessionClaimResult> {
    return this.claimAuthorized(connectId, tenantId, action, visibilityTimeoutMs, confirmation);
  }

  private async claimAuthorized(
    connectId: string,
    tenantId: string,
    action: ConnectSessionAction,
    visibilityTimeoutMs: number,
    confirmation?: ConnectConfirmationWork,
    principal?: ConnectSessionPrincipal,
  ): Promise<ConnectSessionClaimResult> {
    const record = this.records.get(connectId);
    if (!record || Date.parse(record.session.expiresAt) <= this.nowMs()) {
      this.records.delete(connectId);
      return { status: 'not-found' };
    }
    if (record.session.tenantId !== tenantId) return { status: 'ownership-mismatch' };
    if (principal) {
      const isOwner = record.session.ownerUserId === principal.actorUserId;
      if (action === 'confirm' ? !isOwner : (!isOwner && !principal.allowTenantAdmin)) {
        return { status: 'ownership-mismatch' };
      }
    }
    if (action === 'cancel') record.cancelRequested = true;
    if (record.handedOff && action === 'confirm') {
      if (!this.reuseWarmSessions || record.cancelRequested) return { status: 'not-found' };
      // Warm reuse (keep-alive): this session was already scanned but is still live, start a
      // FRESH scan on it. Clear the handoff and the prior stable search so the new search work
      // (a new searchId) is adopted below. The ownership check above still gated this reuse.
      record.handedOff = false;
      delete record.confirmation;
    }
    if (record.claim && record.claim.until > this.nowMs()) return { status: 'busy' };
    const effectiveAction: ConnectSessionAction = record.cancelRequested ? 'cancel' : action;
    if (effectiveAction === 'confirm' && !record.confirmation) {
      if (!confirmation) throw new Error('confirmation claim requires stable search work');
      record.confirmation = structuredClone(confirmation);
    }
    record.claim = {
      token: id('claim'),
      action: effectiveAction,
      until: Math.min(Date.parse(record.session.expiresAt), this.nowMs() + positiveVisibility(visibilityTimeoutMs)),
    };
    return { status: 'claimed', claim: this.toClaim(connectId, record) };
  }

  async ack(claim: ConnectSessionClaim): Promise<boolean> {
    const record = this.records.get(claim.connectId);
    if (!record || record.session.tenantId !== claim.session.tenantId || record.claim?.token !== claim.token) return false;
    if (claim.action === 'confirm') {
      record.handedOff = true;
      if (record.cancelRequested) {
        record.claim.action = 'cancel';
        record.claim.until = this.nowMs();
      } else {
        delete record.claim;
      }
      return true;
    }
    this.records.delete(claim.connectId);
    return true;
  }

  async defer(claim: ConnectSessionClaim): Promise<boolean> {
    const record = this.records.get(claim.connectId);
    if (!record || record.session.tenantId !== claim.session.tenantId || record.claim?.token !== claim.token) return false;
    record.claim.until = this.nowMs();
    return true;
  }

  async renew(claim: ConnectSessionClaim, visibilityTimeoutMs: number): Promise<ConnectClaimState> {
    const record = this.records.get(claim.connectId);
    if (!record || record.session.tenantId !== claim.session.tenantId || record.claim?.token !== claim.token) return 'lost';
    record.claim.until = Math.min(
      Date.parse(record.session.expiresAt),
      this.nowMs() + positiveVisibility(visibilityTimeoutMs),
    );
    return record.cancelRequested && claim.action === 'confirm' ? 'cancelled' : 'active';
  }

  async claimState(claim: ConnectSessionClaim): Promise<ConnectClaimState> {
    const record = this.records.get(claim.connectId);
    if (!record || record.session.tenantId !== claim.session.tenantId) return 'lost';
    if (record.cancelRequested) return 'cancelled';
    return record.claim?.token === claim.token ? 'active' : 'lost';
  }

  async claimByConsent(
    consentId: string,
    tenantId: string,
    visibilityTimeoutMs: number,
    batchLimit = 100,
  ): Promise<ConsentConnectClaims> {
    const work = this.claimRevocationWork(this.consentKey(tenantId, consentId), visibilityTimeoutMs);
    return work ? this.scanRevocationWork(work, visibilityTimeoutMs, batchLimit) : { claims: [], pending: 1 };
  }

  async claimDueConsentRevocations(
    workLimit: number,
    sessionBatchLimit: number,
    visibilityTimeoutMs: number,
  ): Promise<ConsentConnectClaims[]> {
    const now = this.nowMs();
    const due = [...this.revocationWork.entries()]
      .filter(([, work]) => work.expiresAt > now && work.dueAt <= now)
      .slice(0, Math.max(0, Math.floor(workLimit)));
    const batches: ConsentConnectClaims[] = [];
    for (const [key] of due) {
      const work = this.claimRevocationWork(key, visibilityTimeoutMs);
      if (work) batches.push(await this.scanRevocationWork(work, visibilityTimeoutMs, sessionBatchLimit));
    }
    return batches;
  }

  async settleConsentRevocation(work: ConsentRevocationWorkClaim): Promise<boolean> {
    const current = this.revocationWork.get(work.digest);
    if (!current || current.tenantId !== work.tenantId || current.consentId !== work.consentId) return true;
    const remaining = [...this.records.values()].some(
      (record) => record.session.tenantId === work.tenantId && record.session.consentId === work.consentId,
    );
    if (!remaining) {
      this.revocationWork.delete(work.digest);
      return true;
    }
    current.dueAt = this.nowMs();
    return false;
  }

  async claimExpired(limit: number, visibilityTimeoutMs: number): Promise<ConnectSessionClaim[]> {
    const now = this.nowMs();
    const candidates = [...this.records.entries()]
      .filter(([, record]) => record.claim && record.claim.until <= now)
      .slice(0, Math.max(0, Math.floor(limit)));
    const claimed: ConnectSessionClaim[] = [];
    for (const [connectId, record] of candidates) {
      record.claim = {
        token: id('claim'),
        action: record.cancelRequested ? 'cancel' : record.claim!.action,
        until: Math.min(Date.parse(record.session.expiresAt), now + positiveVisibility(visibilityTimeoutMs)),
      };
      claimed.push(this.toClaim(connectId, record));
    }
    return claimed;
  }

  async markConsentRevoked(consentId: string, tenantId: string, ttlMs: number): Promise<void> {
    const key = this.consentKey(tenantId, consentId);
    const expiresAt = this.nowMs() + ttlMs;
    this.revokedConsents.set(key, expiresAt);
    if (!this.revocationWork.has(key)) {
      this.revocationWork.set(key, { tenantId, consentId, cursor: '', dueAt: this.nowMs(), expiresAt });
    }
  }

  private consentRevoked(tenantId: string, consentId: string): boolean {
    const key = this.consentKey(tenantId, consentId);
    const expiresAt = this.revokedConsents.get(key) ?? 0;
    if (expiresAt <= this.nowMs()) {
      this.revokedConsents.delete(key);
      return false;
    }
    return true;
  }

  private consentKey(tenantId: string, consentId: string): string {
    return `${tenantId}\u0000${consentId}`;
  }

  private claimRevocationWork(key: string, visibilityTimeoutMs: number): ConsentRevocationWorkClaim | null {
    const work = this.revocationWork.get(key);
    const now = this.nowMs();
    if (!work || work.expiresAt <= now || work.dueAt > now || (work.token && (work.claimUntil ?? 0) > now)) return null;
    work.token = id('revoke-claim');
    work.claimUntil = now + positiveVisibility(visibilityTimeoutMs);
    work.dueAt = work.claimUntil;
    return {
      digest: key,
      token: work.token,
      tenantId: work.tenantId,
      consentId: work.consentId,
      cursor: work.cursor,
    };
  }

  private async scanRevocationWork(
    claim: ConsentRevocationWorkClaim,
    visibilityTimeoutMs: number,
    batchLimit: number,
  ): Promise<ConsentConnectClaims> {
    const work = this.revocationWork.get(claim.digest);
    if (!work || work.token !== claim.token) return { claims: [], pending: 1 };
    const all = [...this.records.entries()]
      .filter(([, record]) => record.session.tenantId === claim.tenantId && record.session.consentId === claim.consentId)
      .map(([connectId]) => connectId)
      .sort();
    const afterCursor = claim.cursor ? all.filter((connectId) => connectId > claim.cursor) : all;
    const page = afterCursor.slice(0, Math.max(1, Math.min(500, Math.floor(batchLimit))));
    const claims: ConnectSessionClaim[] = [];
    let pending = 0;
    for (const connectId of page) {
      const result = await this.claimForSystem(connectId, claim.tenantId, 'cancel', visibilityTimeoutMs);
      if (result.status === 'claimed') claims.push(result.claim);
      else if (result.status === 'busy') pending += 1;
    }
    const hasMore = page.length > 0 && afterCursor.length > page.length;
    work.cursor = hasMore ? page[page.length - 1]! : '';
    work.dueAt = hasMore ? this.nowMs() : this.nowMs() + positiveVisibility(visibilityTimeoutMs);
    delete work.token;
    delete work.claimUntil;
    return { claims, pending, work: claim };
  }

  private toClaim(
    connectId: string,
    record: {
      session: DurableConnectSession;
      claim?: { token: string; action: ConnectSessionAction; until: number };
      confirmation?: ConnectConfirmationWork;
    },
  ): ConnectSessionClaim {
    if (!record.claim) throw new Error('connect session is not claimed');
    return {
      connectId,
      token: record.claim.token,
      action: record.claim.action,
      session: structuredClone(record.session),
      ...(record.confirmation ? { confirmation: structuredClone(record.confirmation) } : {}),
    };
  }
}

export interface ConnectSessionRedis {
  set(key: string, value: string, mode: 'PX', ttlMs: number): Promise<unknown>;
  eval(script: string, numberOfKeys: number, ...args: string[]): Promise<unknown>;
  smembers(key: string): Promise<string[]>;
  srem(key: string, member: string): Promise<unknown>;
  scard(key: string): Promise<number>;
  sscan(key: string, cursor: string, count: 'COUNT', limit: number): Promise<[string, string[]]>;
  zrangebyscore(
    key: string,
    min: string | number,
    max: string | number,
    limit: 'LIMIT',
    offset: number,
    count: number,
  ): Promise<string[]>;
}

const PUT_INDEXED_CONNECT_SESSION_LUA = `
-- put-indexed-connect-session
if #KEYS == 3 and redis.call('EXISTS', KEYS[3]) == 1 then
  return '__consent_revoked__'
end
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
redis.call('SADD', KEYS[2], ARGV[3])
local currentTtl = redis.call('PTTL', KEYS[2])
if currentTtl < tonumber(ARGV[2]) then
  redis.call('PEXPIRE', KEYS[2], ARGV[2])
end
return 'OK'
`;

const BEGIN_CONSENT_REVOCATION_LUA = `
-- begin-consent-revocation
redis.call('SET', KEYS[1], '1', 'PX', ARGV[1])
if redis.call('EXISTS', KEYS[2]) == 0 then
  redis.call('SET', KEYS[2], ARGV[2], 'PX', ARGV[1])
else
  local currentTtl = redis.call('PTTL', KEYS[2])
  if currentTtl < tonumber(ARGV[1]) then redis.call('PEXPIRE', KEYS[2], ARGV[1]) end
end
if not redis.call('ZSCORE', KEYS[3], ARGV[3]) then
  redis.call('ZADD', KEYS[3], ARGV[4], ARGV[3])
end
return 'OK'
`;

const RESTORE_CANCEL_CONNECT_SESSION_LUA = `
-- restore-cancel-connect-session
local value = cjson.decode(ARGV[1])
value.cancelRequested = true
value.claimToken = ARGV[2]
value.claimAction = 'cancel'
value.claimUntil = tonumber(ARGV[3])
redis.call('SET', KEYS[1], cjson.encode(value), 'PX', ARGV[4])
redis.call('ZADD', KEYS[2], ARGV[3], ARGV[5])
return 'OK'
`;

const CLAIM_CONSENT_REVOCATION_LUA = `
-- claim-consent-revocation
local raw = redis.call('GET', KEYS[1])
if not raw then
  redis.call('ZREM', KEYS[2], ARGV[1])
  return false
end
local value = cjson.decode(raw)
local now = tonumber(ARGV[2])
if value.workToken and tonumber(value.workUntil or 0) > now then return '__busy__' end
value.workToken = ARGV[3]
value.workUntil = tonumber(ARGV[4])
local encoded = cjson.encode(value)
redis.call('SET', KEYS[1], encoded, 'KEEPTTL')
redis.call('ZADD', KEYS[2], ARGV[4], ARGV[1])
return encoded
`;

const ADVANCE_CONSENT_REVOCATION_LUA = `
-- advance-consent-revocation
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local value = cjson.decode(raw)
if value.workToken ~= ARGV[1] then return 0 end
value.cursor = ARGV[2]
value.workToken = nil
value.workUntil = nil
redis.call('SET', KEYS[1], cjson.encode(value), 'KEEPTTL')
redis.call('ZADD', KEYS[2], ARGV[3], ARGV[4])
return 1
`;

const SETTLE_CONSENT_REVOCATION_LUA = `
-- settle-consent-revocation
if redis.call('SCARD', KEYS[1]) == 0 then
  redis.call('DEL', KEYS[2])
  redis.call('ZREM', KEYS[3], ARGV[1])
  return 1
end
local raw = redis.call('GET', KEYS[2])
if not raw then
  redis.call('ZREM', KEYS[3], ARGV[1])
  return 1
end
local value = cjson.decode(raw)
if not value.workToken or tonumber(value.workUntil or 0) <= tonumber(ARGV[2]) then
  redis.call('ZADD', KEYS[3], ARGV[2], ARGV[1])
end
return 0
`;

const CLAIM_CONNECT_SESSION_LUA = `
-- claim-connect-session
local raw = redis.call('GET', KEYS[1])
if not raw then return false end
local value = cjson.decode(raw)
if value.tenantId ~= ARGV[1] then return '__ownership_mismatch__' end
local isSystem = ARGV[11] == '1'
if not isSystem then
  local isOwner = value.ownerDigest == ARGV[9]
  local tenantAdminCancel = ARGV[2] == 'cancel' and ARGV[10] == '1'
  if not isOwner and not tenantAdminCancel then return '__ownership_mismatch__' end
end
if ARGV[2] == 'cancel' then value.cancelRequested = true end
if value.handedOff and ARGV[2] == 'confirm' then
  if ARGV[12] ~= '1' or value.cancelRequested then return '__handed_off__' end
  value.handedOff = nil
  value.confirmSearchId = nil
  value.confirmCreatedAt = nil
end
local now = tonumber(ARGV[4])
if value.claimToken and tonumber(value.claimUntil or 0) > now then
  redis.call('SET', KEYS[1], cjson.encode(value), 'KEEPTTL')
  return '__busy__'
end
local action = ARGV[2]
if value.cancelRequested then action = 'cancel' end
if action == 'confirm' and not value.confirmSearchId then
  if ARGV[6] == '' or ARGV[7] == '' then return '__missing_confirmation_work__' end
  value.confirmSearchId = ARGV[6]
  value.confirmCreatedAt = ARGV[7]
end
value.claimToken = ARGV[3]
value.claimAction = action
value.claimUntil = tonumber(ARGV[5])
local encoded = cjson.encode(value)
redis.call('SET', KEYS[1], encoded, 'KEEPTTL')
redis.call('ZADD', KEYS[2], ARGV[5], ARGV[8])
return encoded
`;

const ACK_CONNECT_SESSION_LUA = `
-- ack-connect-session
local raw = redis.call('GET', KEYS[1])
if not raw then
  redis.call('ZREM', KEYS[2], ARGV[3])
  return 0
end
local value = cjson.decode(raw)
if value.tenantId ~= ARGV[1] or value.claimToken ~= ARGV[2] then return 0 end
if ARGV[4] == 'confirm' then
  value.handedOff = true
  if value.cancelRequested then
    value.claimAction = 'cancel'
    value.claimUntil = tonumber(ARGV[5])
    redis.call('SET', KEYS[1], cjson.encode(value), 'KEEPTTL')
    redis.call('ZADD', KEYS[2], ARGV[5], ARGV[3])
  else
    value.claimToken = nil
    value.claimAction = nil
    value.claimUntil = nil
    redis.call('SET', KEYS[1], cjson.encode(value), 'KEEPTTL')
    redis.call('ZREM', KEYS[2], ARGV[3])
  end
  return 1
end
redis.call('DEL', KEYS[1])
redis.call('ZREM', KEYS[2], ARGV[3])
if #KEYS == 3 then redis.call('SREM', KEYS[3], ARGV[3]) end
return 1
`;

const DEFER_CONNECT_SESSION_LUA = `
-- defer-connect-session
local raw = redis.call('GET', KEYS[1])
if not raw then
  redis.call('ZREM', KEYS[2], ARGV[4])
  return 0
end
local value = cjson.decode(raw)
if value.tenantId ~= ARGV[1] or value.claimToken ~= ARGV[2] then return 0 end
value.claimUntil = tonumber(ARGV[3])
redis.call('SET', KEYS[1], cjson.encode(value), 'KEEPTTL')
redis.call('ZADD', KEYS[2], ARGV[3], ARGV[4])
return 1
`;

const CHECK_CONNECT_CLAIM_STATE_LUA = `
-- check-connect-claim-state
local raw = redis.call('GET', KEYS[1])
if not raw then return -1 end
local value = cjson.decode(raw)
if value.tenantId ~= ARGV[1] then return -1 end
if value.cancelRequested then return 1 end
if value.claimToken ~= ARGV[2] then return -1 end
return 0
`;

const RENEW_CONNECT_SESSION_LUA = `
-- renew-connect-session
local raw = redis.call('GET', KEYS[1])
if not raw then return -1 end
local value = cjson.decode(raw)
if value.tenantId ~= ARGV[1] or value.claimToken ~= ARGV[2] then return -1 end
value.claimUntil = tonumber(ARGV[3])
redis.call('SET', KEYS[1], cjson.encode(value), 'KEEPTTL')
redis.call('ZADD', KEYS[2], ARGV[3], ARGV[4])
if value.cancelRequested and ARGV[5] == 'confirm' then return 1 end
return 0
`;

const RECLAIM_EXPIRED_CONNECT_SESSION_LUA = `
-- reclaim-expired-connect-session
local raw = redis.call('GET', KEYS[1])
if not raw then
  redis.call('ZREM', KEYS[2], ARGV[1])
  return false
end
local value = cjson.decode(raw)
local now = tonumber(ARGV[2])
if not value.claimToken then
  redis.call('ZREM', KEYS[2], ARGV[1])
  return false
end
if tonumber(value.claimUntil or 0) > now then return false end
if value.cancelRequested then value.claimAction = 'cancel' end
if value.claimAction ~= 'confirm' and value.claimAction ~= 'cancel' then
  redis.call('ZREM', KEYS[2], ARGV[1])
  return false
end
value.claimToken = ARGV[3]
value.claimUntil = tonumber(ARGV[4])
local encoded = cjson.encode(value)
redis.call('SET', KEYS[1], encoded, 'KEEPTTL')
redis.call('ZADD', KEYS[2], ARGV[4], ARGV[1])
return encoded
`;

/** Redis TTL storage shared across API replicas; claims are atomic, leased, and recoverable. */
export class RedisConnectSessionRegistry implements ConnectSessionRegistry {
  constructor(
    private readonly redis: ConnectSessionRedis,
    private readonly keyPrefix = 'sentinel:connect-session',
    private readonly nowMs: () => number = () => Date.now(),
    private readonly encryptor: EnvelopeCrypto,
    private readonly reuseWarmSessions = false,
  ) {}

  async put(connectId: string, session: DurableConnectSession): Promise<void> {
    await this.write(connectId, session, true);
  }

  async restoreCancellation(connectId: string, session: DurableConnectSession): Promise<void> {
    const ttlMs = Date.parse(session.expiresAt) - this.nowMs();
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error('connect session expiry must be in the future');
    const ownerDigest = this.ownerDigest(session.tenantId, session.ownerUserId);
    const value = {
      tenantId: session.tenantId,
      ownerDigest,
      encryptedSession: await this.encryptor.encrypt(JSON.stringify(session)),
    };
    await this.redis.eval(
      RESTORE_CANCEL_CONNECT_SESSION_LUA,
      2,
      this.key(connectId),
      this.claimsKey(),
      JSON.stringify(value),
      id('claim'),
      String(this.nowMs()),
      String(ttlMs),
      connectId,
    );
  }

  private async write(connectId: string, session: DurableConnectSession, enforceConsentTombstone: boolean): Promise<void> {
    const ttlMs = Date.parse(session.expiresAt) - this.nowMs();
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error('connect session expiry must be in the future');
    const ownerDigest = this.ownerDigest(session.tenantId, session.ownerUserId);
    const value = {
      tenantId: session.tenantId,
      ownerDigest,
      encryptedSession: await this.encryptor.encrypt(JSON.stringify(session)),
    };
    const serialized = JSON.stringify(value);
    if (session.consentId) {
      const indexKey = this.consentKey(session.tenantId, session.consentId);
      // The handoff and reverse-consent index must become visible together. A process crash
      // between two standalone writes would otherwise strand a live Steel session that consent
      // revocation could no longer discover.
      const keys = [this.key(connectId), indexKey];
      if (enforceConsentTombstone) keys.push(this.consentTombstoneKey(session.tenantId, session.consentId));
      const result = await this.redis.eval(
        PUT_INDEXED_CONNECT_SESSION_LUA,
        keys.length,
        ...keys,
        serialized,
        String(ttlMs),
        connectId,
      );
      if (result === '__consent_revoked__') throw consentRevokedError();
      return;
    }
    await this.redis.set(this.key(connectId), serialized, 'PX', ttlMs);
  }

  async markConsentRevoked(consentId: string, tenantId: string, ttlMs: number): Promise<void> {
    const digest = this.consentDigest(tenantId, consentId);
    const value = {
      tenantId,
      encryptedConsentId: await this.encryptor.encrypt(consentId),
      cursor: '0',
    };
    await this.redis.eval(
      BEGIN_CONSENT_REVOCATION_LUA,
      3,
      this.consentTombstoneKey(tenantId, consentId),
      this.revocationWorkKey(digest),
      this.revocationsKey(),
      String(ttlMs),
      JSON.stringify(value),
      digest,
      String(this.nowMs()),
    );
  }

  async claim(
    connectId: string,
    principal: ConnectSessionPrincipal,
    action: ConnectSessionAction,
    visibilityTimeoutMs: number,
    confirmation?: ConnectConfirmationWork,
  ): Promise<ConnectSessionClaimResult> {
    return this.claimAuthorized(connectId, principal.tenantId, action, visibilityTimeoutMs, confirmation, principal);
  }

  async claimForSystem(
    connectId: string,
    tenantId: string,
    action: ConnectSessionAction,
    visibilityTimeoutMs: number,
    confirmation?: ConnectConfirmationWork,
  ): Promise<ConnectSessionClaimResult> {
    return this.claimAuthorized(connectId, tenantId, action, visibilityTimeoutMs, confirmation);
  }

  private async claimAuthorized(
    connectId: string,
    tenantId: string,
    action: ConnectSessionAction,
    visibilityTimeoutMs: number,
    confirmation?: ConnectConfirmationWork,
    principal?: ConnectSessionPrincipal,
  ): Promise<ConnectSessionClaimResult> {
    const now = this.nowMs();
    const token = id('claim');
    const raw = await this.redis.eval(
      CLAIM_CONNECT_SESSION_LUA,
      2,
      this.key(connectId),
      this.claimsKey(),
      tenantId,
      action,
      token,
      String(now),
      String(now + positiveVisibility(visibilityTimeoutMs)),
      confirmation?.searchId ?? '',
      confirmation?.createdAt ?? '',
      connectId,
      principal ? this.ownerDigest(principal.tenantId, principal.actorUserId) : '',
      principal?.allowTenantAdmin ? '1' : '0',
      principal ? '0' : '1',
      this.reuseWarmSessions ? '1' : '0',
    );
    if (raw === '__ownership_mismatch__') return { status: 'ownership-mismatch' };
    if (raw === '__busy__') return { status: 'busy' };
    if (raw === '__handed_off__') return { status: 'not-found' };
    if (raw === '__missing_confirmation_work__') throw new Error('confirmation claim requires stable search work');
    if (typeof raw !== 'string' || raw.length === 0) return { status: 'not-found' };
    const claim = await this.parseStoredClaim(connectId, raw);
    return claim ? { status: 'claimed', claim } : { status: 'not-found' };
  }

  async ack(claim: ConnectSessionClaim): Promise<boolean> {
    const keys = [this.key(claim.connectId), this.claimsKey()];
    if (claim.session.consentId) keys.push(this.consentKey(claim.session.tenantId, claim.session.consentId));
    const result = await this.redis.eval(
      ACK_CONNECT_SESSION_LUA,
      keys.length,
      ...keys,
      claim.session.tenantId,
      claim.token,
      claim.connectId,
      claim.action,
      String(this.nowMs()),
    );
    return Number(result) === 1;
  }

  async defer(claim: ConnectSessionClaim): Promise<boolean> {
    const result = await this.redis.eval(
      DEFER_CONNECT_SESSION_LUA,
      2,
      this.key(claim.connectId),
      this.claimsKey(),
      claim.session.tenantId,
      claim.token,
      String(this.nowMs()),
      claim.connectId,
    );
    return Number(result) === 1;
  }

  async renew(claim: ConnectSessionClaim, visibilityTimeoutMs: number): Promise<ConnectClaimState> {
    const result = await this.redis.eval(
      RENEW_CONNECT_SESSION_LUA,
      2,
      this.key(claim.connectId),
      this.claimsKey(),
      claim.session.tenantId,
      claim.token,
      String(this.nowMs() + positiveVisibility(visibilityTimeoutMs)),
      claim.connectId,
      claim.action,
    );
    if (Number(result) === 1) return 'cancelled';
    if (Number(result) === 0) return 'active';
    return 'lost';
  }

  async claimState(claim: ConnectSessionClaim): Promise<ConnectClaimState> {
    const result = await this.redis.eval(
      CHECK_CONNECT_CLAIM_STATE_LUA,
      1,
      this.key(claim.connectId),
      claim.session.tenantId,
      claim.token,
    );
    if (Number(result) === 1) return 'cancelled';
    if (Number(result) === 0) return 'active';
    return 'lost';
  }

  async claimByConsent(
    consentId: string,
    tenantId: string,
    visibilityTimeoutMs: number,
    batchLimit = 100,
  ): Promise<ConsentConnectClaims> {
    const digest = this.consentDigest(tenantId, consentId);
    const work = await this.claimConsentRevocationWork(digest, visibilityTimeoutMs);
    if (!work) return { claims: [], pending: 1 };
    return this.scanConsentRevocationWork(work, sessionBatchLimit(batchLimit), visibilityTimeoutMs);
  }

  async claimDueConsentRevocations(
    workLimit: number,
    sessionLimit: number,
    visibilityTimeoutMs: number,
  ): Promise<ConsentConnectClaims[]> {
    const boundedWorkLimit = Math.max(0, Math.min(100, Math.floor(workLimit)));
    if (boundedWorkLimit === 0) return [];
    const now = this.nowMs();
    const digests = await this.redis.zrangebyscore(this.revocationsKey(), '-inf', now, 'LIMIT', 0, boundedWorkLimit);
    const batches: ConsentConnectClaims[] = [];
    for (const digest of digests) {
      const work = await this.claimConsentRevocationWork(digest, visibilityTimeoutMs);
      if (work) batches.push(await this.scanConsentRevocationWork(work, sessionBatchLimit(sessionLimit), visibilityTimeoutMs));
    }
    return batches;
  }

  async settleConsentRevocation(work: ConsentRevocationWorkClaim): Promise<boolean> {
    const result = await this.redis.eval(
      SETTLE_CONSENT_REVOCATION_LUA,
      3,
      this.consentKey(work.tenantId, work.consentId),
      this.revocationWorkKey(work.digest),
      this.revocationsKey(),
      work.digest,
      String(this.nowMs()),
    );
    return Number(result) === 1;
  }

  private async scanConsentRevocationWork(
    work: ConsentRevocationWorkClaim,
    batchLimit: number,
    visibilityTimeoutMs: number,
  ): Promise<ConsentConnectClaims> {
    const indexKey = this.consentKey(work.tenantId, work.consentId);
    const [nextCursor, connectIds] = await this.redis.sscan(indexKey, work.cursor, 'COUNT', batchLimit);
    const claims: ConnectSessionClaim[] = [];
    let pending = 0;
    for (const connectId of connectIds) {
      const result = await this.claimForSystem(connectId, work.tenantId, 'cancel', visibilityTimeoutMs);
      if (result.status === 'claimed') claims.push(result.claim);
      else if (result.status === 'busy') pending += 1;
      else if (result.status === 'not-found') await this.redis.srem(indexKey, connectId);
    }
    const dueAt = nextCursor === '0' ? this.nowMs() + positiveVisibility(visibilityTimeoutMs) : this.nowMs();
    const advanced = await this.redis.eval(
      ADVANCE_CONSENT_REVOCATION_LUA,
      2,
      this.revocationWorkKey(work.digest),
      this.revocationsKey(),
      work.token,
      nextCursor,
      String(dueAt),
      work.digest,
    );
    if (Number(advanced) !== 1) pending += 1;
    return { claims, pending, work };
  }

  async claimExpired(limit: number, visibilityTimeoutMs: number): Promise<ConnectSessionClaim[]> {
    const boundedLimit = Math.max(0, Math.min(500, Math.floor(limit)));
    if (boundedLimit === 0) return [];
    const now = this.nowMs();
    const connectIds = await this.redis.zrangebyscore(this.claimsKey(), '-inf', now, 'LIMIT', 0, boundedLimit);
    const claims: ConnectSessionClaim[] = [];
    for (const connectId of connectIds) {
      const raw = await this.redis.eval(
        RECLAIM_EXPIRED_CONNECT_SESSION_LUA,
        2,
        this.key(connectId),
        this.claimsKey(),
        connectId,
        String(now),
        id('claim'),
        String(now + positiveVisibility(visibilityTimeoutMs)),
      );
      if (typeof raw !== 'string' || raw.length === 0) continue;
      const claim = await this.parseStoredClaim(connectId, raw);
      if (claim) claims.push(claim);
    }
    return claims;
  }

  private key(connectId: string): string { return `${this.keyPrefix}:${connectId}`; }
  private claimsKey(): string { return `${this.keyPrefix}:claims`; }
  private revocationsKey(): string { return `${this.keyPrefix}:revoked-consent-work`; }
  private revocationWorkKey(digest: string): string { return `${this.keyPrefix}:revoked-consent-work:${digest}`; }
  private consentDigest(tenantId: string, consentId: string): string {
    return createHash('sha256').update(`${tenantId}\u0000${consentId}`).digest('hex');
  }
  private ownerDigest(tenantId: string, ownerUserId: string): string {
    return createHash('sha256').update(`${tenantId}\u0000${ownerUserId}`).digest('hex');
  }
  private consentKey(tenantId: string, consentId: string): string {
    return `${this.keyPrefix}:by-consent:${this.consentDigest(tenantId, consentId)}`;
  }
  private consentTombstoneKey(tenantId: string, consentId: string): string {
    return `${this.keyPrefix}:revoked-consent:${this.consentDigest(tenantId, consentId)}`;
  }

  private async claimConsentRevocationWork(
    digest: string,
    visibilityTimeoutMs: number,
  ): Promise<ConsentRevocationWorkClaim | null> {
    const now = this.nowMs();
    const token = id('revoke-claim');
    const raw = await this.redis.eval(
      CLAIM_CONSENT_REVOCATION_LUA,
      2,
      this.revocationWorkKey(digest),
      this.revocationsKey(),
      digest,
      String(now),
      token,
      String(now + positiveVisibility(visibilityTimeoutMs)),
    );
    if (raw === '__busy__' || typeof raw !== 'string' || raw.length === 0) return null;
    return this.parseConsentRevocationWork(digest, raw, token);
  }

  private async parseConsentRevocationWork(
    digest: string,
    raw: string,
    token: string,
  ): Promise<ConsentRevocationWorkClaim | null> {
    try {
      const value = JSON.parse(raw) as {
        tenantId?: unknown;
        consentId?: unknown;
        encryptedConsentId?: unknown;
        cursor?: unknown;
        workToken?: unknown;
      };
      if (typeof value.tenantId !== 'string' || typeof value.cursor !== 'string' || value.workToken !== token) return null;
      let consentId: string;
      if (typeof value.encryptedConsentId === 'string') {
        consentId = await this.encryptor.decrypt(value.encryptedConsentId);
      } else throw new Error('refusing unencrypted consent revocation work');
      if (this.consentDigest(value.tenantId, consentId) !== digest) throw new Error('consent revocation work digest mismatch');
      return { digest, token, tenantId: value.tenantId, consentId, cursor: value.cursor };
    } catch (err) {
      if (err instanceof SyntaxError) return null;
      throw err;
    }
  }

  private async parseStoredSession(raw: string): Promise<DurableConnectSession | null> {
    try {
      const value = JSON.parse(raw) as {
        tenantId?: unknown;
        ownerDigest?: unknown;
        encryptedSession?: unknown;
      };
      if (typeof value.encryptedSession === 'string') {
        if (typeof value.tenantId !== 'string' || typeof value.ownerDigest !== 'string') {
          throw new Error('encrypted connect session is missing its authorization binding');
        }
        const session = parseDurableConnectSession(await this.encryptor.decrypt(value.encryptedSession));
        if (
          !session
          || session.tenantId !== value.tenantId
          || this.ownerDigest(session.tenantId, session.ownerUserId) !== value.ownerDigest
        ) {
          throw new Error('encrypted connect session authorization binding mismatch');
        }
        return session;
      }
      throw new Error('refusing unencrypted durable connect session');
    } catch (err) {
      if (err instanceof SyntaxError) return null;
      throw err;
    }
  }

  private async parseStoredClaim(connectId: string, raw: string): Promise<ConnectSessionClaim | null> {
    let value: {
      claimToken?: unknown;
      claimAction?: unknown;
      confirmSearchId?: unknown;
      confirmCreatedAt?: unknown;
    };
    try {
      value = JSON.parse(raw) as typeof value;
    } catch {
      return null;
    }
    const session = await this.parseStoredSession(raw);
    if (
      !session
      || typeof value.claimToken !== 'string'
      || (value.claimAction !== 'confirm' && value.claimAction !== 'cancel')
    ) return null;
    const confirmation = typeof value.confirmSearchId === 'string' && typeof value.confirmCreatedAt === 'string'
      ? { searchId: value.confirmSearchId, createdAt: value.confirmCreatedAt }
      : undefined;
    return {
      connectId,
      token: value.claimToken,
      action: value.claimAction,
      session,
      ...(confirmation ? { confirmation } : {}),
    };
  }
}

export interface DistributorConnectProviderFactory {
  steel(env: NodeJS.ProcessEnv, encryptor: EnvelopeCrypto): BrowserLinkProvider | null;
  /** Explicit composition/test seam. Production startup still enforces an AWS KMS provider. */
  encryptor?: EnvelopeCrypto;
}

const DEFAULT_PROVIDER_FACTORY: DistributorConnectProviderFactory = {
  steel: (env, encryptor) => createCloudLiveProvider(env, encryptor),
};

/**
 * "Connect distributor & scan", the one-click automation. The user logs into their
 * distributor inside an interactive Steel session; we then
 * read their real catalogue over that same session and scan it against the stores.
 *
 * Execution is Steel-only in every runtime.
 */
export class DistributorConnect {
  private readonly encryptor: EnvelopeCrypto;
  private readonly sessionRegistry: ConnectSessionRegistry;

  constructor(
    private readonly store: SearchStore,
    private readonly env: NodeJS.ProcessEnv = process.env,
    /** Kick off the background multi-platform deep scan for the saved search (optional). */
    private readonly enqueueDeepScan?: (searchId: string, tenantId: string) => Promise<void>,
    /** Removed single-job dispatch slot; retained temporarily to preserve construction order. */
    _removedSingleJobDispatch?: undefined,
    /** Records SANITIZED endpoint candidates observed during the read (admin API surfaces them). */
    private readonly candidateSink?: CandidateSink,
    /** Starts the sole NETWORK-FIRST six-stage pipeline (`distrokid-catalog-index`). It is
     * release-chunked, checkpointed and resumable, with per-field completeness reporting. */
    private readonly startSnapshot?: (job: CatalogIndexJob) => Promise<{ jobId: string; accepted: true }>,
    sessionRegistry?: ConnectSessionRegistry,
    private readonly providerFactory: DistributorConnectProviderFactory = DEFAULT_PROVIDER_FACTORY,
    /** Durable post-create consent check closes the authorize/create/revoke race. */
    private readonly assertConsentStillActive?: (binding: ConnectConsentBinding) => Promise<void>,
    /** Process-wide envelope provider; production composition injects its verified KMS instance. */
    envelopeEncryptor?: EnvelopeCrypto,
    /** Re-check durable workspace authority immediately before creating a scan record. */
    private readonly authorizeWorkspaceEdit?: (binding: {
      tenantId: string;
      subjectId: string;
      workspaceId: string;
    }) => Promise<boolean>,
  ) {
    if (!sessionRegistry) throw new Error('A durable connect-session registry is required.');
    this.sessionRegistry = sessionRegistry;
    this.encryptor = envelopeEncryptor ?? providerFactory.encryptor ?? envelopeEncryptorFromEnv(env);
  }

  /** Start an attended login: returns a URL to complete the login (an embeddable
   *  cloud-browser live URL in production). */
  async start(
    distributor: string,
    artists: string[],
    binding: {
      tenantId: string;
      ownerUserId: string;
      consentId?: string;
      artistWorkspaceId: string;
    },
  ): Promise<{ connectId: string; loginUrl: string; expiresAt: string; embedded: boolean; provider: string }> {
    const { tenantId, ownerUserId, consentId, artistWorkspaceId } = binding;
    if (!tenantId.trim() || !ownerUserId.trim() || !artistWorkspaceId.trim()) {
      throw new Error('A tenant, initiating subject, and consent-bound artist workspace are required.');
    }
    if (distributor.trim().toLowerCase() !== 'distrokid') {
      throw new Error('Only DistroKid attended connections are supported.');
    }
    if (!consentId) throw new Error('A durable consent binding is required for a Steel session.');
    const encryptor = this.encryptor;
    const provider = this.providerFactory.steel(this.env, encryptor);
    if (!provider) {
      throw new BrowserLinkUnavailableError(
        'steel',
        'Steel is required for attended distributor login. Configure Steel cloud, external, or self-hosted.',
      );
    }
    if (provider.provider !== 'steel') throw new BrowserLinkUnavailableError('steel', 'Provider factory returned a non-Steel provider.');
    assertDistroKidLiveScannerAllowed(this.env);
    if (!this.startSnapshot) {
      throw new BrowserLinkUnavailableError('steel', 'The durable DistroKid pipeline is unavailable; refusing to start an attended session.');
    }
    if (!this.assertConsentStillActive) {
      throw new BrowserLinkUnavailableError(
        'steel',
        'The durable consent validator is unavailable; refusing to create an attended Steel session.',
      );
    }

    // Ask Steel for the operator-configured lease, not a hard-coded 20-minute window. The
    // network-first pipeline deliberately keeps this same authenticated session through index,
    // chunks, retries, and finalization; silently capping it here made every larger-catalogue
    // timeout setting ineffective even though the provider was configured correctly.
    const sessionTtlMinutes = attendedSessionTtlMinutes(this.env);
    const session = await provider.createSession({
      tenantId,
      artistWorkspaceId,
      distributor,
      targetLoginUrl: signInUrl(distributor),
      ttlMinutes: sessionTtlMinutes,
    });
    let access: Awaited<ReturnType<BrowserLinkProvider['createUserAccessUrl']>>;
    let steelSessionId: string | null;
    try {
      access = await provider.createUserAccessUrl(session.sessionId, { ttlMinutes: sessionTtlMinutes });
      steelSessionId = await provider.getRemoteSessionId?.(session.sessionId) ?? null;
    } catch {
      await provider.terminateSession(session.sessionId).catch(() => undefined);
      throw new BrowserLinkUnavailableError('steel', 'Could not secure the Steel session for durable handoff.');
    }
    const connectId = id('connect');
    if (!steelSessionId) {
      await provider.terminateSession(session.sessionId).catch(() => undefined);
      throw new BrowserLinkUnavailableError('steel', 'Steel did not expose a remote session for durable handoff.');
    }
    const durableSession: DurableConnectSession = {
      tenantId,
      ownerUserId,
      artists: [...artists],
      distributor: 'distrokid',
      steelSessionId,
      consentId,
      artistWorkspaceId,
      expiresAt: session.expiresAt,
    };
    let registered = false;
    try {
      await this.sessionRegistry.put(connectId, durableSession);
      registered = true;
      await this.assertConsentStillActive!({
        tenantId,
        ownerUserId,
        consentId,
        artistWorkspaceId,
        distributor: 'distrokid',
        sessionExpiresAt: session.expiresAt,
      });
    } catch (err) {
      let cleanupClaim: ConnectSessionClaim | null = null;
      if (registered) {
        const result = await this.sessionRegistry.claimForSystem(
          connectId,
          tenantId,
          'cancel',
          connectClaimVisibilityMs(this.env),
        ).catch(() => ({ status: 'not-found' as const }));
        cleanupClaim = result.status === 'claimed' ? result.claim : null;
      }
      if (!registered || cleanupClaim) {
        try {
          await provider.terminateSession(session.sessionId);
          if (cleanupClaim) await this.sessionRegistry.ack(cleanupClaim);
        } catch (cleanupError) {
          if (!registered) {
            await this.sessionRegistry.restoreCancellation(connectId, durableSession).catch(() => undefined);
          } else if (cleanupClaim) {
            await this.sessionRegistry.defer(cleanupClaim).catch(() => undefined);
          }
          throw cleanupError;
        }
      }
      throw err;
    }
    // The user continues in Steel's viewer; API-local Playwright ownership is no longer needed.
    await provider.detachLocalSession?.(session.sessionId);
    return {
      connectId,
      loginUrl: access.url,
      expiresAt: access.expiresAt,
      embedded: /^https?:/i.test(access.url),
      provider: provider.provider,
    };
  }

  /**
   * After the user confirms login: persist a PENDING search immediately, return its id, and
   * run the catalogue read + scan in the BACKGROUND. Reading a real catalogue means visiting
   * each release's detail page over a remote browser, that can take minutes, far longer than
   * an HTTP request should ever block (a synchronous version times the proxy out → 500). The
   * catalogue page polls this record and fills in live when the background read completes.
   */
  async confirmAndScan(connectId: string, principal: ConnectSessionPrincipal): Promise<{ searchId: string; tracksRead: number; reading: boolean }> {
    const proposedWork: ConnectConfirmationWork = { searchId: id('search'), createdAt: new Date().toISOString() };
    const durable = await this.sessionRegistry.claim(
      connectId,
      principal,
      'confirm',
      connectClaimVisibilityMs(this.env),
      proposedWork,
    );
    // The connect id alone must NOT be authorization. It travels in a URL path, browser history,
    // referrers, proxy logs, so treating possession as permission would let anyone who saw it
    // consume a live, logged-in distributor session and read that account's catalogue.
    if (durable.status === 'ownership-mismatch') {
      const err = new Error('connect session belongs to another tenant');
      err.name = 'ConnectSessionOwnershipError';
      throw err;
    }
    if (durable.status === 'busy') throw connectSessionBusyError();
    if (durable.status === 'not-found') throw new Error('unknown or expired connect session');
    const liveClaim = durable.claim;
    if (liveClaim.action === 'cancel') {
      await this.completeCancellation(liveClaim);
      throw new Error('unknown or expired connect session');
    }
    const live = liveClaim.session;
    try {
      if (this.authorizeWorkspaceEdit && !await this.authorizeWorkspaceEdit({
        tenantId: live.tenantId,
        subjectId: principal.actorUserId,
        workspaceId: live.artistWorkspaceId,
      })) {
        const error = new Error('workspace access was revoked before scan creation');
        error.name = 'ConnectWorkspaceAuthorizationError';
        throw error;
      }
      assertSufficientAutomationBudget(live.expiresAt, this.env);
      await this.assertClaimActive(liveClaim);
    } catch (err) {
      if (isTerminalConnectClaimError(err)) await this.completeCancellation(liveClaim);
      else await this.sessionRegistry.defer(liveClaim).catch(() => undefined);
      throw err;
    }
    const artists = live.artists;
    const distributor = live.distributor;
    const tenantId = live.tenantId;
    const ownerUserId = live.ownerUserId;
    const artistWorkspaceId = live.artistWorkspaceId;
    const artistLabel = artists.join(', ');
    let rec: SearchRecord;
    try {
      if (!liveClaim.confirmation) throw new Error('confirmation claim is missing stable search work');
      rec = {
        id: liveClaim.confirmation.searchId,
        revision: 1,
        tenantId,
        ownerUserId,
        artistWorkspaceId,
        createdAt: liveClaim.confirmation.createdAt,
        artist: artistLabel,
        distributor,
        platforms: [],
        song: null,
        result: readingResult(artistLabel, distributor, liveClaim.confirmation.createdAt),
        released: [],
      };
      await this.store.put(rec);
    } catch (err) {
      await this.sessionRegistry.defer(liveClaim).catch(() => undefined);
      throw err;
    }
    console.info(`[connect] search ${rec.id} created (reading ${distributor} catalogue for ${artists.length} artist(s))`);

    // Live Steel always enters the durable network-first pipeline. The worker keeps the remote
    // session through index/chunks and releases it only after terminal persistence.
    try {
        await this.assertClaimActive(liveClaim);
        const res = await this.startSnapshot!({
          tenantId,
          // The lock this keys is "one concurrent catalogue read per distributor account". We
          // never store account credentials, so tenant+distributor is the strongest identifier
          // available, it errs toward serializing, which is the rate-limit-safe direction.
          connectionId: `${tenantId}:${distributor}`,
          snapshotId: rec.id,
          distributor,
          artists,
          ...(live.consentId ? { consentId: live.consentId } : {}),
          artistWorkspaceId: live.artistWorkspaceId,
          sessionExpiresAt: live.expiresAt,
          // BullMQ/Redis must not contain a directly usable Steel handle. Every pipeline stage
          // carries the same envelope and the worker unwraps it only at the attach/release edge.
          steelSessionId: await this.encryptor.encrypt(live.steelSessionId),
        });
        if (!await this.sessionRegistry.ack(liveClaim)) {
          await this.assertClaimActive(liveClaim);
          throw connectSessionClaimLostError();
        }
        console.info(`[connect] ${rec.id}: started network-first pipeline (job ${res.jobId})`);
        return { searchId: rec.id, tracksRead: 0, reading: true };
    } catch (err) {
        if (isTerminalConnectClaimError(err)) await this.completeCancellation(liveClaim);
        else await this.sessionRegistry.defer(liveClaim).catch(() => undefined);
        throw new BrowserLinkUnavailableError('steel', `Could not enqueue the durable Steel scan: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Cancel an unconsumed attended login and explicitly release its Steel session. */
  async cancel(connectId: string, principal: ConnectSessionPrincipal): Promise<void> {
    const durable = await this.sessionRegistry.claim(
      connectId,
      principal,
      'cancel',
      connectClaimVisibilityMs(this.env),
    );
    if (durable.status === 'ownership-mismatch') {
      const err = new Error('connect session belongs to another tenant');
      err.name = 'ConnectSessionOwnershipError';
      throw err;
    }
    if (durable.status === 'busy') throw connectSessionBusyError();
    if (durable.status === 'claimed') {
      try {
        await this.completeCancellation(durable.claim);
      } catch (err) {
        await this.sessionRegistry.defer(durable.claim).catch(() => undefined);
        throw err;
      }
      return;
    }
    throw new Error('unknown or expired connect session');
  }

  /** Revoke every unconfirmed browser handoff associated with a consent grant. A confirm/revoke
   * race is safe: the registry consume is atomic; if the worker won, its next consent boundary
   * observes the durable revocation and terminal cleanup releases the same Steel session. */
  async cancelByConsent(consentId: string, callerTenantId: string): Promise<number> {
    let cancelled = 0;
    // Install the tombstone before taking the reverse-index snapshot. Any in-flight creator that
    // passed the earlier Postgres consent check is then rejected atomically by registry.put.
    const tombstoneTtlMs = attendedSessionTtlMinutes(this.env) * 60_000 + 5 * 60_000;
    await this.sessionRegistry.markConsentRevoked(consentId, callerTenantId, tombstoneTtlMs);
    const durable = await this.sessionRegistry.claimByConsent(
      consentId,
      callerTenantId,
      connectClaimVisibilityMs(this.env),
      sessionBatchLimit(Number(this.env.CONNECT_CONSENT_CANCEL_BATCH_SIZE) || 100),
    );
    const releaseErrors: unknown[] = [];
    for (const claimed of durable.claims) {
      try {
        await this.completeCancellation(claimed);
        cancelled += 1;
      } catch (err) {
        await this.sessionRegistry.defer(claimed).catch(() => undefined);
        releaseErrors.push(err);
      }
    }
    if (durable.work) {
      const settled = await this.sessionRegistry.settleConsentRevocation(durable.work).catch((err) => {
        releaseErrors.push(err);
        return false;
      });
      if (!settled && releaseErrors.length === 0) {
        releaseErrors.push(new Error('Steel session cancellation reconciliation is still pending'));
      }
    }
    if (durable.pending > 0) {
      releaseErrors.push(new Error(`${durable.pending} Steel session cancellation(s) are pending claim recovery`));
    }
    if (releaseErrors.length > 0) {
      throw new AggregateError(releaseErrors, 'one or more Steel sessions could not yet be terminated');
    }
    return cancelled;
  }

  /** Recover a bounded batch abandoned by a crashed or stalled API replica. */
  async recoverAbandoned(maxClaims = 50): Promise<{ claimed: number; completed: number; failed: number }> {
    const claims = await this.sessionRegistry.claimExpired(
      Math.max(1, Math.min(500, Math.floor(maxClaims))),
      connectClaimVisibilityMs(this.env),
    );
    let completed = 0;
    let failed = 0;
    for (const claim of claims) {
      try {
        const claimState = await this.sessionRegistry.claimState(claim);
        if (claim.action === 'cancel' || claimState === 'cancelled') {
          await this.completeCancellation(claim);
        } else if (claimState === 'lost') {
          throw connectSessionClaimLostError();
        } else {
          await this.enqueueClaimedConfirmation(claim);
        }
        completed += 1;
      } catch (err) {
        if (isTerminalConnectClaimError(err)) {
          try {
            await this.completeCancellation(claim);
            completed += 1;
            continue;
          } catch {
            // Fall through: the retained claim schedules another idempotent release attempt.
          }
        }
        // The new lease stays indexed. A later sweep retries it after the visibility window,
        // avoiding both a lost handoff and a tight loop during an infrastructure outage.
        failed += 1;
      }
    }
    const revocationBatches = await this.sessionRegistry.claimDueConsentRevocations(
      Math.max(1, Math.min(20, Math.ceil(maxClaims / 10))),
      sessionBatchLimit(maxClaims),
      connectClaimVisibilityMs(this.env),
    );
    let revokedClaims = 0;
    for (const batch of revocationBatches) {
      revokedClaims += batch.claims.length;
      for (const claim of batch.claims) {
        try {
          await this.completeCancellation(claim);
          completed += 1;
        } catch {
          failed += 1;
        }
      }
      if (batch.work) {
        await this.sessionRegistry.settleConsentRevocation(batch.work).catch(() => { failed += 1; });
      }
    }
    return { claimed: claims.length + revokedClaims, completed, failed };
  }

  private async enqueueClaimedConfirmation(claim: ConnectSessionClaim): Promise<void> {
    if (claim.action !== 'confirm' || !claim.confirmation) throw connectSessionCancelledError();
    assertSufficientAutomationBudget(claim.session.expiresAt, this.env);
    await this.assertClaimActive(claim);

    const { session: live, confirmation } = claim;
    const artistLabel = live.artists.join(', ');
    const rec: SearchRecord = {
      id: confirmation.searchId,
      revision: 1,
      tenantId: live.tenantId,
      ownerUserId: live.ownerUserId,
      artistWorkspaceId: live.artistWorkspaceId,
      createdAt: confirmation.createdAt,
      artist: artistLabel,
      distributor: live.distributor,
      platforms: [],
      song: null,
      result: readingResult(artistLabel, live.distributor, confirmation.createdAt),
      released: [],
    };
    await this.store.put(rec);
    await this.assertClaimActive(claim);
    await this.startSnapshot!({
      tenantId: live.tenantId,
      connectionId: `${live.tenantId}:${live.distributor}`,
      snapshotId: rec.id,
      distributor: live.distributor,
      artists: live.artists,
      ...(live.consentId ? { consentId: live.consentId } : {}),
      artistWorkspaceId: live.artistWorkspaceId,
      sessionExpiresAt: live.expiresAt,
      steelSessionId: await this.encryptor.encrypt(live.steelSessionId),
    });
    if (!await this.sessionRegistry.ack(claim)) {
      await this.assertClaimActive(claim);
      throw connectSessionClaimLostError();
    }
  }

  private async assertClaimActive(claim: ConnectSessionClaim): Promise<void> {
    const state = await this.sessionRegistry.renew(claim, connectClaimVisibilityMs(this.env));
    if (state === 'cancelled') throw connectSessionCancelledError();
    if (state === 'lost') throw connectSessionClaimLostError();
  }

  private async completeCancellation(claim: ConnectSessionClaim): Promise<void> {
    const state = await this.sessionRegistry.renew(claim, connectClaimVisibilityMs(this.env));
    if (state === 'lost') throw connectSessionClaimLostError();
    await this.releaseSteelSession(claim.session.steelSessionId);
    await this.sessionRegistry.ack(claim);
  }

  private async releaseSteelSession(steelSessionId: string): Promise<void> {
    const provider = this.providerFactory.steel(this.env, this.encryptor);
    if (provider?.provider !== 'steel' || !provider.releaseRemoteSession) {
      throw new BrowserLinkUnavailableError('steel', 'Steel is unavailable; the session will expire at its configured TTL.');
    }
    await provider.releaseRemoteSession(steelSessionId);
  }

}

function attendedSessionTtlMinutes(env: NodeJS.ProcessEnv): number {
  const timeoutMs = Number(env.STEEL_SESSION_TIMEOUT_MS);
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) return Math.max(1, Math.ceil(timeoutMs / 60_000));
  const configuredMinutes = Number(env.BROWSER_SESSION_TTL_MINUTES);
  return Number.isFinite(configuredMinutes) && configuredMinutes > 0
    ? Math.max(1, Math.ceil(configuredMinutes))
    : 20;
}

const DEFAULT_CONNECT_CLAIM_VISIBILITY_MS = 60_000;

function positiveVisibility(value: number): number {
  return Number.isFinite(value) ? Math.max(1_000, Math.min(5 * 60_000, Math.floor(value))) : DEFAULT_CONNECT_CLAIM_VISIBILITY_MS;
}

function sessionBatchLimit(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.min(500, Math.floor(value))) : 100;
}

/**
 * Testing keep-alive: when enabled, a distributor session already handed off to a scan can be
 * re-confirmed (a warm rescan) instead of being strictly one-shot. Reuse still re-authorizes the
 * caller in `claim()` (ownership + workspace), and only the cookies-live-in-Steel reference is
 * retained, never credentials. Disabled (default) = today's one-shot behavior.
 */
export function sessionReuseEnabled(env: NodeJS.ProcessEnv): boolean {
  return /^(1|true|yes|on)$/i.test((env.DISTRIBUTOR_SESSION_REUSE ?? '').trim());
}

export function connectClaimVisibilityMs(env: NodeJS.ProcessEnv): number {
  const raw = env.CONNECT_CLAIM_VISIBILITY_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_CONNECT_CLAIM_VISIBILITY_MS;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1_000 || parsed > 5 * 60_000) {
    throw new Error('CONNECT_CLAIM_VISIBILITY_TIMEOUT_MS must be an integer between 1000 and 300000');
  }
  return parsed;
}

function configuredCatalogBudgetMs(env: NodeJS.ProcessEnv): number {
  const configured = Number(env.CATALOG_READ_MAX_DURATION_MS);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 600_000;
}

function assertSufficientAutomationBudget(sessionExpiresAt: string, env: NodeJS.ProcessEnv): void {
  const expiry = Date.parse(sessionExpiresAt);
  const required = configuredCatalogBudgetMs(env) + DISTROKID_SESSION_CLEANUP_GRACE_MS;
  if (!Number.isFinite(expiry) || expiry - Date.now() < required) {
    const error = new Error('Steel session has too little lease remaining to start a DistroKid catalogue read');
    error.name = 'ConnectSessionLeaseTooShortError';
    throw error;
  }
}

function connectSessionBusyError(): Error {
  const error = new Error('connect session operation is already in progress');
  error.name = 'ConnectSessionBusyError';
  return error;
}

function connectSessionCancelledError(): Error {
  const error = new Error('connect session cancellation was requested');
  error.name = 'ConnectSessionCancelledError';
  return error;
}

function connectSessionClaimLostError(): Error {
  const error = new Error('connect session claim ownership was lost');
  error.name = 'ConnectSessionClaimLostError';
  return error;
}

function isTerminalConnectClaimError(error: unknown): boolean {
  return error instanceof Error
    && ['ConnectSessionLeaseTooShortError', 'ConnectSessionCancelledError', 'ConnectWorkspaceAuthorizationError'].includes(error.name);
}

function parseDurableConnectSession(raw: string): DurableConnectSession | null {
  try {
    const value = JSON.parse(raw) as Partial<DurableConnectSession>;
    if (
      typeof value.tenantId !== 'string'
      || typeof value.ownerUserId !== 'string'
      || value.ownerUserId.length === 0
      || !Array.isArray(value.artists)
      || !value.artists.every((artist) => typeof artist === 'string')
      || value.distributor !== 'distrokid'
      || typeof value.steelSessionId !== 'string'
      || typeof value.artistWorkspaceId !== 'string'
      || value.artistWorkspaceId.length === 0
      || typeof value.expiresAt !== 'string'
    ) return null;
    return {
      tenantId: value.tenantId,
      ownerUserId: value.ownerUserId,
      artists: value.artists,
      distributor: 'distrokid',
      steelSessionId: value.steelSessionId,
      ...(typeof value.consentId === 'string' ? { consentId: value.consentId } : {}),
      artistWorkspaceId: value.artistWorkspaceId,
      expiresAt: value.expiresAt,
    };
  } catch {
    return null;
  }
}

/** Sentinel in a result's warnings that marks it as still being read (the UI polls on it). */
export const READING_SENTINEL = '__reading_in_progress__';

/** A placeholder result shown while the catalogue is still being read in the background. */
function readingResult(artist: string, distributor: string, generatedAt = new Date().toISOString()): CatalogScanResult {
  return {
    artist,
    stores: [],
    profiles: [],
    tracks: [],
    summary: { tracks: 0, live: 0, notLive: 0, wrongProfile: 0, needsReview: 0 },
    generatedAt,
    warnings: [READING_SENTINEL],
    note: `Reading your ${distributor} catalogue in a real browser… large catalogues can take a minute. Tracks appear here as soon as the read finishes.`,
  };
}

function signInUrl(distributor: string): string {
  const map: Record<string, string> = {
    distrokid: 'https://distrokid.com/signin',
    tunecore: 'https://www.tunecore.com/login',
    cdbaby: 'https://members.cdbaby.com/Account/Login',
    unitedmasters: 'https://unitedmasters.com/login',
    ditto: 'https://dittomusic.com/en/login',
    amuse: 'https://artist.amuse.io/login',
  };
  return map[distributor.toLowerCase()] ?? 'https://distrokid.com/signin';
}
