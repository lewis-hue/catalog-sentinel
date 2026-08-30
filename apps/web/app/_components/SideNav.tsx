'use client';
import Link from 'next/link';
import { Suspense } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';

const NAV: Array<{ group: string; items: Array<{ href: string; label: string; primary?: boolean }> }> = [
  {
    group: 'Monitor',
    items: [
      { href: '/', label: 'Overview' },
      { href: '/scorecard', label: 'Health score' },
      { href: '/catalogue', label: 'Catalogue' },
      { href: '/catalog', label: 'Store health' },
      { href: '/identity', label: 'Identity guardian' },
      { href: '/alerts', label: 'Release alerts' },
      { href: '/history', label: 'Audit history' },
    ],
  },
  {
    group: 'Workflow',
    items: [
      { href: '/connect', label: 'Connect distributor', primary: true },
      { href: '/fixer', label: 'One-click fixer' },
      { href: '/review', label: 'Manual review' },
      { href: '/support', label: 'Support center' },
    ],
  },
  {
    group: 'Account',
    items: [
      { href: '/profile', label: 'Profile' },
    ],
  },
];

const AUDIT_CONTEXT_ROUTES = new Set(['/scorecard', '/catalogue', '/catalog', '/identity', '/fixer', '/review', '/support']);

function isActive(pathname: string, href: string) {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}

function contextualHref(href: string, auditId: string | null): string {
  return auditId && AUDIT_CONTEXT_ROUTES.has(href) ? `${href}?id=${encodeURIComponent(auditId)}` : href;
}

function NavLinks({ pathname, auditId }: { pathname: string; auditId: string | null }) {
  return (
    <nav className="nav" aria-label="Primary">
      {NAV.map((g) => (
        <div key={g.group}>
          <div className="eyebrow">{g.group}</div>
          {g.items.map((it) => {
            const active = isActive(pathname, it.href);
            return (
              <Link
                key={it.href}
                href={contextualHref(it.href, auditId)}
                aria-current={active ? 'page' : undefined}
                className={[active ? 'active' : '', it.primary ? 'primary' : ''].filter(Boolean).join(' ') || undefined}
              >
                {it.label}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

function ContextualNav({ pathname }: { pathname: string }) {
  const auditId = useSearchParams().get('id');
  return <NavLinks pathname={pathname} auditId={auditId} />;
}

export function SideNav() {
  const pathname = usePathname() || '/';
  return (
    <Suspense fallback={<NavLinks pathname={pathname} auditId={null} />}>
      <ContextualNav pathname={pathname} />
    </Suspense>
  );
}
