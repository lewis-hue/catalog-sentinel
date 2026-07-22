/**
 * Closed enumerations for the domain. Modeled as `as const` string-literal
 * arrays (not TS `enum`) so they are tree-shakeable, iterable at runtime, and
 * friendly to esbuild/isolatedModules.
 */

export const DISTRIBUTOR_PROVIDERS = [
  'distrokid',
  'unitedmasters',
  'tunecore',
  'cdbaby',
  'ditto',
  'amuse',
  'routenote',
  'symphonic',
  'landr',
  'generic-csv',
] as const;
export type DistributorProvider = (typeof DISTRIBUTOR_PROVIDERS)[number];

export const DSP_PLATFORMS = [
  'audiomack',
  'spotify',
  'apple-music',
  'youtube-music',
  'amazon-music',
  'deezer',
  'tidal',
  'boomplay',
  'soundcloud',
  'pandora',
  'tiktok',
  'instagram-facebook',
  'anghami',
  'audius',
  'napster',
  'iheart',
  'qobuz',
  'joox',
  'jiosaavn',
] as const;
export type DSPPlatform = (typeof DSP_PLATFORMS)[number];

/** Whether a release/track is delivered to a given store, per the distributor. */
export const STORE_DELIVERY_STATUSES = [
  'selected',
  'not-selected',
  'delivered',
  'pending',
  'processing',
  'delivery-error',
  'taken-down',
  'unknown',
] as const;
export type StoreDeliveryStatus = (typeof STORE_DELIVERY_STATUSES)[number];

/** Presence of an item on a DSP as observed by an adapter. */
export const PRESENCE_STATUSES = [
  'confirmed-live',
  'missing',
  'probable-match',
  'wrong-profile',
  'not-selected',
  'unknown-api-unavailable',
  'needs-manual-review',
  'curated-no-guarantee',
  'processing',
  'removed-takedown',
  'private-unplayable',
  'duplicate',
] as const;
export type PresenceStatus = (typeof PRESENCE_STATUSES)[number];

export const LYRICS_STATES = [
  'none',
  'plain-submitted',
  'plain-approved',
  'synced-submitted',
  'synced-approved',
  'rejected',
  'submitted-not-visible',
  'unknown',
] as const;
export type LyricsState = (typeof LYRICS_STATES)[number];

export const CREDITS_STATES = [
  'none',
  'submitted',
  'displayed',
  'submitted-not-displayed',
  'unknown',
] as const;
export type CreditsState = (typeof CREDITS_STATES)[number];

/** Distributor "album extras" that gate certain deliveries (e.g. Audiomack). */
export const ALBUM_EXTRAS = [
  'store-maximizer',
  'social-media-pack',
  'audiomack-opt-in',
  'discovery-pack',
  'leave-a-legacy',
  'lyric-blaster',
] as const;
export type AlbumExtra = (typeof ALBUM_EXTRAS)[number];

/** How a given piece of data was obtained — recorded on every evidence item. */
export const DATA_SOURCE_MODES = [
  'official-api',
  'partner-api',
  'user-oauth',
  'user-uploaded-export',
  'csv-import',
  'manual-url-entry',
  'attended-browser-assist',
  'test-fixture',
] as const;
export type DataSourceMode = (typeof DATA_SOURCE_MODES)[number];

export const SCAN_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'partial'] as const;
export type ScanStatus = (typeof SCAN_STATUSES)[number];

export const ISSUE_STATUSES = ['open', 'in-review', 'confirmed', 'remediating', 'resolved', 'dismissed'] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];

export const CONSENT_SCOPES = [
  'read-distributor-catalog',
  'read-dsp-catalog',
  'store-session-ephemeral',
  'capture-screenshots',
  'generate-reports',
  'browser-assist',
] as const;
export type ConsentScope = (typeof CONSENT_SCOPES)[number];

export const USER_ROLES = ['owner', 'admin', 'manager', 'analyst', 'viewer'] as const;
export type UserRole = (typeof USER_ROLES)[number];
