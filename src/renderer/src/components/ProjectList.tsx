import { useState } from 'react';
import type { Environment, Project, ProjectFolder } from '@shared/types';
import { groupProjects, type ProjectGroupBy } from '@shared/projects';
import { FolderTree } from './FolderTree';
import { GROUP_INDENT, GroupHeader } from './GroupHeader';
import { useListNav } from './hooks';
import { showProjectMenu, showProjectsListMenu } from './row-menus';
import { listContextMenu, parentIndex } from './list-nav';

/** A project's row: its name, then its folder unless the list is compact. */
function ProjectRow({ p, compact }: { p: Project; compact: boolean }) {
  return (
    <>
      <div className="task-item-row">
        <span className="task-name">{p.name}</span>
      </div>
      {!compact && (
        <div className="task-item-sub mono" title={p.cwd}>
          {p.cwd}
        </div>
      )}
    </>
  );
}

/**
 * The Projects tab's list. Ungrouped, it's the task list's tree (FolderTree):
 * the user's folders, nested, mixed with the projects in one order, with the
 * same drag and drop. Grouped by parent folder or harness (see
 * `groupProjects`), it has a header per group instead, and nothing drags.
 */
export function ProjectList({
  projects,
  folders,
  layout,
  groupBy,
  environments,
  selected,
  compact,
  onSelect,
}: {
  projects: Project[];
  folders: ProjectFolder[];
  layout: Record<string, string[]>;
  groupBy: ProjectGroupBy;
  environments: Environment[];
  selected: string | null;
  compact: boolean;
  onSelect: (id: string | null) => void;
}) {
  const paneMenu = showProjectsListMenu;
  if (!projects.length && !folders.length) {
    return (
      <div
        className="addon-pane-note muted"
        onContextMenu={(e) => {
          e.preventDefault();
          paneMenu();
        }}
      >
        No projects yet.
      </div>
    );
  }
  if (groupBy !== 'none') return <GroupedProjects projects={projects} groupBy={groupBy} environments={environments} selected={selected} compact={compact} onSelect={onSelect} />;
  return (
    <FolderTree
      items={projects}
      folders={folders}
      layout={layout}
      label="Projects"
      idPrefix="project-"
      selected={selected}
      onSelect={onSelect}
      compact={compact}
      passes={() => true}
      showFolders
      // An empty folder shows, to drop projects in.
      folderShown={() => true}
      autoOpenFolders
      renderItem={(p) => <ProjectRow p={p} compact={compact} />}
      onActivate={(p) => window.looper.openItemWindow('project', p.id)}
      // Delete Project… asks first.
      onDelete={(p) => void window.looper.projects.remove(p.id)}
      onItemMenu={showProjectMenu}
      onFolderCommand={(id, command) => window.looper.projects.folderCommand(id, command)}
      onFolderMenu={(id) => window.looper.projects.showFolderMenu(id)}
      onEmptyMenu={paneMenu}
      onReorder={(ids, folderById, nextLayout, parentById) =>
        void window.looper.projects.reorder(ids, folderById, nextLayout, parentById).catch((e) => void window.looper.showError((e as Error).message))
      }
    />
  );
}

/** A row the keyboard visits in the grouped list: a group's header or a project. */
type NavRow = { kind: 'group'; key: string } | { kind: 'project'; p: Project };

/** The projects under a header per group (parent folder or harness), in the user's order within each. */
function GroupedProjects({
  projects,
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
  onSelect: (id: string | null) => void;
}) {
  const groups = groupProjects(projects, groupBy, environments);
  // The keys of the groups the user closed (per session, like the task folders).
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const toggleGroup = (key: string) =>
    setClosed((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const rowId = (id: string) => `project-${id}`;
  const groupRowId = (key: string) => `project-group-${groups.findIndex((g) => g.key === key)}`;
  const rows: NavRow[] = groups.flatMap((g): NavRow[] => [{ kind: 'group', key: g.key }, ...(closed.has(g.key) ? [] : g.projects.map((p) => ({ kind: 'project' as const, p })))]);
  const [activeGroup, setActiveGroup] = useState<string | null>(null);
  const groupAt = activeGroup === null ? -1 : rows.findIndex((r) => r.kind === 'group' && r.key === activeGroup);
  const index = groupAt >= 0 ? groupAt : selected === null ? -1 : rows.findIndex((r) => r.kind === 'project' && r.p.id === selected);
  const idAt = (r: NavRow) => (r.kind === 'group' ? groupRowId(r.key) : rowId(r.p.id));
  const pick = (id: string) => {
    setActiveGroup(null);
    onSelect(id);
  };
  const showRowMenu = (r: NavRow) => (r.kind === 'project' ? showProjectMenu(r.p) : showProjectsListMenu());
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
      else window.looper.openItemWindow('project', r.p.id);
    },
    onDelete: (i) => {
      const r = rows[i];
      if (r.kind === 'project') void window.looper.projects.remove(r.p.id);
    },
    onMenu: (i) => showRowMenu(rows[i]),
    tree: {
      expanded: (i) => {
        const r = rows[i];
        return r.kind === 'group' ? !closed.has(r.key) : undefined;
      },
      set: (i, open) => {
        const r = rows[i];
        if (r.kind === 'group' && closed.has(r.key) === open) toggleGroup(r.key);
      },
      parent: (i) => parentIndex(rows.map((r) => (r.kind === 'group' ? 0 : 1)), i),
    },
    scrollToId: index >= 0 ? idAt(rows[index]) : null,
  });
  return (
    <ul
      className={`task-list${compact ? ' compact' : ''}`}
      role="tree"
      aria-label="Projects"
      tabIndex={0}
      onKeyDown={nav}
      aria-activedescendant={index >= 0 ? idAt(rows[index]) : undefined}
      onClick={(e) => {
        if (e.target === e.currentTarget) onSelect(null);
      }}
      onContextMenu={(e) => listContextMenu(e, index, (i) => showRowMenu(rows[i]), showProjectsListMenu)}
    >
      {groups.map((g) => [
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
            showProjectsListMenu();
          }}
        />,
        ...(closed.has(g.key)
          ? []
          : g.projects.map((p) => (
              <li
                key={p.id}
                id={rowId(p.id)}
                role="treeitem"
                aria-level={2}
                aria-selected={p.id === selected}
                className={`task-item${p.id === selected ? ' selected' : ''}`}
                style={{ marginLeft: GROUP_INDENT }}
                onClick={() => pick(p.id)}
                onDoubleClick={() => window.looper.openItemWindow('project', p.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  pick(p.id);
                  showProjectMenu(p);
                }}
              >
                <ProjectRow p={p} compact={compact} />
              </li>
            ))),
      ])}
    </ul>
  );
}
