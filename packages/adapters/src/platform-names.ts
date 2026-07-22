import type { DSPPlatform } from '@sentinel/core';

/**
 * Maps free-text store/platform names as they appear in distributor exports onto
 * canonical {@link DSPPlatform} codes. Distributor CSVs label stores
 * inconsistently ("Apple Music / iTunes", "YouTube Music", "FB/IG"), so match on
 * a normalized, punctuation-stripped key.
 */
const NAME_MAP: Record<string, DSPPlatform> = {
  audiomack: 'audiomack',
  spotify: 'spotify',
  applemusic: 'apple-music',
  apple: 'apple-music',
  itunes: 'apple-music',
  youtubemusic: 'youtube-music',
  youtube: 'youtube-music',
  ytmusic: 'youtube-music',
  amazonmusic: 'amazon-music',
  amazon: 'amazon-music',
  deezer: 'deezer',
  tidal: 'tidal',
  boomplay: 'boomplay',
  soundcloud: 'soundcloud',
  pandora: 'pandora',
  tiktok: 'tiktok',
  tiktokresso: 'tiktok',
  instagram: 'instagram-facebook',
  facebook: 'instagram-facebook',
  instagramfacebook: 'instagram-facebook',
  fbig: 'instagram-facebook',
  meta: 'instagram-facebook',
  anghami: 'anghami',
  audius: 'audius',
  napster: 'napster',
  iheartradio: 'iheart',
  iheart: 'iheart',
  qobuz: 'qobuz',
  joox: 'joox',
  jiosaavn: 'jiosaavn',
  saavn: 'jiosaavn',
};

export function toPlatformCode(name: string): DSPPlatform | null {
  const key = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  return NAME_MAP[key] ?? null;
}

/** Split a delimited store list ("Spotify, Apple Music | Audiomack") into codes. */
export function parseStoreList(raw: string): DSPPlatform[] {
  if (!raw) return [];
  const parts = raw.split(/[,;|/]+/).map((s) => s.trim()).filter(Boolean);
  const out = new Set<DSPPlatform>();
  for (const p of parts) {
    const code = toPlatformCode(p);
    if (code) out.add(code);
  }
  return [...out];
}
