import { describe, it, expect } from 'vitest';
import { parseTitle, normalizeArtist, normalizeArtistSet, detectVersionTags, isCommonTitle } from './normalize';

describe('parseTitle', () => {
  it('lowercases, trims, and strips diacritics into the base', () => {
    expect(parseTitle('  Café Del Mar  ').base).toBe('cafe del mar');
    expect(parseTitle('Naïve').base).toBe('naive');
    expect(parseTitle('Beyoncé, Déjà Vu').base).toBe('beyonce deja vu');
  });

  it('extracts featured artists from bracketed and trailing forms', () => {
    expect(parseTitle('Song Title (feat. John Doe)').featured).toEqual(['john doe']);
    expect(parseTitle('Song ft. A & B').featured).toEqual(['a', 'b']);
    expect(parseTitle('Track [featuring Jane]').featured).toEqual(['jane']);
    const p = parseTitle('Song Title (feat. John Doe) [Remix]');
    expect(p.base).toBe('song title');
    expect(p.featured).toEqual(['john doe']);
    expect(p.versionTags).toEqual(['remix']);
  });

  it('captures version tags as structured fields, not discarded text', () => {
    expect(parseTitle('Track - Radio Edit').versionTags).toEqual(['radio edit']);
    expect(parseTitle('Track - Radio Edit').base).toBe('track');
    expect(parseTitle('Hello (Sped Up)').versionTags).toEqual(['sped up']);
    expect(parseTitle('Song (Slowed + Reverb)').versionTags).toEqual(['slowed']);
    expect(parseTitle('Live at Home (Acoustic)').versionTags).toContain('acoustic');
  });

  it('keeps non-version parentheticals as part of the base', () => {
    // A subtitle that is neither a feature nor a version tag stays in the title.
    expect(parseTitle('Interlude (The Beginning)').base).toBe('interlude the beginning');
  });

  it('does not double-count radio edit as edit', () => {
    expect(detectVersionTags('Radio Edit')).toEqual(['radio edit']);
  });
});

describe('artist normalization', () => {
  it('normalizes a single artist name', () => {
    expect(normalizeArtist('Beyoncé')).toBe('beyonce');
    expect(normalizeArtist('  The Weeknd ')).toBe('the weeknd');
  });

  it('builds an artist key set including split collaborators and aliases', () => {
    const set = normalizeArtistSet(['Lewis KE', 'Lewis K.E.', 'Big Man & Small Man']);
    expect(set.has('lewis ke')).toBe(true);
    expect(set.has('big man')).toBe(true);
    expect(set.has('small man')).toBe(true);
  });
});

describe('isCommonTitle', () => {
  it('flags short/common single-word titles', () => {
    expect(isCommonTitle('intro')).toBe(true);
    expect(isCommonTitle('you')).toBe(true);
    expect(isCommonTitle('run')).toBe(true);
    expect(isCommonTitle('lagos city nights')).toBe(false);
  });
});
