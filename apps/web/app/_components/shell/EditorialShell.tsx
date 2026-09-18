'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { ALL_ITEMS, NAV_GROUPS, VIEW_NOTES, activeItem, contextualHref, type NavItem } from './nav-config';
import { useTenant, type TenantSummary } from './tenant-context';
import { apiFetch } from '@/lib/api-client';

/* ------------------------------------------------------------------ dropdown primitive */
function useOutside(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open, onClose]);
  return ref;
}

function Dropdown({ trigger, label, children, up, right }: {
  trigger: (props: { onClick: () => void; 'aria-expanded': boolean }) => ReactNode;
  label?: string;
  children: ReactNode;
  up?: boolean;
  right?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useOutside(open, () => setOpen(false));
  return (
    <div className="ed-pop-wrap" ref={ref}>
      {trigger({ onClick: () => setOpen((o) => !o), 'aria-expanded': open })}
      {open && (
        <div className={`ed-pop${up ? ' ed-pop-up' : ''}${right ? ' ed-pop-right' : ''}`} role="menu" onClick={() => setOpen(false)}>
          {label && <div className="ed-pop-label">{label}</div>}
          {children}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ tenant switcher (header) */
function TenantSwitcher() {
  const { tenants, currentTenant, setCurrent } = useTenant();
  if (tenants.length < 2) return null; // nothing to switch between
  const label = (t: TenantSummary) => (t.personal ? 'Personal' : t.tenantId.replace(/^org_/, 'Org '));
  const cur = currentTenant;
  return (
    <Dropdown
      label="Workspace"
      trigger={(p) => (
        <button type="button" className="ed-switch" aria-haspopup="menu" {...p}>
          <span className="ed-switch-label">{cur ? label(cur) : 'Personal'}</span>
          {cur && !cur.personal && <span className="ed-switch-badge">{cur.role}</span>}
          <span className="ed-caret" aria-hidden>⌄</span>
        </button>
      )}
    >
      {tenants.map((t) => (
        <button key={t.tenantId} type="button" role="menuitem" className="ed-pop-item" onClick={() => setCurrent(t.tenantId)}>
          <span>{label(t)}<span className="ed-pop-item-desc">{t.personal ? 'Your own catalogue' : `Shared · ${t.role}`}</span></span>
          {cur && t.tenantId === cur.tenantId && <span className="ed-check" aria-hidden>✓</span>}
        </button>
      ))}
    </Dropdown>
  );
}

/* ------------------------------------------------------------------ header */
function Header({ onOpenCmd, inspectorOpen, onToggleInspector }: {
  onOpenCmd: () => void;
  inspectorOpen: boolean;
  onToggleInspector: () => void;
}) {
  const pathname = usePathname() || '/';
  const active = activeItem(pathname);
  return (
    <header className="ed-header">
      <Link href="/" className="ed-brand" title="Catalog Sentinel home">
        <span className="ed-brand-mark">CS</span>
      </Link>
      <div className="ed-header-main">
        <div className="ed-header-left">
          <TenantSwitcher />
          <nav className="ed-crumbs" aria-label="Breadcrumb">
            <span className="ed-divider" aria-hidden>/</span>
            <Link href="/" className={`ed-crumb-link${pathname === '/' ? ' is-current' : ''}`} aria-current={pathname === '/' ? 'page' : undefined}>
              Catalogue
            </Link>
            {active && active.href !== '/' && (
              <>
                <span className="ed-divider" aria-hidden>/</span>
                <span className="ed-crumb-current" aria-current="page">{active.label}</span>
              </>
            )}
          </nav>
        </div>
        <div className="ed-header-right">
          <button type="button" className="ed-iconbtn ed-iconbtn-outline" onClick={onOpenCmd} aria-label="Search navigation">
            <span className="ed-search-glyph" aria-hidden>⌕</span>
            <span>Search</span>
            <kbd className="ed-kbd">⌘K</kbd>
          </button>
          <button
            type="button"
            className={`ed-iconbtn${inspectorOpen ? ' is-active' : ''}`}
            aria-pressed={inspectorOpen}
            title="About this view"
            onClick={onToggleInspector}
          >
            <span aria-hidden>ⓘ</span>
          </button>
        </div>
      </div>
    </header>
  );
}

/* ------------------------------------------------------------------ account menu (rail footer) */
function AccountMenu({ collapsed }: { collapsed: boolean }) {
  const { displayName, account, currentTenant } = useTenant();
  const name = displayName || account?.username || 'Signed-in user';
  const initial = name.trim().charAt(0).toUpperCase() || '?';
  const role = currentTenant?.role;
  return (
    <Dropdown
      up
      label="Account"
      trigger={(p) => (
        <button type="button" className="ed-account" aria-haspopup="menu" title={name} {...p}>
          <span className="ed-avatar">{initial}</span>
          {!collapsed && (
            <span className="ed-account-id">
              <span className="ed-account-name">{name}</span>
              {role && <span className="ed-account-role">{role}</span>}
            </span>
          )}
        </button>
      )}
    >
      <div className="ed-account-head">
        <div className="ed-account-head-name">{name}</div>
        {account?.email && <div className="ed-account-head-sub">{account.email}</div>}
      </div>
      {role && (
        <div className="ed-account-role-line">
          Role in this workspace<span className="ed-role-badge">{role}</span>
        </div>
      )}
      <div className="ed-pop-sep" />
      <Link role="menuitem" className="ed-pop-item" href="/profile"><span>Profile</span></Link>
      <form action="/auth/logout" method="post" className="ed-signout-form">
        <button role="menuitem" type="submit" className="ed-pop-item"><span>Sign out</span></button>
      </form>
    </Dropdown>
  );
}

/* ------------------------------------------------------------------ rail */
const RAIL_BEHAVIOR_KEY = 'sentinel:rail-behavior';
type RailBehavior = 'open' | 'collapsed' | 'expandable';

function RailView({ pathname, auditId }: { pathname: string; auditId: string | null }) {
  const [behavior, setBehavior] = useState<RailBehavior>('expandable');
  const [hovered, setHovered] = useState(false);
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(RAIL_BEHAVIOR_KEY) as RailBehavior | null;
      if (saved === 'open' || saved === 'collapsed' || saved === 'expandable') setBehavior(saved);
    } catch { /* stay expandable */ }
  }, []);
  const choose = (b: RailBehavior) => {
    setBehavior(b);
    try { window.localStorage.setItem(RAIL_BEHAVIOR_KEY, b); } catch { /* ignore */ }
  };
  const expanded = behavior === 'open' || (behavior === 'expandable' && hovered);
  const overlay = behavior === 'expandable' && hovered;
  const active = activeItem(pathname);

  const tile = (it: NavItem) => {
    const isActive = active?.key === it.key;
    return (
      <Link
        key={it.key}
        href={contextualHref(it.href, auditId)}
        className={`ed-railitem${isActive ? ' is-active' : ''}`}
        aria-current={isActive ? 'page' : undefined}
        title={expanded ? undefined : it.label}
      >
        <span className="ed-mark" aria-hidden>{it.mark}</span>
        <span className="ed-railitem-label">
          <span>{it.label}</span>
          {it.flag && <span className="ed-flag">{it.flag}</span>}
        </span>
      </Link>
    );
  };

  return (
    <>
      {overlay && <div className="ed-rail-spacer" aria-hidden />}
      <nav
        className={`ed-rail${expanded ? ' is-expanded' : ''}${overlay ? ' is-overlay' : ''}`}
        aria-label="Primary"
        onMouseEnter={() => behavior === 'expandable' && setHovered(true)}
        onMouseLeave={() => behavior === 'expandable' && setHovered(false)}
      >
        <div className="ed-rail-groups">
          <div className="ed-rail-scope">Catalogue</div>
          {NAV_GROUPS.map((g, i) => (
            <div key={g.label} className="ed-rail-group-wrap">
              {i > 0 && <div className="ed-rail-sep" />}
              <div className={`ed-rail-grouplabel${g.section ? ' is-section' : ''}`}>{g.label}</div>
              <div className="ed-rail-group">{g.items.map(tile)}</div>
            </div>
          ))}
        </div>
        <div className="ed-rail-footer">
          <Dropdown
            up
            label="Rail"
            trigger={(p) => (
              <button type="button" className="ed-railitem ed-rail-control" title="Rail display" {...p}>
                <span className="ed-mark ed-mark-quiet" aria-hidden>☰</span>
                <span className="ed-railitem-label"><span>Rail display</span></span>
              </button>
            )}
          >
            {([['open', 'Always expanded'], ['collapsed', 'Always collapsed'], ['expandable', 'Expand on hover']] as const).map(([b, l]) => (
              <button key={b} type="button" role="menuitem" className="ed-pop-item" onClick={() => choose(b)}>
                <span>{l}</span>{behavior === b && <span className="ed-check" aria-hidden>✓</span>}
              </button>
            ))}
          </Dropdown>
          <div className="ed-rail-account"><AccountMenu collapsed={!expanded} /></div>
        </div>
      </nav>
    </>
  );
}

function RailContextual() {
  const pathname = usePathname() || '/';
  const auditId = useSearchParams().get('id');
  return <RailView pathname={pathname} auditId={auditId} />;
}

function Rail() {
  const pathname = usePathname() || '/';
  return (
    <Suspense fallback={<RailView pathname={pathname} auditId={null} />}>
      <RailContextual />
    </Suspense>
  );
}

/* ------------------------------------------------------------------ command menu (⌘K) */
function CommandMenu({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [q, setQ] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const groups = useMemo(() => {
    const query = q.trim().toLowerCase();
    return NAV_GROUPS
      .map((g) => ({ label: g.label, items: g.items.filter((it) => !query || it.label.toLowerCase().includes(query)) }))
      .filter((g) => g.items.length > 0);
  }, [q]);

  const go = (it: NavItem) => { router.push(it.href); onClose(); };

  return (
    <div className="ed-cmd-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="ed-cmd" role="dialog" aria-modal="true" aria-label="Search navigation">
        <div className="ed-cmd-input">
          <span className="ed-search-glyph" aria-hidden>⌕</span>
          <input ref={inputRef} placeholder="Jump to a view…" value={q} onChange={(e) => setQ(e.target.value)} />
          <kbd className="ed-kbd">esc</kbd>
        </div>
        <div className="ed-cmd-list">
          {groups.length === 0 && <div className="ed-cmd-empty">No matching views.</div>}
          {groups.map((g) => (
            <div key={g.label}>
              <div className="ed-cmd-grouplabel">{g.label}</div>
              {g.items.map((it) => (
                <button key={it.key} type="button" className="ed-cmd-item" onClick={() => go(it)}>
                  <span className="ed-mark ed-mark-sm" aria-hidden>{it.mark}</span>
                  <span>{it.label}</span>
                  <span className="ed-cmd-item-path">{g.label}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ inspector: catalogue assistant */
interface ChatMessage { role: 'user' | 'assistant'; content: string }

function AssistantPanel({ contextLabel }: { contextLabel: string }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    apiFetch('/api/assistant/status')
      .then((r) => (r.ok ? (r.json() as Promise<{ enabled?: boolean }>) : { enabled: false }))
      .then((d) => { if (active) setEnabled(Boolean(d.enabled)); })
      .catch(() => { if (active) setEnabled(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }); }, [messages, sending]);

  const send = async () => {
    const question = input.trim();
    if (!question || sending) return;
    const next: ChatMessage[] = [...messages, { role: 'user', content: question }];
    setMessages(next);
    setInput('');
    setSending(true);
    try {
      const res = await apiFetch('/api/assistant', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: next }),
      });
      const data = (await res.json().catch(() => ({}))) as { answer?: string; error?: string };
      const reply = res.ok && data.answer ? data.answer : data.error || 'The assistant is unavailable right now.';
      setMessages((m) => [...m, { role: 'assistant', content: reply }]);
    } catch {
      setMessages((m) => [...m, { role: 'assistant', content: 'Something went wrong reaching the assistant. Try again.' }]);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="ed-assistant">
      <div className="ed-assistant-context">Grounded in your saved audits · viewing {contextLabel}</div>
      <div className="ed-assistant-log" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="ed-assistant-empty">
            <p>Ask about your catalogue across every audit, or how to use a view.</p>
            <ul>
              <li>Which tracks aren&apos;t confirmed live?</li>
              <li>What&apos;s my worst store?</li>
              <li>How do I fix a wrong-profile match?</li>
            </ul>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`ed-msg ed-msg-${m.role}`}>{m.content}</div>
        ))}
        {sending && <div className="ed-msg ed-msg-assistant ed-msg-thinking">Thinking…</div>}
      </div>
      {enabled === false && (
        <div className="ed-assistant-note">Set <code>ANTHROPIC_API_KEY</code> on the API service to enable the assistant.</div>
      )}
      <div className="ed-assistant-input">
        <textarea
          rows={2}
          placeholder={enabled === false ? 'Assistant disabled' : 'Ask about your releases…'}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}
          disabled={enabled === false || sending}
          aria-label="Ask the catalogue assistant"
        />
        <button type="button" className="ed-assistant-send" onClick={() => void send()} disabled={!input.trim() || sending || enabled === false}>
          Send
        </button>
      </div>
    </div>
  );
}

function InspectorView({ pathname, auditId, onClose }: { pathname: string; auditId: string | null; onClose: () => void }) {
  const active = activeItem(pathname);
  const note = active ? VIEW_NOTES[active.key] : undefined;
  return (
    <aside className="ed-inspector" aria-label="Catalogue assistant">
      <div className="ed-inspector-head">
        <span className="ed-inspector-title">Assistant</span>
        <button type="button" className="ed-iconbtn" onClick={onClose} aria-label="Close panel"><span aria-hidden>✕</span></button>
      </div>
      <div className="ed-inspector-about">
        <div className="ed-inspector-eyebrow">About {active ? active.label : 'Catalogue'}</div>
        <p>{note ?? 'Select a view from the rail to see what it does.'}</p>
        {auditId && <div className="ed-inspector-fact"><span className="ed-inspector-fact-label">Active audit</span><code>{auditId}</code></div>}
      </div>
      <AssistantPanel contextLabel={active ? active.label : 'Catalogue'} />
    </aside>
  );
}

function InspectorContextual({ onClose }: { onClose: () => void }) {
  const pathname = usePathname() || '/';
  const auditId = useSearchParams().get('id');
  return <InspectorView pathname={pathname} auditId={auditId} onClose={onClose} />;
}

function Inspector({ onClose }: { onClose: () => void }) {
  const pathname = usePathname() || '/';
  return (
    <Suspense fallback={<InspectorView pathname={pathname} auditId={null} onClose={onClose} />}>
      <InspectorContextual onClose={onClose} />
    </Suspense>
  );
}

/* ------------------------------------------------------------------ shell orchestrator */
const INSPECTOR_KEY = 'sentinel:inspector-open';

export function EditorialShell({ children }: { children: ReactNode }) {
  const [cmdOpen, setCmdOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  useEffect(() => {
    try { setInspectorOpen(window.localStorage.getItem(INSPECTOR_KEY) === '1'); } catch { /* closed */ }
  }, []);
  const toggleInspector = useCallback(() => {
    setInspectorOpen((o) => {
      const next = !o;
      try { window.localStorage.setItem(INSPECTOR_KEY, next ? '1' : '0'); } catch { /* ignore */ }
      return next;
    });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setCmdOpen((o) => !o); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="ed-shell">
      <Header onOpenCmd={() => setCmdOpen(true)} inspectorOpen={inspectorOpen} onToggleInspector={toggleInspector} />
      <div className="ed-body">
        <Rail />
        <main className="ed-content main" id="main-content" tabIndex={-1}>{children}</main>
        {inspectorOpen && <Inspector onClose={toggleInspector} />}
      </div>
      {cmdOpen && <CommandMenu onClose={() => setCmdOpen(false)} />}
    </div>
  );
}
