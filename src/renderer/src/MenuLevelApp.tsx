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
  useLayoutEffect(() => {
    document.documentElement.classList.add('menu-level-window');
  }, []);
  useEffect(() => {
    const off = window.looper.onUi((e) => {
      if (e.type === 'menu-level') setLevel(e.level);
    });
    window.looper.commands.menuLevelLayout(depth, null);
    return off;
  }, [depth]);
  // Its size and each item's top, for the main process to place this window and the next level's.
  useLayoutEffect(() => {
    const menu = box.current?.querySelector<HTMLElement>('.ws-menu');
    if (!level || !menu) return;
    const r = menu.getBoundingClientRect();
    const tops: Record<number, number> = {};
    for (const el of menu.querySelectorAll<HTMLElement>(':scope > [data-index]')) tops[Number(el.dataset.index)] = el.getBoundingClientRect().top - r.top;
    window.looper.commands.menuLevelLayout(depth, { width: Math.ceil(r.width), height: Math.ceil(r.height), tops });
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
