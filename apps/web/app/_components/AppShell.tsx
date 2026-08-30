'use client';

import { type ReactNode, useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { AuthControls } from './AuthControls';
import { SideNav } from './SideNav';

const NAV_COLLAPSED_KEY = 'sentinel:nav-collapsed';

// Route -> human label for the breadcrumb trail. Mirrors the side-nav labels.
const ROUTE_LABELS: Record<string, string> = {
  '/': 'Overview',
  '/scorecard': 'Health score',
  '/catalogue': 'Catalogue',
  '/catalog': 'Store health',
  '/identity': 'Identity guardian',
  '/alerts': 'Release alerts',
  '/history': 'Audit history',
  '/connect': 'Connect distributor',
  '/fixer': 'One-click fixer',
  '/review': 'Manual review',
  '/support': 'Support center',
  '/profile': 'Profile',
};

function labelFor(pathname: string): string {
  const base = pathname.split('?')[0] ?? '/';
  return ROUTE_LABELS[base] ?? (base.replace(/^\//, '').replace(/-/g, ' ') || 'Overview');
}

/** Breadcrumb trail rendered as pills: a home pill plus the current page. */
function Breadcrumbs({ pathname }: { pathname: string }) {
  const base = pathname.split('?')[0] ?? '/';
  const atHome = base === '/';
  return (
    <nav className="crumbs" aria-label="Breadcrumb">
      <Link href="/" className={`pill${atHome ? ' current' : ''}`} aria-current={atHome ? 'page' : undefined}>
        Catalog Sentinel
      </Link>
      {atHome ? null : (
        <>
          <span className="sep" aria-hidden>›</span>
          <span className="pill current" aria-current="page">{labelFor(base)}</span>
        </>
      )}
    </nav>
  );
}

/** Keep the public authentication entry separate from the authenticated application chrome. */
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);

  // Hydrate the collapse preference after mount (server render is always expanded).
  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(NAV_COLLAPSED_KEY) === '1');
    } catch {
      /* localStorage unavailable, stay expanded */
    }
  }, []);

  const toggleNav = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(NAV_COLLAPSED_KEY, next ? '1' : '0');
      } catch {
        /* ignore persistence failures */
      }
      return next;
    });
  };

  if (pathname === '/sign-in') return <>{children}</>;

  return (
    <>
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <div className={`layout${collapsed ? ' nav-collapsed' : ''}`}>
        <aside className="sidebar">
          <div className="brand">
            <span className="name">
              Catalog Sentinel
              <small>Catalog operations</small>
            </span>
          </div>

          <SideNav />

          <div className="nav-spacer" />
        </aside>

        <div>
          <header className="topbar">
            <button
              type="button"
              className="nav-toggle"
              onClick={toggleNav}
              aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
              aria-expanded={!collapsed}
              title={collapsed ? 'Expand navigation' : 'Collapse navigation'}
            >
              {collapsed ? '»' : '«'}
            </button>
            <Breadcrumbs pathname={pathname} />
            <span className="spacer" />
            <AuthControls />
          </header>
          <main className="main" id="main-content" tabIndex={-1}>{children}</main>
        </div>
      </div>
    </>
  );
}
