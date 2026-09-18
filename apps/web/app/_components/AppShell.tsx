'use client';

import { type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { TenantProvider } from './shell/tenant-context';
import { EditorialShell } from './shell/EditorialShell';

/**
 * Application chrome entry. Keeps the public authentication page free of chrome, and otherwise wraps
 * every view in the editorial shell (header, catalogue rail, command menu, tenant switcher,
 * account menu, inspector). The shell renders the `#main-content` landmark itself.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  if (pathname === '/sign-in') return <>{children}</>;

  return (
    <>
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <TenantProvider>
        <EditorialShell>{children}</EditorialShell>
      </TenantProvider>
    </>
  );
}
