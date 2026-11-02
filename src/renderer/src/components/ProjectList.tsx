import { useState } from 'react';
import type { Environment, Project } from '@shared/types';
import { groupProjects, type ProjectGroupBy } from '@shared/projects';
import { GROUP_INDENT, GroupHeader } from './GroupHeader';
import { useListNav } from './hooks';
import { listContextMenu, parentIndex } from './list-nav';

/** A row the keyboard visits: a group's header or a project. */
type NavRow = { kind: 'group'; key: string } | { kind: 'project'; p: Project };

/**
 * The Projects tab's list: the projects in the user's order, dragged to
 * reorder, or under a header for each group (see `groupProjects`), in which
 * the order can't be dragged.
 */
export function ProjectList({
  projects: ordered,
  groupBy,
  environments,
  selected,
  compact,
  onSelect,
}: {
  projects: Project[];
  groupBy: ProjectGroupBy;
  environments: Environment[];
  selected: string | null;
  compact: boolean;
  onSelect: (id: string) => void;
}) {
  // The dragged project, and the row it would go before (null = the end).
  const [drag, setDrag] = useState<{ id: string; before: string | null } | null>(null);
  const grouped = groupBy !== 'none';
  const groups = groupProjects(ordered, groupBy, environments);
  // The keys of the groups the user closed (per session, like the task folders).
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const toggleGroup = (key: string) =>
    setClosed((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  // The rows as they show, top to bottom: a closed group's rows don't.
  const projects = groups.flatMap((g) => (grouped && closed.has(g.key) ? [] : g.projects));
  const rowId = (id: string) => `project-${id}`;
  const groupRowId = (key: string) => `project-group-${groups.findIndex((g) => g.key === key)}`;
  // The rows the keyboard visits: the group headers too, and the project selected or the header it last stopped on is the active one.
  const rows: NavRow[] = groups.flatMap((g): NavRow[] => [
    ...(grouped ? [{ kind: 'group' as const, key: g.key }] : []),
    ...(grouped && closed.has(g.key) ? [] : g.projects.map((p) => ({ kind: 'project' as const, p }))),
  ]);
  const [activeGroup, setActiveGroup] = useState<string | null>(null);
  const groupAt = activeGroup === null ? -1 : rows.findIndex((r) => r.kind === 'group' && r.key === activeGroup);
  const index = groupAt >= 0 ? groupAt : selected === null ? -1 : rows.findIndex((r) => r.kind === 'project' && r.p.id === selected);
  const idAt = (r: NavRow) => (r.kind === 'group' ? groupRowId(r.key) : rowId(r.p.id));
  const pick = (id: string) => {
    setActiveGroup(null);
    onSelect(id);
  };
  /** A project's menu, the pane's (New Project…) for a header. */
  const showRowMenu = (r: NavRow) => window.looper.projects.showContextMenu(r.kind === 'project' ? r.p.id : '');
  const nav = useListNav({
    count: rows.length,
    index,
    onIndex: (i) => {
      const r = rows[i];
      if (r.kind === 'group') return setActiveGroup(r.key);
      pick(r.p.id);
    },
    onActivate: (i) => {
      const r = rows[i];
      if (r.kind === 'group') toggleGroup(r.key);
      else void window.looper.projects.openEditor(r.p.id);
    },
    // Delete Project… asks first.
    onDelete: (i) => {
      const r = rows[i];
      if (r.kind === 'project') void window.looper.projects.remove(r.p.id);
    },
    onMenu: (i) => showRowMenu(rows[i]),
    tree: grouped
      ? {
          expanded: (i) => {
            const r = rows[i];
            return r.kind === 'group' ? !closed.has(r.key) : undefined;
          },
          set: (i, open) => {
            const r = rows[i];
            if (r.kind === 'group' && closed.has(r.key) === open) toggleGroup(r.key);
          },
          parent: (i) => parentIndex(rows.map((r) => (r.kind === 'group' ? 0 : 1)), i),
        }
      : undefined,
    scrollToId: index >= 0 ? idAt(rows[index]) : null,
  });

  if (!ordered.length) {
    return (
      <div
        className="addon-pane-note muted"
        onContextMenu={(e) => {
          e.preventDefault();
          window.looper.projects.showContextMenu('');
        }}
      >
        No projects yet.
      </div>
    );
  }

  const drop = () => {
    if (!drag) return;
    const rest = ordered.map((p) => p.id).filter((id) => id !== drag.id);
    const at = drag.before === null ? rest.length : rest.indexOf(drag.before);
    rest.splice(at < 0 ? rest.length : at, 0, drag.id);
    setDrag(null);
    void window.looper.projects.reorder(rest);
  };

  const row = (p: Project) => (
    <li
      key={p.id}
      id={rowId(p.id)}
      role={grouped ? 'treeitem' : 'option'}
      aria-level={grouped ? 2 : undefined}
      aria-selected={p.id === selected}
      className={`task-item${p.id === selected ? ' selected' : ''}${
        drag && drag.id !== p.id && drag.before === p.id ? ' drop-before' : ''
      }${drag && drag.id !== p.id && drag.before === null && p === projects[projects.length - 1] ? ' drop-after' : ''}`}
      draggable={!grouped}
      style={grouped ? { marginLeft: GROUP_INDENT } : undefined}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        setDrag({ id: p.id, before: null });
      }}
      onDragOver={(e) => {
        if (!drag) return;
        e.preventDefault();
        const rect = e.currentTarget.getBoundingClientRect();
        const after = e.clientY > rect.top + rect.height / 2;
        const i = projects.indexOf(p);
        const before = after ? (projects[i + 1]?.id ?? null) : p.id;
        if (before !== drag.before) setDrag({ ...drag, before });
      }}
      onDragEnd={() => setDrag(null)}
      onClick={() => pick(p.id)}
      onDoubleClick={() => void window.looper.projects.openEditor(p.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        pick(p.id);
        window.looper.projects.showContextMenu(p.id);
      }}
    >
      <div className="task-item-row">
        <span className="task-name">{p.name}</span>
      </div>
      {!compact && (
        <div className="task-item-sub mono" title={p.cwd}>
          {p.cwd}
        </div>
      )}
    </li>
  );

  return (
    <ul
      className={`task-list${compact ? ' compact' : ''}`}
      role={grouped ? 'tree' : 'listbox'}
      aria-label="Projects"
      tabIndex={0}
      onKeyDown={nav}
      aria-activedescendant={index >= 0 ? idAt(rows[index]) : undefined}
      // The keyboard's menu request (Shift+F10, the Menu key) lands on the list: it opens the active row's menu.
      onContextMenu={(e) => listContextMenu(e, index, (i) => showRowMenu(rows[i]), () => window.looper.projects.showContextMenu(''))}
      onDragOver={(e) => {
        if (!drag) return;
        e.preventDefault();
        // Below the last row: the end of the list.
        if (e.target === e.currentTarget && drag.before !== null) setDrag({ ...drag, before: null });
      }}
      onDrop={(e) => {
        e.preventDefault();
        drop();
      }}
    >
      {groups.map((g) => [
        grouped && (
          <GroupHeader
            key={`group-${g.key}`}
            id={groupRowId(g.key)}
            as="li"
            name={g.title}
            open={!closed.has(g.key)}
            count={g.projects.length}
            title={g.title}
            className={activeGroup === g.key ? 'active' : undefined}
            onToggle={() => {
              setActiveGroup(g.key);
              toggleGroup(g.key);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              window.looper.projects.showContextMenu('');
            }}
          />
        ),
        ...(grouped && closed.has(g.key) ? [] : g.projects.map(row)),
      ])}
    </ul>
  );
}
