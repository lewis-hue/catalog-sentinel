import { createStoreScanTargets, prepareStorePresence, scanStorePresence, type ScannableStore } from '@sentinel/adapters';
import { planDeepScan, type PlannerTrack } from './query-planner';
import { ownerOf, type CatalogTrackLike, type PerStoreLike, type ReleasedTrackLike, type SearchRecord, type SearchStore } from '@sentinel/search-store';

export interface DeepScanPresenceDeps {
  store: SearchStore;
  env: NodeJS.ProcessEnv;
  /** Hard cap on tracks per scan (Env: DEEP_SCAN_MAX_TRACKS_PER_SCAN, default 5000). */
  maxTracks?: number;
  /** Tracks per resolver call / checkpoint boundary (Env: DEEP_SCAN_TRACK_CHUNK_SIZE). */
  chunkSize?: number;
  /** Injectable production adapters; tests supply deterministic transport doubles. */
  targets?: ScannableStore[];
  log?: (message: string, extra?: Record<string, unknown>) => void;
}

function configuredInteger(env: NodeJS.ProcessEnv, name: string, override: number | undefined, fallback: number, min: number, max: number): number {
  const raw = override ?? (env[name] === undefined ? fallback : Number(env[name]));
  if (!Number.isSafeInteger(raw) || raw < min || raw > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return raw;
}

function withPlatformWarnings(existing: string[], platform: string, warnings: readonly string[]): string[] {
  const prefix = `DSP ${platform}: `;
  return [
    ...existing.filter((warning) => !warning.startsWith(prefix)),
    ...warnings.map((warning) => `${prefix}${warning}`),
  ];
}

/**
 * Background multi-platform deep scan. It refines fast index results with exact
 * per-track checks and covers confirmation-only platforms via web verification.
 *
 * It runs ONE platform at a time and writes results back to the shared store after each,
 * so the report fills in live and each platform respects its own rate limit. Bounded to
 * DEEP_SCAN_MAX_TRACKS because search providers are quota-metered. Capacity overflow
 * is a terminal error for the attempt; no track is silently dropped.
 */
export async function runStorePresenceDeepScan(searchId: string, deps: DeepScanPresenceDeps, expectedTenantId?: string): Promise<void> {
  const { store, env } = deps;
  const log = deps.log ?? (() => {});
  const rec = await store.get(searchId);
  if (!rec) { log(`deep-scan: search ${searchId} not found`); return; }
  if (expectedTenantId && ownerOf(rec) !== expectedTenantId) {
    throw new Error('presence job tenant does not own the target search record');
  }

  const released: ReleasedTrackLike[] = rec.released?.length
    ? rec.released
    : rec.result.tracks.map((t) => ({ title: t.title, primaryArtist: rec.artist, isrc: t.isrc }));

  // The fast pass only performed index comparison. The deep pass must revisit those
  // providers for exact ISRC/wrong-profile checks; a store column is not proof that
  // its deep verification completed. On retry, pending platforms are authoritative.
  const resumableState = rec.deepScan
    && ['queued', 'running', 'error'].includes(rec.deepScan.status)
    && rec.deepScan.platformsPending.length > 0;
  const resumePending = new Set(resumableState ? rec.deepScan!.platformsPending : []);
  const priorDone = rec.deepScan?.platformsDone ?? [];
  const completed = new Set(priorDone);
  const allTargets = deps.targets ?? createStoreScanTargets(env, { includeWebSearch: true });
  const targets = allTargets.filter((target) => resumePending.size
    ? resumePending.has(target.catalog.store)
    : !completed.has(target.catalog.store));
  const platformNames = targets.map((t) => t.catalog.store);

  const maxTracks = configuredInteger(env, 'DEEP_SCAN_MAX_TRACKS_PER_SCAN', deps.maxTracks, 20_000, 1, 100_000);
  const chunkSize = configuredInteger(env, 'DEEP_SCAN_TRACK_CHUNK_SIZE', deps.chunkSize, 25, 1, 1_000);
  const catalogMaxTracks = configuredInteger(env, 'DSP_CATALOG_MAX_TRACKS_PER_ARTIST', undefined, 20_000, 1, 100_000);
  const catalogFetchConcurrency = configuredInteger(env, 'DSP_CATALOG_FETCH_CONCURRENCY', undefined, 2, 1, 16);
  const maxDistinctArtists = configuredInteger(env, 'DEEP_SCAN_MAX_DISTINCT_ARTISTS', undefined, 5_000, 1, 20_000);

  // Plan: enforce an explicit budget, dedupe estimates, and chunk for checkpoints.
  const plannerTracks: PlannerTrack[] = released.map((t) => ({ title: t.title, primaryArtist: t.primaryArtist, isrc: t.isrc }));
  const plan = planDeepScan({
    tracks: plannerTracks,
    platforms: platformNames,
    maxTracks,
    chunkSize,
  });
  const tracksScanned = plan.tracksToVerify;

  if (!platformNames.length || !tracksScanned) {
    await store.update(searchId, (r) => ({ ...r, deepScan: { ...r.deepScan, status: 'done', platformsPending: [], platformsDone: priorDone, updatedAt: new Date().toISOString(), tracksScanned } }));
    return;
  }

  log(`deep-scan plan: ${searchId} — ${platformNames.length} platform(s) × ${tracksScanned} track(s), ${plan.uniqueQueries} unique queries, ~${plan.estimatedSearchCalls} max search calls, ${plan.chunks.length} chunk(s)`, { platforms: platformNames, skippedOverBudget: plan.skippedOverBudget });
  if (plan.skippedOverBudget > 0) {
    const message = `Deep scan requires ${released.length} tracks but DEEP_SCAN_MAX_TRACKS_PER_SCAN is ${maxTracks}; no track was silently truncated.`;
    await store.update(searchId, (r) => ({
      ...r,
      result: { ...r.result, warnings: [...r.result.warnings.filter((warning) => !warning.startsWith('Deep-scan capacity:')), `Deep-scan capacity: ${message}`] },
      deepScan: {
        ...r.deepScan,
        status: 'error', platformsPending: platformNames, platformsDone: priorDone,
        updatedAt: new Date().toISOString(), tracksScanned: 0, error: message,
      },
    }));
    throw new Error(message);
  }
  await store.update(searchId, (r) => ({
    ...r,
    deepScan: {
      ...r.deepScan,
      status: 'running', platformsPending: platformNames, platformsDone: priorDone,
      startedAt: r.deepScan?.startedAt ?? new Date().toISOString(), updatedAt: new Date().toISOString(), tracksScanned,
      error: undefined,
    },
  }));

  const done: string[] = [...priorDone];
  const failed: Array<{ platform: string; error: string }> = [];
  for (const target of targets) {
    const name = target.catalog.store;
    const verifiedPrefix = resumableState ? (rec.deepScan?.platformTracksVerified?.[name] ?? 0) : 0;
    // Existing fast-pass cells are not deep-scan checkpoints. Only the explicitly
    // persisted contiguous prefix may be reused after a worker retry.
    const perTrackByIndex: Array<PerTrackVerdict | undefined> = rec.result.tracks.map((track, index) => {
      if (index >= verifiedPrefix) return undefined;
      const existing = track.perStore.find((p) => p.store === name);
      return existing ? { ...existing } : undefined;
    });
    try {
      const prepared = await prepareStorePresence({
        expectedArtist: rec.artist,
        releasedTracks: released,
        stores: [target],
        catalogMaxTracks,
        catalogFetchConcurrency,
        maxDistinctArtists,
      });
      for (const chunk of plan.chunks) {
        // A prior attempt may have checkpointed this whole chunk. Do not spend quota twice.
        if (chunk.every((i) => perTrackByIndex[i] !== undefined)) continue;
        const chunkTracks = chunk.map((i) => released[i]!);
        const report = await scanStorePresence({
          expectedArtist: rec.artist,
          releasedTracks: chunkTracks,
          stores: [target],
          prepared,
        });
        if (report.results.length !== chunk.length) throw new Error('platform resolver returned a misaligned track set');
        chunk.forEach((origIdx, j) => {
          const res = report.results[j];
          perTrackByIndex[origIdx] = res ? res.perStore.find((p) => p.store === name) ?? res.perStore[0] : undefined;
        });
        // Durable progress at the chunk boundary. If the worker dies, the next attempt resumes
        // from the first absent cell instead of repeating the whole platform.
        const verifiedThrough = Math.max(...chunk) + 1;
        await store.update(searchId, (r) => {
          const merged = mergePlatform(r, name, perTrackByIndex);
          return {
            ...merged,
            result: { ...merged.result, warnings: withPlatformWarnings(merged.result.warnings, name, report.warnings) },
            deepScan: {
              ...r.deepScan!,
              platformTracksVerified: { ...(r.deepScan?.platformTracksVerified ?? {}), [name]: verifiedThrough },
            },
          };
        });
      }
      if (plan.chunks.flat().some((i) => perTrackByIndex[i] === undefined)) {
        throw new Error('platform resolver returned an incomplete track set');
      }
      log(`deep-scan: ${name} done`);
      if (!done.includes(name)) done.push(name);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      failed.push({ platform: name, error });
      log(`deep-scan: ${name} failed`, { error });
    }
    await store.update(searchId, (r) => ({
      ...r,
      deepScan: {
        ...r.deepScan,
        status: 'running', platformsDone: [...done], platformsPending: platformNames.filter((p) => !done.includes(p)),
        startedAt: r.deepScan?.startedAt, updatedAt: new Date().toISOString(), tracksScanned,
        platformTracksVerified: {
          ...(r.deepScan?.platformTracksVerified ?? {}),
          ...(done.includes(name) ? { [name]: released.length } : {}),
        },
      },
    }));
  }

  if (failed.length) {
    await store.update(searchId, (r) => ({
      ...r,
      deepScan: {
        ...r.deepScan,
        status: 'error', platformsDone: [...done], platformsPending: failed.map((f) => f.platform),
        startedAt: r.deepScan?.startedAt, updatedAt: new Date().toISOString(), tracksScanned,
        error: `${failed.length} platform verification(s) failed and will be retried`,
      },
    }));
    throw new Error(`deep-scan platform failures: ${failed.map((f) => f.platform).join(', ')}`);
  }

  await store.update(searchId, (r) => ({ ...r, deepScan: { ...r.deepScan, status: 'done', platformsDone: [...done], platformsPending: [], startedAt: r.deepScan?.startedAt, updatedAt: new Date().toISOString(), tracksScanned, error: undefined } }));
  log(`deep-scan: ${searchId} complete`);
}

type PerTrackVerdict = { status: string; foundArtist?: string | null; url?: string | null; confidence: number; needsManualReview: boolean; reviewQuery?: string | null };

/** Merge one platform's per-track results into a record (index-aligned) + recompute summary. */
export function mergePlatform(rec: SearchRecord, platform: string, perTrack: Array<{ status: string; foundArtist?: string | null; url?: string | null; confidence: number; needsManualReview: boolean; reviewQuery?: string | null } | undefined>): SearchRecord {
  const tracks: CatalogTrackLike[] = rec.result.tracks.map((t, i) => {
    const p = perTrack[i];
    if (!p) return t;
    const entry: PerStoreLike = { store: platform, status: p.status, foundArtist: p.foundArtist ?? null, url: p.url ?? null, confidence: p.confidence, needsManualReview: p.needsManualReview, reviewQuery: p.reviewQuery ?? null };
    return { ...t, perStore: [...t.perStore.filter((x) => x.store !== platform), entry] };
  });
  const stores = rec.result.stores.includes(platform) ? rec.result.stores : [...rec.result.stores, platform];
  const flat = tracks.flatMap((t) => t.perStore);
  return {
    ...rec,
    result: {
      ...rec.result,
      tracks,
      stores,
      summary: {
        tracks: tracks.length,
        live: flat.filter((p) => p.status === 'live').length,
        notLive: flat.filter((p) => p.status === 'not-live').length,
        wrongProfile: flat.filter((p) => p.status === 'wrong-profile').length,
        needsReview: flat.filter((p) => p.needsManualReview).length,
      },
    },
  };
}
