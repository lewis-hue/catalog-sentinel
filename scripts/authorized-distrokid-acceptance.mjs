#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

const args = process.argv.slice(2);
function argument(name) {
  const index = args.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`--${name} requires a value`);
  return value;
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function safeBaseUrl() {
  const url = new URL(requiredEnvironment('SENTINEL_BASE_URL'));
  const loopback = new Set(['localhost', '127.0.0.1', '::1']).has(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('SENTINEL_BASE_URL must use HTTPS (HTTP is allowed only for loopback)');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url;
}

function authenticationHeaders() {
  const token = process.env.SENTINEL_ACCEPTANCE_TOKEN?.trim();
  const cookie = process.env.SENTINEL_ACCEPTANCE_COOKIE?.trim();
  if (Boolean(token) === Boolean(cookie)) {
    throw new Error('Set exactly one of SENTINEL_ACCEPTANCE_TOKEN or SENTINEL_ACCEPTANCE_COOKIE');
  }
  return { accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : { cookie }) };
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

const scanId = argument('scan') ?? process.env.SENTINEL_SCAN_ID?.trim();
if (!scanId || !/^[A-Za-z0-9_-]{8,200}$/.test(scanId)) {
  throw new Error('Provide a valid existing scan id with --scan or SENTINEL_SCAN_ID');
}
const baseUrl = safeBaseUrl();
const apiPrefix = (process.env.SENTINEL_API_PREFIX?.trim() || '/bff/api').replace(/\/+$/, '');
if (!apiPrefix.startsWith('/') || apiPrefix.startsWith('//')) throw new Error('SENTINEL_API_PREFIX must be a same-origin path');
const authorizationReference = requiredEnvironment('DISTROKID_ACCOUNT_AUTHORIZATION_REF');
const complianceApprovalId = requiredEnvironment('COMPLIANCE_APPROVAL_ID');
const headers = authenticationHeaders();
const url = new URL(`${apiPrefix}/searches/${encodeURIComponent(scanId)}`, baseUrl);
if (url.origin !== baseUrl.origin) throw new Error('scan URL escaped SENTINEL_BASE_URL');

const response = await fetch(url, {
  method: 'GET',
  headers,
  cache: 'no-store',
  redirect: 'manual',
  signal: globalThis.AbortSignal.timeout(30_000),
});
if (!response.ok) throw new Error(`authorized scan read failed with HTTP ${response.status}`);
const record = await response.json();

const extraction = record?.result?.distributorExtraction;
const completeness = extraction?.completeness;
const tracks = Array.isArray(record?.result?.tracks) ? record.result.tracks : [];
const released = Array.isArray(record?.released) ? record.released : [];
const failures = [];

function requireGate(condition, code, detail) {
  if (!condition) failures.push({ code, detail });
}

requireGate(String(record?.distributor ?? '').toLowerCase() === 'distrokid', 'WRONG_DISTRIBUTOR', 'scan distributor is not DistroKid');
requireGate(extraction?.engine === 'NETWORK_FIRST', 'WRONG_ENGINE', 'terminal extraction evidence is not NETWORK_FIRST');
requireGate(['COMPLETE', 'COMPLETE_WITH_SOURCE_GAPS'].includes(extraction?.status), 'NON_TERMINAL_EXTRACTION', `status=${extraction?.status ?? 'missing'}`);
requireGate(completeness && Number.isSafeInteger(completeness.extractedTracks), 'MISSING_COMPLETENESS', 'terminal completeness counters are missing');
requireGate((completeness?.extractedTracks ?? 0) >= 1_000, 'CATALOGUE_TOO_SMALL', `extractedTracks=${completeness?.extractedTracks ?? 0}`);
requireGate(tracks.length >= 1_000, 'RESULT_TOO_SMALL', `resultTracks=${tracks.length}`);
requireGate(released.length >= 1_000, 'SNAPSHOT_TOO_SMALL', `releasedTracks=${released.length}`);
requireGate(completeness?.extractedTracks === tracks.length, 'TRACK_COUNT_MISMATCH', `extracted=${completeness?.extractedTracks}, result=${tracks.length}`);
requireGate(completeness?.failedReleases === 0, 'FAILED_RELEASES', `failedReleases=${completeness?.failedReleases ?? 'missing'}`);
requireGate(completeness?.skippedReleases === 0, 'SKIPPED_RELEASES', `skippedReleases=${completeness?.skippedReleases ?? 'missing'}`);
requireGate(Array.isArray(completeness?.unresolvedReleaseIds) && completeness.unresolvedReleaseIds.length === 0, 'UNRESOLVED_RELEASES', `count=${completeness?.unresolvedReleaseIds?.length ?? 'missing'}`);
requireGate(completeness?.attemptedReleases === completeness?.expectedReleases, 'RELEASE_ATTEMPT_MISMATCH', `attempted=${completeness?.attemptedReleases}, expected=${completeness?.expectedReleases}`);
requireGate(completeness?.completedReleases === completeness?.expectedReleases, 'RELEASE_COMPLETION_MISMATCH', `completed=${completeness?.completedReleases}, expected=${completeness?.expectedReleases}`);
if (completeness?.expectedTracksKnown) {
  requireGate(completeness.expectedTracks === completeness.extractedTracks, 'EXPECTED_TRACK_MISMATCH', `expected=${completeness.expectedTracks}, extracted=${completeness.extractedTracks}`);
}

const requiredScalars = ['title', 'primaryArtist'];
const evidenceFields = ['isrc', 'upc', 'artworkUrl', 'label', 'releaseDate', 'uploadDate'];
const statusCounts = Object.fromEntries(evidenceFields.map((field) => [field, {}]));
for (let index = 0; index < tracks.length; index += 1) {
  const track = tracks[index];
  for (const field of requiredScalars) {
    requireGate(nonEmptyString(track?.[field]), 'BLANK_REQUIRED_FIELD', `track=${index}, field=${field}`);
  }
  requireGate(Array.isArray(track?.featuredArtists), 'MISSING_FEATURED_ARTIST_SHAPE', `track=${index}`);
  for (const field of evidenceFields) {
    const evidence = track?.metadata?.[field];
    const status = evidence?.status;
    if (typeof status === 'string') {
      statusCounts[field][status] = (statusCounts[field][status] ?? 0) + 1;
    }
    requireGate(Boolean(evidence), 'MISSING_FIELD_EVIDENCE', `track=${index}, field=${field}`);
    requireGate(['PRESENT', 'ABSENT_AT_SOURCE'].includes(status), 'UNCAPTURED_METADATA', `track=${index}, field=${field}, status=${status ?? 'missing'}`);
    requireGate(nonEmptyString(evidence?.source), 'MISSING_METADATA_SOURCE', `track=${index}, field=${field}`);
    requireGate(nonEmptyString(evidence?.capturedAt), 'MISSING_CAPTURE_TIME', `track=${index}, field=${field}`);
    requireGate(nonEmptyString(evidence?.parserVersion), 'MISSING_PARSER_VERSION', `track=${index}, field=${field}`);
    if (status === 'PRESENT') {
      requireGate(nonEmptyString(evidence?.value), 'PRESENT_WITHOUT_VALUE', `track=${index}, field=${field}`);
    }
  }
}

const uniqueFailures = [...new Map(failures.map((failure) => [`${failure.code}:${failure.detail}`, failure])).values()];
const report = {
  schemaVersion: 1,
  kind: 'sentinel-authorized-distrokid-large-catalogue-acceptance',
  passed: uniqueFailures.length === 0,
  checkedAt: new Date().toISOString(),
  targetOrigin: baseUrl.origin,
  scan: {
    id: scanId,
    createdAt: record?.createdAt ?? null,
    finalizedAt: extraction?.finalizedAt ?? null,
    ownerBound: nonEmptyString(record?.ownerUserId),
    tenantBound: nonEmptyString(record?.tenantId),
    workspaceBound: nonEmptyString(record?.artistWorkspaceId),
  },
  approvals: { authorizationReference, complianceApprovalId },
  extraction: {
    engine: extraction?.engine ?? null,
    status: extraction?.status ?? null,
    completeness: completeness ?? null,
    resultTracks: tracks.length,
    releasedSnapshotTracks: released.length,
    metadataStatusCounts: statusCounts,
  },
  expectedTrackTotalKnown: completeness?.expectedTracksKnown === true,
  failures: uniqueFailures,
};

requireGate(report.scan.ownerBound && report.scan.tenantBound && report.scan.workspaceBound, 'UNBOUND_SCAN', 'scan lacks owner, tenant, or workspace binding');
report.failures = [...new Map(failures.map((failure) => [`${failure.code}:${failure.detail}`, failure])).values()];
report.passed = report.failures.length === 0;

const canonical = JSON.stringify(report);
report.evidenceSha256 = createHash('sha256').update(canonical).digest('hex');
const serialized = `${JSON.stringify(report, null, 2)}\n`;
const output = argument('out') ?? process.env.SENTINEL_REPORT_PATH?.trim();
if (output) await writeFile(output, serialized, { encoding: 'utf8', flag: 'wx' });
process.stdout.write(serialized);
if (!report.passed) process.exitCode = 1;
