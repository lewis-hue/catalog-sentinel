'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { apiFetch } from '@/lib/api-client';

const DEV_SESSION_TTL_MS = 20 * 60 * 1000;
const SCOPE = 'distributor:read-catalog';
const CONSENT_DISCLOSURE_VERSION = 'distrokid-read-catalog-2026-07-22.v1';
const CONSENT_RETENTION_DAYS = 30;

interface ConnectSession {
  connectId: string;
  loginUrl: string;
  expiresAt: number;
}

interface ConsentGrant {
  consentId: string;
  scope: string;
  expiresAt: string;
  purpose: string;
  disclosureVersion: string;
  retentionDays: number;
}

interface ScanResult { searchId: string; tracksRead: number; reading?: boolean }
type Phase = 'form' | 'login' | 'scanning' | 'done' | 'expired';

async function responseError(response: Response, fallback: string): Promise<string> {
  const body = (await response.json().catch(() => ({}))) as { error?: unknown };
  return typeof body.error === 'string' && body.error.trim() ? body.error : `${fallback} (HTTP ${response.status}).`;
}

function safeSteelUrl(value: string, approvedOrigins: readonly string[]): string | null {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && approvedOrigins.includes(url.origin)) return url.toString();
    const localDevelopment = process.env.NODE_ENV !== 'production'
      && url.protocol === 'http:'
      && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    return localDevelopment ? url.toString() : null;
  } catch {
    return null;
  }
}

function serverExpiry(value: unknown): number | null {
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed > Date.now()) return parsed;
  }
  // Older local development backends did not return expiresAt. Production never guesses.
  return process.env.NODE_ENV !== 'production' ? Date.now() + DEV_SESSION_TTL_MS : null;
}

function formatRemaining(milliseconds: number): string {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

export function RealConnect({ viewerOrigins }: { viewerOrigins: string[] }) {
  const [artists, setArtists] = useState<string[]>([]);
  const [artistInput, setArtistInput] = useState('');
  const [consented, setConsented] = useState(false);
  const [consent, setConsent] = useState<ConsentGrant | null>(null);
  const [phase, setPhase] = useState<Phase>('form');
  const [session, setSession] = useState<ConnectSession | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [result, setResult] = useState<ScanResult | null>(null);
  const [busy, setBusy] = useState(false);

  const consentExpiry = useMemo(() => {
    if (!consent?.expiresAt) return null;
    const date = new Date(consent.expiresAt);
    return Number.isNaN(date.getTime()) ? null : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }, [consent]);

  useEffect(() => {
    if (!session || phase !== 'login') return;
    const update = () => {
      const next = session.expiresAt - Date.now();
      setRemaining(Math.max(0, next));
      if (next <= 0) {
        setPhase('expired');
        setSession(null);
        setConsented(false);
        setError('The server-issued Steel access window ended. Start a new connection to continue.');
        if (consent) {
          void apiFetch(`/api/consent/${encodeURIComponent(consent.consentId)}/revoke`, { method: 'POST' })
            .then((response) => {
              if (!response.ok) throw new Error('Consent revocation was not confirmed.');
              setConsent(null);
              setNotice('The Steel access window ended and its scoped read consent was revoked.');
            })
            .catch(() => {
              setError(`The Steel access window ended. Consent revocation was not confirmed${consentExpiry ? `; the record expires automatically at ${consentExpiry}` : ''}.`);
            });
        }
      }
    };
    update();
    const interval = window.setInterval(update, 1000);
    return () => window.clearInterval(interval);
  }, [consent, consentExpiry, phase, session]);

  function addArtist(raw: string) {
    const names = raw.split(',').map((name) => name.trim()).filter(Boolean);
    if (!names.length) return;
    setArtists((previous) => [...new Set([...previous, ...names])].slice(0, 100));
    setArtistInput('');
  }

  function removeArtist(name: string) {
    setArtists((previous) => previous.filter((artist) => artist !== name));
  }

  async function start() {
    const roster = [...new Set([...artists, ...(artistInput.trim() ? [artistInput.trim()] : [])])].slice(0, 100);
    if (!roster.length || !consented) return;
    setBusy(true);
    setError('');
    setNotice('');
    let grant: ConsentGrant | null = null;
    try {
      const consentResponse = await apiFetch('/api/consent', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          distributor: 'distrokid',
          scope: SCOPE,
          provider: 'steel',
        }),
      });
      if (!consentResponse.ok) throw new Error(await responseError(consentResponse, 'Consent could not be recorded'));
      grant = (await consentResponse.json()) as ConsentGrant;
      if (grant.scope !== SCOPE) throw new Error('The server returned a different consent scope; no browser session was opened.');
      if (grant.disclosureVersion !== CONSENT_DISCLOSURE_VERSION || grant.retentionDays !== CONSENT_RETENTION_DAYS) {
        throw new Error('The server returned a different consent disclosure or retention policy; no browser session was opened.');
      }
      setConsent(grant);

      const connectResponse = await apiFetch('/api/connect', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ distributor: 'distrokid', artists: roster, consentId: grant.consentId }),
      });
      if (!connectResponse.ok) throw new Error(await responseError(connectResponse, 'Steel could not open a DistroKid session'));
      const opened = (await connectResponse.json()) as { connectId?: unknown; loginUrl?: unknown; provider?: unknown; expiresAt?: unknown };
      const loginUrl = typeof opened.loginUrl === 'string' ? safeSteelUrl(opened.loginUrl, viewerOrigins) : null;
      const expiresAt = serverExpiry(opened.expiresAt);
      if (opened.provider !== 'steel' || typeof opened.connectId !== 'string' || !opened.connectId || !loginUrl || !expiresAt) {
        throw new Error('The server did not return a valid Steel session; the login view was not opened.');
      }

      setArtists(roster);
      setArtistInput('');
      setSession({ connectId: opened.connectId, loginUrl, expiresAt });
      setRemaining(expiresAt - Date.now());
      setPhase('login');
    } catch (cause) {
      let message = cause instanceof Error ? cause.message : 'The DistroKid connection could not be started.';
      if (grant) {
        try {
          const revoked = await apiFetch(`/api/consent/${encodeURIComponent(grant.consentId)}/revoke`, { method: 'POST' });
          if (revoked.ok) setConsent(null);
          else message += ` The consent grant could not be revoked and expires at ${new Date(grant.expiresAt).toLocaleTimeString()}.`;
        } catch {
          message += ` The consent grant could not be revoked and expires at ${new Date(grant.expiresAt).toLocaleTimeString()}.`;
        }
      }
      setError(message);
      setPhase('form');
    } finally {
      setBusy(false);
    }
  }

  async function cancelAndRevoke() {
    if (!session || busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    let steelRevoked = false;
    try {
      const response = await apiFetch(`/api/connect/${encodeURIComponent(session.connectId)}/cancel`, { method: 'POST' });
      if (!response.ok) {
        throw new Error(await responseError(response, 'The server did not confirm Steel session revocation'));
      }
      steelRevoked = true;
      if (consent) {
        const consentResponse = await apiFetch(`/api/consent/${encodeURIComponent(consent.consentId)}/revoke`, { method: 'POST' });
        if (!consentResponse.ok) {
          setSession(null);
          setPhase('form');
          throw new Error(
            `Steel confirmed session termination, but read-consent revocation was not confirmed` +
            `${consentExpiry ? `; that record expires automatically at ${consentExpiry}` : ''}.`,
          );
        }
      }
      setSession(null);
      setConsent(null);
      setPhase('form');
      setConsented(false);
      setNotice('Steel session and scoped read consent revoked. No reusable DistroKid credential was retained.');
    } catch (cause) {
      setError(`${cause instanceof Error ? cause.message : 'Revocation was not confirmed.'}${!steelRevoked ? ' The login view remains open; retry, or leave it unused until its access window expires.' : ''}`);
    } finally {
      setBusy(false);
    }
  }

  async function confirmAndScan() {
    if (!session || remaining <= 0) return;
    setBusy(true);
    setError('');
    setPhase('scanning');
    try {
      const response = await apiFetch(`/api/connect/${encodeURIComponent(session.connectId)}/scan`, { method: 'POST' });
      if (!response.ok) throw new Error(await responseError(response, 'The catalog read could not be started'));
      setResult((await response.json()) as ScanResult);
      setPhase('done');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The catalog read could not be started.');
      setPhase('login');
    } finally {
      setBusy(false);
    }
  }

  async function revokeConsentAfterHandoff() {
    if (!consent || busy) return;
    setBusy(true);
    setError('');
    try {
      const response = await apiFetch(`/api/consent/${encodeURIComponent(consent.consentId)}/revoke`, { method: 'POST' });
      if (!response.ok) throw new Error(await responseError(response, 'Read-consent revocation was not confirmed'));
      setConsent(null);
      setNotice('Scoped read consent revoked. Any in-flight catalog work will stop at its next consent check, and Steel cleanup is handled server-side.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Read-consent revocation was not confirmed.');
    } finally {
      setBusy(false);
    }
  }

  if (phase === 'form' || phase === 'expired') {
    return (
      <div className="card" style={{ maxWidth: 680 }}>
        <p className="hint" style={{ marginTop: 0, marginBottom: 16 }}>
          Saved to your private catalog.
        </p>
        <label className="field-label" htmlFor="artist">Your artist name(s)</label>
        {artists.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
            {artists.map((artist) => (
              <span key={artist} className="pip live" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 999 }}>
                {artist}
                <button type="button" aria-label={`Remove ${artist}`} onClick={() => removeArtist(artist)} style={{ border: 0, background: 'transparent', cursor: 'pointer', color: 'inherit', fontSize: 14, lineHeight: 1 }}>×</button>
              </span>
            ))}
          </div>
        )}
        <input
          id="artist"
          className="field"
          placeholder={artists.length ? 'Add another artist… (Enter)' : 'Artist name · press Enter to add more'}
          value={artistInput}
          onChange={(event) => setArtistInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ',') {
              event.preventDefault();
              addArtist(artistInput);
            }
          }}
          onBlur={() => addArtist(artistInput)}
          style={{ marginBottom: 16 }}
        />

        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 16, cursor: 'pointer' }}>
          <input type="checkbox" checked={consented} onChange={(event) => setConsented(event.target.checked)} style={{ marginTop: 3 }} />
          <span className="rail-sub">
            I authorize Catalog Sentinel to read my DistroKid catalog metadata (<code>{SCOPE}</code>) to verify store
            presence and keep the results for {CONSENT_RETENTION_DAYS} days. It cannot upload, edit, delete, change billing, or collect my password.
          </span>
        </label>

        {notice && <div className="notice-banner" role="status" style={{ borderColor: 'var(--live-edge)', background: 'var(--live-tint)', color: 'var(--live)' }}>{notice}</div>}
        {error && <div className="notice-banner" role="alert" style={{ borderColor: 'var(--wrong-edge)', background: 'var(--wrong-tint)', color: 'var(--wrong)' }}>{error}</div>}
        <button className="btn" disabled={(artists.length === 0 && !artistInput.trim()) || !consented || busy} onClick={() => void start()}>
          {busy ? <><span className="spinner" /> Opening Steel…</> : 'Open Steel and sign in to DistroKid'}
        </button>
      </div>
    );
  }

  if (phase === 'login' && session) {
    return (
      <div className="card">
        <div className="login-callout">
          <div>
            <strong>Sign in to DistroKid in this Steel session.</strong>
            <p>
              Complete DistroKid sign-in and 2FA, then start the import. This viewer has your account&rsquo;s full authority: don&rsquo;t share its link or change account settings. Time remaining: <strong>{formatRemaining(remaining)}</strong>.
            </p>
          </div>
        </div>
        <div className="link-embed" style={{ height: 620 }}>
          <iframe
            src={session.loginUrl}
            title="DistroKid sign-in in Steel"
            style={{ width: '100%', height: '100%', border: 0 }}
            sandbox="allow-downloads allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts"
            referrerPolicy="no-referrer"
            allow="clipboard-read; clipboard-write"
          />
        </div>
        {error && <div className="notice-banner" role="alert" style={{ marginTop: 14, borderColor: 'var(--wrong-edge)', background: 'var(--wrong-tint)', color: 'var(--wrong)' }}>{error}</div>}
        <div style={{ display: 'flex', gap: 12, marginTop: 16, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn" disabled={busy || remaining <= 0} onClick={() => void confirmAndScan()}>
            {busy ? <><span className="spinner" /> Starting catalog read…</> : 'I’m signed in, read my catalog'}
          </button>
          <button className="btn ghost" disabled={busy} onClick={() => void cancelAndRevoke()}>Cancel and revoke Steel session</button>
          <a className="btn ghost" href={session.loginUrl} target="_blank" rel="noopener noreferrer">Open Steel in a new tab ↗</a>
        </div>
        <p className="hint">
          Revocation is reported as complete only after the API confirms Steel terminated the session.
          {consentExpiry ? ` The scoped consent record expires at ${consentExpiry}.` : ''}
        </p>
      </div>
    );
  }

  if (phase === 'scanning') {
    return <div className="cat-empty"><p><span className="spinner" style={{ marginRight: 8 }} />Starting the DistroKid catalog import…</p></div>;
  }

  return (
    <div className="cat-empty">
      <p>
        <strong>Catalog read accepted.</strong> Your catalog was handed to the import pipeline.
        Open the catalog to follow progress; results appear as the pipeline records them.
      </p>
      <div className="row" style={{ gap: 12, marginTop: 16, justifyContent: 'center' }}>
        <Link className="btn" href={result?.searchId ? `/catalog?id=${encodeURIComponent(result.searchId)}` : '/catalog'}>View your catalog →</Link>
        <Link className="btn ghost" href={result?.searchId ? `/review?id=${encodeURIComponent(result.searchId)}` : '/review'}>Review uncertain matches</Link>
        {consent && <button className="btn ghost" type="button" disabled={busy} onClick={() => void revokeConsentAfterHandoff()}>Revoke remaining read consent</button>}
      </div>
      {notice && <p className="hint" role="status">{notice}</p>}
      {error && <p className="hint" role="alert" style={{ color: 'var(--wrong)' }}>{error}</p>}
    </div>
  );
}
