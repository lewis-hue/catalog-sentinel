import { describe, it, expect } from 'vitest';
import { assistantConfigFromEnv, buildGroundingContext, parseSseDeltas } from './assistant';
import type { SearchStore } from '@sentinel/search-store';

describe('assistantConfigFromEnv', () => {
  it('prefers Anthropic when ANTHROPIC_API_KEY is set and strips the anthropic/ model prefix', () => {
    const cfg = assistantConfigFromEnv({ ANTHROPIC_API_KEY: 'sk-ant-x', CLAUDE_STANDARD_MODEL: 'anthropic/claude-sonnet-5' } as NodeJS.ProcessEnv);
    expect(cfg).toMatchObject({ provider: 'anthropic', apiKey: 'sk-ant-x', model: 'claude-sonnet-5', baseUrl: 'https://api.anthropic.com/v1' });
  });
  it('uses OpenRouter (OpenAI-compatible) with a Claude model when OPENROUTER_API_KEY is set', () => {
    const cfg = assistantConfigFromEnv({ OPENROUTER_API_KEY: 'sk-or-x', OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1', ASSISTANT_MODEL: 'anthropic/claude-sonnet-5' } as NodeJS.ProcessEnv);
    expect(cfg).toMatchObject({ provider: 'openai', apiKey: 'sk-or-x', model: 'anthropic/claude-sonnet-5', baseUrl: 'https://openrouter.ai/api/v1' });
  });
  it('falls through to OpenRouter when LLM_PROVIDER=anthropic but only an OpenRouter key exists', () => {
    const cfg = assistantConfigFromEnv({ LLM_PROVIDER: 'anthropic', OPENROUTER_API_KEY: 'sk-or-y' } as NodeJS.ProcessEnv);
    expect(cfg?.provider).toBe('openai');
    expect(cfg?.apiKey).toBe('sk-or-y');
  });
  it('falls back to OpenAI when only OPENAI_API_KEY is set', () => {
    expect(assistantConfigFromEnv({ OPENAI_API_KEY: 'sk-o' } as NodeJS.ProcessEnv)?.provider).toBe('openai');
  });
  it('honours LLM_PROVIDER=openai even when an anthropic key exists', () => {
    expect(assistantConfigFromEnv({ LLM_PROVIDER: 'openai', ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o' } as NodeJS.ProcessEnv)?.provider).toBe('openai');
  });
  it('returns null when no provider key is configured', () => {
    expect(assistantConfigFromEnv({} as NodeJS.ProcessEnv)).toBeNull();
  });
});

describe('parseSseDeltas (anthropic Messages stream)', () => {
  it('yields only text_delta text from content_block_delta events', async () => {
    const sse = [
      'event: message_start', 'data: {"type":"message_start"}', '',
      'event: content_block_delta', 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}', '',
      'event: content_block_delta', 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"lo"}}', '',
      'event: message_stop', 'data: {"type":"message_stop"}', '', '',
    ].join('\n');
    let out = '';
    for await (const d of parseSseDeltas(new Response(sse), 'anthropic')) out += d;
    expect(out).toBe('Hello');
  });
});

describe('buildGroundingContext (tenancy + latest-audit focus)', () => {
  const summary = (id: string, createdAt: string) => ({
    id, artist: 'Nova', distributor: 'distrokid', createdAt,
    summary: { tracks: 2, live: 1, notLive: 1, wrongProfile: 0, needsReview: 0 }, stores: ['Deezer'],
  });
  const record = (id: string, userId: string, createdAt: string) => ({
    id, userId, artist: 'Nova', createdAt,
    result: { tracks: [{ title: 'Song', isrc: 'US1', perStore: [{ store: 'Deezer', status: 'not-live' }], lyricsStore: null }] },
  });

  it('scopes to the user, centres on the latest audit, and details only the latest', async () => {
    const gotIds: string[] = [];
    const store = {
      async listForUser(uid: string) {
        expect(uid).toBe('user-1');
        return [summary('a2', '2026-09-19T00:00:00Z'), summary('a1', '2026-09-01T00:00:00Z')] as never;
      },
      async get(id: string) { gotIds.push(id); return record(id, 'user-1', '2026-09-19T00:00:00Z') as never; },
    } as unknown as SearchStore;
    const g = await buildGroundingContext(store, 'user-1');
    expect(g).toContain('this user only');
    expect(g).toContain('The LATEST audit is a2');
    expect(g).toContain('(LATEST)');
    expect(g).toContain('Latest audit detail');
    expect(gotIds).toEqual(['a2']); // only the newest audit is detailed
  });

  it('never surfaces another user\'s record (defence-in-depth on get)', async () => {
    const store = {
      async listForUser() { return [summary('x', '2026-09-19T00:00:00Z')] as never; },
      async get() { return record('x', 'someone-else', '2026-09-19T00:00:00Z') as never; },
    } as unknown as SearchStore;
    const g = await buildGroundingContext(store, 'user-1');
    expect(g).not.toContain('Latest audit detail'); // foreign-owned record is skipped
  });

  it('returns a no-audits message when the user has none (deleted or never run)', async () => {
    const store = { async listForUser() { return [] as never; }, async get() { return null; } } as unknown as SearchStore;
    expect(await buildGroundingContext(store, 'user-1')).toContain('no saved audits');
  });
});
