'use client';

import { useEffect, useState } from 'react';

interface AuthSession {
  mode: 'keycloak';
  authenticated: boolean;
  displayName?: string;
  tenantId?: string | null;
}

export function AuthControls() {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [unavailable, setUnavailable] = useState(false);

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

  const initial = (session.displayName ?? '?').trim().charAt(0).toUpperCase() || '?';
  return (
    <>
      <div className="ws" title={session.tenantId ? `Tenant: ${session.tenantId}` : undefined}>
        <span className="avatar">{initial}</span>
        {session.displayName}
      </div>
      <form action="/auth/logout" method="post">
        <button className="btn ghost" type="submit">Sign out</button>
      </form>
    </>
  );
}
