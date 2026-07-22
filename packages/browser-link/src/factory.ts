import { readDistributorLinkFlags, assertProviderEnabled, type EnvelopeCrypto } from '@sentinel/security';
import type { BrowserLinkProvider } from './types';
import { createCloudLiveProvider } from './cloud-live-provider';

export interface BrowserLinkFactoryDeps {
  encryptor: EnvelopeCrypto;
  env?: NodeJS.ProcessEnv;
}

/** Build the configured Steel provider. No alternate browser implementation is selectable. */
export function createBrowserLinkProvider(deps: BrowserLinkFactoryDeps): BrowserLinkProvider {
  const env = deps.env ?? process.env;
  assertProviderEnabled(env);
  const flags = readDistributorLinkFlags(env);
  if (flags.browserLinkProvider !== 'steel') {
    throw new Error('BROWSER_LINK_PROVIDER must be steel.');
  }
  const provider = createCloudLiveProvider(env, deps.encryptor);
  if (!provider) throw new Error('BROWSER_LINK_PROVIDER=steel requires a configured Steel session endpoint.');
  return provider;
}
