import type { CSSProperties, ReactNode } from 'react';
import { UsageGlyph } from '../components/ContextRing';
import { ICONS } from '../components/icons';
import type { BarModel, PageNavAction } from './nav-bar-model';

/*
 * The bar rows each phone platform draws, from a BarModel (nav-bar-model.ts).
 * Internal to the frames and to NavBar: a screen uses NavBar, never these.
 * Their styles are ios-bar.css and md-bar.css, which the frame's and the
 * page's stylesheets both import.
 */

// ---------- glyphs ----------

export const BACK = (
  <svg width="11" height="19" viewBox="0 0 11 19" aria-hidden="true">
    <path d="M9 1.5L1.5 9.5 9 17.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
export const ELLIPSIS = (
  <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="5.5" cy="12" r="1.9" fill="currentColor" />
    <circle cx="12" cy="12" r="1.9" fill="currentColor" />
    <circle cx="18.5" cy="12" r="1.9" fill="currentColor" />
  </svg>
);
export const XMARK = (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M2 2l12 12M14 2L2 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
);
export const CHECKMARK = (
  <svg width="20" height="16" viewBox="0 0 20 16" aria-hidden="true">
    <path d="M2 8.5l5.5 5.5L18 2" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
export const ARROW_BACK = (
  <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20z" fill="currentColor" />
  </svg>
);
export const CLOSE = (
  <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" fill="currentColor" />
  </svg>
);
export const MENU = (
  <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z" fill="currentColor" />
  </svg>
);
export const MENU_OPEN = (
  <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M3 18h13v-2H3v2zm0-5h10v-2H3v2zm0-7v2h13V6H3zm18 9.59L17.42 12 21 8.41 19.59 7l-5 5 5 5L21 15.59z" fill="currentColor" />
  </svg>
);
export const MORE_VERT = (
  <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="5.5" r="2" fill="currentColor" />
    <circle cx="12" cy="12" r="2" fill="currentColor" />
    <circle cx="12" cy="18.5" r="2" fill="currentColor" />
  </svg>
);

/** An ICONS entry as a 22 px glyph for a bar button. */
export function NavIcon({ name, size = 22 }: { name: string; size?: number }) {
  const icon = (ICONS as Record<string, ReactNode>)[name];
  if (!icon) return null;
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {icon}
    </svg>
  );
}

/** A bar button's glyph: its usage ring, or its icon. */
export function ActionGlyph({ action, size = 22 }: { action: Pick<PageNavAction, 'icon' | 'ring'>; size?: number }) {
  if (action.ring) {
    return (
      <svg width={size} height={size} viewBox="0 0 18 18" aria-hidden="true">
        <UsageGlyph context={action.ring.context} used={action.ring.used} />
      </svg>
    );
  }
  return action.icon ? <NavIcon name={action.icon} size={size} /> : null;
}

// ---------- iOS ----------

export interface IosBarRowProps {
  model: BarModel;
  /** The screen has a More menu: its button, before Confirm. */
  onMore?: (button: HTMLElement) => void;
  /** A bar button with a menu was pressed. */
  onActionMenu?: (action: PageNavAction, button: HTMLElement) => void;
  /** The title waits for the page's large title to scroll away. */
  titleFaded?: boolean;
  /** A column's bar on an iPad (ios-bar-list, ios-bar-detail, ios-bar-inspector) and its scroll edge. */
  className?: string;
  style?: CSSProperties;
  /** h2 for a column that isn't the screen's main one. */
  titleAs?: 'h1' | 'h2';
}

/** iOS's bar row: Back or the xmark at the leading edge, the title, then the actions, More and the Confirm checkmark. */
export function IosBarRow({ model, onMore, onActionMenu, titleFaded, className, style, titleAs: Title = 'h1' }: IosBarRowProps) {
  const { lead, confirm } = model;
  return (
    <div className={`ios-bar-row${className ? ` ${className}` : ''}`} style={style}>
      <div className="ios-bar-lead">
        {lead &&
          (lead.kind === 'back' ? (
            <button className="ios-back" aria-label={lead.label} onClick={() => lead.run()}>
              {BACK}
            </button>
          ) : (
            <button className="ios-icon-btn" aria-label={lead.label} disabled={lead.kind === 'cancel' ? lead.disabled : undefined} onClick={() => lead.run()}>
              {XMARK}
            </button>
          ))}
      </div>
      <Title className={`ios-bar-title${titleFaded ? ' faded' : ''}`}>{model.title}</Title>
      <div className="ios-bar-trail">
        {model.actions.map((a) => (
          <button key={a.id} className={`${a.icon || a.ring ? 'ios-icon-btn' : 'ios-text-btn'}${a.on ? ' on' : ''}`} aria-label={a.label} aria-haspopup={a.menu ? 'menu' : undefined} disabled={a.disabled} onClick={(e) => (a.menu ? onActionMenu?.(a, e.currentTarget) : a.run())}>
            {a.icon || a.ring ? <ActionGlyph action={a} /> : a.label}
          </button>
        ))}
        {onMore && (
          <button className="ios-icon-btn" aria-label="More" aria-haspopup="menu" onClick={(e) => onMore(e.currentTarget)}>
            {ELLIPSIS}
          </button>
        )}
        {confirm && (
          <button className="ios-icon-btn prominent" aria-label={confirm.label} disabled={confirm.disabled} onClick={() => confirm.run()}>
            {CHECKMARK}
          </button>
        )}
      </div>
    </div>
  );
}

// ---------- Android ----------

export interface MdBarRowProps {
  model: BarModel;
  /** The screen has an overflow menu: its button, last. */
  onMore?: (button: HTMLElement) => void;
  /** A bar button with a menu was pressed. */
  onActionMenu?: (action: PageNavAction, button: HTMLElement) => void;
  /** A dialog's actions are text buttons, as Material draws them. */
  dialogLike?: boolean;
}

/** Material's top app bar row: the navigation icon, the title, the actions, Confirm as a text button, then the overflow menu. */
export function MdBarRow({ model, onMore, onActionMenu, dialogLike }: MdBarRowProps) {
  const { lead, confirm } = model;
  return (
    <div className="md-bar-row">
      {lead && (
        <button className="md-icon-btn" aria-label={lead.label} disabled={lead.kind === 'cancel' ? lead.disabled : undefined} onClick={() => lead.run()}>
          {lead.kind === 'back' ? ARROW_BACK : lead.kind === 'menu' ? MENU : CLOSE}
        </button>
      )}
      <h1 className={`md-bar-title${lead ? '' : ' no-lead'}`}>{model.title}</h1>
      {model.actions.map((a) =>
        (a.icon || a.ring) && !dialogLike ? (
          <button key={a.id} className={`md-icon-btn${a.on ? ' on' : ''}`} aria-label={a.label} title={a.label} aria-haspopup={a.menu ? 'menu' : undefined} disabled={a.disabled} onClick={(e) => (a.menu ? onActionMenu?.(a, e.currentTarget) : a.run())}>
            <ActionGlyph action={a} size={24} />
          </button>
        ) : (
          <button key={a.id} className="md-text-btn" disabled={a.disabled} onClick={() => a.run()}>
            {a.label}
          </button>
        ),
      )}
      {confirm && (
        <button className="md-text-btn" disabled={confirm.disabled} onClick={() => confirm.run()}>
          {confirm.label}
        </button>
      )}
      {onMore && (
        <button className="md-icon-btn" aria-label="More options" aria-haspopup="menu" onClick={(e) => onMore(e.currentTarget)}>
          {MORE_VERT}
        </button>
      )}
    </div>
  );
}
