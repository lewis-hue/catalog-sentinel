# Serper Per-Store Lyric Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Replace LRCLIB store-lyric verification with Serper web verification that reports, per song, which lyric-capable stores actually display the lyrics, plus a per-song LyricFind "lyrics distributed" signal.

**Architecture:** A new `WebLyricsResolver` (adapters) mirrors `WebPresenceResolver`'s low-request strategy (one broad `"<artist>" "<title>" lyrics` query + grouped `site:` follow-ups, cached per song). It classifies each lyric-capable store's SERP snippet as `shown | not-shown | unverifiable` and detects the LyricFind page. The existing, separately-triggered lyric-verification worker is rewritten to use it, writing per-store flags + LyricFind to new `DistributorTrackOutcome` columns. The store-presence API merges those flags into the `perStore[]` cells the grid already renders.

**Tech Stack:** TypeScript ESM monorepo, Serper (via existing `SearchBackend`/search-provider), Fastify API, BullMQ worker, Postgres/Prisma, Next.js 15 web.

**Spec:** Agreed in-session 2026-08-30 (per-store lyric flags; Serper-only, LRCLIB removed because it returns wrong data; LyricFind distribution signal; low-request strategy; lyric-capable stores only, others left blank; shown in the store-presence grid; lyric check stays a separate decoupled pass).

## Global Constraints

- NO em dashes and NO AI/Lucide-style icons anywhere (hard rule).
- Never a false "no lyrics": a search miss/outage is `unverifiable`, never `not-shown`. A store shows `not-shown` only when the song is confirmed present on it (has presence) yet no lyric evidence appears.
- Serper budget discipline: reuse the broad + grouped-`site:` pattern and the per-song cache; roughly 1 to 3 lyric requests per song.
- Per-user isolation: all reads/writes stay scoped by the owning subject (tenantId carries the sub).
- LRCLIB is removed from the store-lyric path entirely (resolver, wiring, contracts text, tests).

---

## File Structure

- Create `packages/adapters/src/lyrics/web-lyrics.ts` - `WebLyricsResolver` + lyric-capable store config + snippet classifier + LyricFind detection.
- Modify `packages/adapters/src/index.ts` - export web-lyrics, drop lrclib export.
- Delete `packages/adapters/src/lyrics/lrclib.ts` (+ its test).
- Migration `packages/db/prisma/migrations/2026..._track_store_lyrics/migration.sql` + `schema.prisma` - add `storeLyricsPerStore JSONB`, `lyricfindDistributed BOOLEAN`, `lyricfindUrl TEXT` to `DistributorTrackOutcome`.
- Modify `packages/persistence/src/outcome-repository.ts` - write/read the new columns; new per-store update shape; drop LRCLIB-specific verdict mapping.
- Modify `apps/worker/src/lyrics-verification.ts` - Serper resolver, per-store verdicts + LyricFind, write new columns.
- Modify `packages/search-store/src/search-store.ts` - extend `PerStoreLike` with `lyrics?`; add per-track `lyricfind?`; keep `LyricsStoreLike` only if still referenced, else remove.
- Modify the store-presence API endpoint - merge per-store lyric flags + LyricFind into returned `perStore[]`/track.
- Modify `apps/web/app/catalogue/store-presence.tsx` - per-store lyric badge + per-song LyricFind indicator.

---

## Task 1: WebLyricsResolver + lyric-capable store config

**Files:** Create `packages/adapters/src/lyrics/web-lyrics.ts`; Test `packages/adapters/src/lyrics/web-lyrics.test.ts`.

**Interfaces (Produces):**
```ts
export type StoreLyricStatus = 'shown' | 'not-shown' | 'unverifiable';
export interface SongLyricEvidence {
  perStore: Map<string, StoreLyricStatus>;      // only lyric-capable stores
  lyricfindDistributed: boolean;
  lyricfindUrl: string | null;
}
export interface LyricCapablePlatform { store: string; domains: string[]; lyricPathRe?: RegExp; followUp?: boolean }
export const LYRIC_PLATFORMS: LyricCapablePlatform[];  // Apple Music, Amazon Music, YouTube Music, Deezer, Boomplay, Anghami, ... (stores known to render lyrics)
export class WebLyricsResolver {
  constructor(search: SearchBackend, platforms?: LyricCapablePlatform[]);
  resolve(artist: string, title: string): Promise<SongLyricEvidence>;  // cached per song
}
```

**Consumes:** `SearchBackend` (from `../stores/web-search`), `normalizeTitle`.

- [ ] Broad query `"<artist>" "<title>" lyrics`; grouped `site:` follow-ups (`SITE_GROUP_SIZE` reuse) for lyric-capable stores missing from the broad set.
- [ ] Snippet classifier `snippetShowsLyrics(title, artist, text)`: true when the result is on the store's domain AND the snippet both verifies the song (title + artist tokens, reuse `verifyText`) AND carries a lyric marker (`/\blyrics\b/i`, `/composition\s*&?\s*lyrics/i`, or 6+ consecutive word-tokens of lyric-like text). Precision over recall.
- [ ] LyricFind: a result on `lyrics.lyricfind.com/lyrics/...` matching the song, OR a constructed-slug HEAD check as a fallback, sets `lyricfindDistributed=true` + `lyricfindUrl`.
- [ ] A lyric-capable store with confirmed presence but no lyric evidence => caller maps to `not-shown`; a store absent from all results => `unverifiable` (never `not-shown`). The resolver returns only the stores it saw evidence for; the worker fills the rest using presence.
- [ ] Tests: broad-only hit, grouped follow-up hit, LyricFind detection, non-lyric snippet rejected, outage => empty (unverifiable), request-count assertion (<= 1 + ceil(N/6)).

## Task 2: Schema + outcome-repository per-store lyric storage

**Files:** Migration + `schema.prisma`; Modify `packages/persistence/src/outcome-repository.ts`; Test the repo.

- [ ] Migration adds `storeLyricsPerStore JSONB NOT NULL DEFAULT '{}'`, `lyricfindDistributed BOOLEAN`, `lyricfindUrl TEXT` to `DistributorTrackOutcome`. Keep existing `storeLyricStatus`/`storeHasPlain`/`storeHasSynced` columns for now (repurposed or left, decided in Task 4) to avoid a destructive drop mid-feature.
- [ ] `updateStoreLyrics` signature becomes per-store: `Array<{ trackIndex; perStore: Record<string,StoreLyricStatus>; lyricfindDistributed: boolean; lyricfindUrl: string|null }>`.
- [ ] `CatalogueTrackRow` / read path expose `storeLyricsPerStore` + `lyricfind*` (for the API merge).
- [ ] Repo tests: write + read round-trip of the JSON map + lyricfind fields.

## Task 3: Worker rewrite (Serper, per-store, LyricFind)

**Files:** Modify `apps/worker/src/lyrics-verification.ts`; Modify `apps/worker/src/lyrics-verification-queue.ts` (resolver wiring: build a `SearchBackend` from env like store presence does); Test.

- [ ] Replace the LRCLIB resolver with `WebLyricsResolver`. For each track, `resolve(artist,title)`; combine with the track's known store presence (read from the outcome/search store) to fill `not-shown` for present-but-no-lyric lyric-capable stores; `unverifiable` for unseen.
- [ ] Write per-store map + LyricFind via the new `updateStoreLyrics`. Preserve progress/checkpoint/never-all-unverifiable-throws semantics.
- [ ] Tests: a release with mixed per-store lyric outcomes + LyricFind true/false; outage => unverifiable, not false negatives.

## Task 4: Remove LRCLIB

**Files:** Delete `packages/adapters/src/lyrics/lrclib.ts` + test; `packages/adapters/src/index.ts`; `packages/contracts/src/scan-jobs.ts` (comment text); any `LyricsResolver`/`createLrclibResolver`/`toStoreVerdict` references.

- [ ] Remove exports + dead references; whole-repo typecheck green; no residual `lrclib`/`LRCLIB` in the store-lyric path (comments in unrelated DistroKid-DOM lyric code may stay if accurate).

## Task 5: search-store + API merge

**Files:** Modify `packages/search-store/src/search-store.ts` (`PerStoreLike.lyrics?: StoreLyricStatus`; per-track `lyricfind?: { distributed: boolean; url: string|null }`); Modify the store-presence API endpoint to merge the outcome's per-store lyric map + lyricfind into the returned `perStore[]` cells/track; Tests.

- [ ] Merge keyed by (trackIndex/ISRC/title, store). A cell with no lyric entry stays undefined (renders blank).
- [ ] Endpoint test: perStore cells carry `lyrics`, track carries `lyricfind`.

## Task 6: UI

**Files:** Modify `apps/web/app/catalogue/store-presence.tsx` (+ any shared cell/pip component); Test/typecheck + lint.

- [ ] Per-store cell shows a small lyric marker when `lyrics === 'shown'` (and a muted state for `not-shown`; nothing for undefined/`unverifiable`). No em dashes, no icon fonts, use text/pip styling consistent with the grid.
- [ ] Per-song LyricFind "lyrics distributed" indicator (links `lyricfindUrl` when present).
- [ ] web typecheck + lint + existing tests green.

## Self-Review

- Spec coverage: per-store flags (T1,T2,T5,T6), Serper low-request (T1), LyricFind (T1,T2,T6), LRCLIB removed (T4), never-false-missing (T1,T3), store-presence UI (T5,T6), lyric-capable-only (T1). All covered.
- Type consistency: `StoreLyricStatus` defined once in T1, consumed by T2/T3/T5/T6.
