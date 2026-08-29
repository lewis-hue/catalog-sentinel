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
