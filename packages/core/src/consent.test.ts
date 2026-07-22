import { describe, it, expect } from 'vitest';
import { requireConsent, isConsentValid, ConsentError } from './consent';
import type { ConsentGrant } from './entities';
import type { ConsentGrantId, UserId, WorkspaceId } from './ids';

function grant(overrides: Partial<ConsentGrant> = {}): ConsentGrant {
  return {
    id: 'cg_1' as ConsentGrantId,
    workspaceId: 'ws_1' as WorkspaceId,
    grantedByUserId: 'usr_1' as UserId,
    scopes: ['read-distributor-catalog', 'read-dsp-catalog'],
    purpose: 'Audit Audiomack coverage',
    retentionDays: 30,
    grantedAt: '2026-07-01T00:00:00.000Z',
    expiresAt: '2026-08-01T00:00:00.000Z',
    revokedAt: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

const at = new Date('2026-07-07T00:00:00.000Z');

describe('consent enforcement', () => {
  it('treats a valid, in-scope grant as usable', () => {
    expect(isConsentValid(grant(), at)).toBe(true);
    expect(() => requireConsent(grant(), ['read-dsp-catalog'], at)).not.toThrow();
  });

  it('rejects a missing grant', () => {
    expect(isConsentValid(null, at)).toBe(false);
    expect(() => requireConsent(null, ['read-dsp-catalog'], at)).toThrow(ConsentError);
  });

  it('rejects a revoked grant', () => {
    const g = grant({ revokedAt: '2026-07-05T00:00:00.000Z' });
    expect(() => requireConsent(g, ['read-dsp-catalog'], at)).toThrow(ConsentError);
  });

  it('rejects an expired grant', () => {
    const g = grant({ expiresAt: '2026-07-05T00:00:00.000Z' });
    expect(() => requireConsent(g, ['read-dsp-catalog'], at)).toThrow(/expired/i);
  });

  it('rejects when a required scope is not granted', () => {
    try {
      requireConsent(grant(), ['browser-assist'], at);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ConsentError);
      expect((e as ConsentError).missingScopes).toContain('browser-assist');
    }
  });
});
