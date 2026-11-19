import type { ReactNode } from 'react';
import { StatusGlyph, type StatusLevel } from './icons';

/**
 * Where a screen's "nothing to show here" text sits. `pane`: a window's or a
 * pane's whole body. `detail`: the detail beside a list, with no row chosen or
 * nothing in the row. `row`: the only row of an empty listbox or tree, which
 * must own one. `section`: a list section's body (a phone draws it as the
 * section's row). `overlay`: over the content that's on its way (a terminal
 * starting). `inline`: inside a screen, after its other parts, in place of
 * the content it can't show.
 */
export type EmptyAt = 'pane' | 'detail' | 'row' | 'section' | 'overlay' | 'inline';

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
  level,
  action,
  children,
}: {
  /**
   * A problem that keeps the content from showing (Windows' in-place error:
   * normal text after a 16x16 icon of this level), not just nothing to show.
   */
  level?: StatusLevel;
  /** What fixes it or shows the content: a button under the text (Restart, Try Again, Install Git). */
  action?: ReactNode;
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
      {level ? (
        <div className="empty-state-problem" role="alert">
          <StatusGlyph level={level} />
          <div className="empty-state-text">
            {title && <span className="empty-state-title">{title}</span>}
            {children && <span className="empty-state-body">{children}</span>}
          </div>
        </div>
      ) : (
        <>
          {title && <span className="empty-state-title">{title}</span>}
          {children}
        </>
      )}
      {action && <div className="empty-state-action">{action}</div>}
    </div>
  );
}
