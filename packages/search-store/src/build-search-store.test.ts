import { describe, expect, it } from 'vitest';
import { buildSearchStore } from './build-search-store';

describe('buildSearchStore database selection', () => {
  it('uses only the canonical migration-owned DATABASE_URL', async () => {
    const deprecatedOnly = buildSearchStore({
      NODE_ENV: 'test',
      SCAN_DATABASE_URL: 'postgresql://legacy.invalid/separate',
    } as NodeJS.ProcessEnv);
    expect(deprecatedOnly.kind).toBe('test-memory');
    expect(deprecatedOnly.pgPool).toBeNull();
    await deprecatedOnly.close();

    const canonical = buildSearchStore({
      DATABASE_URL: 'postgresql://canonical.invalid/sentinel',
    } as NodeJS.ProcessEnv);
    expect(canonical.kind).toBe('postgres');
    expect(canonical.pgPool).not.toBeNull();
    await canonical.close();
  });

  it('fails closed outside tests when the durable database is absent', () => {
    expect(() => buildSearchStore({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toThrow(
      'DATABASE_URL is required',
    );
  });
});
