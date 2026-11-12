import { groupProjects } from '@shared/projects';
import type { Project } from '@shared/types';
import { taskEntries } from '../task-tree';
import type { MainWindow } from '../useMainWindow';
import { isPhone } from '../web/page-nav';
import { EmptyRow, Group, LargeTitle, Row } from './phone/PhoneList';
import { showProjectMenu, showProjectsListMenu } from './row-menus';
import { ProjectsSidebar } from './Sidebar';
import { FOLDER_ICON } from './TaskCollection';

/** Where a phone's project list is: one folder level a screen. */
export interface PhoneProjectsPlace {
  container: string;
  onOpenFolder: (id: string) => void;
}

/**
 * The project list. It adapts by itself, as TaskCollection does: the desktop's
 * Projects pane, and a phone's list of rows whose folders open one level a
 * screen (grouped by harness or environment, its groups as sections). `current`:
 * the project a phone's or tablet's detail column shows.
 */
export function ProjectCollection({ m, current = null, phone }: { m: MainWindow; current?: string | null; phone?: PhoneProjectsPlace }) {
  if (isPhone) return <PhoneProjects m={m} current={current} place={phone} />;
  if (!m.view) return <aside className="sidebar" />;
  return (
    <ProjectsSidebar
      projects={m.projects}
      folders={m.projectFolders}
      layout={m.projectLayout}
      selected={m.projectSel}
      onSelect={m.selectProject}
      environments={m.info?.settings.environments ?? []}
      view={m.view}
    />
  );
}

/** What a phone's Projects screen lists in a folder ('' = the top level): its subfolders and projects, in the desktop list's order. */
export const projectEntries = (m: MainWindow, container: string) =>
  taskEntries(container, { tasks: m.projects, folders: m.projectFolders, layout: m.projectLayout, passes: () => true, showFolders: true, hideEmptyFolders: true });

function PhoneProjects({ m, current, place }: { m: MainWindow; current: string | null; place?: PhoneProjectsPlace }) {
  const projectsMenu = showProjectsListMenu;
  const container = place?.container ?? '';
  const groupBy = m.view?.projectsPane.groupBy ?? 'none';
  const row = (p: Project) => (
    <Row
      key={p.id}
      title={p.name}
      sub={<span className="mono">{p.cwd}</span>}
      chevron
      selected={p.id === current}
      onOpen={() => m.selectProject(p.id)}
      onMenu={() => showProjectMenu(p)}
    />
  );
  let body: React.ReactNode;
  if (m.projects.length === 0) {
    body = (
      <Group onTitleMenu={projectsMenu}>
        <EmptyRow onMenu={projectsMenu}>No projects yet.</EmptyRow>
      </Group>
    );
  } else if (groupBy === 'none' && place) {
    const entries = projectEntries(m, container);
    body = (
      <Group>
        {entries.length === 0 ? (
          <EmptyRow>This folder is empty.</EmptyRow>
        ) : (
          entries.map((e) =>
            e.kind === 'folder' ? (
              <Row
                key={`folder-${e.folder.id}`}
                lead={FOLDER_ICON}
                title={e.folder.name}
                value={e.count}
                chevron
                selected={e.folder.id === current}
                onOpen={() => place.onOpenFolder(e.folder.id)}
                onMenu={() => window.looper.projects.showFolderMenu(e.folder.id)}
              />
            ) : (
              row(e.task)
            ),
          )
        )}
      </Group>
    );
  } else {
    // Grouped by harness or environment: each group a section, as the desktop's headers.
    const groups = groupProjects(m.projects, groupBy, m.info?.settings.environments ?? [], m.projectFolders).filter((g) => g.projects.length > 0);
    body = groups.map((g) => (
      <Group key={g.key} title={g.title || undefined} onTitleMenu={projectsMenu}>
        {g.projects.map(row)}
      </Group>
    ));
  }
  return (
    <div
      className="pg-scroll"
      // A long press between the rows: the list's menu (New Project, Group By), at the top level.
      onContextMenu={(e) => {
        if (container !== '' || (e.target as HTMLElement).closest('.pg-row, .pg-group-title')) return;
        e.preventDefault();
        projectsMenu();
      }}
    >
      {container === '' && <LargeTitle>Projects</LargeTitle>}
      {body}
    </div>
  );
}
