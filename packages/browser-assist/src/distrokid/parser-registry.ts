import type { CanonicalDistributorRelease, MetadataSource } from './metadata-model';
import { parseDistroKidReleaseV1, SchemaMismatchError, PARSER_VERSION as V1 } from './parser-v1';

/**
 * Versioned parser registry.
 *
 * A distributor can change its response shape at any time. When that happens we must NOT guess
 * and must NOT emit silently-partial data. Instead:
 *   1. try each compatible parser variant, newest first;
 *   2. if all fail → report SCHEMA_CHANGED so the caller marks the endpoint DEGRADED, raises an
 *      operational alert, and falls back to a lower tier of the extraction hierarchy;
 *   3. keep old parsers around so a rollback is a config change, not a code change.
 */

export interface ParserVariant {
  version: string;
  parse(payload: unknown, source: MetadataSource): CanonicalDistributorRelease;
}

export type ParseOutcome =
  | { ok: true; release: CanonicalDistributorRelease; parserVersion: string }
  | { ok: false; reason: 'SCHEMA_CHANGED'; parserVersion: string; detail: string };

/** Newest first. Add v2 here when DistroKid's shape changes; never delete v1. */
export const PARSER_VARIANTS: ParserVariant[] = [
  { version: V1, parse: (payload, source) => parseDistroKidReleaseV1(payload, source) },
];

export class ParserRegistry {
  constructor(
    private readonly variants: ParserVariant[] = PARSER_VARIANTS,
    private readonly onAlert: (a: { level: 'warn' | 'error'; code: string; message: string }) => void = () => {},
  ) {}

  get versions(): string[] { return this.variants.map((v) => v.version); }

  /**
   * Try every compatible parser, newest first. Only a total failure is SCHEMA_CHANGED -
   * a single variant failing while another succeeds is normal during a migration.
   */
  parse(payload: unknown, source: MetadataSource = 'NETWORK_JSON'): ParseOutcome {
    const failures: string[] = [];
    for (const variant of this.variants) {
      try {
        return { ok: true, release: variant.parse(payload, source), parserVersion: variant.version };
      } catch (err) {
        failures.push(`${variant.version}: ${err instanceof SchemaMismatchError ? err.message : 'unexpected parser error'}`);
      }
    }
    const detail = failures.join(' | ');
    this.onAlert({
      level: 'error',
      code: 'SOURCE_SCHEMA_CHANGED',
      message: `No parser variant matched the distributor payload (tried ${this.versions.join(', ')}). ${detail}`,
    });
    return { ok: false, reason: 'SCHEMA_CHANGED', parserVersion: this.variants[0]?.version ?? 'none', detail };
  }
}
