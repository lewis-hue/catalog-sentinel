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

/** Background lyric-availability verification (LRCLIB), a fault-isolated microservice on its own
 *  queue so a lyrics-store outage can never affect catalogue scraping or store-presence scanning. */
export const LYRICS_QUEUE = 'lyrics-verification';

export const lyricsJobSchema = z.object({
  searchId: z.string().min(1),
  /** Owner is carried across the process boundary and re-verified against the record. */
  tenantId: z.string().min(1),
});
export type LyricsJobPayload = z.infer<typeof lyricsJobSchema>;

/** Dedicated DistroKid lyric scan, a SEPARATE, decoupled pass that runs after the metadata scrape,
 *  re-attaches to the warm Steel session, and reads each album's lyric state unhurriedly (the only
 *  reliable way to read DistroKid's lazy-rendered lyric controls). Carries the encrypted Steel
 *  session handle + expiry so the sweep worker can re-attach and bound itself to the session window. */
export const DISTROKID_LYRIC_SCAN_QUEUE = 'distrokid-lyric-scan';

export const distroKidLyricScanJobSchema = z.object({
  snapshotId: z.string().min(1),
  tenantId: z.string().min(1),
  connectionId: z.string().min(1),
  /** Envelope-encrypted Steel remote-session handle (from the scrape's SnapshotRef). */
  steelSessionId: z.string().optional(),
  /** ISO timestamp the Steel session expires, the sweep stops before this. */
  sessionExpiresAt: z.string().optional(),
});
export type DistroKidLyricScanJobPayload = z.infer<typeof distroKidLyricScanJobSchema>;

/** Distributor connection scan queued by the consent-bound connection service. */
export const DEEP_SCAN_QUEUE = 'deep-scan';

export const deepScanJobSchema = z.object({
  tenantId: z.string().min(1),
  artistWorkspaceId: z.string().min(1),
  deepScanRunId: z.string().min(1),
  distributorConnectionId: z.string().min(1),
});
export type DeepScanJobPayload = z.infer<typeof deepScanJobSchema>;
