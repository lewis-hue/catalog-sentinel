'use client';

import type { ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { AuthControls } from './AuthControls';
import { SideNav } from './SideNav';

/** Keep the public authentication entry separate from the authenticated application chrome. */
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  if (pathname === '/sign-in') return <>{children}</>;

  return (
    <>
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <div className="layout">
        <aside className="sidebar">
          <div className="brand">
            <span className="mark" aria-hidden>
              <svg viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round">
                <circle cx="12" cy="12" r="8.5" opacity="0.5" />
                <circle cx="12" cy="12" r="4" />
                <path d="M12 12 18 6" />
              </svg>
            </span>
            <span className="name">
              Catalog Sentinel
              <small>Catalog operations</small>
            </span>
          </div>

          <SideNav />

          <div className="nav-spacer" />
          <div className="rail-foot">
            <span className="env">Read-only catalog access</span>
            <div style={{ marginTop: 4 }}>Distributor passwords are never collected</div>
          </div>
        </aside>

        <div>
          <header className="topbar">
            <span className="crumb">Catalog Sentinel</span>
            <span className="spacer" />
            <AuthControls />
          </header>
          <main className="main" id="main-content" tabIndex={-1}>{children}</main>
        </div>
      </div>
    </>
  );
}
