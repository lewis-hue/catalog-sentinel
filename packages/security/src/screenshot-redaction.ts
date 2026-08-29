/**
 * Screenshot redaction (PRD §K/§M). When attended browser-assist captures a
 * screenshot as evidence, sensitive regions (account email, payment details,
 * balances, session/2FA UI) must be blurred before the image is stored.
 *
 * This module produces a REDACTION MANIFEST, the deterministic plan of what to
 * blur and why. The pixel-level blurring is performed by the worker's image
 * pipeline (sharp/canvas) in production; that step is a documented TODO here so
 * the security contract and tests exist independently of an image dependency.
 */
export type SensitiveRegionKind =
  | 'account-email'
  | 'payment-method'
  | 'bank-details'
  | 'balance-earnings'
  | 'session-token'
  | 'two-factor-ui'
  | 'address';

export interface RedactionRegion {
  kind: SensitiveRegionKind;
  /** Bounding box in image pixels. */
  x: number;
  y: number;
  width: number;
  height: number;
  reason: string;
}

export interface RedactionManifest {
  imageRef: string;
  regions: RedactionRegion[];
  /** Whether the pixel-level blur has been applied (false = manifest only). */
  applied: boolean;
}

/**
 * Build a redaction manifest for a screenshot. Regions are supplied by the
 * browser-assist capture step (e.g. from known DOM selectors' bounding boxes).
 * Always returns a manifest, even when empty, so callers must acknowledge it
 * before persisting an image.
 */
export function buildRedactionManifest(imageRef: string, regions: RedactionRegion[]): RedactionManifest {
  return { imageRef, regions: [...regions], applied: false };
}

/**
 * TODO(prod): apply the manifest to actual pixels using an image library and
 * return the redacted image reference. Throws until implemented so no unredacted
 * screenshot can be stored by mistake.
 */
export async function applyRedaction(_manifest: RedactionManifest): Promise<never> {
  throw new Error('Screenshot pixel redaction is not implemented; browser-assist evidence capture is disabled by default.');
}
