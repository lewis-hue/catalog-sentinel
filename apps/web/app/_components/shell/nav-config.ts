// ============================================================================
// Editorial shell — navigation described as data.
//
// The chrome holds no labels or routes of its own; it renders entirely from this
// file. Each item carries a two-letter `mark` — a typeset catalogue initial set
// in Fraunces in the rail tiles (this project uses no icon set; the marks are the
// rail's visual language). `href` is a real Next route, not a hash.
// ============================================================================

export interface NavItem {
  key: string;
  label: string;
  href: string;
  /** Two-character catalogue letter-mark shown in the rail tile. */
  mark: string;
  /** Small reserved/beta pill, optional. */
  flag?: string;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Monitor',
    items: [
      { key: 'overview', label: 'Overview', href: '/', mark: 'Ov' },
      { key: 'scorecard', label: 'Health score', href: '/scorecard', mark: 'Hs' },
      { key: 'catalogue', label: 'Catalogue', href: '/catalogue', mark: 'Ca' },
      { key: 'catalog', label: 'Store health', href: '/catalog', mark: 'St' },
      { key: 'identity', label: 'Identity guardian', href: '/identity', mark: 'Id' },
      { key: 'alerts', label: 'Release alerts', href: '/alerts', mark: 'Al' },
      { key: 'history', label: 'Audit history', href: '/history', mark: 'Hi' },
    ],
  },
  {
    label: 'Workflow',
    items: [
      { key: 'connect', label: 'Connect distributor', href: '/connect', mark: 'Cn' },
      { key: 'fixer', label: 'One-click fixer', href: '/fixer', mark: 'Fx' },
      { key: 'review', label: 'Manual review', href: '/review', mark: 'Rv' },
      { key: 'support', label: 'Support center', href: '/support', mark: 'Sp' },
    ],
  },
  {
    label: 'Account',
    items: [
      { key: 'profile', label: 'Profile', href: '/profile', mark: 'Pr' },
    ],
  },
];

export const ALL_ITEMS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);

/** Routes that carry the selected audit id so navigation preserves it (mirrors the legacy SideNav). */
const AUDIT_CONTEXT_ROUTES = new Set(['/scorecard', '/catalogue', '/catalog', '/identity', '/fixer', '/review', '/support']);

/** Append `?id=` to audit-scoped routes so switching views keeps the current audit in context. */
export function contextualHref(href: string, auditId: string | null): string {
  return auditId && AUDIT_CONTEXT_ROUTES.has(href) ? `${href}?id=${encodeURIComponent(auditId)}` : href;
}

/** The active nav item for a pathname (exact for home, prefix elsewhere), or null. */
export function activeItem(pathname: string): NavItem | null {
  if (pathname === '/') return ALL_ITEMS.find((i) => i.href === '/') ?? null;
  // Longest matching href wins so /catalogue/x picks Catalogue, not Overview.
  const matches = ALL_ITEMS.filter((i) => i.href !== '/' && (pathname === i.href || pathname.startsWith(`${i.href}/`)));
  return matches.sort((a, b) => b.href.length - a.href.length)[0] ?? null;
}

/** A short, plain-language description per view for the inspector's "About this view". */
export const VIEW_NOTES: Record<string, string> = {
  overview: 'Catalogue health at a glance, with the toolkit for the current audit.',
  scorecard: 'The weighted health score for the selected audit and what moves it.',
  catalogue: 'Every release and its artwork, drawn from the latest catalogue read.',
  catalog: 'Store-by-store coverage for each track, with the evidence behind each verdict.',
  identity: 'Wrong-profile and namesake checks that guard your artist identity.',
  alerts: 'What changed between this audit and the one before it.',
  history: 'Every saved audit, newest first.',
  connect: 'Link a distributor over an attended browser session to read your catalogue.',
  fixer: 'Prepared, one-click corrections for the issues an audit surfaced.',
  review: 'The manual triage queue for verdicts that need a human decision.',
  support: 'Distributor-ready evidence packets and copy-ready support tickets.',
  profile: 'Your account, sign-in identity, and the roles you hold.',
};
