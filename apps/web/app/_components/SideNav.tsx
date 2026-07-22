'use client';
import Link from 'next/link';
import { Suspense } from 'react';
import type { ReactNode } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';

/** Restrained line icons (Lucide-style). Keeps the nav professional without an icon dep. */
function Icon({ name }: { name: string }) {
  const p: Record<string, ReactNode> = {
    overview: <><path d="M3 13h8V3H3z" /><path d="M13 21h8V11h-8z" /><path d="M13 3v6h8V3z" /><path d="M3 21h8v-4H3z" /></>,
    catalog: <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="2.5" /></>,
    connect: <><path d="M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3" /><rect x="4" y="7" width="16" height="6" rx="2" /><path d="M8 13v3a4 4 0 0 0 8 0v-3" /></>,
    support: <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="3.5" /><path d="m5 5 3.5 3.5M15.5 15.5 19 19M19 5l-3.5 3.5M8.5 15.5 5 19" /></>,
    history: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    review: <><path d="M4 5h16" /><path d="M4 12h10" /><path d="M4 19h7" /><path d="m16 16 2 2 4-4" /></>,
    organization: <><circle cx="9" cy="8" r="3" /><circle cx="17" cy="10" r="2.5" /><path d="M3 20c0-4 2.5-6 6-6s6 2 6 6" /><path d="M15 15c3.5 0 6 1.7 6 5" /></>,
  };
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {p[name]}
    </svg>
  );
}

const NAV: Array<{ group: string; items: Array<{ href: string; label: string; icon: string; primary?: boolean }> }> = [
  {
    group: 'Monitor',
    items: [
      { href: '/', label: 'Overview', icon: 'overview' },
      { href: '/catalog', label: 'Catalog', icon: 'catalog' },
      { href: '/history', label: 'Audit history', icon: 'history' },
    ],
  },
  {
    group: 'Workflow',
    items: [
      { href: '/connect', label: 'Connect distributor', icon: 'connect', primary: true },
      { href: '/review', label: 'Manual review', icon: 'review' },
      { href: '/support', label: 'Support center', icon: 'support' },
      { href: '/organization', label: 'Organization', icon: 'organization' },
    ],
  },
];

const AUDIT_CONTEXT_ROUTES = new Set(['/catalog', '/review', '/support']);

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
                <Icon name={it.icon} />
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
