import type { DistributorProvider } from '@sentinel/core';
import type { DistributorAdapter } from './types';
import { GenericCsvDistributorAdapter } from './distributor/generic-csv';
import { DistroKidAdapter } from './distributor/distrokid';

export interface AdapterFactoryOptions {
  distroKid?: ConstructorParameters<typeof DistroKidAdapter>[0];
}

/** Build a distributor adapter for a provider (defaults to CSV-capable paths). */
export function createDistributorAdapter(provider: DistributorProvider, opts: AdapterFactoryOptions = {}): DistributorAdapter {
  switch (provider) {
    case 'distrokid':
      return new DistroKidAdapter(opts.distroKid);
    default:
      return new GenericCsvDistributorAdapter(provider);
  }
}
