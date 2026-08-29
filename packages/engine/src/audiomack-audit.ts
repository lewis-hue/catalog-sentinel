import {
  classifyConfidence,
  reasonMeta,
  stableId,
  type Clock,
  type ConfidenceBand,
  type Issue,
  type IssueEvidence,
  type IssueReasonCode,
  type Release,
  type Severity,
  type Track,
  type WorkspaceId,
} from '@sentinel/core';
import type { ArtistProfileCandidate, DSPAdapter, DSPCatalogSnapshot, RawDSPItem } from '@sentinel/adapters';
import { detectDuplicateIsrcs, matchAgainstCatalog, parseTitle } from '@sentinel/matching';
import { dspItemToItem, trackToItem } from './mapping';

export type AudiomackTrackStatus =
  | 'present'
  | 'present-wrong-profile'
  | 'present-duplicate-profile'
  | 'present-unplayable'
  | 'missing'
  | 'review';

export interface ClassifiedTrack {
  trackId: string;
  releaseId: string;
  trackTitle: string;
  releaseTitle: string;
  isrc: string | null;
  upc: string | null;
  distributorUrl: string | null;
  releaseDate: string | null;
  status: AudiomackTrackStatus;
  confidence: number;
  confidenceBand: ConfidenceBand;
  matchedExternalId: string | null;
  matchedUrl: string | null;
  evidenceNote: string;
  reasonCode: IssueReasonCode | null;
}

export interface AudiomackAuditResult {
  profile: ArtistProfileCandidate | null;
  audiomackUploadsScanned: number;
  audiomackScanComplete: boolean;
  totalExpected: number;
  counts: Record<AudiomackTrackStatus, number>;
  classified: ClassifiedTrack[];
  issues: Issue[];
  evidence: IssueEvidence[];
}

export interface AudiomackAuditInput {
  workspaceId: string;
  releases: Release[];
  tracks: Track[];
  audiomackSnapshot: DSPCatalogSnapshot;
  /** Optional adapter for cross-profile lookups (wrong/duplicate profile). */
  audiomackAdapter?: DSPAdapter;
  canonicalArtistName: string;
  clock: Clock;
}

const AUDIOMACK = 'audiomack' as const;

/** Is this release expected to be on Audiomack (opted-in / selected)? */
export function isExpectedOnAudiomack(release: Release): boolean {
  const selected = release.storeSelections.some(
    (s) => s.platform === AUDIOMACK && (s.status === 'selected' || s.status === 'delivered' || s.status === 'pending'),
  );
  return selected || release.albumExtras.includes('audiomack-opt-in');
}

/**
 * Compare the distributor catalog against the confirmed Audiomack profile and
 * classify every expected track as present / missing / wrong-profile /
 * duplicate-profile / unplayable / review, producing issues + evidence.
 */
export async function runAudiomackAudit(input: AudiomackAuditInput): Promise<AudiomackAuditResult> {
  const { workspaceId, releases, tracks, audiomackSnapshot, clock } = input;
  const ws = workspaceId as WorkspaceId;
  const now = clock.nowIso();
  const scannedAt = audiomackSnapshot.capturedAt;
  const canonicalProfileId = audiomackSnapshot.artistProfile?.externalId ?? null;

  const releaseById = new Map(releases.map((r) => [r.id as string, r]));
  const candidates = audiomackSnapshot.items.map(dspItemToItem);
  const rawByExternalId = new Map<string, RawDSPItem>(audiomackSnapshot.items.map((i) => [i.externalId, i]));

  const classified: ClassifiedTrack[] = [];
  const issues: Issue[] = [];
  const evidence: IssueEvidence[] = [];
  const counts: Record<AudiomackTrackStatus, number> = {
    present: 0,
    'present-wrong-profile': 0,
    'present-duplicate-profile': 0,
    'present-unplayable': 0,
    missing: 0,
    review: 0,
  };

  const scanComplete = audiomackSnapshot.pagination.complete;
  const expectedTracks = tracks.filter((t) => {
    const rel = releaseById.get(t.releaseId as string);
    return rel ? isExpectedOnAudiomack(rel) : false;
  });

  // Workspace-level: profile missing entirely, or connected but zero uploads.
  if (!audiomackSnapshot.artistProfile || (audiomackSnapshot.items.length === 0 && expectedTracks.length > 0)) {
    const { issue, ev } = buildIssue({
      ws,
      reasonCode: 'AUDIOMACK_NOT_CONNECTED',
      severityOverride: 'high',
      trackId: null,
      releaseId: null,
      platform: AUDIOMACK,
      summary: audiomackSnapshot.artistProfile
        ? 'Audiomack profile resolved but has zero uploads while releases are opted in, likely a broken account connection.'
        : 'No Audiomack profile could be resolved for the confirmed slug.',
      confidence: 0.8,
      scannedAt,
      now,
      candidatesConsidered: candidates.length,
      metadata: { warnings: audiomackSnapshot.warnings },
      sourceMode: audiomackSnapshot.sourceMode,
    });
    issues.push(issue);
    evidence.push(ev);
  }

  for (const track of expectedTracks) {
    const rel = releaseById.get(track.releaseId as string)!;
    const subject = trackToItem(track, rel.upc);
    const result = matchAgainstCatalog(subject, candidates, { canonicalArtistProfileId: canonicalProfileId });

    let status: AudiomackTrackStatus;
    let confidence: number;
    let matchedExternalId: string | null = null;
    let matchedUrl: string | null = null;
    let evidenceNote: string;
    let reasonCode: IssueReasonCode | null = null;

    if (result.decision === 'matched' && result.best) {
      matchedExternalId = result.best.candidate.id;
      const raw = rawByExternalId.get(matchedExternalId);
      matchedUrl = raw?.url ?? null;
      if (raw && (raw.status === 'removed-takedown' || raw.status === 'private-unplayable')) {
        status = 'present-unplayable';
        reasonCode = raw.status === 'removed-takedown' ? 'TAKEDOWN_OR_REMOVAL' : 'PROCESSING_DELAY';
        confidence = result.best.score.score;
        evidenceNote = `Found on Audiomack but ${raw.status.replace('-', '/')} (${raw.url ?? 'no url'}).`;
      } else if (result.crossProfile) {
        status = 'present-duplicate-profile';
        reasonCode = 'DUPLICATE_ARTIST_PROFILE';
        confidence = result.best.score.score;
        evidenceNote = `Found on Audiomack under a non-canonical profile (${raw?.url ?? matchedExternalId}).`;
      } else {
        status = 'present';
        confidence = result.best.score.score;
        evidenceNote = `Confirmed on Audiomack (${result.best.score.band}, ${raw?.url ?? matchedExternalId}).`;
      }
    } else if (result.decision === 'review') {
      // Ambiguous match or a wrong-profile lead inside the confirmed catalog.
      status = 'review';
      reasonCode = result.wrongProfileSuspected ? 'WRONG_ARTIST_PROFILE' : 'UNKNOWN_NEEDS_REVIEW';
      confidence = result.best?.score.score ?? 0.5;
      matchedExternalId = result.best?.candidate.id ?? null;
      evidenceNote = result.wrongProfileSuspected
        ? 'A same-title item exists under a different artist, verify the artist profile.'
        : 'A probable match needs manual review before confirming presence.';
    } else {
      // Not in the confirmed profile, check other profiles before calling it missing.
      const cross = await this_findCrossProfile(input, track);
      if (cross) {
        matchedExternalId = cross.externalId;
        matchedUrl = cross.url;
        if (cross.sameArtist) {
          status = 'present-duplicate-profile';
          reasonCode = 'DUPLICATE_ARTIST_PROFILE';
          evidenceNote = `Found under a second Audiomack profile for this artist (${cross.url ?? cross.externalId}).`;
        } else {
          status = 'present-wrong-profile';
          reasonCode = 'WRONG_ARTIST_PROFILE';
          evidenceNote = `Found on Audiomack under a DIFFERENT artist profile (${cross.url ?? cross.externalId}).`;
        }
        confidence = 0.85;
      } else {
        status = 'missing';
        reasonCode = 'MISSING_ON_PLATFORM';
        confidence = scanComplete ? 0.95 : 0.6;
        evidenceNote = scanComplete
          ? `Absent from all ${audiomackSnapshot.items.length} scanned Audiomack uploads and from search.`
          : `Not found in the ${audiomackSnapshot.items.length} uploads scanned before rate-limit backpressure (scan incomplete).`;
      }
    }

    counts[status]++;
    const confidenceBand = classifyConfidence(confidence);
    classified.push({
      trackId: track.id,
      releaseId: rel.id,
      trackTitle: track.title,
      releaseTitle: rel.title,
      isrc: track.isrc,
      upc: rel.upc,
      distributorUrl: rel.distributorUrl,
      releaseDate: rel.releaseDate,
      status,
      confidence,
      confidenceBand,
      matchedExternalId,
      matchedUrl,
      evidenceNote,
      reasonCode,
    });

    // Emit an issue for anything that is not cleanly present.
    if (reasonCode && status !== 'present') {
      const { issue, ev } = buildIssue({
        ws,
        reasonCode,
        severityOverride: reasonCode === 'MISSING_ON_PLATFORM' ? 'high' : undefined,
        trackId: track.id,
        releaseId: rel.id,
        platform: AUDIOMACK,
        summary: `${reasonMeta(reasonCode).title}: "${track.title}" (${rel.title})`,
        confidence,
        scannedAt,
        now,
        candidatesConsidered: candidates.length,
        metadata: { isrc: track.isrc, evidenceNote, matchedExternalId, matchedUrl },
        sourceMode: audiomackSnapshot.sourceMode,
      });
      issues.push(issue);
      evidence.push(ev);
    }

    // Metadata health: missing ISRC on an expected track.
    if (!track.isrc) {
      const { issue, ev } = buildIssue({
        ws,
        reasonCode: 'ISRC_MISSING',
        trackId: track.id,
        releaseId: rel.id,
        platform: null,
        summary: `Missing ISRC: "${track.title}" (${rel.title})`,
        confidence: 1,
        scannedAt,
        now,
        candidatesConsidered: 0,
        metadata: {},
        sourceMode: audiomackSnapshot.sourceMode,
      });
      issues.push(issue);
      evidence.push(ev);
    }
  }

  // Duplicate ISRC across the distributor catalog.
  const dupes = detectDuplicateIsrcs(tracks.map((t) => trackToItem(t, releaseById.get(t.releaseId as string)?.upc ?? null)));
  for (const [isrc, items] of dupes) {
    const { issue, ev } = buildIssue({
      ws,
      reasonCode: 'DUPLICATE_ISRC',
      trackId: null,
      releaseId: null,
      platform: null,
      summary: `ISRC ${isrc} is shared by ${items.length} distinct recordings.`,
      confidence: 1,
      scannedAt,
      now,
      candidatesConsidered: items.length,
      metadata: { isrc, titles: items.map((i) => i.base) },
      sourceMode: audiomackSnapshot.sourceMode,
    });
    issues.push(issue);
    evidence.push(ev);
  }

  return {
    profile: audiomackSnapshot.artistProfile,
    audiomackUploadsScanned: audiomackSnapshot.items.length,
    audiomackScanComplete: scanComplete,
    totalExpected: expectedTracks.length,
    counts,
    classified,
    issues,
    evidence,
  };
}

/** Cross-profile lookup helper (kept as a free function to avoid `this` binding). */
async function this_findCrossProfile(
  input: AudiomackAuditInput,
  track: Track,
): Promise<{ externalId: string; url: string | null; sameArtist: boolean } | null> {
  if (!input.audiomackAdapter) return null;
  const canonicalProfileId = input.audiomackSnapshot.artistProfile?.externalId ?? null;
  // Search by title ONLY (passing artist would match every same-artist upload),
  // then require an exact normalized-title match on a non-canonical profile.
  const targetBase = parseTitle(track.title).base;
  const hits = await input.audiomackAdapter.findTrack({ title: track.title });
  const offProfile = hits.find((h) => h.artistProfileId !== canonicalProfileId && parseTitle(h.title).base === targetBase);
  if (!offProfile) return null;
  const sameArtist = offProfile.primaryArtist.toLowerCase().trim() === input.canonicalArtistName.toLowerCase().trim();
  return { externalId: offProfile.externalId, url: offProfile.url, sameArtist };
}

interface BuildIssueArgs {
  ws: WorkspaceId;
  reasonCode: IssueReasonCode;
  severityOverride?: Severity;
  trackId: string | null;
  releaseId: string | null;
  platform: 'audiomack' | null;
  summary: string;
  confidence: number;
  scannedAt: string;
  now: string;
  candidatesConsidered: number;
  metadata: Record<string, unknown>;
  sourceMode: DSPCatalogSnapshot['sourceMode'];
}

function buildIssue(args: BuildIssueArgs): { issue: Issue; ev: IssueEvidence } {
  const meta = reasonMeta(args.reasonCode);
  const confidenceBand = classifyConfidence(args.confidence);
  const issueId = stableId<'IssueId'>('iss', args.ws, args.reasonCode, args.trackId ?? args.releaseId ?? 'ws');
  const evidenceId = stableId<'EvidenceId'>('ev', issueId);

  const issue: Issue = {
    id: issueId,
    workspaceId: args.ws,
    reasonCode: args.reasonCode,
    severity: args.severityOverride ?? meta.defaultSeverity,
    status: 'open',
    platform: args.platform,
    releaseId: (args.releaseId as Issue['releaseId']) ?? null,
    trackId: (args.trackId as Issue['trackId']) ?? null,
    summary: args.summary,
    confidence: args.confidence,
    confidenceBand,
    evidenceIds: [evidenceId],
    recommendedAction: meta.remediation,
    createdAt: args.now,
    updatedAt: args.now,
  };

  const ev: IssueEvidence = {
    id: evidenceId,
    workspaceId: args.ws,
    issueId,
    snapshotId: null,
    sourceMode: args.sourceMode,
    sourceEndpointCategory: 'audiomack:artist-uploads',
    scannedAt: args.scannedAt,
    normalizedMetadata: args.metadata,
    matchCandidatesConsidered: args.candidatesConsidered,
    confidence: args.confidence,
    confidenceBand,
    reasonCode: args.reasonCode,
    screenshotRef: null,
    remediation: meta.remediation,
    createdAt: args.now,
    updatedAt: args.now,
  };

  return { issue, ev };
}
