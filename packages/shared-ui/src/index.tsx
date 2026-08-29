import type { CSSProperties, ReactNode } from 'react';

/**
 * @sentinel/shared-ui, small, dependency-free presentational components used by
 * the dashboard. Server-component friendly (no hooks). Colors are inline so the
 * package needs no CSS pipeline.
 */

const BAND_COLORS: Record<string, string> = {
  confirmed: '#0a875a',
  strong: '#2f9e6b',
  probable: '#c07a00',
  weak: '#c0500f',
  'no-match': '#b3352e',
};

const SEVERITY_COLORS: Record<string, string> = {
  critical: '#b3352e',
  high: '#c0500f',
  medium: '#c07a00',
  low: '#5b6470',
};

const STATUS_COLORS: Record<string, string> = {
  'confirmed-live': '#0a875a',
  present: '#0a875a',
  missing: '#b3352e',
  'present-wrong-profile': '#b3352e',
  'present-duplicate-profile': '#c0500f',
  'present-unplayable': '#c07a00',
  review: '#c07a00',
  'not-selected': '#5b6470',
  'unknown-api-unavailable': '#5b6470',
  'curated-no-guarantee': '#5b6470',
  processing: '#c07a00',
  'removed-takedown': '#b3352e',
};

function pill(bg: string): CSSProperties {
  return {
    background: bg,
    color: '#fff',
    padding: '2px 9px',
    borderRadius: 999,
    fontSize: 12,
    fontWeight: 600,
    whiteSpace: 'nowrap',
    display: 'inline-block',
  };
}

export function ConfidenceBadge({ band, score }: { band: string; score?: number }) {
  return <span style={pill(BAND_COLORS[band] ?? '#5b6470')}>{score != null ? score.toFixed(2) : band}</span>;
}

export function SeverityBadge({ severity }: { severity: string }) {
  return <span style={pill(SEVERITY_COLORS[severity] ?? '#5b6470')}>{severity}</span>;
}

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  return <span style={pill(STATUS_COLORS[status] ?? '#5b6470')}>{label ?? status}</span>;
}

export function StatCard({ label, value, tone }: { label: string; value: ReactNode; tone?: 'good' | 'bad' | 'warn' | 'neutral' }) {
  const color = tone === 'bad' ? '#b3352e' : tone === 'good' ? '#0a875a' : tone === 'warn' ? '#c07a00' : 'inherit';
  return (
    <div
      style={{
        border: '1px solid var(--border, #e4e4e7)',
        borderRadius: 12,
        padding: '16px 18px',
        minWidth: 150,
        background: 'var(--card, transparent)',
      }}
    >
      <div style={{ fontSize: 28, fontWeight: 700, color }}>{value}</div>
      <div style={{ fontSize: 12, color: 'var(--muted, #71717a)', textTransform: 'uppercase', letterSpacing: '.04em', marginTop: 2 }}>
        {label}
      </div>
    </div>
  );
}

export function Card({ title, action, children }: { title?: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <section
      style={{
        border: '1px solid var(--border, #e4e4e7)',
        borderRadius: 14,
        padding: 20,
        background: 'var(--card, transparent)',
        marginBottom: 20,
      }}
    >
      {(title || action) && (
        <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h2 style={{ fontSize: 16, margin: 0 }}>{title}</h2>
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div style={{ padding: 32, textAlign: 'center', color: 'var(--muted, #71717a)' }}>{children}</div>;
}

/* ------------------------------------------------------------------ *
 * Catalog-audit primitives. Single source of truth for the platform
 * short-codes, the presence-status → design-system class mapping, CSV
 * export, and the readout/empty blocks repeated across audit pages.
 * The components below use the app's className API (globals.css), so
 * they only render styled inside the web app that ships those tokens.
 * ------------------------------------------------------------------ */

/** Two-letter platform codes for dense pip strips. */
export const PLATFORM_CODE: Record<string, string> = {
  Deezer: 'DZ', 'Apple Music / iTunes': 'AP', 'Apple Music': 'AP', Spotify: 'SP', 'YouTube Music': 'YT',
  Audiomack: 'AM', SoundCloud: 'SC', TIDAL: 'TD', 'Amazon Music': 'AZ', Boomplay: 'BP', Anghami: 'AN', Pandora: 'PD', Napster: 'NP',
  // Remaining DistroKid delivery targets.
  iHeartRadio: 'IH', JioSaavn: 'JS', NetEase: 'NE', Tencent: 'QQ', Qobuz: 'QB', JOOX: 'JX', FLO: 'FL', TikTok: 'TK',
  'Instagram/Facebook': 'IG', Snapchat: 'SN', 'Claro Música': 'CM', TouchTunes: 'TT', 'Kuack Media': 'KM', Adaptr: 'AD', MediaNet: 'MN',
};
export const platformCode = (store: string): string => PLATFORM_CODE[store] ?? store.slice(0, 2).toUpperCase();

/** Per-store presence status → status-pill class. */
export type StatusClass = 'live' | 'gap' | 'wrong' | 'unk';
export const statusClass = (status: string): StatusClass =>
  status === 'live' ? 'live' : status === 'not-live' ? 'gap' : status === 'wrong-profile' ? 'wrong' : 'unk';

/** Quote a CSV field if it contains a comma, quote, or newline. */
export const csvEscape = (v: unknown): string => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
/** Build a CSV from a row matrix and trigger a browser download (client-only). */
export function downloadCsv(filename: string, rows: Array<Array<string | number>>): void {
  const text = rows.map((r) => r.map(csvEscape).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export interface ReadoutStat { value: ReactNode; label: string; tone?: 'ok' | 'warn' | 'bad' }
/** Identity block (eyebrow + name) with a right-aligned stat readout. */
export function Readout({ eyebrow, title, stats, style }: { eyebrow: ReactNode; title: ReactNode; stats: ReadoutStat[]; style?: CSSProperties }) {
  return (
    <div className="cat-identity" style={{ marginBottom: 16, ...style }}>
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h2 className="cat-name" style={{ marginBottom: 2 }}>{title}</h2>
      </div>
      <div className="cat-readout">
        {stats.map((s, i) => (
          <div key={i} className="cat-stat">
            <div className={`cat-stat-n ${s.tone ?? ''}`}>{s.value}</div>
            <div className="cat-stat-k">{s.label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** "No audit run yet" empty state with the standard CTA. */
export function NoAudit({ message, cta = 'Start catalog audit', href = '/connect' }: { message: ReactNode; cta?: string; href?: string }) {
  return (
    <div className="cat-empty">
      <p>{message}</p>
      <a className="btn" href={href} style={{ marginTop: 16 }}>{cta}</a>
    </div>
  );
}
