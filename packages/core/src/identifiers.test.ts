import { describe, it, expect } from 'vitest';
import { normalizeIsrc, isValidIsrc, normalizeUpc, hasValidUpcCheckDigit } from './identifiers';

describe('normalizeIsrc', () => {
  it('accepts and canonicalizes a valid ISRC with separators', () => {
    expect(normalizeIsrc('US-RC1-17-00001')).toBe('USRC11700001');
    expect(normalizeIsrc('usrc11700001')).toBe('USRC11700001');
    expect(normalizeIsrc('  qz-abc-24-12345 ')).toBe('QZABC2412345');
  });

  it('rejects malformed ISRCs', () => {
    expect(normalizeIsrc('NOT-AN-ISRC')).toBeNull();
    expect(normalizeIsrc('USRC11700')).toBeNull(); // too short (9 chars)
    expect(normalizeIsrc('USRC117000012')).toBeNull(); // too long (13 chars)
    expect(normalizeIsrc('12RC11700001')).toBeNull(); // country must be letters
    expect(normalizeIsrc('')).toBeNull();
    expect(normalizeIsrc(null)).toBeNull();
    expect(normalizeIsrc(undefined)).toBeNull();
  });

  it('isValidIsrc mirrors normalizeIsrc', () => {
    expect(isValidIsrc('US-RC1-17-00001')).toBe(true);
    expect(isValidIsrc('bad')).toBe(false);
  });
});

describe('normalizeUpc', () => {
  it('strips non-digits and left-pads leading-zero-stripped barcodes to 12', () => {
    expect(normalizeUpc('0 88807 21990 3')).toBe('088807219903');
    // DistroKid CSV exports sometimes strip a leading zero (11 digits -> 12).
    expect(normalizeUpc('88807219903')).toBe('088807219903');
  });

  it('accepts EAN-13 and ITF-14 lengths untouched', () => {
    expect(normalizeUpc('0885686000000')).toBe('0885686000000');
  });

  it('rejects implausible barcodes', () => {
    expect(normalizeUpc('123')).toBeNull();
    expect(normalizeUpc('abcdefgh')).toBeNull();
    expect(normalizeUpc(null)).toBeNull();
  });

  it('validates a GTIN check digit', () => {
    // 036000291452 is a canonical valid UPC-A example.
    const upc = normalizeUpc('036000291452')!;
    expect(hasValidUpcCheckDigit(upc)).toBe(true);
    const bad = normalizeUpc('036000291453')!;
    expect(hasValidUpcCheckDigit(bad)).toBe(false);
  });
});
