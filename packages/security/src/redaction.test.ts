import { describe, it, expect } from 'vitest';
import { redact, redactString, maskEmail, isSensitiveKey, REDACTED } from './redaction';

describe('redact', () => {
  it('scrubs sensitive keys wholesale', () => {
    const out = redact({
      username: 'lewis',
      password: 'hunter2',
      apiKey: 'sk-abcdef123456',
      nested: { sessionToken: 'xyz', clientSecret: 'shh' },
    }) as any;
    expect(out.username).toBe('lewis');
    expect(out.password).toBe(REDACTED);
    expect(out.apiKey).toBe(REDACTED);
    expect(out.nested.sessionToken).toBe(REDACTED);
    expect(out.nested.clientSecret).toBe(REDACTED);
  });

  it('scrubs token/secret patterns inside ordinary string values', () => {
    const out = redact({ note: 'call failed with Authorization: Bearer abc.def.ghijklmnop' }) as any;
    expect(out.note).not.toContain('abc.def.ghijklmnop');
    expect(out.note).toContain(REDACTED);
  });

  it('masks emails as PII by default', () => {
    const out = redact({ contact: 'teamkidaflow@gmail.com' }) as any;
    expect(out.contact).toBe('t***@gmail.com');
  });

  it('does not mutate the input and handles cycles', () => {
    const input: any = { a: 1 };
    input.self = input;
    const out = redact(input) as any;
    expect(input.self).toBe(input); // unchanged
    expect(out.self).toBe('[CIRCULAR]');
  });

  it('redactString strips JWTs and provider keys', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dQw4w9WgXcQZ1234567890abcdef';
    expect(redactString(`token ${jwt} here`)).toContain(REDACTED);
    expect(redactString(`token ${jwt} here`)).not.toContain(jwt);
    expect(maskEmail('a.b.c@example.co.uk')).toBe('a***@example.co.uk');
    expect(isSensitiveKey('refresh_token')).toBe(true);
    expect(isSensitiveKey('title')).toBe(false);
  });
});
