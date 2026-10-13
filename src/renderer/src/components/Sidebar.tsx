import { useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import type { Task, TaskFolder, TaskRuntime, View } from '@shared/types';
import { PANES, passesFilter, type PaneId } from '@shared/panes';
import { TaskList } from './TaskList';
import { useDragResize } from './hooks';

interface Props {
  tasks: Task[];
  folders: TaskFolder[];
  layout: Record<string, string[]>;
  runtimes: Record<string, TaskRuntime>;
  selected: string | null;
  now: number;
  onSelect: (id: string) => void;
  view: View;
  onView: (patch: Partial<View>) => void;
}

/** A pane never shrinks below its header and about one row. */
const MIN_PANE_PX = 72;

/** The pair of panes a splitter drag resizes, measured when the drag starts. */
interface SashDrag {
  above: PaneId;
  below: PaneId;
  startY: number;
  heightAbove: number;
  heightBelow: number;
  weightSum: number;
}

/** The task list: one list of every task, or the Tasks / Goals / Watchers panes stacked. */
export function Sidebar({ tasks, folders, layout, runtimes, selected, now, onSelect, view, onView }: Props) {
  const asideRef = useRef<HTMLElement>(null);
  const paneRefs = useRef<Partial<Record<PaneId, HTMLDivElement | null>>>({});
  const sash = useRef<SashDrag | null>(null);
  // Weights while a splitter is dragged; saved to the view when it is released.
  const [dragWeights, setDragWeights] = useState<Partial<Record<PaneId, number>> | null>(null);

  const onSashDown = useDragResize({
    axis: 'y',
    containerRef: asideRef,
    onDrag: (y) => {
      const s = sash.current;
      if (!s) return;
      const total = s.heightAbove + s.heightBelow;
      const above = Math.max(MIN_PANE_PX, Math.min(total - MIN_PANE_PX, s.heightAbove + y - s.startY));
      setDragWeights({ [s.above]: (s.weightSum * above) / total, [s.below]: (s.weightSum * (total - above)) / total });
    },
    onEnd: () => {
      const s = sash.current;
      sash.current = null;
      if (s && dragWeights) {
        onView({
          panes: {
            ...view.panes,
            [s.above]: { ...view.panes[s.above], weight: dragWeights[s.above] ?? view.panes[s.above].weight },
            [s.below]: { ...view.panes[s.below], weight: dragWeights[s.below] ?? view.panes[s.below].weight },
          },
        });
      }
      setDragWeights(null);
    },
  });

  const listProps = {
    tasks,
    folders,
    layout,
    runtimes,
    selected,
    now,
    onSelect,
    compact: view.taskList === 'compact',
    autoOpenFolders: view.autoOpenFolders,
  };

  if (view.sidebar === 'single') {
    return (
      <aside className="sidebar">
        <div
          className="sidebar-header"
          onContextMenu={(e) => {
            e.preventDefault();
            window.looper.showPaneContextMenu({});
          }}
        >
          <span className="pane-title">Tasks</span>
        </div>
        <TaskList {...listProps} pane={null} filter={view.single} showEmptyFolders />
      </aside>
    );
  }

  const shown = PANES.filter((p) => view.panes[p.id].visible);
  const isOpen = (id: PaneId) => !view.panes[id].collapsed;
  const weight = (id: PaneId) => dragWeights?.[id] ?? view.panes[id].weight;
  // Folders with no tasks in them would otherwise show in no pane at all.
  const emptyFoldersIn = shown[0]?.id;

  /** The splitter above pane `i` resizes the nearest open pane above it and the nearest open one from `i` down. */
  const sashPair = (i: number): [PaneId, PaneId] | null => {
    const above = shown.slice(0, i).reverse().find((p) => isOpen(p.id));
    const below = shown.slice(i).find((p) => isOpen(p.id));
    return above && below ? [above.id, below.id] : null;
  };

  const startSash = (e: ReactMouseEvent, [above, below]: [PaneId, PaneId]) => {
    const a = paneRefs.current[above]?.getBoundingClientRect().height;
    const b = paneRefs.current[below]?.getBoundingClientRect().height;
    const rect = asideRef.current?.getBoundingClientRect();
    if (a === undefined || b === undefined || !rect) return;
    sash.current = {
      above,
      below,
      startY: e.clientY - rect.top,
      heightAbove: a,
      heightBelow: b,
      weightSum: weight(above) + weight(below),
    };
    onSashDown(e);
  };

  return (
    <aside className="sidebar" ref={asideRef}>
      {shown.map((p, i) => {
        const open = isOpen(p.id);
        const filter = view.panes[p.id];
        const count = tasks.filter((t) => p.member(t) && passesFilter(t, filter, p.filters)).length;
        const pair = i > 0 ? sashPair(i) : null;
        return (
          <div
            key={p.id}
            ref={(el) => {
              paneRefs.current[p.id] = el;
            }}
            className={`sidebar-pane${i > 0 ? ' follows' : ''}`}
            style={{ flex: open ? `${weight(p.id)} 1 0px` : '0 0 auto' }}
          >
            {pair && <div className="pane-sash" onMouseDown={(e) => startSash(e, pair)} />}
            <div
              className="sidebar-header pane-header"
              onClick={() => onView({ panes: { ...view.panes, [p.id]: { ...filter, collapsed: open } } })}
              onContextMenu={(e) => {
                e.preventDefault();
                window.looper.showPaneContextMenu({ pane: p.id });
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
              <span className="pane-title">{p.title}</span>
              <span className="pane-count">{count}</span>
            </div>
            {open && (
              <TaskList {...listProps} pane={p} filter={filter} showEmptyFolders={p.id === emptyFoldersIn} />
            )}
          </div>
        );
      })}
    </aside>
  );
}
