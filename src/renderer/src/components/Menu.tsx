import { lazy, Suspense, useEffect, useLayoutEffect, useRef, type ComponentType } from 'react';
import { createPortal } from 'react-dom';
import type { MenuItemSpec } from '@shared/remote-access';
import { platform } from '../platform';
import { useMenuState, type MenuState } from '../web/menu-state';
import { MenuList } from './MenuList';

/** Where a menu opens. */
export type MenuPlace =
  /**
   * Out of a control: a bar button's menu lines up with its trailing edge (`rect`, the button or its group) and
   * grows out of `from` (the button; `rect` when unset); a title's (`align: 'center'`) is centered on it.
   */
  | { kind: 'control'; rect: DOMRect; from?: DOMRect; align?: 'end' | 'center' }
  /** At a point: a right-click, a long press, under a menu bar's item. `control`: the control the menu belongs to, which iOS opens it out of. */
  | { kind: 'point'; x: number; y: number; control?: DOMRect | null };

export interface MenuProps {
  items: MenuItemSpec[];
  place: MenuPlace;
  /** An item picked. A menu closes itself after a pick (onClose), except a `popup`, which the computer closes. With `keys`, the opener's state picks. */
  onPick?: (item: MenuItemSpec) => void;
  /** It closed without a pick, or after one. With `keys`, the opener's state closes it. */
  onClose?: () => void;
  /** iOS: a row of buttons across its top, a symbol over a short label (HIG: Menus, the medium layout). */
  row?: MenuItemSpec[];
  /**
   * A menu the computer popped up over a page (a long press, a right-click): a phone leaves out what can't be done
   * now and puts destructive items last; iOS dims what's behind it; Android shows a long one as a bottom sheet on a
   * phone. It stays until the computer closes it.
   */
  popup?: boolean;
  /**
   * The desktop: the keyboard of whoever opened it (a menu bar, which also catches the clicks around it), with its
   * access-key cues and whether the highlighted item takes the focus. Without it the menu takes the keys and the
   * clicks outside itself.
   */
  keys?: { state: MenuState; cues: boolean; focusActive: boolean };
  isMac?: boolean;
}

/**
 * Loads one OS's menu on demand: the desktop app never loads a phone's, and a phone's frame starts loading its own
 * as soon as this module does, so it's there by the first menu.
 */
function variant(load: () => Promise<{ default: ComponentType<MenuProps> }>, now: boolean): ComponentType<MenuProps> {
  let loaded: ComponentType<MenuProps> | null = null;
  const start = () =>
    load().then((m) => {
      loaded = m.default;
      return m;
    });
  if (now) void start().catch(() => undefined);
  const Lazy = lazy(start);
  return function MenuVariant(props: MenuProps) {
    const Loaded = loaded;
    if (Loaded) return <Loaded {...props} />;
    return (
      <Suspense fallback={null}>
        <Lazy {...props} />
      </Suspense>
    );
  };
}

const IosMenu = variant(() => import('../web/IosMenu'), platform === 'ios');
const MaterialMenu = variant(() => import('../web/MaterialMenu'), platform === 'android');

/**
 * A menu, as the OS it shows on draws one: iOS's (groups split by a gap, an icon column, submenus opening in place
 * over their row), Material's on Android (a submenu replaces its level, with a row back up), Win32's on the
 * desktop (submenus beside their item, keyboard and access keys). The frames, the menu bar and the context menus
 * all place this.
 */
export function Menu(props: MenuProps) {
  if (platform === 'ios') return <IosMenu {...props} />;
  if (platform === 'android') return <MaterialMenu {...props} />;
  return <Win32Menu {...props} />;
}

function Win32Menu({ items, place, onPick, onClose, popup, keys, isMac = false }: MenuProps) {
  const at = place.kind === 'point' ? { x: place.x, y: place.y } : { x: place.rect.left, y: place.rect.bottom };
  if (keys) {
    const { state, cues, focusActive } = keys;
    return <MenuList nav={state.nav} depth={0} isMac={isMac} cues={cues} focusActive={focusActive} onHover={state.hover} onChoose={state.choose} at={at} />;
  }
  return <Win32Popup items={items} at={at} isMac={isMac} popup={!!popup} onPick={onPick} onClose={onClose} />;
}

/** As with Win32's menus, a press outside the open menu closes it and still reaches what's under the pointer. */
export function useCloseOnPressOutside(close: () => void): void {
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!(e.target instanceof Element && e.target.closest('.ws-menu'))) latest.current();
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, []);
}

/** As under Win32's menus, the wheel doesn't scroll the page while a menu is open (Electron's before-mouse-event doesn't see it). */
export function useHoldWheel(): void {
  useEffect(() => {
    const hold = (e: WheelEvent) => {
      if (!(e.target instanceof Element && e.target.closest('.ws-menu'))) e.preventDefault();
    };
    window.addEventListener('wheel', hold, { capture: true, passive: false });
    return () => window.removeEventListener('wheel', hold, { capture: true });
  }, []);
}

/** A menu of its own (a context menu the computer popped up): it takes the keys, and a click outside closes it. */
function Win32Popup({ items, at, isMac, popup, onPick, onClose }: { items: MenuItemSpec[]; at: { x: number; y: number }; isMac: boolean; popup: boolean; onPick?: (item: MenuItemSpec) => void; onClose?: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const menu = useMenuState({
    pick: (item) => {
      onPick?.(item);
      if (!popup) onClose?.();
    },
    close: () => onClose?.(),
  });
  useLayoutEffect(() => menu.open(items, false), [items]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => box.current?.focus(), []);
  useCloseOnPressOutside(() => onClose?.());
  useHoldWheel();
  return createPortal(
    <div
      className="ws-catcher"
      onContextMenu={(e) => {
        e.preventDefault();
        onClose?.();
      }}
    >
      <div
        ref={box}
        tabIndex={-1}
        className="ws-menu-focus"
        onKeyDown={(e) => {
          if (menu.key(e.key)) {
            e.preventDefault();
            e.stopPropagation();
          }
        }}
      >
        <MenuList nav={menu.nav} depth={0} isMac={isMac} onHover={menu.hover} onChoose={menu.choose} at={at} />
      </div>
    </div>,
    document.body,
  );
}
