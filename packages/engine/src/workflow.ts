import {
  requireConsent,
  stableId,
  systemClock,
  type Clock,
  type ConsentGrant,
  type ScanRun,
  type SupportPacket,
  type WorkspaceId,
} from '@sentinel/core';
import {
  createDistributorAdapter,
  type ArtistProfileCandidate,
  type DSPAdapter,
  type DistributorAdapter,
} from '@sentinel/adapters';
import { buildSupportPacket, type PacketRow, type SupportPacketData } from '@sentinel/reports';
import { maskEmail } from '@sentinel/security';
import type { Repository } from '@sentinel/db';
import { mapDistributorSnapshot } from './mapping';
import { runAudiomackAudit, type AudiomackAuditResult, type ClassifiedTrack } from './audiomack-audit';
import type { ObjectStore } from './object-store';

export interface FindMissingAudiomackInput {
  workspaceId: string;
  artistName: string;
  distributorCsvText: string;
  audiomackSlug?: string;
  audiomackUrl?: string;
  distributorAccountEmail?: string;
  consentGrant: ConsentGrant;
  /** Concrete DSP adapter. Runtime composition must provide a real upstream implementation. */
  audiomackAdapter: DSPAdapter;
  distributorAdapter?: DistributorAdapter;
  /** Durable catalog and audit repository. Runtime callers must provide it explicitly. */
  repo: Repository;
  /** Durable encrypted artifact store. Runtime callers must provide it explicitly. */
  objectStore: ObjectStore;
  clock?: Clock;
}

export interface PacketSummary {
  id: string;
  template: string;
  subject: string;
  missingCount: number;
  artifacts: Array<{ format: string; ref: string; byteSize: number }>;
  bodyMarkdown: string;
}

export interface FindMissingAudiomackResult {
  scanRunId: string;
  workspaceId: string;
  artistName: string;
  audiomackProfileUrl: string | null;
  audit: {
    audiomackUploadsScanned: number;
    audiomackScanComplete: boolean;
    totalExpected: number;
    counts: AudiomackAuditResult['counts'];
    issueCount: number;
  };
  missing: ClassifiedTrack[];
  classified: ClassifiedTrack[];
  packets: PacketSummary[];
}

const AUDIOMACK_URL = 'https://audiomack.com/';

/**
 * Flagship workflow (PRD §H): "Find Missing Audiomack Songs". Consent-gated,
 * idempotent, and explicitly composed with an upstream adapter. Produces the
 * DistroKid reinstatement packet plus an optional Audiomack verification packet.
 */
export async function findMissingAudiomackSongs(input: FindMissingAudiomackInput): Promise<FindMissingAudiomackResult> {
  const clock = input.clock ?? systemClock;
  const ws = input.workspaceId as WorkspaceId;
  const objectStore = input.objectStore;
  const repo = input.repo;

  // 1. Consent is REQUIRED before any scan (enforced + tested).
  requireConsent(input.consentGrant, ['read-distributor-catalog', 'read-dsp-catalog', 'generate-reports'], clock.now());

  // 2. Ingest the distributor catalog (DistroKid CSV mode).
  const distributor =
    input.distributorAdapter ?? createDistributorAdapter('distrokid', { distroKid: { mode: 'csv-import', clockIso: clock.nowIso } });
  const distSnapshot = await distributor.discoverCatalog({ csvText: input.distributorCsvText, artistName: input.artistName });
  const { snapshot, releases, tracks } = mapDistributorSnapshot(distSnapshot, input.workspaceId, clock);

  repo.snapshots.put(snapshot);
  for (const r of releases) repo.releases.put(r);
  for (const t of tracks) repo.tracks.put(t);

  // 3. Resolve + scan the confirmed Audiomack profile.
  const audiomack = input.audiomackAdapter;
  const profile = await resolveAudiomackProfile(audiomack, input);
  const audiomackSnapshot = await audiomack.listArtistCatalog({
    profile: profile ?? {
      platform: 'audiomack',
      externalId: null,
      slug: input.audiomackSlug ?? null,
      url: input.audiomackUrl ?? null,
      name: input.artistName,
      confidence: 0.5,
    },
  });

  // 4. Audit: classify every expected track, produce issues + evidence.
  const audit = await runAudiomackAudit({
    workspaceId: input.workspaceId,
    releases,
    tracks,
    audiomackSnapshot,
    audiomackAdapter: audiomack,
    canonicalArtistName: input.artistName,
    clock,
  });

  for (const i of audit.issues) repo.issues.put(i);
  for (const e of audit.evidence) repo.evidence.put(e);

  // 5. Build support packets from the missing (and off-profile) tracks.
  const audiomackProfileUrl = audiomackSnapshot.artistProfile?.url ?? input.audiomackUrl ?? (input.audiomackSlug ? AUDIOMACK_URL + input.audiomackSlug : null);
  const accountRef = input.distributorAccountEmail ? maskEmail(input.distributorAccountEmail) : `${input.artistName} (DistroKid account)`;
  const scannedAtIso = audiomackSnapshot.capturedAt;

  const missingRows = toPacketRows(audit.classified, ['missing'], audit.audiomackUploadsScanned);
  const packets: PacketSummary[] = [];

  const distroPacketData: SupportPacketData = {
    template: 'distrokid-missing-audiomack',
    targetAudience: 'distributor',
    targetProvider: 'distrokid',
    artistName: input.artistName,
    distributorAccountRef: accountRef,
    audiomackProfileUrl,
    affectedPlatform: 'audiomack',
    scanTimestamp: scannedAtIso,
    rows: missingRows,
  };
  packets.push(await persistPacket(distroPacketData, ws, objectStore, repo, clock));

  // Optional Audiomack-side verification packet (PRD §H.10).
  const audiomackPacketData: SupportPacketData = { ...distroPacketData, template: 'audiomack-verify', targetAudience: 'dsp', targetProvider: 'audiomack' };
  packets.push(await persistPacket(audiomackPacketData, ws, objectStore, repo, clock));

  // 6. Record a ScanRun (idempotent key) + audit trail.
  const scanRunId = stableId<'ScanRunId'>('run', input.workspaceId, 'find-missing-audiomack', snapshot.capturedAt);
  {
    const run: ScanRun = {
      id: scanRunId,
      scanJobId: stableId<'ScanJobId'>('job', input.workspaceId, 'find-missing-audiomack'),
      workspaceId: ws,
      status: audit.audiomackScanComplete ? 'succeeded' : 'partial',
      startedAt: clock.nowIso(),
      finishedAt: clock.nowIso(),
      idempotencyKey: `${input.workspaceId}:find-missing-audiomack:${snapshot.capturedAt}`,
      stats: {
        expected: audit.totalExpected,
        missing: audit.counts.missing,
        present: audit.counts.present,
        issues: audit.issues.length,
      },
      error: null,
      createdAt: clock.nowIso(),
      updatedAt: clock.nowIso(),
    };
    repo.scanRuns.put(run);
  }

  return {
    scanRunId,
    workspaceId: input.workspaceId,
    artistName: input.artistName,
    audiomackProfileUrl,
    audit: {
      audiomackUploadsScanned: audit.audiomackUploadsScanned,
      audiomackScanComplete: audit.audiomackScanComplete,
      totalExpected: audit.totalExpected,
      counts: audit.counts,
      issueCount: audit.issues.length,
    },
    missing: audit.classified.filter((c) => c.status === 'missing'),
    classified: audit.classified,
    packets,
  };
}

async function resolveAudiomackProfile(
  audiomack: DSPAdapter,
  input: FindMissingAudiomackInput,
): Promise<ArtistProfileCandidate | null> {
  const candidates = await audiomack.resolveArtist({ slug: input.audiomackSlug, url: input.audiomackUrl, name: input.artistName });
  return candidates[0] ?? null;
}

function toPacketRows(classified: ClassifiedTrack[], statuses: ClassifiedTrack['status'][], uploadsScanned: number): PacketRow[] {
  return classified
    .filter((c) => statuses.includes(c.status))
    .map((c) => ({
      releaseTitle: c.releaseTitle,
      trackTitle: c.trackTitle,
      isrc: c.isrc,
      upc: c.upc,
      distributorUrl: c.distributorUrl,
      releaseDate: c.releaseDate,
      expectedStatus: 'Selected for Audiomack (opted in)',
      evidence: c.evidenceNote || `Absent from ${uploadsScanned} scanned uploads`,
      confidence: c.confidence,
      confidenceBand: c.confidenceBand,
      reasonCode: c.reasonCode ?? 'MISSING_ON_PLATFORM',
      severity: 'high',
      remediation: 'Ask DistroKid to redeliver/reinstate this release to Audiomack, or confirm a delivery failure.',
    }));
}

async function persistPacket(
  data: SupportPacketData,
  ws: WorkspaceId,
  objectStore: ObjectStore,
  repo: Repository,
  clock: Clock,
): Promise<PacketSummary> {
  const generated = buildSupportPacket(data);
  const packetId = stableId<'SupportPacketId'>('pkt', ws, data.template);
  const artifactRefs: PacketSummary['artifacts'] = [];

  for (const artifact of generated.artifacts) {
    const stored = await objectStore.put(`${ws}/${packetId}/${artifact.filename}`, artifact.content);
    artifactRefs.push({ format: artifact.format, ref: stored.ref, byteSize: stored.byteSize });
  }

  {
    const record: SupportPacket = {
      id: packetId,
      workspaceId: ws,
      template: data.template,
      targetAudience: data.targetAudience,
      targetProvider: data.targetProvider as SupportPacket['targetProvider'],
      title: generated.subject,
      subject: generated.subject,
      bodyMarkdown: generated.bodyMarkdown,
      issueIds: [],
      artifactRefs: artifactRefs.map((a) => ({ format: a.format as 'csv' | 'html' | 'json' | 'pdf', ref: a.ref, byteSize: a.byteSize })),
      createdAt: clock.nowIso(),
      updatedAt: clock.nowIso(),
    };
    repo.packets.put(record);
  }

  return {
    id: packetId,
    template: data.template,
    subject: generated.subject,
    missingCount: generated.missingCount,
    artifacts: artifactRefs,
    bodyMarkdown: generated.bodyMarkdown,
  };
}
