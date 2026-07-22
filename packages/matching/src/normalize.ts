/**
 * Metadata normalization (PRD §E "Title normalization rules"). Version tags and
 * featured artists are preserved as STRUCTURED fields, never silently discarded,
 * so "Song (feat. X) [Remix]" and "Song - Remix" both reduce to the same base
 * title while keeping `featured` and `versionTags` for scoring.
 */

/** Canonical version tag + the patterns that map onto it. Order matters. */
const VERSION_PATTERNS: Array<{ tag: string; re: RegExp }> = [
  { tag: 'radio edit', re: /\bradio\s*edit\b/ },
  { tag: 'sped up', re: /\bsped[\s-]?up\b|\bspeed[\s-]?up\b|\bspedup\b/ },
  { tag: 'slowed', re: /\bslowed(?:\s*(?:\+|and|&)\s*reverb)?\b|\bslowed\s*down\b/ },
  { tag: 'instrumental', re: /\binstrumental\b/ },
  { tag: 'acoustic', re: /\bacoustic\b/ },
  { tag: 'acapella', re: /\ba[\s-]?cappella\b|\bacapella\b/ },
  { tag: 'karaoke', re: /\bkaraoke\b/ },
  { tag: 'live', re: /\blive\b/ },
  { tag: 'remaster', re: /\bre[\s-]?master(?:ed)?\b/ },
  { tag: 'extended', re: /\bextended\b/ },
  { tag: 'remix', re: /\bremix(?:es)?\b|\brmx\b/ },
  { tag: 'demo', re: /\bdemo\b/ },
  { tag: 'explicit', re: /\bexplicit\b/ },
  { tag: 'clean', re: /\bclean\b/ },
  { tag: 'edit', re: /\bedit\b/ },
  { tag: 'version', re: /\bversion\b/ },
  { tag: 'mix', re: /\b(?:club|extended|original)?\s*mix\b/ },
];

const FEAT_LEAD = /(?:feat|ft|featuring|w\/|with)\.?/;

/** NFKC-normalize, drop combining diacritics, lowercase, trim. */
export function normalizeUnicode(input: string): string {
  return input.normalize('NFKC').toLowerCase().trim();
}

export function stripDiacritics(input: string): string {
  // Remove combining diacritical marks (U+0300–U+036F) after NFKD decomposition.
  return input.normalize('NFKD').replace(/[̀-ͯ]/g, '');
}

/** Collapse punctuation to spaces, squeeze whitespace, trim. Case-insensitive. */
export function collapse(input: string): string {
  return stripDiacritics(input.toLowerCase())
    .replace(/[’'`]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitArtistList(raw: string): string[] {
  return raw
    .split(/,|&|\band\b|\bx\b|\/|\bwith\b|\bvs\.?\b|\+/i)
    .map((s) => collapse(s))
    .filter(Boolean);
}

export interface ParsedTitle {
  raw: string;
  /** Fully normalized base title used as the primary comparison key. */
  base: string;
  versionTags: string[];
  featured: string[];
}

/**
 * Parse a track/release title into a normalized base plus structured version and
 * featured-artist fields. Deterministic and side-effect free.
 */
export function parseTitle(raw: string): ParsedTitle {
  const featured: string[] = [];
  const versionTags = new Set<string>();
  let work = normalizeUnicode(raw);

  // 1. Bracketed / parenthetical groups: classify each as feat, version, or keep.
  const groupRe = /[([{]\s*([^)\]}]*?)\s*[)\]}]/g;
  work = work.replace(groupRe, (_full, inner: string) => {
    const seg = inner.trim();
    const featMatch = seg.match(new RegExp(`^${FEAT_LEAD.source}\\s+(.+)$`, 'i'));
    if (featMatch?.[1]) {
      for (const name of splitArtistList(featMatch[1])) featured.push(name);
      return ' ';
    }
    const tags = detectVersionTags(seg);
    if (tags.length > 0) {
      for (const t of tags) versionTags.add(t);
      return ' ';
    }
    // Not feat/version — keep inner text as part of the title (e.g. a subtitle).
    return ` ${seg} `;
  });

  // 2. Trailing dash-delimited version segments: "title - Remix", "title - Live".
  const dashParts = work.split(/\s[-–—]\s/);
  if (dashParts.length > 1) {
    const kept: string[] = [dashParts[0] ?? ''];
    for (let i = 1; i < dashParts.length; i++) {
      const part = dashParts[i]!;
      const tags = detectVersionTags(part);
      const featMatch = part.match(new RegExp(`^${FEAT_LEAD.source}\\s+(.+)$`, 'i'));
      if (featMatch?.[1]) {
        for (const name of splitArtistList(featMatch[1])) featured.push(name);
      } else if (tags.length > 0) {
        for (const t of tags) versionTags.add(t);
      } else {
        kept.push(part);
      }
    }
    work = kept.join(' ');
  }

  // 3. Trailing un-bracketed "feat X" (must run after dash handling).
  work = work.replace(new RegExp(`\\s+${FEAT_LEAD.source}\\s+(.+)$`, 'i'), (_m, names: string) => {
    for (const name of splitArtistList(names)) featured.push(name);
    return ' ';
  });

  return {
    raw,
    base: collapse(work),
    versionTags: [...versionTags].sort(),
    featured: dedupe(featured),
  };
}

/** Detect canonical version tags present in a short segment. */
export function detectVersionTags(segment: string): string[] {
  const s = normalizeUnicode(segment);
  const found = new Set<string>();
  for (const { tag, re } of VERSION_PATTERNS) {
    if (re.test(s)) found.add(tag);
  }
  // Compound tags subsume their generic parts ("radio edit" implies "edit").
  if (found.has('radio edit')) found.delete('edit');
  if (found.has('extended')) found.delete('mix');
  return [...found];
}

/** Normalize a single artist name to a comparison key. */
export function normalizeArtist(raw: string): string {
  return collapse(normalizeUnicode(raw));
}

/**
 * Build the set of normalized artist keys for a primary name plus aliases and
 * featured artists — used for overlap-based artist matching.
 */
export function normalizeArtistSet(names: Array<string | null | undefined>): Set<string> {
  const set = new Set<string>();
  for (const n of names) {
    if (!n) continue;
    for (const part of splitArtistList(n)) set.add(part);
    const whole = normalizeArtist(n);
    if (whole) set.add(whole);
  }
  return set;
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)].sort();
}

/** Very common single-word titles that deserve a confidence penalty (PRD §E). */
const COMMON_TITLE_WORDS = new Set([
  'intro',
  'outro',
  'interlude',
  'skit',
  'freestyle',
  'untitled',
  'love',
  'you',
  'home',
  'alone',
  'forever',
  'stay',
  'run',
  'gone',
]);

export function isCommonTitle(base: string): boolean {
  const words = base.split(' ').filter(Boolean);
  return words.length <= 1 && (words.length === 0 || COMMON_TITLE_WORDS.has(words[0]!) || (words[0]?.length ?? 0) <= 3);
}
