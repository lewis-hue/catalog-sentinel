'use client';

import { useEffect, useRef, useState } from 'react';

interface AuthSession {
  mode: 'keycloak';
  authenticated: boolean;
  displayName?: string;
}

/**
 * Top-right account control. When signed in, the avatar is a button that opens a small menu with
 * the account options (Profile, Sign out). Closes on outside click or Escape.
 */
export function AuthControls() {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    fetch('/auth/session', { credentials: 'same-origin', cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok && response.status !== 401) throw new Error('unavailable');
        return response.json() as Promise<AuthSession>;
      })
      .then((value) => { if (active) setSession(value); })
      .catch(() => { if (active) setUnavailable(true); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  if (unavailable) return <span className="status wrong">Authentication unavailable</span>;
  if (!session) return <span className="status unk">Checking session…</span>;
  if (!session.authenticated) {
    return (
      <>
        <a className="btn ghost" href="/auth/register">Create account</a>
        <a className="btn" href="/auth/login">Sign in</a>
      </>
    );
  }

  const name = session.displayName ?? 'Signed-in user';
  const initial = name.trim().charAt(0).toUpperCase() || '?';

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
        onClick={() => setOpen((o) => !o)}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 8, background: 'transparent', border: 'none', cursor: 'pointer', color: 'inherit', padding: 2 }}
      >
        <span className="avatar">{initial}</span>
      </button>
      {open ? (
        <div
          role="menu"
          className="card"
          style={{ position: 'absolute', right: 0, top: 'calc(100% + 8px)', minWidth: 210, zIndex: 60, padding: 6, boxShadow: '0 12px 32px rgba(10,15,30,0.28)' }}
        >
          <div style={{ padding: '8px 10px 10px', borderBottom: '1px solid var(--edge, var(--mist))', marginBottom: 6 }}>
            <div style={{ fontWeight: 600, fontSize: 14, lineHeight: 1.2 }}>{name}</div>
          </div>
          <a role="menuitem" className="btn ghost" href="/profile" style={{ display: 'block', textAlign: 'left', marginBottom: 6 }} onClick={() => setOpen(false)}>
            Profile
          </a>
          <form action="/auth/logout" method="post" style={{ margin: 0 }}>
            <button role="menuitem" type="submit" className="btn ghost" style={{ display: 'block', width: '100%', textAlign: 'left' }}>
              Sign out
            </button>
          </form>
        </div>
      ) : null}
    </div>
  );
}
