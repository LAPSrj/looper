import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { MenuItemSpec } from '@shared/remote-access';
import { platform } from '../platform';
import { accessChar, eventMatches, parseAccelerator, pickChecked } from '../web/menu-model';
import { useMenuState, type MenuState } from '../web/menu-state';
import { Menu, useCloseOnPressOutside, useHoldWheel } from './Menu';
import { Label } from './MenuList';

// A desktop app's menu level window draws a level of an open menu itself.
export { MenuList } from './MenuList';

/**
 * A desktop app window's menu bar, drawn from the menu the main process keeps set (hidden) for the window:
 * `initial` is the one it had as the window started, and each change comes as a `menu-bar` ui event.
 */
export function WindowMenuBar({ initial }: { initial: MenuItemSpec[] | null }) {
  const [items, setItems] = useState(initial);
  const pick = (item: MenuItemSpec) => window.looper.commands.pickMenuBar(item.id, pickChecked(item));
  useEffect(() => {
    const off = window.looper.onUi((e) => {
      if (e.type === 'menu-bar') setItems(e.items);
    });
    // One that changed before this listened.
    void window.looper.commands.menuBarItems().then(setItems, () => undefined);
    return off;
  }, []);
  // The shortcuts the page's own command handlers don't take (the main process's items, roles), after those had their turn.
  useEffect(() => {
    if (!items?.length) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat) return;
      const item = findShortcut(items, e);
      if (!item) return;
      // A disabled item still keeps its key, as the native menu did.
      e.preventDefault();
      if (item.enabled) pick(item);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [items]);
  if (!items?.length) return null;
  return <MenuBar items={items} isMac={false} systemKeys onPick={pick} />;
}

/**
 * An open menu: drawn past the window's edges by windows of its own in the desktop app (main
 * platform/menu-popups.ts), else in the page. Either way the page keeps the menu, invisible while the windows
 * draw it, with the keyboard focus, so a screen reader reads its items and its keys work as before.
 */
function OpenMenu({ menu, at, cues, focusActive, isMac, live }: { menu: MenuState; at: { x: number; y: number }; cues: boolean; focusActive: boolean; isMac: boolean; live?: string }) {
  const [drawn, setDrawn] = useState<'asking' | 'windows' | 'page'>(platform === 'electron' ? 'asking' : 'page');
  const drawnRef = useRef(drawn);
  drawnRef.current = drawn;
  const menuRef = useRef(menu);
  menuRef.current = menu;
  useEffect(() => {
    if (drawnRef.current === 'page') return;
    const asked = window.looper.commands.menuPopups({ levels: menu.nav.map((l) => ({ items: l.items, active: l.active })), at, cues });
    if (drawnRef.current === 'asking') void asked.then((ok) => setDrawn(ok ? 'windows' : 'page'), () => setDrawn('page'));
  }, [menu.nav, at.x, at.y, cues]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const off = window.looper.onUi((e) => {
      if (e.type !== 'menu-popup-input') return;
      if (e.kind === 'hover') menuRef.current.hover(e.depth, e.index);
      else menuRef.current.choose(e.depth, e.index);
    });
    return () => {
      off();
      if (drawnRef.current !== 'page') void window.looper.commands.menuPopups(null);
    };
  }, []);
  // The window takes the mouse only over what the page draws of the menu and `live` (a menu bar), as under Win32's menus.
  const box = useRef<HTMLDivElement>(null);
  useHoldWheel();
  useLayoutEffect(() => {
    const el = box.current;
    if (platform !== 'electron' || !el) return;
    let sent = '';
    const send = () => {
      const boxes = [...(drawn === 'page' ? el.querySelectorAll('.ws-menu') : []), ...(live ? document.querySelectorAll(live) : [])].map((b) => {
        const r = b.getBoundingClientRect();
        return { x: r.left, y: r.top, width: r.width, height: r.height };
      });
      const json = JSON.stringify(boxes);
      if (json === sent) return;
      sent = json;
      window.looper.commands.menuMouse(boxes);
    };
    send();
    const moved = new MutationObserver(send);
    moved.observe(el, { subtree: true, childList: true, attributes: true });
    return () => {
      moved.disconnect();
      window.looper.commands.menuMouse(null);
    };
  }, [drawn, live]);
  return (
    <div ref={box} className={drawn === 'page' ? undefined : 'ws-menu-mirror'}>
      <Menu items={menu.nav[0]?.items ?? []} place={{ kind: 'point', ...at }} keys={{ state: menu, cues, focusActive }} isMac={isMac} />
    </div>
  );
}

type OpenContextMenu = { menuId: string; items: MenuItemSpec[]; x: number; y: number };

/** The desktop app's context menus, drawn in the page in the menu bar's style from the menu the main process sends. */
export function WindowContextMenu() {
  const [open, setOpen] = useState<OpenContextMenu | null>(null);
  const openRef = useRef(open);
  openRef.current = open;
  /** What had the focus before the first of the menus: a menu replacing an open one gives it back there too. */
  const back = useRef<HTMLElement | null>(null);
  useEffect(() => {
    // Where the last right-click was, until another press: a menu that took a moment to build opens there, not where the pointer went since.
    let rightClick: { x: number; y: number } | null = null;
    const onMenu = (e: MouseEvent) => {
      rightClick = e.button === 2 ? { x: e.clientX, y: e.clientY } : null;
    };
    const onPress = (e: PointerEvent) => {
      if (e.button !== 2) rightClick = null;
    };
    const onKey = () => {
      rightClick = null;
    };
    window.addEventListener('contextmenu', onMenu, true);
    window.addEventListener('pointerdown', onPress, true);
    window.addEventListener('keydown', onKey, true);
    const off = window.looper.onUi((e) => {
      if (e.type !== 'context-menu') return;
      if (!openRef.current) back.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const at = e.atPointer && rightClick ? rightClick : { x: e.x, y: e.y };
      rightClick = null;
      setOpen({ menuId: e.menuId, items: e.items, ...at });
    });
    return () => {
      off();
      window.removeEventListener('contextmenu', onMenu, true);
      window.removeEventListener('pointerdown', onPress, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, []);
  // A new menu replaces the open one; the main process has closed that one already.
  return open ? <ContextMenu key={open.menuId} menu={open} back={back} onDone={() => setOpen(null)} /> : null;
}

function ContextMenu({ menu: m, back, onDone }: { menu: OpenContextMenu; back: React.RefObject<HTMLElement | null>; onDone: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const done = useRef(false);
  const finish = (pick?: MenuItemSpec) => {
    if (done.current) return;
    done.current = true;
    // The focus goes back first, so an edit command (Copy, Paste) acts on what had it.
    if (back.current?.isConnected) back.current.focus({ preventScroll: true });
    if (pick) window.looper.commands.pickContextMenu(m.menuId, pick.id, pickChecked(pick));
    else window.looper.commands.dismissContextMenu(m.menuId);
    onDone();
  };
  const menu = useMenuState({ pick: (item) => finish(item), close: () => finish() });
  useCloseOnPressOutside(() => finish());
  const at = useMemo(() => ({ x: m.x, y: m.y }), [m.x, m.y]);
  useLayoutEffect(() => menu.open(m.items, false), [m.items]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    box.current?.focus({ preventScroll: true });
    // As a Windows menu does, it closes when the window loses the focus.
    const onBlur = () => finish();
    // And it keeps the keys while it's open: what takes the focus meanwhile (a chat the right-click opened focuses
    // its message box) gets it once the menu closes.
    const onFocus = (e: FocusEvent) => {
      const el = box.current;
      if (done.current || !el || !(e.target instanceof HTMLElement) || el.contains(e.target)) return;
      back.current = e.target;
      (el.querySelector<HTMLElement>('.ws-menu-item.active') ?? el).focus({ preventScroll: true });
    };
    window.addEventListener('blur', onBlur);
    document.addEventListener('focusin', onFocus);
    return () => {
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('focusin', onFocus);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return createPortal(
    <div
      className="ws-catcher"
      onContextMenu={(e) => {
        e.preventDefault();
        finish();
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
        <OpenMenu menu={menu} at={at} cues={false} focusActive isMac={false} />
      </div>
    </div>,
    document.body,
  );
}

/** Roles the page carries out itself on their usual keys (the text fields' editing). */
const PAGE_ROLES = new Set(['undo', 'redo', 'cut', 'copy', 'paste', 'pasteandmatchstyle', 'selectall', 'delete']);

/** The item a key press is the shortcut of: like findAccelerator, but the other roles (Reload UI) too, which the main process runs. */
function findShortcut(items: MenuItemSpec[], e: KeyboardEvent): MenuItemSpec | null {
  for (const it of items) {
    if (it.type === 'submenu') {
      const found = it.submenu ? findShortcut(it.submenu, e) : null;
      if (found) return found;
      continue;
    }
    if (it.type === 'separator' || !it.accelerator || it.registerAccelerator === false || (it.role && PAGE_ROLES.has(it.role.toLowerCase()))) continue;
    const a = parseAccelerator(it.accelerator, false);
    if (a && eventMatches(a, e)) return it;
  }
  return null;
}

interface MenuBarProps {
  items: MenuItemSpec[];
  isMac: boolean;
  onPick: (item: MenuItemSpec) => void;
  /** A menu opened or closed (the browser's shell covers the windows under it). */
  onOpenChange?: (open: boolean) => void;
  /**
   * The window's own menu bar in the desktop app: it takes the keys Windows gives a menu bar (Alt or F10 to
   * reach it, Alt+letter to open a menu), underlines access keys while they work, and gives the focus back
   * where it was. In a browser those keys are the browser's.
   */
  systemKeys?: boolean;
}

/** A window's menu bar: File, Task, View… */
export function MenuBar({ items, isMac, onPick, onOpenChange, systemKeys = false }: MenuBarProps) {
  const [open, setOpen] = useState<number | null>(null);
  /** The item the keyboard is on while no menu is open (Alt, F10, Esc from a menu). */
  const [current, setCurrent] = useState<number | null>(null);
  const [cues, setCues] = useState(false);
  const [byKeyboard, setByKeyboard] = useState(false);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  /** Where the focus was before the menu bar took it, to give it back. */
  const back = useRef<HTMLElement | null>(null);
  const takeFocus = () => {
    if (back.current) return;
    const el = document.activeElement;
    back.current = el instanceof HTMLElement && !el.closest('.ws-menubar, .ws-menu') ? el : null;
  };
  const giveBack = () => {
    const el = back.current;
    back.current = null;
    if (el?.isConnected) el.focus({ preventScroll: true });
    else (document.activeElement as HTMLElement | null)?.blur?.();
  };
  const usable = (i: number) => !!items[i]?.enabled;
  const neighbour = (from: number, dir: 1 | -1): number => {
    for (let k = 1; k <= items.length; k++) {
      const i = (from + dir * k + items.length) % items.length;
      if (usable(i)) return i;
    }
    return from;
  };
  const first = () => neighbour(-1, 1);
  /** Everything closes; `restore`: the focus goes back where it was. */
  const leave = (restore: boolean) => {
    setOpen(null);
    setCurrent(null);
    setCues(false);
    menu.reset();
    if (restore) giveBack();
    else back.current = null;
  };
  const openAt = (i: number, keyboard: boolean) => {
    const top = items[i];
    if (!top?.enabled || !top.submenu?.length) return;
    takeFocus();
    setOpen(i);
    setCurrent(i);
    setByKeyboard(keyboard);
    menu.open(top.submenu, keyboard);
  };
  const menu = useMenuState({
    pick: (item) => {
      // The focus goes back first, so an edit command (Copy, Paste) acts on what had it.
      leave(true);
      onPick(item);
    },
    close: () => leave(true),
    escape: () => {
      // Esc on a menu closes it and leaves its name on the bar highlighted; Esc again leaves the bar.
      if (!systemKeys || open === null) return leave(true);
      const at = open;
      setOpen(null);
      menu.reset();
      setCurrent(at);
      setCues(true);
    },
    prev: () => open !== null && openAt(neighbour(open, -1), true),
    next: () => open !== null && openAt(neighbour(open, 1), true),
  });
  const isOpen = open !== null;
  const openChange = useRef(onOpenChange);
  openChange.current = onOpenChange;
  useEffect(() => {
    if (!isOpen) return;
    openChange.current?.(true);
    return () => openChange.current?.(false);
  }, [isOpen]);
  // Focus once `open` is on the button, so its focus ring (hidden while open) never paints; with no menu, the keyboard's item.
  useLayoutEffect(() => {
    if (open === null && current !== null) buttons.current[current]?.focus({ preventScroll: true });
    else if (open !== null && !byKeyboard) buttons.current[open]?.focus({ preventScroll: true });
  }, [open, current, byKeyboard]);

  /** The top item whose access key is `key`, or -1. */
  const byAccess = (key: string) => items.findIndex((it) => it.enabled && accessChar(it) === key.toLocaleLowerCase());

  // The keys of a menu bar on Windows. Alt alone (pressed and let go) and F10 reach the bar or leave it.
  const altAlone = useRef(false);
  const state = useRef({ open, current });
  state.current = { open, current };
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const { open: o, current: c } = state.current;
      if (o !== null) {
        if (e.key === 'Alt' || e.key === 'F10') {
          e.preventDefault();
          altAlone.current = e.key === 'Alt';
          if (e.key === 'F10') leave(true);
          return;
        }
        if (menu.key(e.key)) {
          e.preventDefault();
          e.stopPropagation();
        }
        return;
      }
      if (!systemKeys) return;
      if (e.key === 'Alt' && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        if (!e.repeat) altAlone.current = true;
        setCues(true);
        e.preventDefault();
        return;
      }
      altAlone.current = false;
      if (e.key === 'F10' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        if (c !== null) return leave(true);
        takeFocus();
        setCues(true);
        setCurrent(first());
        return;
      }
      // Alt+letter: the menu with that access key (AltGr, which is Ctrl+Alt, types instead).
      if (e.altKey && !e.ctrlKey && !e.metaKey && e.key.length === 1) {
        const i = byAccess(e.key);
        if (i >= 0) {
          e.preventDefault();
          e.stopPropagation();
          openAt(i, true);
        }
        return;
      }
      if (c === null) return;
      // The bar has the keyboard: Left and Right move along it, Down, Up, Enter and Space open, a letter opens its menu.
      const take = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        take();
        setCurrent(neighbour(c, e.key === 'ArrowLeft' ? -1 : 1));
      } else if (e.key === 'Home' || e.key === 'End') {
        take();
        setCurrent(e.key === 'Home' ? first() : neighbour(0, -1));
      } else if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
        take();
        openAt(c, true);
      } else if (e.key === 'Escape' || e.key === 'Tab') {
        take();
        leave(true);
      } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
        take();
        const i = byAccess(e.key);
        if (i >= 0) openAt(i, true);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (!systemKeys || e.key !== 'Alt') return;
      const { open: o, current: c } = state.current;
      const alone = altAlone.current;
      altAlone.current = false;
      // Electron would otherwise hand Alt to the hidden native menu bar.
      e.preventDefault();
      if (!alone) {
        if (c === null && o === null) setCues(false);
        return;
      }
      if (o !== null || c !== null) return leave(true);
      takeFocus();
      setCurrent(first());
    };
    // A press anywhere else, or the window losing the focus, leaves the bar; as with Win32's menus, the press still
    // reaches what's under it. The bar's own items open and close its menus.
    const onPointerDown = (e: PointerEvent) => {
      const at = e.target instanceof Element ? e.target : null;
      if (at?.closest('.ws-menubar')) return;
      if (state.current.open !== null) {
        if (!at?.closest('.ws-menu')) leave(true);
      } else if (state.current.current !== null) leave(false);
    };
    const onBlur = () => {
      if (state.current.current !== null || state.current.open !== null) leave(false);
      setCues(false);
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('blur', onBlur);
    };
    // The handlers read the state through `state` and the menu through its ref-backed object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [systemKeys, items, menu]);
  // The menu went away under it (a new menu bar): close.
  useEffect(() => {
    if (open !== null && !items[open]?.submenu) leave(false);
  });

  const anchor = open !== null ? buttons.current[open]?.getBoundingClientRect() : undefined;

  return (
    <div className="ws-menubar" role="menubar" aria-orientation="horizontal">
      {items.map((top, i) => {
        const access = accessChar(top);
        return (
          <button
            key={top.id}
            ref={(el) => {
              buttons.current[i] = el;
            }}
            type="button"
            tabIndex={i === (current ?? open ?? -1) ? 0 : -1}
            className={`ws-menubar-item${open === i ? ' open' : ''}${current === i && open === null ? ' current' : ''}`}
            role="menuitem"
            aria-haspopup={top.submenu ? 'menu' : undefined}
            aria-expanded={top.submenu ? open === i : undefined}
            aria-keyshortcuts={systemKeys && access ? `Alt+${access.toUpperCase()}` : undefined}
            disabled={!top.enabled}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.preventDefault();
              if (open === i) leave(true);
              else openAt(i, false);
            }}
            onPointerEnter={() => {
              if (open !== null && open !== i) openAt(i, byKeyboard);
            }}
            onClick={() => {
              // A top-level item without a menu of its own is picked like any other.
              if (!top.submenu) {
                leave(true);
                onPick(top);
              }
            }}
          >
            <Label item={top} cues={cues} />
          </button>
        );
      })}
      {open !== null &&
        anchor &&
        createPortal(
          <div className="ws-catcher" onContextMenu={(e) => e.preventDefault()}>
            <OpenMenu menu={menu} at={{ x: anchor.left, y: anchor.bottom }} cues={cues} focusActive={systemKeys} isMac={isMac} live=".ws-menubar" />
          </div>,
          document.body,
        )}
    </div>
  );
}
