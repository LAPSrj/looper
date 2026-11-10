import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { MenuItemSpec } from '@shared/remote-access';
import { platform } from '../platform';
import { accessChar, eventMatches, parseAccelerator, pickChecked, shortcutText, type MenuNav } from '../web/menu-model';
import { useMenuState, type MenuState } from '../web/menu-state';
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
function Label({ item, cues }: { item: MenuItemSpec; cues: boolean }): ReactNode {
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

interface MenuListProps {
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

/** An open menu and its open submenus, kept on the screen. */
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
    const right = r.right - fitRef.current.dx;
    const top = r.top - fitRef.current.dy;
    const bottom = r.bottom - fitRef.current.dy;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const flip = depth > 0 && (fitRef.current.flip || right > vw - 4);
    const dx = depth === 0 && right > vw - 4 ? Math.max(vw - 4 - right, 4 - left) : 0;
    const dy = bottom > vh - 4 ? Math.max(vh - 4 - bottom, 4 - top) : 0;
    setFit({ dx, dy, flip });
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
  const checks = level.items.some((it) => it.type === 'checkbox' || it.type === 'radio');
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
            role={it.type === 'checkbox' ? 'menuitemcheckbox' : it.type === 'radio' ? 'menuitemradio' : 'menuitem'}
            aria-checked={it.type === 'checkbox' || it.type === 'radio' ? !!it.checked : undefined}
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
function OpenMenu({ menu, at, cues, focusActive, isMac }: { menu: MenuState; at: { x: number; y: number }; cues: boolean; focusActive: boolean; isMac: boolean }) {
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
  return (
    <div className={drawn === 'page' ? undefined : 'ws-menu-mirror'}>
      <MenuList nav={menu.nav} depth={0} isMac={isMac} cues={cues} focusActive={focusActive} onHover={menu.hover} onChoose={menu.choose} at={at} />
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
  const at = useMemo(() => ({ x: m.x, y: m.y }), [m.x, m.y]);
  useLayoutEffect(() => menu.open(m.items, false), [m.items]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    box.current?.focus({ preventScroll: true });
    // As a Windows menu does, it closes when the window loses the focus.
    const onBlur = () => finish();
    window.addEventListener('blur', onBlur);
    return () => window.removeEventListener('blur', onBlur);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return createPortal(
    <div
      className="ws-catcher"
      onPointerDown={() => finish()}
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
    // A click anywhere else, or the window losing the focus, leaves the bar.
    const onPointerDown = (e: PointerEvent) => {
      if (state.current.current !== null && state.current.open === null && !(e.target as Element | null)?.closest?.('.ws-menubar')) leave(false);
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

  /** The top-level item under the pointer while a menu is open (the catcher covers the bar). */
  const hit = (x: number, y: number): number =>
    buttons.current.findIndex((b) => {
      const r = b?.getBoundingClientRect();
      return !!r && x >= r.left && x < r.right && y >= r.top && y < r.bottom;
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
          <div
            className="ws-catcher"
            onPointerDown={(e) => {
              const i = hit(e.clientX, e.clientY);
              if (i >= 0 && i !== open) openAt(i, false);
              else leave(true);
            }}
            onPointerMove={(e) => {
              const i = hit(e.clientX, e.clientY);
              if (i >= 0 && i !== open && items[i]?.submenu) openAt(i, byKeyboard);
            }}
            onContextMenu={(e) => e.preventDefault()}
          >
            <OpenMenu menu={menu} at={{ x: anchor.left, y: anchor.bottom }} cues={cues} focusActive={systemKeys} isMac={isMac} />
          </div>,
          document.body,
        )}
    </div>
  );
}
