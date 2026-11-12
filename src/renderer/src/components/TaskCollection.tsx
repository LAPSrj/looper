import type { View } from '@shared/types';
import { ALL_FILTERS, PANES, passesFilter } from '@shared/panes';
import { taskEntries } from '../task-tree';
import type { MainWindow } from '../useMainWindow';
import { isPhone } from '../web/page-nav';
import { Icon } from './Icon';
import { ICONS } from './icons';
import { TaskSubText } from './Live';
import { EmptyRow, Group, LargeTitle, Row } from './phone/PhoneList';
import { OverviewSwitch, type OverviewChoice } from './phone/OverviewSwitch';
import { TasksOverview } from './phone/TasksOverview';
import { showTaskMenu, showTasksListMenu } from './row-menus';
import { Sidebar } from './Sidebar';

export interface TasksSwitch {
  value: OverviewChoice;
  onChange: (v: OverviewChoice) => void;
}

/** Where a phone's list is: one folder level a screen. */
export interface PhoneTasksPlace {
  container: string;
  onOpenFolder: (id: string) => void;
  current?: string | null;
  show?: OverviewChoice;
  tasksSwitch: TasksSwitch;
}

const NO_KIND_TEXT: Record<View['phoneTaskKind'], string> = { all: 'No tasks yet.', tasks: 'No tasks yet.', goals: 'No goals yet.', watchers: 'No watchers yet.' };

/**
 * The task list, with its sections (PANES: Tasks, Goals, Watchers) and filters.
 * It adapts by itself: the desktop stacks the sections as panes, and a phone
 * shows one list, narrowed by the Filter button on its bar (the `tasksFilter`
 * command). A screen places it and doesn't check the platform.
 */
export function TaskCollection({ m, phone }: { m: MainWindow; phone?: PhoneTasksPlace }) {
  if (isPhone) return phone ? <PhoneTasks m={m} {...phone} /> : null;
  if (!m.view) return <aside className="sidebar" />;
  return <Sidebar tasks={m.tasks} folders={m.folders} layout={m.layout} runtimes={m.runtimes} selected={m.selected} onSelect={m.select} view={m.view} onView={m.changeView} />;
}

/** A folder row's symbol on a phone. */
export const FOLDER_ICON = (
  <span className="pg-folder-icon">
    <Icon>{ICONS.folder}</Icon>
  </span>
);

/**
 * The Tasks tab: a container's folders (a row with the folder's symbol, the
 * count of tasks inside and a chevron, which opens the folder's own screen) and
 * tasks, as iOS lists a hierarchy: one level a screen, no outline.
 */
function PhoneTasks({
  m,
  container,
  onOpenFolder,
  current = null,
  show,
  tasksSwitch,
}: {
  m: MainWindow;
  container: string;
  onOpenFolder: (id: string) => void;
  current?: string | null;
  show?: OverviewChoice;
  tasksSwitch: TasksSwitch;
}) {
  const view = m.view;
  if (!view) return <div className="pg-scroll" />;
  const kind = view.phoneTaskKind;
  const pane = PANES.find((p) => p.id === kind);
  const entries = taskEntries(container, {
    tasks: m.tasks,
    folders: m.folders,
    layout: m.layout,
    passes: (t) => passesFilter(t, view.single, ALL_FILTERS) && (!pane || pane.member(t)),
    showFolders: view.single.showFolders,
    // A filter's folders are the ones with something it shows.
    hideEmptyFolders: view.single.hideEmptyFolders || !!pane,
  });
  const emptyMenu = showTasksListMenu;
  const entryRows = entries.map((e) => {
    if (e.kind === 'folder') {
      return (
        <Row
          key={`folder-${e.folder.id}`}
          lead={FOLDER_ICON}
          title={e.folder.name}
          value={e.count}
          chevron
          selected={e.folder.id === current}
          onOpen={() => onOpenFolder(e.folder.id)}
          onMenu={() => window.looper.showFolderContextMenu({ folderId: e.folder.id })}
        />
      );
    }
    const t = e.task;
    const rt = m.runtimes[t.id];
    return (
      <Row
        key={t.id}
        title={t.name}
        sub={<TaskSubText task={t} runtime={rt} />}
        tone={rt?.held || rt?.asking ? 'warning' : t.enabled ? undefined : 'muted'}
        chevron
        selected={t.id === current}
        onOpen={() => m.select(t.id)}
        // The press must not open the task: its menu acts on this row's task, not the selected one.
        onMenu={() => showTaskMenu(t, rt)}
      />
    );
  });
  const listBody = (
    <>
      <Group>
        {entryRows.length === 0 ? (
          <EmptyRow onMenu={container === '' ? emptyMenu : undefined}>{container === '' ? NO_KIND_TEXT[kind] : 'This folder is empty.'}</EmptyRow>
        ) : (
          entryRows
        )}
      </Group>
    </>
  );
  return (
    <div
      className="pg-scroll"
      // A long press between the rows: the list's menu (New Folder…), at the top level.
      onContextMenu={(e) => {
        if (container !== '' || (e.target as HTMLElement).closest('.pg-row, .pg-group-title, .pg-segmented, .pg-overview')) return;
        e.preventDefault();
        emptyMenu();
      }}
    >
      {container === '' && <LargeTitle>Tasks</LargeTitle>}
      {container === '' ? (
        <OverviewSwitch listLabel="Tasks" show={show} {...tasksSwitch} list={listBody} overview={<TasksOverview m={m} />} />
      ) : (
        listBody
      )}
    </div>
  );
}
