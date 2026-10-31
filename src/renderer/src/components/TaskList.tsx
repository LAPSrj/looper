import { useEffect, useState } from 'react';
import type { DragEvent } from 'react';
import type { UiEvent } from '@shared/api';
import type { Task, TaskFolder, TaskListOptions, TaskRuntime } from '@shared/types';
import { folderParents, folderSubtree } from '@shared/folders';
import { ALL_FILTERS, passesFilter, type PaneDef } from '@shared/panes';
import { siblingOrder } from '../task-tree';
import { isPhone } from '../web/page-nav';
import { GROUP_INDENT, GroupHeader } from './GroupHeader';
import { useListNav } from './hooks';
import { listContextMenu, parentIndex } from './list-nav';
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

/** What is being dragged: a task row or a folder header. */
type DragItem = { kind: 'task' | 'folder'; id: string };

/**
 * Where the drag would land: before/after a task (in that task's container),
 * into a folder (at its end), before/after a folder (in the folder's parent
 * container), or at the top level's end.
 */
type DropTarget =
  | { kind: 'task'; taskId: string; pos: 'before' | 'after' }
  | { kind: 'folder'; folderId: string; pos: 'before' | 'into' | 'after' }
  | { kind: 'root' };

/** One rendered sidebar row, flattened out of the folder tree. */
type Row =
  | { kind: 'folder'; folder: TaskFolder; depth: number; open: boolean; showChildren: boolean; taskCount: number }
  | { kind: 'task'; task: Task; depth: number; container: string; popOut: boolean };

const INDENT = GROUP_INDENT;

export function TaskList({ tasks, folders, layout, runtimes, selected, onSelect, onCommand, compact, pane, options, showEmptyFolders, autoOpenFolders }: Props) {
  const passes = (t: Task) => (!pane || pane.member(t)) && passesFilter(t, options, pane?.filters ?? ALL_FILTERS);
  // Goals list by due time; the other lists keep the order the user dragged them into.
  const sorted = pane?.id === 'goals';
  // Row ids stay unique when a task is listed in two panes.
  const rowId = (id: string) => `task-${pane ? `${pane.id}-` : ''}${id}`;
  const parents = folderParents(folders);
  const folderById = new Map(folders.map((f) => [f.id, f]));
  // A task pointing at a deleted/unknown folder lists at the top level.
  const containerOf = (t: Task) => (t.folderId && parents.has(t.folderId) ? t.folderId : '');

  // Sibling order per container, self-healed: the folders/tasks props can
  // outrun the layout event, so members the layout doesn't know append.
  const entriesOf = siblingOrder(tasks, folders, layout, parents);

  // Folder open state lives per session; the setting decides the default.
  // `marked` holds the exceptions: closed folders when auto-open is on, open
  // folders when it's off. Flipping the setting resets everything to its
  // default (all open / all closed).
  const [marked, setMarked] = useState<Set<string>>(new Set());
  useEffect(() => setMarked(new Set()), [autoOpenFolders]);
  const isOpen = (id: string) => (autoOpenFolders ? !marked.has(id) : marked.has(id));
  const toggleFolder = (id: string) => {
    setMarked((prev) => {
      const next = new Set(prev);
      const opening = autoOpenFolders ? next.has(id) : !next.has(id);
      if (autoOpenFolders) {
        // Opening a folder re-opens its whole subtree, however it was left.
        if (opening) for (const sub of folderSubtree(folders, id)) next.delete(sub);
        else next.add(id);
      } else {
        if (opening) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  };

  // Flatten the tree into rows. A task row marks whether it closes its
  // container's subtree (its bottom edge doubles as "after that folder").
  const rows: Row[] = [];
  const subtreeTaskCount = (id: string): number => {
    const ids = folderSubtree(folders, id);
    return tasks.filter((t) => t.folderId && ids.has(t.folderId) && passes(t)).length;
  };
  const folderShown = (id: string) => {
    const ids = folderSubtree(folders, id);
    const inside = tasks.filter((t) => t.folderId && ids.has(t.folderId));
    if (options.hideEmptyFolders) return inside.some(passes);
    if (!pane) return true;
    return inside.length === 0 ? showEmptyFolders : inside.some(pane.member);
  };
  const byDue = dueOrder(runtimes);
  /** Folders off: every task the list shows, in tree order (folders open or not), at the top level. */
  const buildFlat = () => {
    const inOrder: Task[] = [];
    const walk = (container: string) => {
      for (const entry of entriesOf.get(container) ?? []) {
        if (entry.startsWith('folder:')) walk(entry.slice(7));
        else inOrder.push(...tasks.filter((t) => t.id === entry && passes(t)));
      }
    };
    walk('');
    if (sorted) inOrder.sort(byDue);
    for (const t of inOrder) rows.push({ kind: 'task', task: t, depth: 0, container: containerOf(t), popOut: false });
  };
  const build = (container: string, depth: number) => {
    let entries = entriesOf.get(container) ?? [];
    if (sorted) {
      // Folders keep their order, ahead of the sorted tasks.
      const inOrder = entries.flatMap((e) => (e.startsWith('folder:') ? [] : tasks.filter((t) => t.id === e)));
      entries = [...entries.filter((e) => e.startsWith('folder:')), ...inOrder.sort(byDue).map((t) => t.id)];
    }
    entries.forEach((entry, i) => {
      const lastHere = i === entries.length - 1;
      if (entry.startsWith('folder:')) {
        const f = folderById.get(entry.slice(7));
        if (!f || !folderShown(f.id)) return;
        const open = isOpen(f.id);
        const children = entriesOf.get(f.id) ?? [];
        rows.push({
          kind: 'folder',
          folder: f,
          depth,
          open,
          showChildren: open && children.length > 0,
          taskCount: subtreeTaskCount(f.id),
        });
        if (open) build(f.id, depth + 1);
      } else {
        const t = tasks.find((x) => x.id === entry);
        if (!t || !passes(t)) return;
        rows.push({ kind: 'task', task: t, depth, container, popOut: container !== '' && lastHere });
      }
    });
  };
  if (options.showFolders) build('', 0);
  else buildFlat();

  // The keyboard walks every row, folder headers included. The active row is the selected task, or the folder the
  // keyboard last stopped on (the selected task stays selected while it does).
  const folderRowId = (id: string) => rowId(`folder-${id}`);
  const [activeFolder, setActiveFolder] = useState<string | null>(null);
  const folderAt = activeFolder ? rows.findIndex((r) => r.kind === 'folder' && r.folder.id === activeFolder) : -1;
  const idx = folderAt >= 0 ? folderAt : rows.findIndex((r) => r.kind === 'task' && r.task.id === selected);
  const rowIdAt = (r: Row) => (r.kind === 'task' ? rowId(r.task.id) : folderRowId(r.folder.id));
  const depths = rows.map((r) => r.depth);
  const showRowMenu = (r: Row) => (r.kind === 'task' ? showTaskMenu(r.task, runtimes[r.task.id]) : window.looper.showFolderContextMenu({ folderId: r.folder.id }));
  const onKeyDown = useListNav({
    count: rows.length,
    index: idx,
    onIndex: (i) => {
      const r = rows[i];
      if (r.kind === 'folder') return setActiveFolder(r.folder.id);
      setActiveFolder(null);
      if (r.task.id !== selected) onSelect(r.task.id);
    },
    onActivate: (i) => {
      const r = rows[i];
      if (r.kind === 'folder') toggleFolder(r.folder.id);
      else void window.looper.openEditor(r.task.id);
    },
    onDelete: (i) => {
      const r = rows[i];
      if (r.kind === 'folder') window.looper.folders.command(r.folder.id, 'delete');
      else onCommand?.('delete-task');
    },
    onRename: (i) => {
      const r = rows[i];
      if (r.kind === 'folder') window.looper.folders.command(r.folder.id, 'rename');
    },
    onMenu: (i) => showRowMenu(rows[i]),
    tree: options.showFolders
      ? {
          expanded: (i) => {
            const r = rows[i];
            return r.kind === 'folder' ? r.open : undefined;
          },
          set: (i, open) => {
            const r = rows[i];
            if (r.kind === 'folder' && r.open !== open) toggleFolder(r.folder.id);
          },
          parent: (i) => parentIndex(depths, i),
        }
      : undefined,
    scrollToId: idx >= 0 ? rowIdAt(rows[idx]) : null,
  });

  const [drag, setDrag] = useState<DragItem | null>(null);
  const [drop, setDrop] = useState<DropTarget | null>(null);

  const clearDrag = () => {
    setDrag(null);
    setDrop(null);
  };

  /** Containers a dragged folder must not land in: itself and its subtree. */
  const forbidden = drag?.kind === 'folder' ? folderSubtree(folders, drag.id) : new Set<string>();

  /** The layout with `entry` removed everywhere (lists copied). */
  const stripped = (entry: string): Record<string, string[]> =>
    Object.fromEntries([...entriesOf].map(([k, v]) => [k, v.filter((x) => x !== entry)]));

  /** Place `entry` next to `anchor` inside `container`. */
  const placed = (entry: string, container: string, anchor: string, pos: 'before' | 'after') => {
    const map = stripped(entry);
    const list = map[container] ?? [];
    const i = list.indexOf(anchor);
    if (i < 0) list.push(entry);
    else list.splice(i + (pos === 'after' ? 1 : 0), 0, entry);
    map[container] = list;
    return map;
  };

  /** Place `entry` at the end of `container`. */
  const appended = (entry: string, container: string) => {
    const map = stripped(entry);
    map[container] = [...(map[container] ?? []), entry];
    return map;
  };

  const completeDrop = (target: DropTarget) => {
    const d = drag;
    clearDrag();
    if (!d) return;
    const reorder = (
      folderById2?: Record<string, string | null>,
      nextLayout?: Record<string, string[]>,
      parentById?: Record<string, string | null>,
    ) =>
      void window.looper.tasks
        .reorder(tasks.map((t) => t.id), folderById2, nextLayout, parentById)
        .catch((e) => void window.looper.showError((e as Error).message));

    if (d.kind === 'folder') {
      const entry = `folder:${d.id}`;
      if (target.kind === 'root') {
        reorder(undefined, appended(entry, ''), { [d.id]: null });
      } else if (target.kind === 'task') {
        const anchor = tasks.find((t) => t.id === target.taskId);
        if (!anchor) return;
        const c = containerOf(anchor);
        reorder(undefined, placed(entry, c, anchor.id, target.pos), { [d.id]: c || null });
      } else if (target.pos === 'into') {
        reorder(undefined, appended(entry, target.folderId), { [d.id]: target.folderId });
      } else {
        const c = parents.get(target.folderId) ?? '';
        reorder(undefined, placed(entry, c, `folder:${target.folderId}`, target.pos), { [d.id]: c || null });
      }
      return;
    }

    const dragged = tasks.find((t) => t.id === d.id);
    if (!dragged) return;
    let folderId: string | null = null;
    let nextLayout: Record<string, string[]>;
    if (target.kind === 'task') {
      const anchor = tasks.find((t) => t.id === target.taskId);
      if (!anchor) return;
      const c = containerOf(anchor);
      folderId = c || null;
      nextLayout = placed(dragged.id, c, anchor.id, target.pos);
    } else if (target.kind === 'folder') {
      if (target.pos === 'into') {
        folderId = target.folderId;
        nextLayout = appended(dragged.id, target.folderId);
      } else {
        const c = parents.get(target.folderId) ?? '';
        folderId = c || null;
        nextLayout = placed(dragged.id, c, `folder:${target.folderId}`, target.pos);
      }
    } else {
      nextLayout = appended(dragged.id, '');
    }
    const changedFolder = folderId !== (containerOf(dragged) || null);
    reorder(changedFolder ? { [dragged.id]: folderId } : undefined, nextLayout);
  };

  const allowDrop = (e: DragEvent, target: DropTarget) => {
    if (!drag) return;
    if (drag.kind === 'task' && target.kind === 'task' && target.taskId === drag.id) return;
    if (!options.showFolders) {
      // Without folder rows, a drop only reorders a task among its own folder's tasks.
      if (sorted || drag.kind !== 'task' || target.kind !== 'task') return;
      const dragged = tasks.find((t) => t.id === drag.id);
      const anchor = tasks.find((t) => t.id === target.taskId);
      if (!dragged || !anchor || containerOf(dragged) !== containerOf(anchor)) return;
    }
    if (drag.kind === 'folder') {
      // Never into (or next to anything inside) the dragged folder's own subtree.
      if (target.kind === 'folder' && forbidden.has(target.folderId)) return;
      if (target.kind === 'task') {
        const anchor = tasks.find((t) => t.id === target.taskId);
        if (!anchor || forbidden.has(containerOf(anchor))) return;
      }
    }
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    setDrop(target);
  };

  const taskRow = (r: Extract<Row, { kind: 'task' }>) => {
    const { task: t, depth, container, popOut } = r;
    const rt = runtimes[t.id];
    // "After the folder" on its closing row shows a line one indent step out.
    const dropClass =
      drop?.kind === 'task' && drop.taskId === t.id
        ? ` drop-${drop.pos}`
        : drop?.kind === 'folder' && drop.pos === 'after' && popOut && drop.folderId === container
          ? ' drop-after-out'
          : '';
    return (
      <li
        key={t.id}
        id={rowId(t.id)}
        role={options.showFolders ? 'treeitem' : 'option'}
        aria-level={options.showFolders ? depth + 1 : undefined}
        aria-selected={selected === t.id}
        className={`task-item ${selected === t.id ? 'selected' : ''} ${rt?.held || rt?.asking ? 'held' : ''}${t.enabled ? '' : ' disabled'}${dropClass}`}
        style={depth > 0 ? { marginLeft: depth * INDENT } : undefined}
        // A flat list that sorts itself has nowhere to drop a task.
        draggable={options.showFolders || !sorted}
        onDragStart={(e) => {
          setDrag({ kind: 'task', id: t.id });
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', t.id);
        }}
        onDragEnd={clearDrag}
        onDragOver={(e) => {
          if (!drag) return;
          const rect = e.currentTarget.getBoundingClientRect();
          const y = e.clientY - rect.top;
          if (sorted) {
            // The list sorts itself: a drop on a task only moves into that task's folder.
            allowDrop(e, container ? { kind: 'folder', folderId: container, pos: 'into' } : { kind: 'root' });
          } else if (popOut && y >= rect.height * 0.75) {
            // Bottom quarter of a folder's closing row: leave it, land right after it.
            allowDrop(e, { kind: 'folder', folderId: container, pos: 'after' });
          } else {
            allowDrop(e, { kind: 'task', taskId: t.id, pos: y < rect.height / 2 ? 'before' : 'after' });
          }
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (drop) completeDrop(drop);
        }}
        onClick={() => {
          setActiveFolder(null);
          onSelect(t.id);
        }}
        onDoubleClick={() => void window.looper.openEditor(t.id)}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          // On a phone a selection is a push: the long press mustn't open the task.
          if (!isPhone) onSelect(t.id);
          showTaskMenu(t, runtimes[t.id]);
        }}
      >
        <div className="task-item-row">
          <span className="task-name">{t.name}</span>
        </div>
        {!compact && <TaskSubline task={t} runtime={rt} sorted={sorted} />}
      </li>
    );
  };

  const folderRow = (r: Extract<Row, { kind: 'folder' }>) => {
    const { folder: f, depth, open, showChildren, taskCount } = r;
    const dropHere = drop?.kind === 'folder' && drop.folderId === f.id ? drop.pos : null;
    // With children visible, the "after the folder" line renders on its closing row instead.
    const dropClass =
      dropHere === 'into'
        ? ' drop-into'
        : dropHere === 'before'
          ? ' drop-before'
          : dropHere === 'after' && !showChildren
            ? ' drop-after'
            : '';
    return (
      <GroupHeader
        key={`folder-${f.id}`}
        id={folderRowId(f.id)}
        as="li"
        name={f.name}
        open={open}
        count={taskCount}
        level={depth + 1}
        className={`task-folder${activeFolder === f.id ? ' active' : ''}${dropClass}`}
        style={depth > 0 ? { marginLeft: depth * INDENT } : undefined}
        draggable
        onDragStart={(e) => {
          setDrag({ kind: 'folder', id: f.id });
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', `folder:${f.id}`);
        }}
        onDragEnd={clearDrag}
        onToggle={() => {
          setActiveFolder(f.id);
          toggleFolder(f.id);
        }}
        onDragOver={(e) => {
          if (!drag) return;
          const rect = e.currentTarget.getBoundingClientRect();
          const y = e.clientY - rect.top;
          // Top edge = before the folder; bottom edge (nothing visible inside) =
          // after it; the rest = into the folder (a dragged folder nests).
          const pos =
            y < rect.height * 0.25 ? 'before' : !showChildren && y >= rect.height * 0.75 ? 'after' : 'into';
          allowDrop(e, { kind: 'folder', folderId: f.id, pos });
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (drop) completeDrop(drop);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          window.looper.showFolderContextMenu({ folderId: f.id });
        }}
      />
    );
  };

  return (
    <ul
      className={`task-list${compact ? ' compact' : ''}`}
      role={options.showFolders ? 'tree' : 'listbox'}
      aria-label="Tasks"
      tabIndex={0}
      onKeyDown={onKeyDown}
      aria-activedescendant={idx >= 0 ? rowIdAt(rows[idx]) : undefined}
      // A click on the empty space below the rows clears the selection, which shows the dashboard.
      onClick={(e) => {
        if (e.target === e.currentTarget) onSelect(null);
      }}
      onDragOver={(e) => {
        if (e.target === e.currentTarget) allowDrop(e, { kind: 'root' });
      }}
      onDrop={(e) => {
        if (e.target !== e.currentTarget) return;
        e.preventDefault();
        completeDrop({ kind: 'root' });
      }}
      // The keyboard's menu request (Shift+F10, the Menu key) lands here: it opens the active row's menu.
      onContextMenu={(e) => listContextMenu(e, idx, (i) => showRowMenu(rows[i]), () => window.looper.showTasksEmptyContextMenu())}
    >
      {rows.map((r) => (r.kind === 'task' ? taskRow(r) : folderRow(r)))}
    </ul>
  );
}
