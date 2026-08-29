import type { Branded } from './ids';

/**
 * ISRC, International Standard Recording Code (track-level canonical key).
 * Canonical form is 12 chars: 2-letter country + 3-char registrant + 2-digit
 * year + 5-digit designation, uppercased with separators removed.
 */
export type Isrc = Branded<string, 'Isrc'>;

/** UPC/EAN, release-level canonical key (barcode). Stored digits-only. */
export type Upc = Branded<string, 'Upc'>;

const ISRC_RE = /^[A-Z]{2}[A-Z0-9]{3}\d{2}\d{5}$/;

export function normalizeIsrc(raw: string | null | undefined): Isrc | null {
  if (!raw) return null;
  const cleaned = raw.toUpperCase().replace(/[\s-]/g, '');
  return ISRC_RE.test(cleaned) ? (cleaned as Isrc) : null;
}

export function isValidIsrc(raw: string | null | undefined): boolean {
  return normalizeIsrc(raw) !== null;
}

/**
 * Normalize a UPC/EAN to digits only. Accepts UPC-A (12), EAN-13 (13), and
 * ITF-14 (14) lengths; pads short numeric barcodes to 12 (some distributors
 * strip leading zeros in CSV exports). Returns null if not a plausible barcode.
 */
export function normalizeUpc(raw: string | null | undefined): Upc | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 0) return null;
  if (digits.length < 8 || digits.length > 14) return null;
  const padded = digits.length < 12 ? digits.padStart(12, '0') : digits;
  return padded as Upc;
}

export function isValidUpc(raw: string | null | undefined): boolean {
  return normalizeUpc(raw) !== null;
}

/** GTIN check-digit validation (mod-10). Optional stronger UPC/EAN check. */
export function hasValidUpcCheckDigit(upc: Upc): boolean {
  const digits = [...upc].map(Number);
  if (digits.some(Number.isNaN)) return false;
  const check = digits[digits.length - 1]!;
  const body = digits.slice(0, -1).reverse();
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    sum += body[i]! * (i % 2 === 0 ? 3 : 1);
  }
  const expected = (10 - (sum % 10)) % 10;
  return expected === check;
}
