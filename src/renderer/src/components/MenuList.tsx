import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { MenuItemSpec } from '@shared/remote-access';
import { shortcutText, type MenuNav } from '../web/menu-model';
import { placeOnAxis } from '../web/menu-motion';
import { isChoice, menuItemRole } from '../web/menu-roles';
import { Chevron } from './icons';

const CHECK = (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
    <path d="M2 6.5l2.5 2.5L10 3.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
  </svg>
);
const DOT = (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
    <circle cx="6" cy="6" r="2.5" fill="currentColor" />
  </svg>
);

/** "Ctrl+Shift+N" as aria-keyshortcuts writes it: "Control+Shift+N". */
const ariaKeys = (text: string): string | undefined => (text ? text.replace(/\bCtrl\b/g, 'Control').replace(/\bCmd\b/g, 'Meta').replace(/\bDel\b/g, 'Delete') : undefined);

/** A label with its access key underlined while `cues` is on, as Windows shows them once Alt is pressed. */
export function Label({ item, cues }: { item: MenuItemSpec; cues: boolean }): ReactNode {
  const label = item.label ?? '';
  const at = item.access;
  if (!cues || at === undefined || at >= label.length) return label;
  return (
    <>
      {label.slice(0, at)}
      <u className="menu-access">{label[at]}</u>
      {label.slice(at + 1)}
    </>
  );
}

export interface MenuListProps {
  nav: MenuNav;
  depth: number;
  isMac: boolean;
  /** Access keys underlined. */
  cues?: boolean;
  /** The highlighted item takes the focus, so a screen reader reads it. */
  focusActive?: boolean;
  onHover: (depth: number, index: number) => void;
  onChoose: (depth: number, index: number) => void;
  /** The outermost list's page position; submenus sit next to their item. */
  at?: { x: number; y: number };
  /** Moved to stay in the page; off in a menu level window, which the main process places on the screen. */
  fit?: boolean;
}

/**
 * A Win32 menu: an open level and its open submenus, kept on the screen. Placed through Menu (Menu.tsx),
 * which draws it on the desktop; a desktop app's menu level window draws a level with it directly.
 */
export function MenuList({ nav, depth, isMac, cues = false, focusActive = false, onHover, onChoose, at, fit: fits = true }: MenuListProps) {
  const level = nav[depth];
  const ref = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState({ dx: 0, dy: 0, flip: false });
  const fitRef = useRef(fit);
  fitRef.current = fit;
  // Kept on screen: measured where it would be without the last shift.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !fits) return;
    const r = el.getBoundingClientRect();
    const left = r.left - fitRef.current.dx;
    const top = r.top - fitRef.current.dy;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // Shifted in from the edge it would cross; a submenu that would cross the right edge opens to the left.
    const x = placeOnAxis({ start: left, back: vw - 4, size: r.width, min: 4, max: vw - 4 });
    const y = placeOnAxis({ start: top, back: vh - 4, size: r.height, min: 4, max: vh - 4 });
    const flip = depth > 0 && (fitRef.current.flip || !x.forward);
    setFit({ dx: depth === 0 ? x.pos - left : 0, dy: y.pos - top, flip });
  }, [level?.items, depth]);
  const active = level?.active ?? -1;
  const deepest = depth === nav.length - 1;
  useLayoutEffect(() => {
    if (!focusActive || !deepest || active < 0) return;
    ref.current?.querySelector<HTMLElement>(`:scope > [data-index="${active}"]`)?.focus({ preventScroll: true });
  }, [focusActive, deepest, active]);
  if (!level) return null;
  const style: React.CSSProperties = at
    ? { position: 'fixed', left: at.x + fit.dx, top: at.y + fit.dy }
    : { position: 'absolute', top: -5 + fit.dy, ...(fit.flip ? { right: '100%' } : { left: '100%' }) };
  const checks = level.items.some(isChoice);
  return (
    <div ref={ref} className={checks ? 'ws-menu has-checks' : 'ws-menu'} role="menu" style={style} onPointerDown={(e) => e.stopPropagation()}>
      {level.items.map((it, i) => {
        if (it.type === 'separator') return <div key={it.id} className="ws-menu-sep" role="separator" />;
        const keys = shortcutText(it, isMac);
        return (
          <div
            key={it.id}
            data-index={i}
            tabIndex={-1}
            role={menuItemRole(it)}
            aria-checked={isChoice(it) ? !!it.checked : undefined}
            aria-disabled={!it.enabled || undefined}
            aria-haspopup={it.type === 'submenu' ? 'menu' : undefined}
            aria-expanded={it.type === 'submenu' ? i === level.active && !!nav[depth + 1] : undefined}
            aria-keyshortcuts={ariaKeys(keys)}
            className={`ws-menu-item${i === level.active ? ' active' : ''}${it.enabled ? '' : ' disabled'}`}
            onPointerEnter={() => onHover(depth, i)}
            onClick={(e) => {
              e.stopPropagation();
              onChoose(depth, i);
            }}
          >
            <span className="ws-menu-check">{it.checked ? (it.type === 'radio' ? DOT : it.type === 'checkbox' ? CHECK : null) : null}</span>
            <span className="ws-menu-label">
              <Label item={it} cues={cues} />
            </span>
            <span className="ws-menu-key">{keys}</span>
            <span className="ws-menu-arrow">{it.type === 'submenu' ? <Chevron /> : null}</span>
            {it.type === 'submenu' && level.active === i && nav[depth + 1] && (
              <MenuList nav={nav} depth={depth + 1} isMac={isMac} cues={cues} focusActive={focusActive} onHover={onHover} onChoose={onChoose} />
            )}
          </div>
        );
      })}
    </div>
  );
}
