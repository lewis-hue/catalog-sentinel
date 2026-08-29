import {
  CONSENT_DISCLOSURE_VERSION,
  CONSENT_PURPOSE,
  CONSENT_RETENTION_DAYS,
  type DistributorLinkRepository,
} from '@sentinel/db';
import { ownerOf, type SearchStore } from '@sentinel/search-store';

export interface SnapshotPrincipalBinding {
  tenantId: string;
  snapshotId: string;
  consentId?: string;
  distributor: string;
}

/**
 * Validate the complete queue-to-record-to-consent ownership chain before any browser attach or
 * public projection. Queue payloads are internal input, not authorization: a forged same-tenant
 * payload must not be able to attach Alice's Steel session to Bob's scan (or vice versa).
 */
export async function snapshotPrincipalBindingValid(
  store: Pick<SearchStore, 'get'>,
  repository: Pick<DistributorLinkRepository, 'consents'>,
  job: SnapshotPrincipalBinding,
  nowMs = Date.now(),
): Promise<boolean> {
  if (!job.consentId) return false;
  const [record, consent] = await Promise.all([
    store.get(job.snapshotId),
    repository.consents.get({ tenantId: job.tenantId }, job.consentId),
  ]);
  if (!record || !consent || !record.userId) return false;
  // Per-user isolation: the whole binding is the user boundary. Workspaces are gone, so the check
  // is that the record owner, the consent tenant, and the consent's granting user all agree.
  return Boolean(
    ownerOf(record) === job.tenantId
    && consent.tenantId === job.tenantId
    && consent.grantedByUserId === record.userId
    && consent.distributor?.toLowerCase() === job.distributor.toLowerCase()
    && consent.provider === 'steel'
    && consent.scope === 'distributor:read-catalog'
    && Boolean(consent.grantedAt)
    && consent.purpose === CONSENT_PURPOSE
    && consent.disclosureVersion === CONSENT_DISCLOSURE_VERSION
    && consent.retentionDays === CONSENT_RETENTION_DAYS
    && !consent.revokedAt
    && Date.parse(consent.expiresAt) > nowMs
  );
}

export async function assertSnapshotPrincipalBinding(
  store: Pick<SearchStore, 'get'>,
  repository: Pick<DistributorLinkRepository, 'consents'>,
  job: SnapshotPrincipalBinding,
  nowMs = Date.now(),
): Promise<void> {
  if (!await snapshotPrincipalBindingValid(store, repository, job, nowMs)) {
    const error = new Error('DistroKid snapshot principal and consent binding is invalid');
    error.name = 'SnapshotPrincipalBindingError';
    throw error;
  }
}
