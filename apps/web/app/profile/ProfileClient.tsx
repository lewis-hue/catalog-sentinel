'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiErrorMessage, apiFetch } from '@/lib/api-client';

interface Account {
  subject: string;
  username: string | null;
  email: string | null;
  emailVerified: boolean;
  identityProvider: string | null;
  roles: string[];
}

/**
 * Profile / account settings. Reads the caller's own identity, links out to the Keycloak account
 * console for edits (name, email, password, 2FA), and offers a confirmed, irreversible full delete
 * (all data + login) via DELETE /api/account.
 */
export function ProfileClient({ accountConsoleUrl }: { accountConsoleUrl: string }) {
  const [account, setAccount] = useState<Account | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [confirmText, setConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await apiFetch('/api/account');
        if (!res.ok) throw new Error(await apiErrorMessage(res, 'Could not load your account.'));
        const data = (await res.json()) as Account;
        if (active) setAccount(data);
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : 'Could not load your account.');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, []);

  const deleteAccount = useCallback(async () => {
    setDeleting(true);
    setDeleteError('');
    try {
      const res = await apiFetch('/api/account', { method: 'DELETE' });
      if (!res.ok) throw new Error(await apiErrorMessage(res, 'Could not delete your account.'));
      // Data + login are gone; end the browser session.
      window.location.assign('/auth/logout');
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : 'Could not delete your account.');
      setDeleting(false);
    }
  }, []);

  if (loading) return <div className="card"><span className="status unk">Loading your account…</span></div>;
  if (error) return <div className="card"><span className="status wrong">{error}</span></div>;
  if (!account) return null;

  const name = account.username ?? account.email ?? 'Your account';
  const initial = name.trim().charAt(0).toUpperCase() || '?';

  return (
    <div style={{ display: 'grid', gap: 16, maxWidth: 640 }}>
      <div>
        <h1 className="page-title" style={{ marginBottom: 4 }}>Profile</h1>
        <p className="page-sub" style={{ marginTop: 0 }}>Your identity and account settings.</p>
      </div>

      <div className="card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
          <span className="avatar" style={{ width: 44, height: 44, fontSize: 18 }}>{initial}</span>
          <div>
            <div style={{ fontWeight: 600, fontSize: 18 }}>{name}</div>
            {account.identityProvider ? <span className="status unk">Signed in with {account.identityProvider}</span> : null}
          </div>
        </div>
        <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '8px 16px', margin: 0 }}>
          <dt style={{ color: 'var(--mist)' }}>Email</dt>
          <dd style={{ margin: 0 }}>{account.email ?? 'not provided'}{account.email ? (account.emailVerified ? ' (verified)' : ' (unverified)') : ''}</dd>
          <dt style={{ color: 'var(--mist)' }}>Username</dt>
          <dd style={{ margin: 0 }}>{account.username ?? 'not set'}</dd>
          <dt style={{ color: 'var(--mist)' }}>Account ID</dt>
          <dd className="mono" style={{ margin: 0, fontSize: 12, wordBreak: 'break-all' }}>{account.subject}</dd>
          <dt style={{ color: 'var(--mist)' }}>Access</dt>
          <dd style={{ margin: 0 }}>{account.roles.join(', ') || 'user'}</dd>
        </dl>
        <div style={{ marginTop: 16 }}>
          <a className="btn" href={accountConsoleUrl} target="_blank" rel="noreferrer">Edit details, password &amp; 2FA</a>
        </div>
      </div>

      <div className="card" style={{ borderColor: 'var(--wrong-edge)' }}>
        <div className="k" style={{ color: 'var(--wrong)', fontFamily: 'var(--font-mono)', fontSize: 11.5, textTransform: 'uppercase', letterSpacing: '0.03em', marginBottom: 4 }}>Danger zone</div>
        <p className="page-sub" style={{ marginTop: 0 }}>
          Deleting your account permanently erases your catalogue, scans, store checks, and distributor connections, and removes your login. This cannot be undone.
        </p>
        <p style={{ marginBottom: 8 }}>Type <strong>DELETE</strong> to confirm.</p>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder="DELETE"
            aria-label="Type DELETE to confirm"
            style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid var(--mist)', background: 'transparent', color: 'inherit', maxWidth: 160 }}
          />
          <button
            className="btn"
            style={{ background: 'var(--wrong)', borderColor: 'var(--wrong)', color: '#fff' }}
            disabled={confirmText !== 'DELETE' || deleting}
            onClick={deleteAccount}
          >
            {deleting ? 'Deleting…' : 'Delete my account'}
          </button>
        </div>
        {deleteError ? (
          <div className="notice-banner" style={{ background: 'var(--wrong-tint)', borderColor: 'var(--wrong-edge)', color: 'var(--wrong)', marginTop: 10 }}>{deleteError}</div>
        ) : null}
      </div>
    </div>
  );
}
