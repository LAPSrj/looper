import type { UiEvent } from '@shared/api';
import type { Task, TaskFolder, TaskListOptions, TaskRuntime } from '@shared/types';
import { ALL_FILTERS, passesFilter, type PaneDef } from '@shared/panes';
import { FolderTree } from './FolderTree';
import { TaskSubline } from './Live';

interface Props {
  /** The main window's task commands (Delete runs `delete-task` on the selected task, with its question). */
  onCommand?: (type: UiEvent['type']) => void;
  tasks: Task[];
  folders: TaskFolder[];
  /** Sibling display order per container ('' = top level): `folder:<id>` entries mixed with task ids. */
  layout: Record<string, string[]>;
  runtimes: Record<string, TaskRuntime>;
  selected: string | null;
  /** null = nothing selected (a click on the list's empty space). */
  onSelect: (id: string | null) => void;
  /** Show only the task name, without the state line. */
  compact: boolean;
  /** The pane this list is (multiple-pane sidebar), null = the single list of every task. */
  pane: PaneDef | null;
  options: TaskListOptions;
  /** Show folders without any task in them; in a pane, other folders show only when they hold its members. */
  showEmptyFolders: boolean;
  /** On: folders start open and opening one opens its whole subtree. Off: folders start closed. */
  autoOpenFolders: boolean;
}

/** Goals order: the next due first, then the ones with no next run, then the completed (latest first). */
function dueOrder(rts: Record<string, TaskRuntime>) {
  const key = (t: Task): [number, number] =>
    t.completedAt ? [2, -Date.parse(t.completedAt)] : [rts[t.id]?.nextRunAt == null ? 1 : 0, rts[t.id]?.nextRunAt ?? 0];
  return (a: Task, b: Task) => {
    const [ga, va] = key(a);
    const [gb, vb] = key(b);
    return ga - gb || va - vb;
  };
}

/** The task row context menu; its commands act on the main window's current task. */
export function showTaskMenu(t: Task, rt: TaskRuntime | undefined): void {
  window.looper.showTaskContextMenu({
    enabled: t.enabled,
    completed: !!t.completedAt,
    allowComplete: t.completion.allowed,
    state: rt?.state,
    held: !!rt?.held,
    hasNote: !!t.note,
    activeRuns: rt?.runs.length ?? 0,
    maxRuns: t.maxConcurrentRuns,
  });
}

/** The Tasks tab's task list, or one of its panes: the tasks in their folders (FolderTree), each with its status line. */
export function TaskList({ tasks, folders, layout, runtimes, selected, onSelect, onCommand, compact, pane, options, showEmptyFolders, autoOpenFolders }: Props) {
  const passes = (t: Task) => (!pane || pane.member(t)) && passesFilter(t, options, pane?.filters ?? ALL_FILTERS);
  // Goals list by due time; the other lists keep the order the user dragged them into.
  const sorted = pane?.id === 'goals';
  const folderShown = (inside: Task[]) => {
    if (options.hideEmptyFolders) return inside.some(passes);
    if (!pane) return true;
    return inside.length === 0 ? showEmptyFolders : inside.some(pane.member);
  };
  return (
    <FolderTree
      items={tasks}
      folders={folders}
      layout={layout}
      label="Tasks"
      // Row ids stay unique when a task is listed in two panes.
      idPrefix={`task-${pane ? `${pane.id}-` : ''}`}
      selected={selected}
      onSelect={onSelect}
      compact={compact}
      passes={passes}
      sortItems={sorted ? dueOrder(runtimes) : undefined}
      showFolders={options.showFolders}
      folderShown={folderShown}
      autoOpenFolders={autoOpenFolders}
      itemClass={(t) => `${runtimes[t.id]?.held || runtimes[t.id]?.asking ? 'held' : ''}${t.enabled ? '' : ' disabled'}`}
      renderItem={(t) => (
        <>
          <div className="task-item-row">
            <span className="task-name">{t.name}</span>
          </div>
          {!compact && <TaskSubline task={t} runtime={runtimes[t.id]} sorted={sorted} />}
        </>
      )}
      onActivate={(t) => window.looper.openItemWindow('task', t.id)}
      onDelete={() => onCommand?.('delete-task')}
      onItemMenu={(t) => showTaskMenu(t, runtimes[t.id])}
      onFolderCommand={(id, command) => window.looper.folders.command(id, command)}
      onFolderMenu={(id) => window.looper.showFolderContextMenu({ folderId: id })}
      onEmptyMenu={() => window.looper.showTasksEmptyContextMenu()}
      onReorder={(ids, folderById, nextLayout, parentById) =>
        void window.looper.tasks.reorder(ids, folderById, nextLayout, parentById).catch((e) => void window.looper.showError((e as Error).message))
      }
    />
  );
}
