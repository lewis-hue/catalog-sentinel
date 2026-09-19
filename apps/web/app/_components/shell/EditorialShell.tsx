'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { ALL_ITEMS, NAV_GROUPS, activeItem, contextualHref, type NavItem } from './nav-config';
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

/* ------------------------------------------------------------------ sidebar control (Expanded / Collapsed / Expand on hover) */
type RailMode = 'expanded' | 'collapsed' | 'hover';
const RAIL_MODE_KEY = 'sentinel:rail-mode';
const RAIL_MODES: Array<{ value: RailMode; label: string; hint: string }> = [
  { value: 'expanded', label: 'Expanded', hint: 'Always show the navigation' },
  { value: 'collapsed', label: 'Collapsed', hint: 'Hide it to free up width' },
  { value: 'hover', label: 'Expand on hover', hint: 'Reveal it from the left edge' },
];

function SidebarControl({ mode, onChange }: { mode: RailMode; onChange: (m: RailMode) => void }) {
  return (
    <Dropdown
      label="Sidebar control"
      trigger={(p) => (
        <button type="button" className="ed-iconbtn ed-menu-btn" aria-haspopup="menu" aria-label="Sidebar control" title="Sidebar control" {...p}>
          <span aria-hidden>◧</span>
        </button>
      )}
    >
      {RAIL_MODES.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="menuitemradio"
          aria-checked={mode === opt.value}
          className="ed-pop-item ed-mode-item"
          onClick={() => onChange(opt.value)}
        >
          <span>
            {opt.label}
            <span className="ed-pop-item-desc">{opt.hint}</span>
          </span>
          <span className={`ed-radio${mode === opt.value ? ' is-on' : ''}`} aria-hidden />
        </button>
      ))}
    </Dropdown>
  );
}

/* ------------------------------------------------------------------ header */
function Header({ onOpenCmd, inspectorOpen, onToggleInspector, railMode, onRailMode }: {
  onOpenCmd: () => void;
  inspectorOpen: boolean;
  onToggleInspector: () => void;
  railMode: RailMode;
  onRailMode: (m: RailMode) => void;
}) {
  const pathname = usePathname() || '/';
  const active = activeItem(pathname);
  const railInFlow = railMode === 'expanded';
  return (
    <header className={`ed-header${railInFlow ? '' : ' is-collapsed'}`}>
      <div className="ed-header-lead">
        <SidebarControl mode={railMode} onChange={onRailMode} />
      </div>
      <Link href="/" className="ed-brand" title="Catalog Sentinel home">
        <span className="ed-brand-mark">CS</span>
      </Link>
      <div className="ed-header-main">
        <div className="ed-header-left">
          <TenantSwitcher />
          <nav className="ed-crumbs" aria-label="Breadcrumb">
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
            className={`ed-iconbtn ed-iconbtn-outline ed-assistant-btn${inspectorOpen ? ' is-active' : ''}`}
            aria-pressed={inspectorOpen}
            title="Catalogue assistant"
            onClick={onToggleInspector}
          >
            <span className="ed-assistant-glyph" aria-hidden>✦</span>
            <span>Assistant</span>
          </button>
          <AccountMenu />
        </div>
      </div>
    </header>
  );
}

/* ------------------------------------------------------------------ account menu (header) */
function AccountMenu() {
  const { displayName, account, currentTenant } = useTenant();
  const name = displayName || account?.username || 'Signed-in user';
  const initial = name.trim().charAt(0).toUpperCase() || '?';
  const role = currentTenant?.role;
  return (
    <Dropdown
      right
      label="Account"
      trigger={(p) => (
        <button type="button" className="ed-header-account" aria-haspopup="menu" aria-label="Account menu" title={name} {...p}>
          <span className="ed-avatar">{initial}</span>
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

/* ------------------------------------------------------------------ rail (text-only, collapsible) */
function RailGroup({ group, active, auditId }: { group: (typeof NAV_GROUPS)[number]; active: NavItem | null; auditId: string | null }) {
  return (
    <div className="ed-rail-group-wrap">
      <div className="ed-rail-grouplabel">{group.label}</div>
      <div className="ed-rail-group">
        {group.items.map((it) => {
          const isActive = active?.key === it.key;
          return (
            <Link
              key={it.key}
              href={contextualHref(it.href, auditId)}
              className={`ed-railitem${isActive ? ' is-active' : ''}`}
              aria-current={isActive ? 'page' : undefined}
            >
              <span>{it.label}</span>
              {it.flag && <span className="ed-flag">{it.flag}</span>}
            </Link>
          );
        })}
      </div>
    </div>
  );
}

function RailView({ pathname, auditId }: { pathname: string; auditId: string | null }) {
  const active = activeItem(pathname);
  // Main groups scroll; the last group (Account) is pinned to the bottom of the rail.
  const mainGroups = NAV_GROUPS.slice(0, -1);
  const footerGroup = NAV_GROUPS[NAV_GROUPS.length - 1];
  return (
    <nav className="ed-rail" aria-label="Primary">
      <div className="ed-rail-groups">
        {mainGroups.map((g) => (
          <RailGroup key={g.label} group={g} active={active} auditId={auditId} />
        ))}
      </div>
      {footerGroup && (
        <div className="ed-rail-footer">
          <RailGroup group={footerGroup} active={active} auditId={auditId} />
        </div>
      )}
    </nav>
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
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const onDown = (e: MouseEvent) => { if (dialogRef.current && !dialogRef.current.contains(e.target as Node)) onClose(); };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onDown); };
  }, [onClose]);

  const groups = useMemo(() => {
    const query = q.trim().toLowerCase();
    return NAV_GROUPS
      .map((g) => ({ label: g.label, items: g.items.filter((it) => !query || it.label.toLowerCase().includes(query)) }))
      .filter((g) => g.items.length > 0);
  }, [q]);

  const go = (it: NavItem) => { router.push(it.href); onClose(); };

  return (
    <div className="ed-cmd-overlay">
      <div className="ed-cmd" role="dialog" aria-modal="true" aria-label="Search navigation" ref={dialogRef}>
        <div className="ed-cmd-input">
          <span className="ed-cmd-field">
            <span className="ed-search-glyph" aria-hidden>⌕</span>
            <input ref={inputRef} placeholder="Jump to a view…" value={q} onChange={(e) => setQ(e.target.value)} />
          </span>
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

function AssistantPanel() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

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
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setMessages((m) => [...m, { role: 'assistant', content: data.error || 'The assistant is unavailable right now.' }]);
        return;
      }
      // Stream the plain-text answer into a single assistant message as deltas arrive.
      const reader = res.body?.getReader();
      if (!reader) {
        const text = await res.text().catch(() => '');
        setMessages((m) => [...m, { role: 'assistant', content: text || 'No answer.' }]);
        return;
      }
      const decoder = new TextDecoder();
      let started = false;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        if (!chunk) continue;
        if (!started) {
          started = true;
          setMessages((m) => [...m, { role: 'assistant', content: chunk }]);
        } else {
          setMessages((m) => {
            const copy = m.slice();
            const last = copy[copy.length - 1];
            if (last && last.role === 'assistant') copy[copy.length - 1] = { role: 'assistant', content: last.content + chunk };
            return copy;
          });
        }
      }
      if (!started) setMessages((m) => [...m, { role: 'assistant', content: 'No answer was returned. Try rephrasing.' }]);
    } catch {
      setMessages((m) => [...m, { role: 'assistant', content: 'Something went wrong reaching the assistant. Try again.' }]);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="ed-assistant">
      <div className="ed-assistant-log" ref={scrollRef}>
        {messages.map((m, i) => (
          <div key={i} className={`ed-msg ed-msg-${m.role}`}>{m.content}</div>
        ))}
        {sending && messages[messages.length - 1]?.role === 'user' && (
          <div className="ed-msg ed-msg-assistant ed-msg-thinking">Thinking…</div>
        )}
      </div>
      <div className="ed-assistant-input">
        <textarea
          rows={2}
          placeholder="Ask about your releases…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}
          disabled={sending}
          aria-label="Ask the catalogue assistant"
        />
        <button type="button" className="ed-assistant-send" onClick={() => void send()} disabled={!input.trim() || sending}>
          Send
        </button>
      </div>
    </div>
  );
}

function Inspector({ onClose }: { onClose: () => void }) {
  return (
    <aside className="ed-inspector" aria-label="Catalogue assistant">
      <div className="ed-inspector-head">
        <span className="ed-inspector-title">Assistant</span>
        <button type="button" className="ed-iconbtn" onClick={onClose} aria-label="Close panel"><span aria-hidden>✕</span></button>
      </div>
      <AssistantPanel />
    </aside>
  );
}

/* ------------------------------------------------------------------ shell orchestrator */
const INSPECTOR_KEY = 'sentinel:inspector-open';

export function EditorialShell({ children }: { children: ReactNode }) {
  const [cmdOpen, setCmdOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [railMode, setRailMode] = useState<RailMode>('expanded');
  useEffect(() => {
    try {
      setInspectorOpen(window.localStorage.getItem(INSPECTOR_KEY) === '1');
      const saved = window.localStorage.getItem(RAIL_MODE_KEY);
      if (saved === 'expanded' || saved === 'collapsed' || saved === 'hover') setRailMode(saved);
      else if (window.localStorage.getItem('sentinel:nav-collapsed') === '1') setRailMode('collapsed');
    } catch { /* defaults */ }
  }, []);
  const toggleInspector = useCallback(() => {
    setInspectorOpen((o) => {
      const next = !o;
      try { window.localStorage.setItem(INSPECTOR_KEY, next ? '1' : '0'); } catch { /* ignore */ }
      return next;
    });
  }, []);
  const changeRailMode = useCallback((mode: RailMode) => {
    setRailMode(mode);
    try { window.localStorage.setItem(RAIL_MODE_KEY, mode); } catch { /* ignore */ }
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
      <Header onOpenCmd={() => setCmdOpen(true)} inspectorOpen={inspectorOpen} onToggleInspector={toggleInspector} railMode={railMode} onRailMode={changeRailMode} />
      <div className="ed-body">
        {railMode === 'expanded' && <Rail />}
        {railMode === 'hover' && <div className="ed-rail-hover"><Rail /></div>}
        <main className="ed-content main" id="main-content" tabIndex={-1}>{children}</main>
        {inspectorOpen && <Inspector onClose={toggleInspector} />}
      </div>
      {cmdOpen && <CommandMenu onClose={() => setCmdOpen(false)} />}
    </div>
  );
}
