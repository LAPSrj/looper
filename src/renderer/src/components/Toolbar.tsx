import { Fragment } from 'react';
import type { CommandView } from '@shared/commands/command';
import type { CommandContext } from '@shared/commands/context';
import { isPhone, uiHere, type PageNav } from '../web/page-nav';
import { commandToolbar, phoneNav } from './command-surfaces';
import { iconNode } from './icons';
import { NavBar } from './NavBar';
import { SplitToolButton, ToolButton } from './ToolButton';
import { isEnabled, toolbarFor, type ToolbarGroup, type ToolbarItem } from './toolbar-model';

const iconOf = (it: { icon?: string }): React.ReactNode => (it.icon ? iconNode(it.icon) : undefined);

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

/**
 * A toolbar's groups as buttons, a separator between groups; what doesn't show on this platform is left out.
 * `controls`: an item whose id is a key here draws that control in its place (a zoom box) instead of a button.
 */
export function ToolbarButtons({ groups, controls }: { groups: ToolbarGroup[]; controls?: Record<string, React.ReactNode> }) {
  return (
    <>
      {toolbarFor(groups, uiHere).map((g, i) => (
        <Fragment key={g.id}>
          {i > 0 && <span className="toolbar-sep" />}
          {g.items.map((it) => (controls && it.id in controls ? <Fragment key={it.id}>{controls[it.id]}</Fragment> : <ToolbarButton key={it.id} item={it} />))}
        </Fragment>
      ))}
    </>
  );
}

/**
 * A window's toolbar, from its data. On a phone nothing is drawn: the page
 * reports the toolbar to the frame (PageNav `toolbar`), whose More menu
 * offers it, or, with `nav`, reports that bar instead (a screen whose phone bar
 * has its own buttons: Save as the confirming action, Back). `order`: where its
 * items go among other toolbars of the page. `children` follow the buttons on
 * the desktop, and `controls` take an item's place there (ToolbarButtons).
 * `inline`: a pane's own strip, drawn in place on a phone too.
 */
export function Toolbar({
  groups,
  nav,
  controls,
  inline = false,
  className,
  order = 0,
  onClick,
  onContextMenu,
  children,
}: {
  groups: ToolbarGroup[];
  nav?: PageNav;
  controls?: Record<string, React.ReactNode>;
  inline?: boolean;
  className?: string;
  order?: number;
  /** A click anywhere on the strip (a card's toolbar keeps its clicks from opening the card). */
  onClick?: (e: React.MouseEvent) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  children?: React.ReactNode;
}) {
  if (isPhone && !inline) return <NavBar {...(nav ?? { toolbar: groups })} order={order} />;
  return (
    <div className={`toolbar${className ? ` ${className}` : ''}`} onClick={onClick} onContextMenu={onContextMenu}>
      <ToolbarButtons groups={groups} controls={controls} />
      {children}
    </div>
  );
}

/**
 * A window's commands of these views from the one list: its toolbar on the
 * desktop (none when it has no buttons), its bar's buttons and More menu on a
 * phone. The menu bar is useCommandMenu's.
 */
export function CommandBar({ views, context, order = 0 }: { views: readonly CommandView[]; context: CommandContext; order?: number }) {
  if (isPhone) return <NavBar {...phoneNav(views, context)} order={order} />;
  const groups = commandToolbar(views, context);
  return groups.length ? <Toolbar groups={groups} /> : null;
}
