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

/** Display an identity-provider name with a capital first letter ("google" becomes "Google"). */
function formatProvider(provider: string): string {
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 20, padding: '11px 0', borderBottom: '1px solid var(--line-soft)' }}>
      <span style={{ color: 'var(--mist)', fontSize: 13 }}>{label}</span>
      <span style={{ fontSize: 14, fontWeight: 500, textAlign: 'right', wordBreak: 'break-word' }}>{children}</span>
    </div>
  );
}

/**
 * Username is the only self-editable identity field. Email is read-only: it is the federated identity
 * anchor and changing it would break sign-in. Save calls PATCH /api/account; the server validates and
 * writes to Keycloak, and surfaces a taken (409) or invalid (400) username inline.
 */
function UsernameRow({ value, onSaved }: { value: string | null; onSaved: (username: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const begin = () => { setDraft(value ?? ''); setError(''); setEditing(true); };
  const cancel = () => { setEditing(false); setError(''); };

  const trimmed = draft.trim();
  const canSave = !saving && trimmed.length >= 3 && trimmed.length <= 255 && trimmed !== (value ?? '');

  const save = useCallback(async () => {
    setSaving(true);
    setError('');
    try {
      const res = await apiFetch('/api/account', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: trimmed }),
      });
      if (!res.ok) throw new Error(await apiErrorMessage(res, 'Could not update your username.'));
      const data = (await res.json()) as { username: string };
      onSaved(data.username);
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not update your username.');
    } finally {
      setSaving(false);
    }
  }, [trimmed, onSaved]);

  if (!editing) {
    return (
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 20, padding: '11px 0', borderBottom: '1px solid var(--line-soft)' }}>
        <span style={{ color: 'var(--mist)', fontSize: 13 }}>Username</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 14, fontWeight: 500, wordBreak: 'break-word' }}>{value ?? 'not set'}</span>
          <button className="btn ghost" style={{ padding: '4px 12px', fontSize: 12.5 }} onClick={begin}>Edit</button>
        </span>
      </div>
    );
  }

  return (
    <div style={{ padding: '12px 0', borderBottom: '1px solid var(--line-soft)' }}>
      <label htmlFor="username-input" style={{ display: 'block', color: 'var(--mist)', fontSize: 13, marginBottom: 7 }}>Username</label>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          id="username-input"
          value={draft}
          autoFocus
          maxLength={255}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && canSave) save(); if (e.key === 'Escape') cancel(); }}
          style={{ flex: 1, minWidth: 180, padding: '9px 12px', borderRadius: 9, border: '1px solid var(--line)', background: 'var(--panel)', color: 'var(--paper)', fontSize: 14 }}
        />
        <button className="btn" disabled={!canSave} style={{ opacity: canSave ? 1 : 0.6 }} onClick={save}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button className="btn ghost" disabled={saving} onClick={cancel}>Cancel</button>
      </div>
      <p style={{ color: 'var(--mist-2)', fontSize: 12, margin: '8px 0 0' }}>
        Use 3 to 255 characters. Your new username appears across the app the next time you sign in.
      </p>
      {error ? (
        <div className="notice-banner" style={{ background: 'var(--panel)', borderColor: 'var(--wrong-edge)', color: 'var(--wrong)', marginTop: 10 }}>{error}</div>
      ) : null}
    </div>
  );
}

/**
 * Profile / account settings: identity overview, in-app username editing (email read-only), and a
 * confirmed, irreversible full-delete danger zone (all data + login) via DELETE /api/account.
 */
export function ProfileClient() {
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
      window.location.assign('/auth/logout');
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : 'Could not delete your account.');
      setDeleting(false);
    }
  }, []);

  return (
    <div style={{ maxWidth: 600 }}>
      <h1 className="page-title">Profile</h1>
      <p className="page-sub">Manage your identity and account.</p>

      {loading ? (
        <div className="card"><span className="status unk">Loading your account…</span></div>
      ) : error ? (
        <div className="card"><span className="status wrong">{error}</span></div>
      ) : account ? (
        <>
          <div className="card">
            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              <span
                aria-hidden
                style={{ width: 54, height: 54, borderRadius: 14, background: 'var(--brand-tint)', color: 'var(--brand-dim)', display: 'grid', placeItems: 'center', fontSize: 22, fontWeight: 700, fontFamily: 'var(--font-display)', flexShrink: 0 }}
              >
                {(account.username ?? account.email ?? '?').trim().charAt(0).toUpperCase() || '?'}
              </span>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontFamily: 'var(--font-display)', fontSize: 20, fontWeight: 700, letterSpacing: '-0.01em', lineHeight: 1.15 }}>
                  {account.username ?? account.email ?? 'Your account'}
                </div>
                {account.identityProvider ? (
                  <div style={{ color: 'var(--mist)', fontSize: 13, marginTop: 4 }}>Signed in with {formatProvider(account.identityProvider)}</div>
                ) : null}
              </div>
            </div>

            <div style={{ marginTop: 20, borderTop: '1px solid var(--line)', paddingTop: 4 }}>
              <Field label="Email">
                {account.email ?? 'not provided'}
                {account.email ? (
                  <span
                    className={`status ${account.emailVerified ? 'live' : 'gap'}`}
                    style={{ marginLeft: 8, fontSize: 11, padding: '1px 8px' }}
                  >
                    {account.emailVerified ? 'verified' : 'unverified'}
                  </span>
                ) : null}
              </Field>
              <UsernameRow value={account.username} onSaved={(username) => setAccount((a) => (a ? { ...a, username } : a))} />
            </div>

            {account.identityProvider ? (
              <p style={{ color: 'var(--mist-2)', fontSize: 12.5, margin: '16px 0 0' }}>
                Your email, password, and two-factor authentication are managed in your {formatProvider(account.identityProvider)} account.
              </p>
            ) : null}
          </div>

          <div className="card" style={{ borderColor: 'var(--wrong-edge)', background: 'var(--wrong-tint)' }}>
            <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 15, color: 'var(--wrong)', marginBottom: 6 }}>Delete account</div>
            <p style={{ margin: '0 0 14px', fontSize: 13.5, color: 'var(--paper)', maxWidth: '58ch' }}>
              This permanently erases your catalogue, scans, store checks, and distributor connections, and removes your login. It cannot be undone.
            </p>
            <label style={{ display: 'block', fontSize: 12.5, color: 'var(--mist)', marginBottom: 6 }}>
              Type <strong style={{ color: 'var(--paper)' }}>DELETE</strong> to confirm
            </label>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder="DELETE"
                aria-label="Type DELETE to confirm"
                style={{ padding: '9px 12px', borderRadius: 9, border: '1px solid var(--wrong-edge)', background: 'var(--panel)', color: 'var(--paper)', maxWidth: 150, fontSize: 14 }}
              />
              <button
                className="btn"
                style={{ background: confirmText === 'DELETE' && !deleting ? 'var(--wrong)' : 'var(--wrong-edge)', borderColor: 'var(--wrong)', color: '#fff', opacity: confirmText === 'DELETE' && !deleting ? 1 : 0.7 }}
                disabled={confirmText !== 'DELETE' || deleting}
                onClick={deleteAccount}
              >
                {deleting ? 'Deleting…' : 'Delete my account'}
              </button>
            </div>
            {deleteError ? (
              <div className="notice-banner" style={{ background: 'var(--panel)', borderColor: 'var(--wrong-edge)', color: 'var(--wrong)', marginTop: 12 }}>{deleteError}</div>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
