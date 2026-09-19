'use client';

import { type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { TenantProvider } from './shell/tenant-context';
import { EditorialShell } from './shell/EditorialShell';

/**
 * Application chrome entry. Keeps the public pages free of chrome (auth pages, and the signed-out
 * landing at `/`), and otherwise wraps every view in the editorial shell (header, catalogue rail,
 * command menu, tenant switcher, account menu, inspector). The shell renders the `#main-content`
 * landmark itself; the public pages render their own.
 */
export function AppShell({ children, authed }: { children: ReactNode; authed: boolean }) {
  const pathname = usePathname();
  const bare = pathname === '/sign-in' || pathname === '/sign-up' || (pathname === '/' && !authed);
  if (bare) return <>{children}</>;

  return (
    <>
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <TenantProvider>
        <EditorialShell>{children}</EditorialShell>
      </TenantProvider>
    </>
  );
}
