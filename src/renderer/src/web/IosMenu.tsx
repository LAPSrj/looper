import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MenuItemSpec } from '../../../shared/remote-access';
import { noMnemonic } from '../../../shared/commands/command';
import type { MenuProps } from '../components/Menu';
import { placeOnAxis, placeSubmenu, SMOOTH, SNAPPY, trailingInset } from './menu-motion';
import { isChoice, menuItemRole } from './menu-roles';
import { phoneMenu } from './more-menu';
import { NavIcon } from './NavBarRow';
import { CHECK, CHEVRON_RIGHT } from './phone-files';
import { menuGroups, type Viewport } from './phone-shell';
import { useViewport } from './viewport-context';

/*
 * iOS's menus (Menu, components/Menu.tsx, draws this on an iPhone or iPad): a
 * bar button's pull-down, a title's menu, and a long press's context menu.
 * Styled in ios.css.
 */

/**
 * One level of a menu as iOS draws it: groups split by a thick gap, a column
 * before the labels holding a chosen item's check or else the item's symbol
 * (a chevron at the end of a submenu), destructive items in red. A group shows
 * symbols only when every item in it has one (HIG: Menus, "icons for all menu
 * items in a group, or none of them"). The column is only in a group with
 * symbols or a check; a group of plain items starts at the menu's edge, as
 * the kit draws it. `row`: the medium layout's row of buttons across the top, a
 * symbol over a short label (HIG: Menus, iOS). `header`: a submenu's own row,
 * which folds it back up.
 */
function MenuLevel({
  items,
  row = [],
  header,
  onHeader,
  onItem,
}: {
  items: MenuItemSpec[];
  row?: MenuItemSpec[];
  header?: MenuItemSpec;
  onHeader?: () => void;
  onItem: (it: MenuItemSpec, el: HTMLElement) => void;
}) {
  const iconOf = (it: MenuItemSpec) => (it.type !== 'submenu' ? it.icon : undefined);
  const inRow = new Set(row.map((it) => it.id));
  const groups = menuGroups(items.filter((it) => !inRow.has(it.id)));
  const iconGroups = groups.map((group) => group.every((it) => iconOf(it)));
  return (
    <div className="ios-menu-scroll ph-scroll" role="menu">
      {header && (
        <button className="ios-menu-item ios-menu-header" aria-expanded="true" onClick={onHeader}>
          {header.icon && (
            <span className="ios-menu-lead">
              <NavIcon name={header.icon} size={20} />
            </span>
          )}
          <span className="ios-menu-label">{noMnemonic(header.label ?? '')}</span>
          <span className="ios-menu-sub ios-menu-fold">{CHEVRON_RIGHT}</span>
        </button>
      )}
      {row.length > 0 && (
        <div className="ios-menu-row" style={{ gridTemplateColumns: `repeat(${row.length}, 1fr)` }}>
          {row.map((it) => (
            <button key={it.id} role="menuitem" className="ios-menu-tile" onClick={(e) => onItem(it, e.currentTarget)}>
              <NavIcon name={it.icon!} size={22} />
              <span className="ios-menu-tile-label">{noMnemonic(it.label ?? '')}</span>
            </button>
          ))}
        </div>
      )}
      {groups.map((group, gi) => {
        const icons = iconGroups[gi];
        const lead = icons || group.some(isChoice);
        return (
          <div key={gi} className="ios-menu-group">
            {group.map((it) => (
              <button
                key={it.id}
                role={menuItemRole(it)}
                aria-checked={isChoice(it) ? !!it.checked : undefined}
                aria-haspopup={it.type === 'submenu' || undefined}
                className={`ios-menu-item${it.type !== 'submenu' && it.destructive ? ' destructive' : ''}`}
                disabled={!it.enabled}
                onClick={(e) => onItem(it, e.currentTarget)}
              >
                {lead && <span className="ios-menu-lead">{isChoice(it) && it.checked ? CHECK : icons ? <NavIcon name={iconOf(it)!} size={20} /> : null}</span>}
                <span className="ios-menu-label">{noMnemonic(it.label ?? '')}</span>
                {it.type === 'submenu' && <span className="ios-menu-sub">{CHEVRON_RIGHT}</span>}
              </button>
            ))}
          </div>
        );
      })}
    </div>
  );
}

/** Where a menu of `width` × about its height goes so it stays on screen: below `y` when it fits, else on the roomier side, capped to that room (it scrolls). */
function placeMenu(x: number, y: number, width: number, height: number, vw: number, vh: number): React.CSSProperties {
  const left = placeOnAxis({ start: Math.max(8, x), back: vw - 8, size: width, min: 8, max: vw - 8 }).pos;
  const v = placeOnAxis({ start: Math.max(8, y), back: Math.min(vh - 8, y), size: height, min: 8, max: vh - 8, roomier: true });
  return v.forward ? { left, top: v.pos, width, maxHeight: v.room } : { left, bottom: vh - Math.min(vh - 8, y), width, maxHeight: v.room };
}

/**
 * A pop-up button's menu: over the button, out of it, lined up with its trailing edge as a bar button's is;
 * opening upward from the button's bottom when there isn't room for it below.
 */
function placePopUp(button: DOMRect, height: number, vp: Viewport): React.CSSProperties {
  const right = trailingInset(button.right, vp.width);
  const v = placeOnAxis({ start: button.top, back: button.bottom, size: height, min: vp.safe.top + 8, max: vp.height - vp.safe.bottom - 8, roomier: true });
  if (v.forward) return { right, top: button.top, maxHeight: v.room };
  return { right, bottom: vp.height - button.bottom, maxHeight: v.room, transformOrigin: 'bottom right' };
}

const springs = typeof CSS !== 'undefined' && CSS.supports('transition-timing-function', 'linear(0, 1)');
/** The menus' springs as CSS variables, for the transitions in ios.css. */
const SPRING_VARS = springs ? ({ '--ios-spring': SNAPPY.easing, '--ios-spring-ms': `${SNAPPY.ms}ms` } as React.CSSProperties) : undefined;

interface Morph {
  cancel: () => void;
  finished: Promise<unknown>;
}

/**
 * A menu's glass grows out of `from` (the button or row that opened it) into
 * its place, or goes back into it: iOS 26 opens a menu from its control ("the
 * bubble simply pops open to reveal the content", WWDC25 Meet Liquid Glass).
 * The content keeps its laid-out size while the glass changes around it, and
 * with `grow` starts smaller, around the source. Reduce Motion fades instead.
 */
function morph(el: HTMLElement, from: DOMRect, dir: 'open' | 'close', grow: boolean, start?: DOMRect): Morph {
  const inner = el.firstElementChild as HTMLElement;
  const open = dir === 'open';
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const a = el.animate({ opacity: open ? [0, 1] : [1, 0] }, { duration: 150, easing: 'ease-out', fill: open ? 'none' : 'forwards' });
    return { cancel: () => a.cancel(), finished: a.finished };
  }
  const base = (el.offsetParent ?? document.body).getBoundingClientRect();
  const to = start ?? el.getBoundingClientRect();
  // min-width gives way while it moves, or a menu's 250 px floor would keep the glass from starting at the button's size.
  const box = (r: DOMRect, radius: string) => ({ left: `${r.left - base.left}px`, top: `${r.top - base.top}px`, width: `${r.width}px`, minWidth: '0px', height: `${r.height}px`, borderRadius: radius });
  const source = box(from, `${Math.min(from.width, from.height) / 2}px`);
  const target = box(to, getComputedStyle(el).borderRadius);
  const motion = open ? SNAPPY : SMOOTH;
  const timing: KeyframeAnimationOptions = { duration: motion.ms, easing: springs ? motion.easing : 'cubic-bezier(0.2, 0.9, 0.3, 1)', fill: open ? 'none' : 'forwards' };
  // The content holds to the glass's edge nearest the source, which barely moves (a bar button's menu: its top and trailing edges),
  // so it stays in place on the screen; a submenu's header rides its top edge from the row up to where the card settles.
  const side = Math.abs(from.right - to.right) <= Math.abs(from.left - to.left) ? { right: '0px' } : { left: '0px' };
  Object.assign(inner.style, {
    position: 'absolute',
    top: '0px',
    ...side,
    width: `${to.width}px`,
    height: `${to.height}px`,
    transformOrigin: `${from.left + from.width / 2 - to.left}px ${from.top + from.height / 2 - to.top}px`,
  });
  const away = grow ? 'scale(0.6)' : 'none';
  const glass = open
    ? [{ ...source, opacity: 0 }, { opacity: 1, offset: 0.12 }, { ...target, opacity: 1 }]
    : [{ ...target, opacity: 1 }, { opacity: 1, offset: 0.75 }, { ...source, opacity: 0 }];
  const content = open
    ? [{ transform: away, opacity: 0 }, { opacity: 1, offset: 0.3 }, { transform: 'none', opacity: 1 }]
    : [{ transform: 'none', opacity: 1 }, { opacity: 0, offset: 0.3 }, { transform: away, opacity: 0 }];
  const a = el.animate(glass, timing);
  const b = inner.animate(content, timing);
  if (open) {
    const settle = () => Object.assign(inner.style, { position: '', top: '', left: '', right: '', width: '', height: '', transformOrigin: '' });
    a.finished.then(settle, settle);
  }
  return {
    cancel: () => {
      a.cancel();
      b.cancel();
    },
    finished: a.finished,
  };
}

/** A submenu open over its menu: the item, the row it opened from, and the menu's right edge and width it lines up with. */
interface OpenLevel {
  item: MenuItemSpec;
  at: DOMRect;
  right: number;
  width: number;
  leaving?: boolean;
}

/**
 * A menu and the submenus opened from it, as iOS 26 stacks them: a submenu is
 * a card of its own over the row it came from, its header folding it back,
 * while the menu behind shrinks a little and fades (tapping it folds the
 * submenu too). `from`: what the menu grows out of. `exit`: the menu closes
 * back into it (a menu the computer removes goes at once).
 */
function MenuStack({
  items,
  row,
  from,
  rootClass = '',
  rootStyle,
  center,
  bottom,
  dim,
  exit = true,
  onPick,
  onClose,
}: {
  items: MenuItemSpec[];
  row?: MenuItemSpec[];
  from: DOMRect;
  rootClass?: string;
  rootStyle: React.CSSProperties;
  /** Centered over this once its width is known, kept on the screen. */
  center?: DOMRect;
  /** The lowest a submenu reaches, above the home indicator. */
  bottom: number;
  dim?: boolean;
  exit?: boolean;
  onPick: (it: MenuItemSpec) => void;
  onClose: () => void;
}) {
  const [path, setPath] = useState<OpenLevel[]>([]);
  const [closing, setClosing] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const cards = useRef<(HTMLDivElement | null)[]>([]);
  const running = useRef<Morph | null>(null);
  const opened = useRef(0);
  useEffect(() => setPath([]), [items]);

  useLayoutEffect(() => {
    const el = root.current!;
    if (center) {
      const width = el.offsetWidth;
      el.style.left = `${Math.min(Math.max(8, center.left + center.width / 2 - width / 2), window.innerWidth - width - 8)}px`;
    }
    running.current = morph(el, from, 'open', true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A new submenu: placed over its row, then grown out of it.
  useLayoutEffect(() => {
    const depth = path.length;
    if (depth <= opened.current) {
      opened.current = depth;
      return;
    }
    opened.current = depth;
    const el = cards.current[depth - 1];
    const level = path[depth - 1];
    if (!el) return;
    const base = (el.offsetParent ?? document.body).getBoundingClientRect();
    const floor = root.current!.getBoundingClientRect().top + 12;
    el.style.maxHeight = 'none';
    const place = placeSubmenu(level.at, el.offsetHeight, floor, bottom);
    Object.assign(el.style, { top: `${place.top - base.top}px`, maxHeight: `${place.maxHeight}px` });
    morph(el, level.at, 'open', false);
  }, [path, bottom]);

  const openSub = (it: MenuItemSpec, rowEl: HTMLElement) => {
    const menu = (path.length ? cards.current[path.length - 1] : root.current)!.getBoundingClientRect();
    const base = (root.current!.offsetParent ?? document.body).getBoundingClientRect();
    setPath((p) => [...p, { item: it, at: rowEl.getBoundingClientRect(), right: base.right - menu.right, width: menu.width }]);
  };
  const fold = () => {
    const depth = path.filter((l) => !l.leaving).length;
    if (!depth) return;
    const el = cards.current[depth - 1];
    setPath((p) => p.map((l, i) => (i === depth - 1 ? { ...l, leaving: true } : l)));
    const gone = () => setPath((p) => p.slice(0, depth - 1));
    if (!el) return gone();
    void morph(el, path[depth - 1].at, 'close', false).finished.then(gone, gone);
  };
  const close = () => {
    if (closing) return;
    setClosing(true);
    if (!exit) return onClose();
    const el = root.current!;
    const now = el.getBoundingClientRect();
    running.current?.cancel();
    for (const card of cards.current) card?.animate({ opacity: [1, 0] }, { duration: 120, fill: 'forwards' });
    void morph(el, from, 'close', true, now).finished.then(onClose, onClose);
  };
  const pick = (it: MenuItemSpec, el: HTMLElement) => {
    if (it.type === 'submenu') return openSub(it, el);
    onPick(it);
    if (exit) close();
  };

  const shown = path.filter((l) => !l.leaving).length;
  // A tap on a menu behind its submenu folds the submenu, without reaching its items.
  const behind = (depth: number) => (depth < shown ? (e: React.MouseEvent) => (e.stopPropagation(), e.preventDefault(), fold()) : undefined);
  return (
    <div
      className={`ios-menu-layer${dim ? ' dim' : ''}${closing ? ' closing' : ''}`}
      style={SPRING_VARS}
      onClick={(e) => !dim && e.target === e.currentTarget && close()}
      onPointerDown={(e) => dim && e.target === e.currentTarget && close()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div ref={root} className={`ios-menu ${rootClass}${shown > 0 ? ' behind' : ''}`} style={rootStyle} onClickCapture={behind(0)}>
        <MenuLevel items={items} row={row} onItem={pick} />
      </div>
      {path.map((level, i) => (
        <div
          key={level.item.id}
          ref={(el) => {
            cards.current[i] = el;
          }}
          className={`ios-menu ios-submenu${i + 1 < shown ? ' behind' : ''}`}
          style={{ right: level.right, minWidth: level.width, top: level.at.top - 6 }}
          onClickCapture={behind(i + 1)}
        >
          <MenuLevel items={level.item.submenu ?? []} header={level.item} onHeader={fold} onItem={pick} />
        </div>
      ))}
    </div>
  );
}

/**
 * iOS's menu where it opens: a control's pull-down over the control, out of
 * it, lined up with its trailing edge and as wide as its longest item (a
 * title's centered on it), a tap outside only closing it; or a context menu
 * by the finger (out of the control the computer named, when it did), dimming
 * what's behind it, scrolling when it's long (HIG: Action sheets shouldn't
 * scroll, so a long menu isn't one), with what can't be done now hidden and
 * destructive items last.
 */
export default function IosMenu({ items, place, row, popup = false, onPick, onClose }: MenuProps) {
  const vp = useViewport();
  const list = useMemo(() => (popup ? phoneMenu(items) : items), [items, popup]);
  const bottom = vp.height - vp.safe.bottom - 8;
  const pick = (it: MenuItemSpec) => onPick?.(it);
  const close = () => onClose?.();
  if (place.kind === 'control') {
    const center = place.align === 'center';
    const side = center ? { left: 8 } : { right: trailingInset(place.rect.right, window.innerWidth) };
    const top = place.rect.top;
    return (
      <MenuStack
        items={list}
        row={row}
        from={place.from ?? place.rect}
        rootClass="ios-pull-down"
        rootStyle={{ ...side, top, maxHeight: `calc(100% - ${top + 8}px - env(safe-area-inset-bottom, 0px))` }}
        center={center ? place.rect : undefined}
        bottom={bottom}
        dim={popup}
        exit={!popup}
        onPick={pick}
        onClose={close}
      />
    );
  }
  const button = place.control ?? null;
  const from = button ?? new DOMRect(place.x - 22, place.y - 22, 44, 44);
  const height = list.length * 40 + 20;
  return (
    <MenuStack
      items={list}
      row={row}
      from={from}
      rootClass={button ? 'ios-pull-down' : ''}
      rootStyle={button ? placePopUp(button, height, vp) : placeMenu(place.x - 20, place.y + 12, 250, height, vp.width, vp.height)}
      bottom={bottom}
      dim={popup}
      exit={!popup}
      onPick={pick}
      onClose={close}
    />
  );
}
