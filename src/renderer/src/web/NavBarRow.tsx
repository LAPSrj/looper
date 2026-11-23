import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { UsageGlyph } from '../components/ContextRing';
import { Icon } from '../components/Icon';
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
export const MORE_VERT = (
  <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="5.5" r="2" fill="currentColor" />
    <circle cx="12" cy="12" r="2" fill="currentColor" />
    <circle cx="12" cy="18.5" r="2" fill="currentColor" />
  </svg>
);

/** An icon as a 22 px glyph for a bar button. */
export function NavIcon({ name, size = 22 }: { name: string; size?: number }) {
  return <Icon name={name} size={size} stroke={1.3} />;
}

/** A bar button's glyph: the usage glyph, or its icon. */
export function ActionGlyph({ action, size = 22 }: { action: Pick<PageNavAction, 'icon' | 'ring'>; size?: number }) {
  if (action.ring) {
    return (
      <svg width={size} height={size} viewBox="0 0 18 18" aria-hidden="true">
        <UsageGlyph ring={action.ring} />
      </svg>
    );
  }
  return action.icon ? <NavIcon name={action.icon} size={size} /> : null;
}

const FIT_TEXT: CSSProperties = { display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
/** No height, so it only widens the line to its longest form, as far as the bar has room. */
const FIT_SIZES: CSSProperties = { display: 'block', height: 0, overflow: 'hidden', visibility: 'hidden' };
const FIT_SIZE: CSSProperties = { display: 'block', width: 'max-content', whiteSpace: 'nowrap' };

/** One line in the first of its forms (longest first) that fits its room, else the last one cut short. */
function FitLine({ className, forms }: { className: string; forms: string[] }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [pick, setPick] = useState(0);
  const key = forms.join('\n');
  useLayoutEffect(() => {
    const line = ref.current;
    if (!line || forms.length < 2) return;
    const [text, sizes] = [line.children[0] as HTMLElement, line.children[1] as HTMLElement];
    const choose = () => {
      const i = [...sizes.children].findIndex((form) => form.getBoundingClientRect().width <= text.clientWidth + 0.5);
      setPick(i < 0 ? forms.length - 1 : i);
    };
    choose();
    const ro = new ResizeObserver(choose);
    ro.observe(line);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` is the forms' content
  }, [key]);
  if (forms.length < 2) return <p className={className}>{forms[0]}</p>;
  return (
    <p ref={ref} className={`${className} fit`}>
      <span style={FIT_TEXT}>{forms[Math.min(pick, forms.length - 1)]}</span>
      <span style={FIT_SIZES} aria-hidden="true">
        {forms.map((f) => (
          <span key={f} style={FIT_SIZE}>
            {f}
          </span>
        ))}
      </span>
    </p>
  );
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

/**
 * The title is centered on the screen, as ios.md says: both side columns take the width of the wider side
 * (`--ios-bar-side`, which ios-bar.css gives them as their least width). When the title can't fit centered between
 * them, as UIKit does, the sides keep their own widths and the title takes all the room between the buttons, off
 * center, whole when that holds it and cut only when nothing does.
 */
function useEqualSides() {
  const row = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = row.current;
    const lead = el?.querySelector<HTMLElement>(':scope > .ios-bar-lead');
    const trail = el?.querySelector<HTMLElement>(':scope > .ios-bar-trail');
    if (!el || !lead || !trail) return;
    const measure = () => {
      const side = Math.max(lead.offsetWidth, trail.offsetWidth);
      const title = el.querySelector<HTMLElement>('.ios-bar-title');
      let fits = true;
      if (title) {
        // The text's own width (the title is cut by its box, not by its text), and the title's side padding.
        const range = document.createRange();
        range.selectNodeContents(title);
        const cs = getComputedStyle(title);
        const need = range.getBoundingClientRect().width + parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
        const rs = getComputedStyle(el);
        const room = el.clientWidth - parseFloat(rs.paddingLeft) - parseFloat(rs.paddingRight) - 2 * side;
        fits = need <= room + 0.5;
      }
      if (fits) el.style.setProperty('--ios-bar-side', `${side}px`);
      else el.style.removeProperty('--ios-bar-side');
    };
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    watch.observe(lead);
    watch.observe(trail);
    return () => watch.disconnect();
  });
  return row;
}

/** iOS's bar row: Back or the xmark at the leading edge, the title, then the actions, More and the Confirm checkmark. */
export function IosBarRow({ model, onMore, onActionMenu, titleFaded, className, style, titleAs: Title = 'h1' }: IosBarRowProps) {
  const { lead, confirm } = model;
  const row = useEqualSides();
  return (
    <div ref={row} className={`ios-bar-row${className ? ` ${className}` : ''}`} style={style}>
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
      {model.subtitle ? (
        <div className={`ios-bar-titles${titleFaded ? ' faded' : ''}`}>
          <Title className="ios-bar-title">{model.title}</Title>
          <FitLine className="ios-bar-subtitle" forms={model.subtitle} />
        </div>
      ) : (
        <Title className={`ios-bar-title${titleFaded ? ' faded' : ''}`}>{model.title}</Title>
      )}
      <div className="ios-bar-trail">
        {(model.actions.length > 0 || onMore) && (
          <div className="ios-bar-group">
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
          </div>
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

export const CHEVRON_DOWN = (
  <svg width="10" height="6" viewBox="0 0 10 6" aria-hidden="true">
    <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export interface IosBrowserBarRowProps {
  /** The folder's path in the title's place: PathBar, the folder's name opening a menu of the folders above it. */
  title: ReactNode;
  canBack: boolean;
  onBack: () => void;
  actions: { id: string; label: string; icon: string; run: () => void }[];
  confirm?: { label: string; disabled: boolean; run: () => void };
  onClose: () => void;
}

/**
 * A file browser's bar in a sheet, its buttons where HIG Sheets puts a sheet's:
 * Close (the xmark, Cancel) at the leading edge, and Back, alone, at the far
 * leading edge once there's a folder to go back to (HIG Toolbars). With Done
 * too, Back takes Close's place, since "Avoid showing all three buttons —
 * Cancel, Done, and Back — together" (a swipe down still closes the sheet).
 * Then the folder's name with a chevron that opens the folders above it, the
 * browser's buttons each in a circle of its own, and Done, tinted, last. An
 * iPhone's bar has no Forward.
 */
export function IosBrowserBarRow({ title, canBack, onBack, actions, confirm, onClose }: IosBrowserBarRowProps) {
  return (
    <div className="ios-bar-row ios-files-bar">
      <div className="ios-bar-lead">
        {canBack && (
          <button className="ios-icon-btn" aria-label="Back" onClick={onBack}>
            {BACK}
          </button>
        )}
        {!(canBack && confirm) && (
          <button className="ios-icon-btn" aria-label="Close" onClick={onClose}>
            {XMARK}
          </button>
        )}
      </div>
      {title}
      <div className="ios-bar-trail">
        {actions.map((a) => (
          <button key={a.id} className="ios-icon-btn" aria-label={a.label} onClick={a.run}>
            <NavIcon name={a.icon} />
          </button>
        ))}
        {confirm && (
          <button className="ios-icon-btn prominent" aria-label={confirm.label} disabled={confirm.disabled} onClick={confirm.run}>
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
          {lead.kind === 'back' ? ARROW_BACK : CLOSE}
        </button>
      )}
      {model.subtitle ? (
        <div className={`md-bar-titles${lead ? '' : ' no-lead'}`}>
          <h1 className="md-bar-title">{model.title}</h1>
          <FitLine className="md-bar-subtitle" forms={model.subtitle} />
        </div>
      ) : (
        <h1 className={`md-bar-title${lead ? '' : ' no-lead'}`}>{model.title}</h1>
      )}
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
