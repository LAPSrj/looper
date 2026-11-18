import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { platform } from '../../platform';
import { AxisDrag } from '../../web/gestures';
import { isPhone } from '../../web/page-nav';
import { useCtrlTab } from '../Tabs';
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
  popUp,
  tone,
  valueTone,
  selected,
  checked,
  disabled,
  tabIndex = 0,
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
  /** The value is a pop-up button: a tap opens a menu of the choices out of it, and `onOpen` gets the button. */
  popUp?: boolean;
  /** `action`: the row is a command; `destructive`: one that destroys something. */
  tone?: 'error' | 'warning' | 'muted' | 'action' | 'destructive';
  /** The value's color (a limit close to its end). */
  valueTone?: 'error' | 'warning';
  /** One option of a choice of one: true shows the check at its end (HIG: Lists and tables). */
  checked?: boolean;
  disabled?: boolean;
  /** A row that opens: -1 leaves it out of the Tab order (one Tab stop for a radio group). */
  tabIndex?: number;
  /** `row` is the row's element, which a menu it opens anchors to. */
  onOpen?: (row: HTMLElement) => void;
  onMenu?: () => void;
}) {
  const button = useRef<HTMLSpanElement>(null);
  const open = disabled || !onOpen ? undefined : (row: HTMLElement) => onOpen((popUp && button.current) || row);
  const valueEl = value !== undefined && <span className="pg-row-value">{value}</span>;
  return (
    <div
      className={`pg-row${open ? ' tappable' : ''}${tone ? ` tone-${tone}` : ''}${valueTone ? ` value-${valueTone}` : ''}${selected ? ' selected' : ''}${disabled ? ' disabled' : ''}`}
      role={checked !== undefined ? 'radio' : onOpen ? 'button' : undefined}
      aria-checked={checked}
      aria-haspopup={(popUp && onOpen && 'menu') || undefined}
      aria-disabled={disabled || undefined}
      aria-current={selected || undefined}
      tabIndex={open ? tabIndex : undefined}
      onClick={open && ((e) => open(e.currentTarget))}
      onKeyDown={
        open &&
        ((e) => {
          // Space presses a button or a radio (ARIA), only on the row itself, not on a control inside it.
          if (e.key === ' ' && e.target === e.currentTarget) e.preventDefault();
          else if (e.key !== 'Enter') return;
          open(e.currentTarget);
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
      {popUp ? (
        <span ref={button} className="pg-popup">
          {valueEl}
          {platform === 'ios' ? UP_DOWN : DOWN}
        </span>
      ) : (
        valueEl
      )}
      {checked && (
        <svg className="pg-row-check" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m2 7.5 3.2 3.2L12 3.5" />
        </svg>
      )}
      {chevron && platform === 'ios' && CHEVRON}
    </div>
  );
}

/** iOS's disclosure chevron: the row opens another screen. */
const CHEVRON = (
  <svg className="pg-chevron" width="8" height="13" viewBox="0 0 8 13" aria-hidden="true">
    <path d="M1.5 1.5 6.5 6.5l-5 5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** iOS's pop-up button mark, chevron.up.chevron.down (kit: Lists, Pop-up Menu Indicator). */
const UP_DOWN = (
  <svg className="pg-popup-mark" width="12" height="16" viewBox="0 0 12 16" aria-hidden="true">
    <path d="M2.5 6 6 2.5 9.5 6M2.5 10 6 13.5 9.5 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** Material's drop-down arrow, as a form's select draws it on Android. */
const DOWN = (
  <svg className="pg-popup-mark" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
    <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** A disclosure chevron at the end of an item that isn't a Row but opens another screen: drawn on phones only. */
export function PhoneChevron() {
  return isPhone ? CHEVRON : null;
}

/** How wide a row's swipe action sits while it stays open. */
const SWIPE_ACTION_WIDTH = 88;
/** The drag that keeps the action open: a third of this distance. */
const SWIPE_OPEN_EXTENT = 120;
/** A swipe this far across the row runs the action as it ends. */
const SWIPE_FULL = 0.6;

/** A row a swipe to the left slides aside to show its destructive command; a full swipe runs it. */
export function SwipeRow({ action, className, children }: { action?: { label: string; run: () => void }; className?: string; children: ReactNode }) {
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const drag = useRef(new AxisDrag('x', -1));
  /** The click ending this touch belongs to the swipe, not to the row. */
  const swallowClick = useRef(false);
  const open = offset > 0 && !dragging;
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!host.current?.contains(e.target as Node)) setOffset(0);
    };
    document.addEventListener('pointerdown', close, true);
    return () => document.removeEventListener('pointerdown', close, true);
  }, [open]);
  const swipeClass = `pg-swipe${className ? ` ${className}` : ''}`;
  if (!action) {
    return (
      <div className={swipeClass}>
        <div className="pg-swipe-content">{children}</div>
      </div>
    );
  }
  return (
    <div className={swipeClass} ref={host}>
      {offset > 0 && (
        <button
          type="button"
          className="pg-swipe-action"
          style={{ width: Math.max(SWIPE_ACTION_WIDTH, offset) }}
          onClick={() => {
            setOffset(0);
            action.run();
          }}
        >
          {action.label}
        </button>
      )}
      <div
        className={`pg-swipe-content swipes${dragging ? ' dragging' : ''}`}
        style={offset > 0 ? { transform: `translateX(${-offset}px)` } : undefined}
        onPointerDown={(e) => {
          swallowClick.current = false;
          if (open) {
            swallowClick.current = true;
            setOffset(0);
            return;
          }
          drag.current.begin(e.clientX, e.clientY, e.timeStamp);
        }}
        onPointerMove={(e) => {
          const moved = drag.current.move(e.clientX, e.clientY, e.timeStamp);
          if (!moved) return;
          if (!dragging) {
            setDragging(true);
            swallowClick.current = true;
            e.currentTarget.setPointerCapture(e.pointerId);
          }
          setOffset(moved.offset);
        }}
        onPointerUp={() => {
          const full = dragging && offset > (host.current?.clientWidth ?? Infinity) * SWIPE_FULL;
          const stays = drag.current.end(SWIPE_OPEN_EXTENT);
          setDragging(false);
          setOffset(stays && !full ? SWIPE_ACTION_WIDTH : 0);
          if (full) action.run();
        }}
        onPointerCancel={() => {
          drag.current.end(SWIPE_OPEN_EXTENT);
          setDragging(false);
          setOffset(0);
        }}
        onClickCapture={(e) => {
          if (!swallowClick.current) return;
          swallowClick.current = false;
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        {children}
      </div>
    </div>
  );
}

/** A list's only row when it has nothing to show. */
export function EmptyRow({ children, onMenu }: { children: ReactNode; onMenu?: () => void }) {
  return <Row title={<span className="pg-empty">{children}</span>} onMenu={onMenu} />;
}

/** On a phone or tablet, a tree list (Chats, History) as a scrolling list section; on the desktop the list scrolls itself. */
export function TreeListSection({ children }: { children: ReactNode }) {
  if (platform !== 'ios' && platform !== 'android') return <>{children}</>;
  return (
    <div className="pg-scroll">
      <section className="pg-group pg-sessions">{children}</section>
    </div>
  );
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
  className = 'pg-segmented',
  activeClass = 'active',
  ctrlTab,
}: {
  items: readonly (readonly [T, string])[];
  value: T;
  onChange: (v: T) => void;
  label: string;
  className?: string;
  activeClass?: string;
  /** Ctrl+Tab and Ctrl+Shift+Tab cycle the segments while the window has focus, as Tabs' `ctrlTab`. */
  ctrlTab?: boolean;
}) {
  const ids = items.map(([id]) => id);
  useCtrlTab(ids, value, onChange as (id: string) => void, ctrlTab);
  return (
    <div
      className={className}
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
          type="button"
          role="tab"
          aria-selected={value === id}
          tabIndex={tabStop(ids, value) === id ? 0 : -1}
          className={value === id ? activeClass : undefined}
          onClick={() => onChange(id)}
        >
          <span className="pg-segment-label">{text}</span>
        </button>
      ))}
    </div>
  );
}
