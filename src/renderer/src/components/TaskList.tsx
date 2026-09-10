import { useEffect, useState } from 'react';
import type { DragEvent } from 'react';
import type { Task, TaskFolder, TaskRuntime } from '@shared/types';
import { folderParents, folderSubtree } from '@shared/folders';
import { capFirst, fmtCountdown, resultLabel, stateLabel } from '../format';
import { useListNav } from './hooks';

interface Props {
  tasks: Task[];
  folders: TaskFolder[];
  /** Sibling display order per container ('' = top level): `folder:<id>` entries mixed with task ids. */
  layout: Record<string, string[]>;
  runtimes: Record<string, TaskRuntime>;
  selected: string | null;
  now: number;
  onSelect: (id: string) => void;
  /** Show only the task name, without the state line. */
  compact: boolean;
  showDisabled: boolean;
  showScheduled: boolean;
  showManual: boolean;
  /** On: folders start open and opening one opens its whole subtree. Off: folders start closed. */
  autoOpenFolders: boolean;
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

const INDENT = 14;

export function TaskList({ tasks, folders, layout, runtimes, selected, now, onSelect, compact, showDisabled, showScheduled, showManual, autoOpenFolders }: Props) {
  const passes = (t: Task) =>
    (t.enabled || showDisabled) && (t.schedule.enabled !== false ? showScheduled : showManual);
  const parents = folderParents(folders);
  const folderById = new Map(folders.map((f) => [f.id, f]));
  // A task pointing at a deleted/unknown folder lists at the top level.
  const containerOf = (t: Task) => (t.folderId && parents.has(t.folderId) ? t.folderId : '');

  // Sibling order per container, self-healed: the folders/tasks props can
  // outrun the layout event, so members the layout doesn't know append.
  const entriesOf = new Map<string, string[]>();
  for (const container of ['', ...folders.map((f) => f.id)]) {
    const valid = new Set<string>();
    for (const f of folders) if (parents.get(f.id) === container) valid.add(`folder:${f.id}`);
    for (const t of tasks) if (containerOf(t) === container) valid.add(t.id);
    const list: string[] = [];
    for (const entry of layout[container] ?? []) {
      if (!valid.has(entry)) continue;
      valid.delete(entry);
      list.push(entry);
    }
    list.push(...valid);
    entriesOf.set(container, list);
  }

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
  const build = (container: string, depth: number) => {
    const entries = entriesOf.get(container) ?? [];
    entries.forEach((entry, i) => {
      const lastHere = i === entries.length - 1;
      if (entry.startsWith('folder:')) {
        const f = folderById.get(entry.slice(7));
        if (!f) return;
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
  build('', 0);

  const visible = rows.flatMap((r) => (r.kind === 'task' ? [r.task] : []));
  const idx = visible.findIndex((t) => t.id === selected);
  const onKeyDown = useListNav({
    count: visible.length,
    index: idx,
    onIndex: (i) => {
      if (visible[i].id !== selected) onSelect(visible[i].id);
    },
    scrollToId: selected ? `task-${selected}` : null,
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
    const label = stateLabel(rt);
    const countdown = rt?.state === 'idle' ? fmtCountdown(rt.nextRunAt, now) : '';
    const sub =
      rt?.state === 'idle'
        ? countdown === ''
          ? t.schedule.enabled === false
            ? 'Manual'
            : 'Not scheduled'
          : countdown === 'now'
            ? 'Next run now'
            : `Next run in ${countdown}`
        : rt?.state === 'paused'
          ? capFirst(rt.pausedReason ?? 'paused')
          : capFirst(rt?.lastDetail ?? '') || resultLabel(rt?.lastResult ?? '');
    const active = rt?.state === 'running' || rt?.state === 'checking' || rt?.state === 'classifying';
    const subLine = active
      ? label
      : rt?.state === 'disabled'
        ? 'Disabled'
        : sub;
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
        id={`task-${t.id}`}
        role="option"
        aria-selected={selected === t.id}
        className={`task-item ${selected === t.id ? 'selected' : ''} ${rt?.held ? 'held' : ''}${t.enabled ? '' : ' disabled'}${dropClass}`}
        style={depth > 0 ? { marginLeft: depth * INDENT } : undefined}
        draggable
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
          if (popOut && y >= rect.height * 0.75) {
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
        onClick={() => onSelect(t.id)}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onSelect(t.id);
          const rt2 = runtimes[t.id];
          window.looper.showTaskContextMenu({
            enabled: t.enabled,
            state: rt2?.state,
            held: !!rt2?.held,
            hasNote: !!t.note,
            activeRuns: rt2?.runs.length ?? 0,
            maxRuns: t.maxConcurrentRuns,
          });
        }}
      >
        <div className="task-item-row">
          <span className="task-name">{t.name}</span>
        </div>
        {!compact && (
          <div className="task-item-sub" title={subLine}>
            {subLine}
          </div>
        )}
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
      <li
        key={`folder-${f.id}`}
        role="presentation"
        className={`task-folder${dropClass}`}
        style={depth > 0 ? { marginLeft: depth * INDENT } : undefined}
        draggable
        onDragStart={(e) => {
          setDrag({ kind: 'folder', id: f.id });
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', `folder:${f.id}`);
        }}
        onDragEnd={clearDrag}
        onClick={() => toggleFolder(f.id)}
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
      >
        <svg
          className={`chev${open ? ' open' : ''}`}
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M3.5 1.5 7 5l-3.5 3.5" />
        </svg>
        <span className="task-folder-name">{f.name}</span>
        {!open && taskCount > 0 && <span className="task-folder-count">{taskCount}</span>}
      </li>
    );
  };

  return (
    <ul
      className={`task-list${compact ? ' compact' : ''}`}
      role="listbox"
      aria-label="Tasks"
      tabIndex={0}
      onKeyDown={onKeyDown}
      aria-activedescendant={selected ? `task-${selected}` : undefined}
      onDragOver={(e) => {
        if (e.target === e.currentTarget) allowDrop(e, { kind: 'root' });
      }}
      onDrop={(e) => {
        if (e.target !== e.currentTarget) return;
        e.preventDefault();
        completeDrop({ kind: 'root' });
      }}
      onContextMenu={(e) => {
        if (e.target !== e.currentTarget) return;
        e.preventDefault();
        window.looper.showTasksEmptyContextMenu();
      }}
    >
      {rows.map((r) => (r.kind === 'task' ? taskRow(r) : folderRow(r)))}
    </ul>
  );
}
