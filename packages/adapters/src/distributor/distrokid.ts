import type { DataSourceMode } from '@sentinel/core';
import { GenericCsvDistributorAdapter } from './generic-csv';
import {
  AdapterUnavailableError,
  type CatalogDiscoveryInput,
  type DistributorCapabilities,
  type DistributorCatalogSnapshot,
} from '../types';

export interface DistroKidAdapterOptions {
  /** Ingestion mode. CSV is the only mode enabled without partner access. */
  mode?: 'csv-import' | 'user-uploaded-export' | 'partner-api' | 'attended-browser-assist';
  /** Both must be true to even attempt attended browser-assist (PRD §L). */
  browserAssistEnabled?: boolean;
  browserAssistLegalApproved?: boolean;
  partnerApiKey?: string;
  clockIso?: () => string;
}

const CAPABILITIES: DistributorCapabilities = {
  supportsOfficialApi: false, // flips true only with approved partner access
  supportsCsvImport: true,
  supportsUserExport: true,
  supportsAttendedBrowserAssist: true, // capability exists; runtime-gated + off by default
  supportsLyricsStatus: true,
  supportsStoreSelectionStatus: true,
  supportsCreditsStatus: true,
  supportsRoyaltyReports: true,
  supportsSplits: true,
};

/**
 * DistroKid adapter. CSV/user-export ingestion is fully implemented via the
 * generic base. The partner-API and attended-browser-assist paths are scaffolded
 * with hard runtime gates: browser-assist requires BOTH an admin feature flag
 * and recorded legal approval, and never handles/stores passwords, never bypasses
 * CAPTCHA/2FA, and is rate-limited (see docs/compliance.md).
 */
export class DistroKidAdapter extends GenericCsvDistributorAdapter {
  override readonly capabilities = CAPABILITIES;

  constructor(private readonly opts: DistroKidAdapterOptions = {}) {
    const mode: DataSourceMode = opts.mode === 'attended-browser-assist'
      ? 'attended-browser-assist'
      : opts.mode === 'partner-api'
        ? 'partner-api'
        : opts.mode === 'user-uploaded-export'
          ? 'user-uploaded-export'
          : 'csv-import';
    super('distrokid', mode, opts.clockIso);
  }

  override async discoverCatalog(input: CatalogDiscoveryInput): Promise<DistributorCatalogSnapshot> {
    switch (this.opts.mode) {
      case 'partner-api':
        // TODO(prod): implement DistroKid partner API client once access is granted.
        if (!this.opts.partnerApiKey) {
          throw new AdapterUnavailableError('distrokid', 'partner-api', 'DistroKid partner API access is not configured.');
        }
        throw new AdapterUnavailableError('distrokid', 'partner-api', 'DistroKid partner API client not yet implemented.');
      case 'attended-browser-assist':
        this.assertBrowserAssistAllowed();
        // TODO(prod): Playwright attended flow, user logs in directly; extract only
        // authorized metadata; encrypt any ephemeral session; capture redacted
        // screenshots for evidence; never bypass CAPTCHA/2FA; rate-limit + log.
        throw new AdapterUnavailableError(
          'distrokid',
          'attended-browser-assist',
          'Attended browser-assist is scaffolded but not implemented; use CSV import.',
        );
      default:
        return super.discoverCatalog(input);
    }
  }

  private assertBrowserAssistAllowed(): void {
    if (!this.opts.browserAssistEnabled || !this.opts.browserAssistLegalApproved) {
      throw new AdapterUnavailableError(
        'distrokid',
        'attended-browser-assist',
        'Browser-assist is disabled: requires both the admin feature flag and recorded legal approval.',
      );
    }
  }
}
