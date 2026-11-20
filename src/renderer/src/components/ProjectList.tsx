import { useState } from 'react';
import type { Environment, Project, ProjectFolder } from '@shared/types';
import { groupProjects, type ProjectGroup, type ProjectGroupBy } from '@shared/projects';
import { EmptyState } from './EmptyState';
import { FolderTree } from './FolderTree';
import { GROUP_INDENT, GroupHeader } from './GroupHeader';
import { ItemText, useGroupedTree, type TreeRow } from './GroupedTree';
import { showProjectMenu, showProjectsListMenu } from './row-menus';
import { reportError } from '../report-error';

/** A project's row: its name, then its folder unless the list is compact. */
function ProjectRow({ p, compact }: { p: Project; compact: boolean }) {
  return <ItemText name={p.name} sub={compact ? undefined : p.cwd} subClass="mono" />;
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
    return <EmptyState onMenu={paneMenu}>No projects yet.</EmptyState>;
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
        void window.looper.projects.reorder(ids, folderById, nextLayout, parentById).catch(reportError)
      }
    />
  );
}

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
  const toggleGroup = (g: ProjectGroup) =>
    setClosed((prev) => {
      const next = new Set(prev);
      if (!next.delete(g.key)) next.add(g.key);
      return next;
    });
  const rows = groups.flatMap((g, gi): TreeRow<ProjectGroup, Project>[] => {
    const open = !closed.has(g.key);
    return [
      { kind: 'group', key: g.key, id: `project-group-${gi}`, depth: 0, open, group: g },
      ...(open ? g.projects.map((p) => ({ kind: 'item' as const, key: p.id, id: `project-${p.id}`, depth: 1, item: p })) : []),
    ];
  });
  const t = useGroupedTree({
    rows,
    selected,
    onSelect: (p) => onSelect(p.id),
    onDeselect: () => onSelect(null),
    toggle: toggleGroup,
    onOpen: (p) => window.looper.openItemWindow('project', p.id),
    onDelete: (r) => {
      if (r.kind === 'item') void window.looper.projects.remove(r.item.id);
    },
    itemMenu: showProjectMenu,
    groupMenu: () => showProjectsListMenu(),
    emptyMenu: showProjectsListMenu,
  });
  return (
    <ul className={`task-list${compact ? ' compact' : ''}`} role="tree" aria-label="Projects" {...t.listProps}>
      {rows.map((r) =>
        r.kind === 'group' ? (
          <GroupHeader
            key={`group-${r.key}`}
            {...t.groupProps(r)}
            as="li"
            name={r.group.title}
            count={r.group.projects.length}
            title={r.group.title}
            className={t.activeGroup === r.key ? 'active' : undefined}
          />
        ) : (
          <li
            key={r.key}
            {...t.itemProps(r)}
            role="treeitem"
            aria-level={2}
            className={`task-item${r.key === selected ? ' selected' : ''}`}
            style={{ marginLeft: GROUP_INDENT }}
          >
            <ProjectRow p={r.item} compact={compact} />
          </li>
        ),
      )}
    </ul>
  );
}
