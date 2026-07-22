import { describe, it, expect } from 'vitest';
import { parseCsv, toCsv } from './csv';

describe('parseCsv', () => {
  it('parses a simple table', () => {
    const { headers, rows } = parseCsv('a,b,c\n1,2,3\n4,5,6\n');
    expect(headers).toEqual(['a', 'b', 'c']);
    expect(rows).toEqual([
      { a: '1', b: '2', c: '3' },
      { a: '4', b: '5', c: '6' },
    ]);
  });

  it('handles quoted fields with commas and escaped quotes', () => {
    const csv = 'title,note\n"Hello, World","She said ""hi"""\n';
    const { rows } = parseCsv(csv);
    expect(rows[0]).toEqual({ title: 'Hello, World', note: 'She said "hi"' });
  });

  it('handles embedded newlines inside quotes and CRLF endings', () => {
    const csv = 'title,lyrics\r\n"Song","line1\nline2"\r\n';
    const { rows } = parseCsv(csv);
    expect(rows[0]?.lyrics).toBe('line1\nline2');
  });

  it('skips blank lines and tolerates a missing trailing newline', () => {
    const { rows } = parseCsv('a\n1\n\n2');
    expect(rows.map((r) => r.a)).toEqual(['1', '2']);
  });

  it('round-trips through toCsv', () => {
    const csv = toCsv(['x', 'y'], [{ x: 'a,b', y: 'c"d' }]);
    const { rows } = parseCsv(csv);
    expect(rows[0]).toEqual({ x: 'a,b', y: 'c"d' });
  });
});
