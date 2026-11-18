import { useMemo } from 'react';
import type { MenuItemSpec } from '../../../shared/remote-access';
import { noMnemonic } from '../../../shared/commands/command';
import type { MenuProps } from '../components/Menu';
import { BottomSheet } from './BottomSheet';
import { placeOnAxis, trailingInset } from './menu-motion';
import { isChoice, menuItemRole } from './menu-roles';
import { phoneMenu } from './more-menu';
import { ARROW_BACK, NavIcon } from './NavBarRow';
import { CHECK } from './phone-files';
import { isLongMenu, menuGroups, useSubmenus } from './phone-shell';
import { useViewport } from './viewport-context';

/*
 * Material 3's menus (Menu, components/Menu.tsx, draws this on Android): the
 * ⋮ overflow menu and a bar button's, and a long press's at the finger, a long
 * one as a bottom sheet on a phone. A submenu replaces its level, with a row
 * back up. Styled in android.css.
 */

const ARROW_RIGHT = (
  <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M10 6 8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z" fill="currentColor" />
  </svg>
);

function MenuItems({ items, title, onUp, onItem }: { items: MenuItemSpec[]; title: string | null; onUp: () => void; onItem: (it: MenuItemSpec) => void }) {
  // One column before the labels for every item, so they line up: a chosen item's check, or else its icon.
  const lead = items.some((it) => isChoice(it) || it.icon);
  const groups = menuGroups(items);
  // The up row heads the first group, even when the level has no items of its own.
  if (title !== null && !groups.length) groups.push([]);
  return (
    <div className="md-menu-list ph-scroll" role="menu">
      {groups.map((group, gi) => (
        <div key={gi} className="md-menu-group" role="group">
          {gi === 0 && title !== null && (
            <button className="md-menu-item md-menu-up" onClick={onUp}>
              <span className="md-menu-lead">{ARROW_BACK}</span>
              <span className="md-menu-label">{title}</span>
            </button>
          )}
          {group.map((it) => (
            <button
              key={it.id}
              role={menuItemRole(it)}
              aria-checked={isChoice(it) ? !!it.checked : undefined}
              aria-haspopup={it.type === 'submenu' || undefined}
              className={`md-menu-item${isChoice(it) && it.checked ? ' checked' : ''}`}
              disabled={!it.enabled}
              onClick={() => onItem(it)}
            >
              {lead && <span className="md-menu-lead">{isChoice(it) && it.checked ? CHECK : it.icon ? <NavIcon name={it.icon} size={24} /> : null}</span>}
              <span className="md-menu-label">{noMnemonic(it.label ?? '')}</span>
              {it.type === 'submenu' && <span className="md-menu-trail">{ARROW_RIGHT}</span>}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

/** The menu's width at the finger. */
const WIDTH = 220;

export default function MaterialMenu({ items, place, popup = false, onPick, onClose }: MenuProps) {
  const vp = useViewport();
  const list = useMemo(() => (popup ? phoneMenu(items) : items), [items, popup]);
  const sub = useSubmenus(list);
  const close = () => onClose?.();
  const pick = (it: MenuItemSpec) => {
    if (it.type === 'submenu') return sub.open(it);
    // The computer closes its own menu; the frame's closes before what's picked runs.
    if (!popup) close();
    onPick?.(it);
  };
  const level = <MenuItems items={sub.level} title={sub.title} onUp={sub.up} onItem={pick} />;
  // Decided on the whole menu, so a short submenu opened in the sheet stays in it.
  if (popup && isLongMenu(list, vp.width, vp.height)) {
    return (
      <BottomSheet onClose={close} label="Menu">
        {level}
      </BottomSheet>
    );
  }
  let style: React.CSSProperties;
  if (place.kind === 'control') style = { right: trailingInset(place.rect.right, window.innerWidth), top: place.rect.top };
  else {
    // 44 dp items, 4 dp padding in each group, 2 dp between groups; a long one stops at .md-menu's max-height and scrolls.
    const groups = menuGroups(list);
    const rows = groups.reduce((n, g) => n + g.length, 0);
    const height = Math.min(rows * 44 + Math.max(1, groups.length) * 8 + Math.max(0, groups.length - 1) * 2, vp.height * 0.7);
    const left = placeOnAxis({ start: Math.max(8, place.x), back: vp.width - 8, size: WIDTH, min: 8, max: vp.width - 8 }).pos;
    const top = placeOnAxis({ start: place.y, size: height, min: 8, max: vp.height - 8 }).pos;
    style = { left, top, minWidth: WIDTH };
  }
  return (
    <div className="md-menu-layer" onPointerDown={(e) => e.target === e.currentTarget && close()} onContextMenu={(e) => e.preventDefault()}>
      <div className="md-menu" style={style}>
        {level}
      </div>
    </div>
  );
}
