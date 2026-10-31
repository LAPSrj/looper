import type { ReactNode } from 'react';
import { platform } from '../../platform';
import { tabKeyTarget, tabStop } from '../tabs-model';

/**
 * A phone's list section: iOS's inset grouped table section, Material's list
 * under a subhead. The platform's CSS draws it; the markup is the same.
 */
export function Group({
  title,
  footer,
  onTitleMenu,
  children,
}: {
  title?: string;
  footer?: ReactNode;
  /** Long press on the title: its menu. */
  onTitleMenu?: () => void;
  children: ReactNode;
}) {
  return (
    <section className="pg-group">
      {title && (
        <h2
          className="pg-group-title"
          onContextMenu={
            onTitleMenu &&
            ((e) => {
              e.preventDefault();
              onTitleMenu();
            })
          }
        >
          {title}
        </h2>
      )}
      <div className="pg-list">{children}</div>
      {footer && <p className="pg-group-footer">{footer}</p>}
    </section>
  );
}

/** A list row: a title, a line under it, a value at the end; a tap opens, a long press shows the menu. */
export function Row({
  title,
  sub,
  value,
  lead,
  chevron,
  tone,
  valueTone,
  selected,
  onOpen,
  onMenu,
}: {
  title: ReactNode;
  /** iPad: what the split view's detail column shows. */
  selected?: boolean;
  sub?: ReactNode;
  value?: ReactNode;
  lead?: ReactNode;
  /** It opens another screen (iOS shows a disclosure chevron). */
  chevron?: boolean;
  tone?: 'error' | 'warning' | 'muted';
  /** The value's color (a limit close to its end). */
  valueTone?: 'error' | 'warning';
  /** `row` is the row's element, which a menu it opens anchors to. */
  onOpen?: (row: HTMLElement) => void;
  onMenu?: () => void;
}) {
  return (
    <div
      className={`pg-row${onOpen ? ' tappable' : ''}${tone ? ` tone-${tone}` : ''}${valueTone ? ` value-${valueTone}` : ''}${selected ? ' selected' : ''}`}
      role={onOpen ? 'button' : undefined}
      aria-current={selected || undefined}
      tabIndex={onOpen ? 0 : undefined}
      onClick={onOpen && ((e) => onOpen(e.currentTarget))}
      onKeyDown={
        onOpen &&
        ((e) => {
          if (e.key === 'Enter') onOpen(e.currentTarget);
        })
      }
      onContextMenu={
        onMenu &&
        ((e) => {
          e.preventDefault();
          onMenu();
        })
      }
    >
      {lead && <span className="pg-row-lead">{lead}</span>}
      <span className="pg-row-text">
        <span className="pg-row-title">{title}</span>
        {sub && <span className="pg-row-sub">{sub}</span>}
      </span>
      {value !== undefined && <span className="pg-row-value">{value}</span>}
      {chevron && platform === 'ios' && (
        <svg className="pg-chevron" width="8" height="13" viewBox="0 0 8 13" aria-hidden="true">
          <path d="M1.5 1.5 6.5 6.5l-5 5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </div>
  );
}

/** A list's only row when it has nothing to show. */
export function EmptyRow({ children, onMenu }: { children: ReactNode; onMenu?: () => void }) {
  return <Row title={<span className="pg-empty">{children}</span>} onMenu={onMenu} />;
}

/** iOS's large title at the top of a root screen; Material's top app bar (the frame's) carries the title instead. */
export function LargeTitle({ children }: { children: ReactNode }) {
  // data-large-title: the frame shows the title in its bar once this has scrolled under it.
  return platform === 'ios' ? (
    <h1 className="pg-large-title" data-large-title="">
      {children}
    </h1>
  ) : null;
}

/** iOS's segmented control, Material's tabs: a few views of one screen. */
export function Segmented<T extends string>({
  items,
  value,
  onChange,
  label,
}: {
  items: readonly (readonly [T, string])[];
  value: T;
  onChange: (v: T) => void;
  label: string;
}) {
  const ids = items.map(([id]) => id);
  return (
    <div
      className="pg-segmented"
      role="tablist"
      aria-label={label}
      // The ARIA tabs pattern as in Tabs.tsx: one Tab stop, the arrow keys, Home and End move to a segment and select it.
      onKeyDown={(e) => {
        const to = tabKeyTarget(ids, value, e);
        if (to === null) return;
        e.preventDefault();
        onChange(to as T);
        e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')[ids.indexOf(to as T)]?.focus();
      }}
    >
      {items.map(([id, text]) => (
        <button
          key={id}
          role="tab"
          aria-selected={value === id}
          tabIndex={tabStop(ids, value) === id ? 0 : -1}
          className={value === id ? 'active' : undefined}
          onClick={() => onChange(id)}
        >
          {text}
        </button>
      ))}
    </div>
  );
}
