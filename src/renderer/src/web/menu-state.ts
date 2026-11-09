import { useMemo, useRef, useState } from 'react';
import type { MenuItemSpec } from '../../../shared/remote-access';
import { menuHover, menuKey, openNav, type MenuNav } from './menu-model';

export interface MenuHandlers {
  pick: (item: MenuItemSpec) => void;
  close: () => void;
  /** Esc on the outermost list; without it, the menu closes. */
  escape?: () => void;
  /** A menu bar's neighbouring menus (Left/Right past the edge). */
  prev?: () => void;
  next?: () => void;
}

export interface MenuState {
  nav: MenuNav;
  open: (items: MenuItemSpec[], byKeyboard: boolean) => void;
  reset: () => void;
  /** A key while the menu is open; true when the menu used it. */
  key: (key: string) => boolean;
  hover: (depth: number, index: number) => void;
  /** A click on item `index` of level `depth`: a submenu opens, anything else is picked. */
  choose: (depth: number, index: number) => void;
}

/** An open menu's highlight and submenus, driven by pointer and keyboard; the frame draws `nav`. */
export function useMenuState(handlers: MenuHandlers): MenuState {
  const [nav, setNavState] = useState<MenuNav>([]);
  const navRef = useRef<MenuNav>([]);
  const h = useRef(handlers);
  h.current = handlers;
  return useMemo(() => {
    const setNav = (n: MenuNav) => {
      navRef.current = n;
      setNavState(n);
    };
    return {
      get nav() {
        return navRef.current;
      },
      open: (items, byKeyboard) => setNav(openNav(items, byKeyboard)),
      reset: () => setNav([]),
      key: (key) => {
        if (navRef.current.length === 0) return false;
        const r = menuKey(navRef.current, key);
        setNav(r.nav);
        const e = r.effect;
        if (e?.kind === 'pick') h.current.pick(e.item);
        else if (e?.kind === 'close') h.current.close();
        else if (e?.kind === 'escape') (h.current.escape ?? h.current.close)();
        else if (e?.kind === 'prev') h.current.prev?.();
        else if (e?.kind === 'next') h.current.next?.();
        return true;
      },
      hover: (depth, index) => setNav(menuHover(navRef.current, depth, index)),
      choose: (depth, index) => {
        const item = navRef.current[depth]?.items[index];
        if (!item || !item.enabled || item.type === 'separator') return;
        if (item.type === 'submenu') setNav(menuHover(navRef.current, depth, index));
        else h.current.pick(item);
      },
    };
    // `nav` is read through the ref; the state only makes the frame draw again.
  }, [nav]);
}
