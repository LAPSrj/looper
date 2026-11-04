import { Fragment } from 'react';
import { isPhone, uiHere } from '../web/page-nav';
import { ICONS } from './icons';
import { NavBar } from './NavBar';
import { SplitToolButton, ToolButton } from './ToolButton';
import { isEnabled, toolbarFor, type ToolbarGroup, type ToolbarItem } from './toolbar-model';

const iconOf = (it: { icon?: string }): React.ReactNode => (it.icon ? (ICONS as Record<string, React.ReactNode>)[it.icon] : undefined);

/** A desktop toolbar button for an item: a split button when it has a list of places. */
export function ToolbarButton({ item }: { item: ToolbarItem }) {
  const title = item.shortcut ? `${item.label} (${item.shortcut})` : item.label;
  const menu = item.menu;
  if (menu?.open) {
    const open = menu.open;
    return <SplitToolButton icon={iconOf(item)} title={title} menuTitle={menu.label} enabled={isEnabled(item)} onClick={item.run ?? null} onMenu={(x, y) => open(x, y)} />;
  }
  return <ToolButton icon={iconOf(item)} title={title} labeled={item.labeled} enabled={isEnabled(item)} pressed={item.pressed} onClick={() => item.run?.()} />;
}

/** A toolbar's groups as buttons, a separator between groups; what doesn't show on this platform is left out. */
export function ToolbarButtons({ groups, leadingSep }: { groups: ToolbarGroup[]; leadingSep?: boolean }) {
  return (
    <>
      {toolbarFor(groups, uiHere).map((g, i) => (
        <Fragment key={g.id}>
          {(i > 0 || leadingSep) && <span className="toolbar-sep" />}
          {g.items.map((it) => (
            <ToolbarButton key={it.id} item={it} />
          ))}
        </Fragment>
      ))}
    </>
  );
}

/**
 * A window's toolbar, from its data. On a phone nothing is drawn: the page
 * reports the toolbar to the frame (PageNav `toolbar`), whose More menu
 * offers it. `order`: where its items go among other toolbars of the page.
 * `children` follow the buttons on the desktop.
 */
export function Toolbar({
  groups,
  className,
  order = 0,
  onContextMenu,
  children,
}: {
  groups: ToolbarGroup[];
  className?: string;
  order?: number;
  onContextMenu?: (e: React.MouseEvent) => void;
  children?: React.ReactNode;
}) {
  if (isPhone) return <NavBar toolbar={groups} order={order} />;
  return (
    <div className={`toolbar${className ? ` ${className}` : ''}`} onContextMenu={onContextMenu}>
      <ToolbarButtons groups={groups} />
      {children}
    </div>
  );
}
