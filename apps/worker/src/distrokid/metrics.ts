import type { SnapshotStatus } from '@sentinel/browser-assist';
import type { PipelineMetrics, SnapshotRef } from './pipeline';

/**
 * Extraction observability.
 *
 * Counters answer the questions the old logs couldn't: did we ATTEMPT every release, which
 * identifier coverage is failing (UPC vs ISRC vs artwork), is an endpoint drifting, and how long
 * a release takes. Labels carry ids only (tenant/connection/scan/release) — never secrets,
 * bodies, or endpoint values.
 */

export interface ExtractionMetricSnapshot {
  releasesExpected: number;
  releasesAttempted: number;
  releasesCompleted: number;
  releasesFailed: number;
  tracksExtracted: number;
  tracksWithIsrc: number;
  releasesWithUpc: number;
  releasesWithArtwork: number;
  endpointSuccess: Record<string, number>;
  endpointFailure: Record<string, number>;
  schemaDriftCount: number;
  responseTimeoutCount: number;
  steelReconnectCount: number;
  parserVersions: Record<string, number>;
  chunkDurationsMs: number[];
  snapshotStatuses: Record<string, number>;
}

const emptySnapshot = (): ExtractionMetricSnapshot => ({
  releasesExpected: 0, releasesAttempted: 0, releasesCompleted: 0, releasesFailed: 0,
  tracksExtracted: 0, tracksWithIsrc: 0, releasesWithUpc: 0, releasesWithArtwork: 0,
  endpointSuccess: {}, endpointFailure: {}, schemaDriftCount: 0, responseTimeoutCount: 0,
  steelReconnectCount: 0, parserVersions: {}, chunkDurationsMs: [], snapshotStatuses: {},
});

/** In-process metrics. Swap for Prometheus/OTel by implementing the same surface. */
export class InMemoryExtractionMetrics implements PipelineMetrics {
  private snap = emptySnapshot();

  // `_ref` carries tenant/connection/scan ids for a labelled backend (Prometheus/OTel). The
  // in-memory implementation aggregates globally, but the signature matches PipelineMetrics.
  releasesExpected(n: number, _ref?: SnapshotRef): void { this.snap.releasesExpected += n; }
  releasesCompleted(n: number, _ref?: SnapshotRef): void { this.snap.releasesCompleted += n; this.snap.releasesAttempted += n; }
  releasesFailed(n: number, _ref?: SnapshotRef): void { this.snap.releasesFailed += n; this.snap.releasesAttempted += n; }
  chunkDuration(ms: number, _ref?: SnapshotRef): void { this.snap.chunkDurationsMs.push(ms); }
  snapshotStatus(status: SnapshotStatus, _ref?: SnapshotRef): void { this.snap.snapshotStatuses[status] = (this.snap.snapshotStatuses[status] ?? 0) + 1; }

  tracks(extracted: number, withIsrc: number): void { this.snap.tracksExtracted += extracted; this.snap.tracksWithIsrc += withIsrc; }
  releaseCoverage(withUpc: number, withArtwork: number): void { this.snap.releasesWithUpc += withUpc; this.snap.releasesWithArtwork += withArtwork; }
  endpointOutcome(fingerprint: string, ok: boolean): void {
    const bucket = ok ? this.snap.endpointSuccess : this.snap.endpointFailure;
    const short = fingerprint.slice(0, 16);
    bucket[short] = (bucket[short] ?? 0) + 1;
  }
  schemaDrift(): void { this.snap.schemaDriftCount++; }
  responseTimeout(): void { this.snap.responseTimeoutCount++; }
  steelReconnect(): void { this.snap.steelReconnectCount++; }
  parserUsed(version: string): void { this.snap.parserVersions[version] = (this.snap.parserVersions[version] ?? 0) + 1; }

  read(): ExtractionMetricSnapshot { return { ...this.snap, chunkDurationsMs: [...this.snap.chunkDurationsMs] }; }
  get avgChunkMs(): number {
    const d = this.snap.chunkDurationsMs;
    return d.length ? Math.round(d.reduce((a, b) => a + b, 0) / d.length) : 0;
  }
  /** Endpoint success rate — the signal that an endpoint is drifting before it fully breaks. */
  endpointSuccessRate(fingerprint: string): number {
    const short = fingerprint.slice(0, 16);
    const ok = this.snap.endpointSuccess[short] ?? 0;
    const bad = this.snap.endpointFailure[short] ?? 0;
    return ok + bad === 0 ? 0 : ok / (ok + bad);
  }
  reset(): void { this.snap = emptySnapshot(); }
}

/** Structured extraction log line. Ids only — never endpoint values, bodies, cookies or tokens. */
export interface ExtractionLogFields {
  tenantId: string;
  connectionId: string;
  scanId: string;
  releaseId?: string;
  /** Sanitized fingerprint (a hash of the endpoint SHAPE), never a URL with values. */
  endpointFingerprint?: string;
  parserVersion?: string;
  outcome: string;
  elapsedMs: number;
}

export function extractionLog(fields: ExtractionLogFields, ref?: SnapshotRef): string {
  return JSON.stringify({
    level: 'info',
    msg: 'distrokid.release.extraction',
    ...(ref ? { distributor: ref.distributor } : {}),
    ...fields,
    endpointFingerprint: fields.endpointFingerprint?.slice(0, 16),
  });
}
