/**
 * Release-title cleaning.
 *
 * DistroKid album pages historically yielded a release title as a single run of text that jams the
 * clean title, the release TYPE (Single/EP/Album), the VERSION/variant (Sped Up, Remix, …) and the
 * ARTIST names together, e.g. `"Feelings Single Lewis KE, Boeyylee"`. This splits that back into
 * distinct fields so the UI and exports read cleanly. It is intentionally conservative: when a
 * separator can't be identified it leaves the title untouched rather than guessing.
 *
 * It also handles the newer, already-clean shape (title = "Feelings", artist known from og:*) as a
 * near no-op, only lifting a version tag out of the title if one is present.
 */

export interface ParsedTitle {
  /** Clean base title, e.g. "Feelings". */
  title: string;
  /** Variant/version if present, e.g. "Sped Up", "Remix", "Slowed Down", else null. */
  version: string | null;
  /** Release type if present, e.g. "Single", "EP", "Album", else null. */
  releaseType: string | null;
  /** First credited artist. */
  primaryArtist: string | null;
  /** Any additional credited artists. */
  featuredArtists: string[];
}

// Version/variant keywords. Matched only inside (…)/[…] or after a trailing " - ", so ordinary
// title words like "Live" in "Live Your Life" are not mistaken for a variant.
const VERSION_KEYWORDS = [
  'sped[\\s-]?up', 'speed[\\s-]?up', 'slowed(?:[\\s+]+(?:and|&|\\+)?[\\s]*reverb)?', 'slowed[\\s-]?down',
  'reverb', 'pitched[\\s-]?up', 'pitched[\\s-]?down', 'pitched', 'remix', 'acoustic', 'live',
  'instrumental', 'a[\\s-]?cappella', 'acapella', 'radio[\\s-]?edit', 'extended(?:[\\s-]mix)?',
  'club[\\s-]?mix', 'vip', 'bootleg', 'cover', 'demo', 'reprise', 'remaster(?:ed)?', 'edit',
];
const RELEASE_TYPES = ['single', 'ep', 'album', 'deluxe', 'mixtape', 'lp'];

const titleCase = (s: string): string => s.replace(/\s+/g, ' ').trim().replace(/\b\w/g, (c) => c.toUpperCase());
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Release types read cleanly: EP/LP stay uppercase acronyms, the rest are title-cased. */
const normalizeType = (t: string): string => {
  const lower = t.toLowerCase();
  return lower === 'ep' || lower === 'lp' ? lower.toUpperCase() : titleCase(t);
};

/** Split a run of credited artists ("Lewis KE, Boeyylee & X feat. Y") into individual names. */
export function splitArtists(raw: string): string[] {
  // Separators: comma, ampersand, or a space-delimited feat./ft./featuring/vs./with/x.
  return raw
    .split(/\s*,\s*|\s*&\s*|\s+(?:feat|ft|featuring|vs|with|x)\.?\s+/i)
    .map((a) => a.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

export function parseReleaseTitle(rawTitle: string | null | undefined, knownArtist: string | null | undefined): ParsedTitle {
  const original = (rawTitle ?? '').replace(/\s+/g, ' ').trim();
  let title = original;
  let version: string | null = null;
  let releaseType: string | null = null;
  let artists: string[] = knownArtist ? splitArtists(knownArtist) : [];

  if (!title) {
    return { title: '', version, releaseType, primaryArtist: artists[0] ?? (knownArtist ?? null), featuredArtists: artists.slice(1) };
  }

  // 1) Version tag inside (…) or […] that contains a known variant keyword.
  const versionParen = new RegExp(`[([]\\s*([^)\\]]*(?:${VERSION_KEYWORDS.join('|')})[^)\\]]*)\\s*[)\\]]`, 'i');
  const vm = versionParen.exec(title);
  if (vm?.[1]) {
    version = titleCase(vm[1]);
    title = (title.slice(0, vm.index) + title.slice(vm.index + vm[0].length)).replace(/\s+/g, ' ').trim();
  }

  // 1b) Featured artists inside a parenthetical: "(feat. X)", "(ft. Y)", "(with Z)".
  const featParen = /[([]\s*(?:feat|ft|featuring|with)\.?\s+([^)\]]+?)\s*[)\]]/i.exec(title);
  const featFromTitle = featParen?.[1] ? splitArtists(featParen[1]) : [];
  if (featParen) {
    title = (title.slice(0, featParen.index) + title.slice(featParen.index + featParen[0].length)).replace(/\s+/g, ' ').trim();
  }

  // 2) Separate artists + release type.
  if (artists.length === 0) {
    // Legacy shape "<Title> <Type> <Artists>": split on a standalone release-type word, OR
    // "<Title> <N> tracks <Artists>" for multi-track releases (DistroKid states the count, not the type).
    const tm = new RegExp(`\\s(${RELEASE_TYPES.join('|')})\\s+(.+)$`, 'i').exec(title);
    const trk = /\s(\d+)\s+tracks?\s+(.+)$/i.exec(title);
    if (tm) {
      releaseType = normalizeType(tm[1]!);
      artists = splitArtists(tm[2]!);
      title = title.slice(0, tm.index).trim();
    } else if (trk) {
      artists = splitArtists(trk[2]!);
      title = title.slice(0, trk.index).trim();
    }
  } else {
    // Artist known (og-based scrape): strip the artist(s) then a trailing type word off the title.
    for (const a of artists) {
      title = title.replace(new RegExp(`[\\s\\-–—·|,]*${escapeRe(a)}\\s*$`, 'i'), '').trim();
    }
    const typeTail = new RegExp(`[\\s\\-–—·|,]*(${RELEASE_TYPES.join('|')})\\s*$`, 'i');
    const tm = typeTail.exec(title);
    if (tm) { releaseType = normalizeType(tm[1]!); title = title.slice(0, tm.index).trim(); }
  }

  // 3) A trailing dash-separated version ("Feelings - Sped Up") not caught by the paren rule.
  if (!version) {
    const versionTail = new RegExp(`[\\s]*[-–—][\\s]*((?:${VERSION_KEYWORDS.join('|')})[\\w\\s]*)$`, 'i');
    const tv = versionTail.exec(title);
    if (tv) { version = titleCase(tv[1]!); title = title.slice(0, tv.index).trim(); }
  }

  title = title.replace(/[\s\-–—·|,]+$/, '').trim() || original;
  const featuredArtists = [...new Set([...artists.slice(1), ...featFromTitle])];
  return { title, version, releaseType, primaryArtist: artists[0] ?? (knownArtist ?? null), featuredArtists };
}
