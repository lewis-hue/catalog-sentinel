/**
 * Minimal, dependency-free RFC-4180-ish CSV parser/serializer. Handles quoted
 * fields, escaped quotes (""), embedded commas/newlines, and CRLF/LF endings.
 * Sufficient for distributor exports; swap for a streaming parser at scale.
 */

export interface ParsedCsv {
  headers: string[];
  rows: Array<Record<string, string>>;
}

export function parseCsv(text: string): ParsedCsv {
  const records = parseCsvRecords(text);
  if (records.length === 0) return { headers: [], rows: [] };
  const headers = (records[0] ?? []).map((h) => h.trim());
  const rows: Array<Record<string, string>> = [];
  for (let i = 1; i < records.length; i++) {
    const rec = records[i]!;
    if (rec.length === 1 && rec[0] === '') continue; // skip blank lines
    const row: Record<string, string> = {};
    for (let c = 0; c < headers.length; c++) {
      row[headers[c]!] = (rec[c] ?? '').trim();
    }
    rows.push(row);
  }
  return { headers, rows };
}

/** Low-level: parse into an array of raw string cells per record. */
export function parseCsvRecords(text: string): string[][] {
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  const src = text.replace(/\r\n?/g, '\n');

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      record.push(field);
      field = '';
    } else if (ch === '\n') {
      record.push(field);
      records.push(record);
      record = [];
      field = '';
    } else {
      field += ch;
    }
  }
  // Flush trailing field/record if the file did not end with a newline.
  if (field !== '' || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records;
}

function escapeCell(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** Serialize rows to CSV given an explicit, ordered column list. */
export function toCsv(columns: string[], rows: Array<Record<string, string | number | null | undefined>>): string {
  const lines: string[] = [columns.map(escapeCell).join(',')];
  for (const row of rows) {
    lines.push(columns.map((col) => escapeCell(String(row[col] ?? ''))).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}
