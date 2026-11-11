import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { MenuItemSpec } from '@shared/remote-access';
import { MenuList } from './components/MenuBar';

/** The room around the menu for its shadow: MENU_PAD in the main process's menu-popups.ts. */
const PAD = 8;

/**
 * One level of a desktop window's open menu, in a window of its own so it can reach past that window's edges
 * (main platform/menu-popups.ts). It only draws: the window whose menu it is has the keyboard and the state,
 * and gets the pointer's hovers and clicks from here.
 */
export function MenuLevelApp({ depth }: { depth: number }) {
  const [level, setLevel] = useState<{ items: MenuItemSpec[]; active: number; cues: boolean } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  /**
   * The size the window is in place for (null: shrunk, as it is between menus), and the layout it's being moved
   * for. Drawn before the window has its size, the menu showed as a corner cut to the shrunk window's 32 × 39 px.
   */
  const placed = useRef<{ width: number; height: number } | null>(null);
  const pending = useRef<{ seq: number; width: number; height: number } | null>(null);
  const seq = useRef(0);
  useLayoutEffect(() => {
    document.documentElement.classList.add('menu-level-window');
  }, []);
  useEffect(() => {
    const off = window.looper.onUi((e) => {
      if (e.type === 'menu-level') {
        if (!e.level) placed.current = pending.current = null;
        setLevel(e.level);
      } else if (e.type === 'menu-level-placed' && pending.current && e.seq >= pending.current.seq) {
        placed.current = { width: pending.current.width, height: pending.current.height };
        pending.current = null;
        if (box.current) box.current.style.visibility = '';
      }
    });
    window.looper.commands.menuLevelLayout(depth, null);
    return off;
  }, [depth]);
  // Drawn empty after a menu: the main process shrinks the window only now.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (level) wasOpen.current = true;
    else if (wasOpen.current) {
      wasOpen.current = false;
      window.looper.commands.menuLevelLayout(depth, null);
    }
  }, [level, depth]);
  // Its size and each item's top, for the main process to place this window and the next level's.
  useLayoutEffect(() => {
    const menu = box.current?.querySelector<HTMLElement>('.ws-menu');
    if (!level || !menu) return;
    const r = menu.getBoundingClientRect();
    const tops: Record<number, number> = {};
    for (const el of menu.querySelectorAll<HTMLElement>(':scope > [data-index]')) tops[Number(el.dataset.index)] = el.getBoundingClientRect().top - r.top;
    const width = Math.ceil(r.width);
    const height = Math.ceil(r.height);
    const n = ++seq.current;
    if (pending.current || placed.current?.width !== width || placed.current?.height !== height) {
      box.current!.style.visibility = 'hidden';
      pending.current = { seq: n, width, height };
    }
    window.looper.commands.menuLevelLayout(depth, { width, height, tops, seq: n });
  }, [level?.items, depth]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!level) return null;
  return (
    <div ref={box}>
      <MenuList
        nav={[{ items: level.items, active: level.active }]}
        depth={0}
        isMac={false}
        cues={level.cues}
        fit={false}
        at={{ x: PAD, y: PAD }}
        onHover={(_d, i) => window.looper.commands.menuLevelInput(depth, i, 'hover')}
        onChoose={(_d, i) => window.looper.commands.menuLevelInput(depth, i, 'choose')}
      />
    </div>
  );
}
