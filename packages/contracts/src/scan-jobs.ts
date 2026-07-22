import { z } from 'zod';

/**
 * Job contracts shared by the API producers and worker consumers.
 * Catalogue extraction uses the dedicated six-stage DistroKid pipeline contracts.
 */

/** Background multi-platform store-presence deep scan. */
export const PRESENCE_QUEUE = 'store-presence-deep-scan';

export const presenceJobSchema = z.object({
  searchId: z.string().min(1),
  /** Owner is carried across the process boundary and re-verified against the record. */
  tenantId: z.string().min(1),
});
export type PresenceJobPayload = z.infer<typeof presenceJobSchema>;

/** Distributor connection scan queued by the consent-bound connection service. */
export const DEEP_SCAN_QUEUE = 'deep-scan';

export const deepScanJobSchema = z.object({
  tenantId: z.string().min(1),
  artistWorkspaceId: z.string().min(1),
  deepScanRunId: z.string().min(1),
  distributorConnectionId: z.string().min(1),
});
export type DeepScanJobPayload = z.infer<typeof deepScanJobSchema>;
