'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { apiFetch, setActiveTenant } from '@/lib/api-client';

/** A tenant the signed-in user may act in, as returned by GET /api/tenants. */
export interface TenantSummary {
  tenantId: string;
  role: string;
  personal: boolean;
}

/** Account facts from GET /api/account, plus the display name from the session. */
export interface AccountInfo {
  subject?: string;
  username?: string;
  email?: string;
  roles?: string[];
}

interface TenantContextValue {
  tenants: TenantSummary[];
  /** The selected tenant id (a shared org, or the personal tenant's id). */
  current: string | null;
  currentTenant: TenantSummary | null;
  setCurrent: (tenantId: string) => void;
  account: AccountInfo | null;
  displayName: string;
  authenticated: boolean;
  ready: boolean;
}

const TenantContext = createContext<TenantContextValue | null>(null);

const STORAGE_KEY = 'sentinel:tenant';

function readSaved(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Scope apiFetch to a tenant. The personal tenant sends no header (unchanged, pre-tenancy behaviour). */
function applyScope(tenants: TenantSummary[], tenantId: string | null): void {
  const chosen = tenants.find((t) => t.tenantId === tenantId);
  setActiveTenant(chosen && !chosen.personal ? chosen.tenantId : null);
}

export function TenantProvider({ children }: { children: ReactNode }) {
  // Set the scope from the saved id during the first render, before any page's fetch effect runs,
  // so a reload restores the selected tenant without a personal-scope flash.
  const [current, setCurrentState] = useState<string | null>(() => {
    const saved = readSaved();
    if (saved) setActiveTenant(saved);
    return saved;
  });
  const [tenants, setTenants] = useState<TenantSummary[]>([]);
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [authenticated, setAuthenticated] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let active = true;
    void (async () => {
      // Session (name + auth state) comes from the BFF's own route, not the API.
      try {
        const res = await fetch('/auth/session', { credentials: 'same-origin', cache: 'no-store' });
        const s = (await res.json()) as { authenticated?: boolean; displayName?: string };
        if (active) {
          setAuthenticated(Boolean(s.authenticated));
          setDisplayName(s.displayName ?? '');
        }
      } catch {
        /* leave defaults; the shell still renders */
      }

      // Tenants + account. Both tolerate a backend without the tenancy routes (404) by degrading to
      // a personal-only scope with no switcher, so the shell never breaks on an older API.
      const [tenantList, acct] = await Promise.all([
        apiFetch('/api/tenants')
          .then((r) => (r.ok ? (r.json() as Promise<{ tenants: TenantSummary[] }>) : { tenants: [] }))
          .catch(() => ({ tenants: [] as TenantSummary[] })),
        apiFetch('/api/account')
          .then((r) => (r.ok ? (r.json() as Promise<AccountInfo>) : null))
          .catch(() => null),
      ]);
      if (!active) return;
      const list = tenantList.tenants ?? [];
      setTenants(list);
      setAccount(acct);

      // Reconcile the saved selection against what the user can actually act in.
      const savedValid = current && list.some((t) => t.tenantId === current);
      const fallback = list.find((t) => t.personal)?.tenantId ?? list[0]?.tenantId ?? null;
      const resolved = savedValid ? current : fallback;
      if (resolved !== current) setCurrentState(resolved);
      applyScope(list, resolved);
      setReady(true);
    })();
    return () => { active = false; };
    // Runs once on mount; `current` is only read for reconciliation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setCurrent = useCallback((tenantId: string) => {
    setCurrentState(tenantId);
    try {
      window.localStorage.setItem(STORAGE_KEY, tenantId);
    } catch {
      /* ignore persistence failures */
    }
    setTenants((list) => {
      applyScope(list, tenantId);
      return list;
    });
  }, []);

  const currentTenant = useMemo(
    () => tenants.find((t) => t.tenantId === current) ?? tenants.find((t) => t.personal) ?? null,
    [tenants, current],
  );

  const value = useMemo<TenantContextValue>(
    () => ({ tenants, current, currentTenant, setCurrent, account, displayName, authenticated, ready }),
    [tenants, current, currentTenant, setCurrent, account, displayName, authenticated, ready],
  );

  return <TenantContext.Provider value={value}>{children}</TenantContext.Provider>;
}

export function useTenant(): TenantContextValue {
  const ctx = useContext(TenantContext);
  if (!ctx) throw new Error('useTenant must be used within a TenantProvider');
  return ctx;
}
