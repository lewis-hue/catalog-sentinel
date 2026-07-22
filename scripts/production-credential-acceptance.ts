import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import {
  AudiomackStoreProvider,
  DeezerStoreProvider,
  ItunesStoreProvider,
  SoundCloudStoreProvider,
  SpotifyStoreProvider,
  TidalStoreProvider,
  YouTubeMusicProvider,
  sameArtist,
  type StoreCatalogProvider,
} from '@sentinel/adapters';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function httpsUrl(name: string): URL {
  const url = new URL(required(name));
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must be an HTTPS URL without credentials, query, or fragment`);
  }
  return url;
}

async function withDeadline<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('provider deadline exceeded')), timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function safeMessage(error: unknown): string {
  let message = error instanceof Error ? error.message : 'provider validation failed';
  for (const name of [
    'SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET', 'YOUTUBE_API_KEY',
    'AUDIOMACK_CONSUMER_KEY', 'AUDIOMACK_CONSUMER_SECRET',
    'SOUNDCLOUD_CLIENT_ID', 'SOUNDCLOUD_CLIENT_SECRET',
    'TIDAL_CLIENT_ID', 'TIDAL_CLIENT_SECRET', 'SENTINEL_ACCEPTANCE_TOKEN',
  ]) {
    const secret = process.env[name];
    if (secret) message = message.split(secret).join('[redacted]');
  }
  return message.replace(/:\/\/[^@\s]+@/g, '://[redacted]@');
}

const artist = required('ACCEPTANCE_ARTIST_NAME');
const referenceTrack = required('ACCEPTANCE_REFERENCE_TRACK_TITLE');
const token = required('SENTINEL_ACCEPTANCE_TOKEN');
const issuer = httpsUrl('KEYCLOAK_ISSUER').href.replace(/\/$/, '');
const audience = required('KEYCLOAK_API_AUDIENCE');
const reportPath = process.env.SENTINEL_REPORT_PATH?.trim();

const jwks = createRemoteJWKSet(new URL(`${issuer}/protocol/openid-connect/certs`));
const verifiedToken = await jwtVerify(token, jwks, {
  issuer,
  audience,
  algorithms: ['RS256'],
  clockTolerance: 30,
});
const identityProvider = typeof verifiedToken.payload.identity_provider === 'string'
  ? verifiedToken.payload.identity_provider
  : null;
if (identityProvider !== 'google') throw new Error('acceptance token was not issued from a Google-brokered Keycloak login');
if (verifiedToken.payload.email_verified !== true) throw new Error('Google-brokered acceptance token does not contain email_verified=true');
if (typeof verifiedToken.payload.sub !== 'string' || typeof verifiedToken.payload.tenant_id !== 'string') {
  throw new Error('Google-brokered acceptance token is missing subject or tenant binding');
}
const roles = (verifiedToken.payload.realm_access as { roles?: unknown } | undefined)?.roles;
if (!Array.isArray(roles) || !roles.some((role) => ['user', 'artist_manager', 'tenant_admin'].includes(String(role)))) {
  throw new Error('Google-brokered acceptance token lacks an interactive catalogue role');
}

interface CatalogProbe {
  name: string;
  provider: StoreCatalogProvider;
  credentialNames: string[];
}

const audiomackProfile = httpsUrl('AUDIOMACK_PROFILE_URL');
const soundCloudProfile = httpsUrl('SOUNDCLOUD_PROFILE_URL');
const tidalProfile = httpsUrl('TIDAL_PROFILE_URL');
const probes: CatalogProbe[] = [
  { name: 'Deezer', provider: new DeezerStoreProvider(), credentialNames: [] },
  { name: 'Apple Music', provider: new ItunesStoreProvider(), credentialNames: [] },
  {
    name: 'Spotify',
    provider: new SpotifyStoreProvider({ clientId: required('SPOTIFY_CLIENT_ID'), clientSecret: required('SPOTIFY_CLIENT_SECRET') }),
    credentialNames: ['SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET'],
  },
  {
    name: 'Audiomack',
    provider: new AudiomackStoreProvider({
      consumerKey: required('AUDIOMACK_CONSUMER_KEY'),
      consumerSecret: required('AUDIOMACK_CONSUMER_SECRET'),
      slug: AudiomackStoreProvider.slugFromProfileUrl(audiomackProfile.href) ?? undefined,
    }),
    credentialNames: ['AUDIOMACK_CONSUMER_KEY', 'AUDIOMACK_CONSUMER_SECRET'],
  },
  {
    name: 'SoundCloud',
    provider: new SoundCloudStoreProvider({
      clientId: required('SOUNDCLOUD_CLIENT_ID'),
      clientSecret: required('SOUNDCLOUD_CLIENT_SECRET'),
      profileUrl: soundCloudProfile.href,
    }),
    credentialNames: ['SOUNDCLOUD_CLIENT_ID', 'SOUNDCLOUD_CLIENT_SECRET'],
  },
  {
    name: 'TIDAL',
    provider: new TidalStoreProvider({
      clientId: required('TIDAL_CLIENT_ID'),
      clientSecret: required('TIDAL_CLIENT_SECRET'),
      profileUrl: tidalProfile.href,
    }),
    credentialNames: ['TIDAL_CLIENT_ID', 'TIDAL_CLIENT_SECRET'],
  },
];

const results: Array<Record<string, unknown>> = [];
let passed = true;
for (const probe of probes) {
  const started = performance.now();
  try {
    if (probe.provider.needsCredential) throw new Error('provider reports that its credential is unavailable');
    const catalog = await withDeadline(probe.provider.listArtistCatalog(artist, { limit: 400 }), 60_000);
    const exactArtist = catalog.artist !== null && sameArtist(catalog.artist.name, artist);
    const credentialError = catalog.warnings.some((warning) => /credential|unauthor|forbidden|invalid.?client|token|premium required/i.test(warning));
    const ok = exactArtist && catalog.tracks.length > 0 && !credentialError;
    if (!ok) passed = false;
    results.push({
      platform: probe.name,
      passed: ok,
      credentialNames: probe.credentialNames,
      exactArtist,
      tracksObserved: catalog.tracks.length,
      paginationComplete: catalog.pagination.complete,
      upstreamTotal: catalog.pagination.total,
      warnings: catalog.warnings,
      latencyMs: Math.round(performance.now() - started),
    });
  } catch (error) {
    passed = false;
    results.push({
      platform: probe.name,
      passed: false,
      credentialNames: probe.credentialNames,
      error: safeMessage(error),
      latencyMs: Math.round(performance.now() - started),
    });
  }
}

const youtubeStarted = performance.now();
try {
  const youtube = new YouTubeMusicProvider({ apiKey: required('YOUTUBE_API_KEY') });
  if (youtube.needsCredential) throw new Error('provider reports that its credential is unavailable');
  const match = await withDeadline(youtube.searchTitle(artist, referenceTrack), 30_000);
  if (!match.found) passed = false;
  results.push({
    platform: 'YouTube',
    passed: match.found,
    credentialNames: ['YOUTUBE_API_KEY'],
    referenceTrackMatched: match.found,
    latencyMs: Math.round(performance.now() - youtubeStarted),
  });
} catch (error) {
  passed = false;
  results.push({
    platform: 'YouTube',
    passed: false,
    credentialNames: ['YOUTUBE_API_KEY'],
    error: safeMessage(error),
    latencyMs: Math.round(performance.now() - youtubeStarted),
  });
}

const report = {
  schemaVersion: 1,
  kind: 'sentinel-live-google-and-dsp-credential-acceptance',
  passed,
  checkedAt: new Date().toISOString(),
  googleIdentity: {
    issuer,
    keyId: verifiedToken.protectedHeader.kid ?? null,
    subjectSha256: createHash('sha256').update(verifiedToken.payload.sub).digest('hex'),
    tenantSha256: createHash('sha256').update(String(verifiedToken.payload.tenant_id)).digest('hex'),
    identityProvider,
    emailVerified: true,
  },
  artist,
  referenceTrack,
  results,
};
const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (reportPath) await writeFile(reportPath, serialized, { encoding: 'utf8', flag: 'wx' });
process.stdout.write(serialized);
if (!passed) process.exitCode = 1;
