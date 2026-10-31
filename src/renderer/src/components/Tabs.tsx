import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { StatusMark } from './StatusMark';
import { ctrlTabTarget, panelDomId, tabAria, tabDomId, tabKeyTarget, type TabItem } from './tabs-model';

export type { TabItem, TabStatus } from './tabs-model';

const CHEVRON_LEFT = <path d="M10 3.5 5.5 8l4.5 4.5" />;
const CHEVRON_RIGHT = <path d="M6 3.5 10.5 8 6 12.5" />;

const CLOSE = (
  <svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" aria-hidden="true">
    <path d="m1 1 6 6M7 1 1 7" />
  </svg>
);

/**
 * One strip of tabs for every window: the ARIA tabs pattern (one Tab stop,
 * Left and Right select the neighbor, Home and End, optionally Ctrl+Tab), the
 * active tab kept in view, no scrollbar, an edge fade where more tabs lie, and
 * scroll buttons at the ends on a desktop pointer while it overflows.
 */
export function Tabs({
  tabs,
  active,
  onSelect,
  label,
  idBase,
  className,
  ctrlTab,
}: {
  tabs: readonly TabItem[];
  active: string;
  onSelect: (id: string) => void;
  /** The tab list's accessible name. */
  label: string;
  /** Ties each tab to its TabPanel (aria-controls); omit when the panel isn't a TabPanel. */
  idBase?: string;
  className?: string;
  /** Ctrl+Tab and Ctrl+Shift+Tab cycle the tabs while the window has focus: one strip per window turns it on. */
  ctrlTab?: boolean;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState({ start: false, end: false });
  const ids = tabs.map((t) => t.id);
  const latest = useRef({ ids, active, onSelect });
  latest.current = { ids, active, onSelect };

  const measure = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    const start = el.scrollLeft > 1;
    const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setMore((m) => (m.start === start && m.end === end ? m : { start, end }));
  }, []);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    measure();
    el.addEventListener('scroll', measure, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(el);
    return () => {
      el.removeEventListener('scroll', measure);
      observer?.disconnect();
    };
  }, [measure, tabs.length]);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    if (typeof el?.scrollIntoView === 'function') el.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }, [active]);

  useEffect(() => {
    if (!ctrlTab) return;
    const onKey = (e: KeyboardEvent) => {
      const to = ctrlTabTarget(latest.current.ids, latest.current.active, e);
      if (to === null) return;
      e.preventDefault();
      latest.current.onSelect(to);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ctrlTab]);

  const focusTab = (id: string) => {
    const at = latest.current.ids.indexOf(id);
    const el = listRef.current?.querySelectorAll<HTMLElement>('[role="tab"]')[at];
    el?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const to = tabKeyTarget(ids, active, e);
    if (to !== null) {
      e.preventDefault();
      onSelect(to);
      focusTab(to);
      return;
    }
    if (e.key === 'Delete') {
      const focused = (e.target as HTMLElement).closest('[role="tab"]');
      const at = focused ? Array.from(listRef.current?.querySelectorAll('[role="tab"]') ?? []).indexOf(focused) : -1;
      const close = tabs[at]?.onClose;
      if (close) {
        e.preventDefault();
        close();
      }
    }
  };

  const scrollBy = (dir: -1 | 1) => {
    const el = listRef.current;
    if (!el) return;
    const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollBy({ left: dir * Math.max(120, el.clientWidth * 0.6), behavior: reduce ? 'auto' : 'smooth' });
  };

  return (
    <div
      className={`tabs tabs-scroll${className ? ` ${className}` : ''}`}
      role="tablist"
      aria-label={label}
      ref={listRef}
      data-more-start={more.start || undefined}
      data-more-end={more.end || undefined}
      onKeyDown={onKeyDown}
    >
      <button type="button" className="tabs-scroll-button start" tabIndex={-1} aria-hidden="true" onClick={() => scrollBy(-1)}>
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          {CHEVRON_LEFT}
        </svg>
      </button>
      {tabs.map((t) => (
        <span key={t.id} role="presentation" className={`tab-item${t.onClose ? ' has-close' : ''}${t.id === active ? ' active' : ''}`}>
          <button
            type="button"
            className={`tab${t.id === active ? ' active' : ''}${t.status ? ' marked' : ''}${t.dividerAfter ? ' divide-after' : ''}`}
            title={t.title}
            onClick={() => onSelect(t.id)}
            {...tabAria(ids, t, active, idBase)}
          >
            {t.status && <StatusMark status={t.status} />}
            <span className="tab-label">{t.label}</span>
          </button>
          {t.onClose && (
            <button type="button" className="tab-close" tabIndex={-1} aria-label={`Close ${t.label}`} title="Close Tab" onClick={t.onClose}>
              {CLOSE}
            </button>
          )}
        </span>
      ))}
      <button type="button" className="tabs-scroll-button end" tabIndex={-1} aria-hidden="true" onClick={() => scrollBy(1)}>
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          {CHEVRON_RIGHT}
        </svg>
      </button>
    </div>
  );
}

/** The panel a tab shows, tied to it by id (pair with the strip's `idBase`). */
export function TabPanel({ idBase, id, className, children }: { idBase: string; id: string; className?: string; children: ReactNode }) {
  return (
    <div role="tabpanel" id={panelDomId(idBase, id)} aria-labelledby={tabDomId(idBase, id)} className={className}>
      {children}
    </div>
  );
}
