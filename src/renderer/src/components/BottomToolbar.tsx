import type { ReactNode } from 'react';
import { platform } from '../platform';
import { NavIcon } from '../web/NavBarRow';
import { isPhone, uiHere } from '../web/page-nav';
import { Toolbar } from './Toolbar';
import { bottomBarGroups, isEnabled, type BottomBarPlaces, type ToolbarGroup, type ToolbarItem } from './toolbar-model';

/**
 * The toolbar of a screen's own content: commands that act on what it shows (Previous, Next, a list of it) and a
 * line of status ("2 of 5"), over `children`, the content they act on. A screen gives the toolbar's data once:
 *
 * - The desktop draws it as the pane's toolbar above the content, the status after its buttons (Win32 Toolbars).
 * - iOS floats it over the content's bottom edge: the groups `places` names as glass capsules at the leading and
 *   trailing edges, the status between them, and the soft scroll edge behind it (ios.md: Bottom toolbar; HIG Toolbars,
 *   Tab bars: "If you need to provide controls that act on elements in the current view, use a Toolbar").
 * - Android floats it as Material 3's floating toolbar, centered 16 dp above the bottom ("best used for contextual
 *   actions relevant to the body content or the specific page", m3 Toolbars).
 *
 * On a phone the content runs under the toolbar to the bottom edge, and what scrolls in it ends with room for the
 * toolbar (`--bottom-toolbar-clear`, phone.css).
 */
export function BottomToolbar({
  label,
  groups,
  places,
  status,
  children,
}: {
  /** The toolbar's accessible name ("Tool Calls"). */
  label: string;
  /** The commands, in the desktop toolbar's order and groups. */
  groups: ToolbarGroup[];
  /** Where the items sit on a phone (toolbar-model's bottomBarGroups). */
  places: BottomBarPlaces;
  /** A short status line: informational text, never a control (SwiftUI's `status` placement). */
  status?: string;
  children: ReactNode;
}) {
  if (!isPhone) {
    return (
      <>
        <Toolbar inline className="pane-toolbar" label={label} groups={groups}>
          {status && <span className="muted toolbar-status">{status}</span>}
        </Toolbar>
        {children}
      </>
    );
  }
  const { leading, trailing } = bottomBarGroups(groups, places, uiHere);
  const side = (list: ToolbarItem[][], end: boolean) => (
    <div className={`bottom-toolbar-side${end ? ' end' : ''}`}>
      {list.map((g) => (
        <div key={g[0].id} className={platform === 'ios' ? 'bottom-toolbar-group ios-bar-group' : 'bottom-toolbar-group'}>
          {g.map((it) => (
            <BarButton key={it.id} item={it} />
          ))}
        </div>
      ))}
    </div>
  );
  return (
    <div className={`bottom-toolbar-host${status ? ' has-status' : ''}`}>
      {children}
      <div className="bottom-toolbar" role="toolbar" aria-label={label}>
        {side(leading, false)}
        {status && <span className="bottom-toolbar-status">{status}</span>}
        {side(trailing, true)}
      </div>
    </div>
  );
}

/** One command of a phone's bottom toolbar: the bar's own button (a glass circle on iOS, an icon button on Android); a toggle that's on is tinted. */
function BarButton({ item }: { item: ToolbarItem }) {
  const ios = platform === 'ios';
  const text = !item.icon;
  const kind = ios ? (text ? 'ios-text-btn' : 'ios-icon-btn') : text ? 'md-text-btn' : 'md-icon-btn';
  const open = item.menu?.open;
  return (
    <button
      type="button"
      className={`${kind}${item.pressed ? ' on' : ''}`}
      aria-label={text ? undefined : item.label}
      {...(item.pressed !== undefined ? { 'aria-pressed': item.pressed } : {})}
      disabled={!isEnabled(item)}
      onClick={(e) => {
        if (item.run) return item.run();
        // A split button with no current place opens its list, above the button.
        const box = e.currentTarget.getBoundingClientRect();
        open?.(box.left, box.top);
      }}
    >
      {text ? item.label : <NavIcon name={item.icon!} size={ios ? 22 : 24} />}
    </button>
  );
}
