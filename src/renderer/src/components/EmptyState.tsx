import type { ReactNode } from 'react';

/**
 * Where a screen's "nothing to show here" text sits. `pane`: a window's or a
 * pane's whole body. `detail`: the detail beside a list, with no row chosen or
 * nothing in the row. `row`: the only row of an empty listbox or tree, which
 * must own one. `section`: a list section's body (a phone draws it as the
 * section's row). `overlay`: over the content that's on its way (a terminal
 * starting).
 */
export type EmptyAt = 'pane' | 'detail' | 'row' | 'section' | 'overlay';

/**
 * A screen's text for nothing to show. How it looks on the desktop, iOS and
 * Android is its CSS's (`.empty-state` and `.empty-<at>` in styles.css and
 * phone.css), never the screen's: a screen only says where it sits.
 */
export function EmptyState({
  at = 'pane',
  list = 'listbox',
  title,
  busy,
  onMenu,
  children,
}: {
  at?: EmptyAt;
  /** at="row": what holds the row, for its role. */
  list?: 'listbox' | 'tree';
  /** A heading over the text (an overlay's "Starting…"). */
  title?: ReactNode;
  /** Something is on its way: a spinner over the title. */
  busy?: boolean;
  /** A right-click or a long press on it: the list's menu (New Folder in an empty folder). */
  onMenu?: () => void;
  children?: ReactNode;
}) {
  const role = at === 'row' ? (list === 'tree' ? 'treeitem' : 'option') : at === 'overlay' ? 'status' : undefined;
  return (
    <div
      className={`empty-state empty-${at}`}
      role={role}
      aria-disabled={at === 'row' ? true : undefined}
      aria-selected={at === 'row' ? false : undefined}
      onContextMenu={
        onMenu &&
        ((e) => {
          e.preventDefault();
          onMenu();
        })
      }
    >
      {busy && <span className="pg-spinner" aria-hidden="true" />}
      {title && <span className="empty-state-title">{title}</span>}
      {children}
    </div>
  );
}
