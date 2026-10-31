import type { ElementType, HTMLAttributes } from 'react';
import { Chevron } from './icons';

/** How far a group's rows sit in from its header, in px (styles.css `--group-indent` is the same step). */
export const GROUP_INDENT = 14;

interface GroupHeaderProps extends Omit<HTMLAttributes<HTMLElement>, 'onToggle' | 'role'> {
  /** The group's name, shown as written. */
  name: string;
  open: boolean;
  /** How many rows the group holds; it shows while the group is closed. */
  count?: number;
  /** The header's tree level, 1 at the top. */
  level?: number;
  /** A click on the header opens or closes the group. */
  onToggle?: () => void;
  /** The element to draw: a list item inside a `ul`, a div elsewhere. */
  as?: 'li' | 'div';
  /** Extra classes beside `group-header` (a phone's list styles select on `task-folder` and `session-group`). */
  className?: string;
}

/**
 * The header of a group in a list: a chevron, the group's name and, when it's
 * closed, its row count. Task folders, project groups, chat groups and addon pane
 * groups all draw it, so they look and collapse the same way. It is a tree item
 * that says whether it is expanded; the rows under it are its children.
 */
export function GroupHeader({ name, open, count, level = 1, onToggle, as = 'div', className, children, ...rest }: GroupHeaderProps) {
  const Tag = as as ElementType;
  return (
    <Tag {...rest} role="treeitem" aria-level={level} aria-expanded={open} className={`group-header${className ? ` ${className}` : ''}`} onClick={onToggle}>
      <Chevron open={open} />
      <span className="group-header-name">{name}</span>
      {!open && count !== undefined && count > 0 && <span className="group-header-count">{count}</span>}
      {children}
    </Tag>
  );
}
