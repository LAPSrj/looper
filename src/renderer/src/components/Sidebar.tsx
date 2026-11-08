import { useRef, useState } from 'react';
import { Chevron } from './icons';
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import type { Environment, Project, ProjectFolder, Task, TaskFolder, TaskRuntime, View } from '@shared/types';
import { ALL_FILTERS, PANES, passesFilter, type PaneId } from '@shared/panes';
import { ProjectList } from './ProjectList';
import { showPaneMenu, showProjectsListMenu } from './row-menus';
import { TaskList } from './TaskList';
import { useDragResize } from './hooks';

interface Props {
  tasks: Task[];
  folders: TaskFolder[];
  layout: Record<string, string[]>;
  runtimes: Record<string, TaskRuntime>;
  selected: string | null;
  onSelect: (id: string | null) => void;
  view: View;
  onView: (patch: Partial<View>) => void;
}

/** A pane never shrinks below its header and about one row. */
const MIN_PANE_PX = 72;
/** One arrow press on a focused splitter moves it this far. */
const SASH_STEP_PX = 24;

/** The pair of panes a splitter drag resizes, measured when the drag starts. */
interface SashDrag {
  above: PaneId;
  below: PaneId;
  startY: number;
  heightAbove: number;
  heightBelow: number;
  weightSum: number;
}

interface PaneEntry {
  key: PaneId;
  title: string;
  count: number;
  open: boolean;
  weight: number;
  onToggle: () => void;
  onMenu: () => void;
  body: ReactNode;
}

/** The Projects tab's list of projects, under its header (a right-click there: Group By and New Project). */
export function ProjectsSidebar({
  projects,
  folders,
  layout,
  selected,
  onSelect,
  environments,
  view,
}: {
  projects: Project[];
  folders: ProjectFolder[];
  layout: Record<string, string[]>;
  selected: string | null;
  onSelect: (id: string | null) => void;
  environments: Environment[];
  view: View;
}) {
  return (
    <aside className="sidebar">
      <div
        className="sidebar-header"
        onContextMenu={(e) => {
          e.preventDefault();
          showProjectsListMenu();
        }}
      >
        <span className="pane-title">Projects</span>
        <span className="pane-count">{projects.length}</span>
      </div>
      <ProjectList
        projects={projects}
        folders={folders}
        layout={layout}
        groupBy={view.projectsPane.groupBy}
        environments={environments}
        selected={selected}
        compact={view.taskList === 'compact'}
        onSelect={onSelect}
      />
    </aside>
  );
}

/** The Tasks tab's task list: one list of every task, or the Tasks, Goals and Watchers panes stacked. */
export function Sidebar({
  tasks,
  folders,
  layout,
  runtimes,
  selected,
  onSelect,
  view,
  onView,
}: Props) {
  const asideRef = useRef<HTMLElement>(null);
  const paneRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const sash = useRef<SashDrag | null>(null);
  // Weights while a splitter is dragged; saved to the view when it is released.
  const [dragWeights, setDragWeights] = useState<Partial<Record<PaneId, number>> | null>(null);

  /** The view patch that stores these pane weights. */
  const weightPatch = (weights: Partial<Record<PaneId, number>>): Partial<View> => {
    const panes = { ...view.panes };
    for (const p of PANES) {
      const weight = weights[p.id];
      if (weight !== undefined) panes[p.id] = { ...panes[p.id], weight };
    }
    return { panes };
  };

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
      sash.current = null;
      if (dragWeights) onView(weightPatch(dragWeights));
      setDragWeights(null);
    },
  });

  const listProps = {
    tasks,
    folders,
    layout,
    runtimes,
    selected,
    onSelect,
    compact: view.taskList === 'compact',
    autoOpenFolders: view.autoOpenFolders,
  };

  if (view.sidebar === 'single') {
    const singleCount = tasks.filter((t) => passesFilter(t, view.single, ALL_FILTERS)).length;
    return (
      <aside className="sidebar">
        <div
          className="sidebar-header"
          onContextMenu={(e) => {
            e.preventDefault();
            showPaneMenu();
          }}
        >
          <span className="pane-title">Tasks</span>
          <span className="pane-count">{singleCount}</span>
        </div>
        <TaskList {...listProps} pane={null} options={view.single} showEmptyFolders />
      </aside>
    );
  }

  const shown: PaneEntry[] = PANES.filter((p) => view.panes[p.id].visible).map((p, i) => {
    const options = view.panes[p.id];
    return {
      key: p.id,
      title: p.title,
      count: tasks.filter((t) => p.member(t) && passesFilter(t, options, p.filters)).length,
      open: !options.collapsed,
      weight: options.weight,
      onToggle: () => onView({ panes: { ...view.panes, [p.id]: { ...options, collapsed: !options.collapsed } } }),
      onMenu: () => showPaneMenu(p.id),
      // Folders with no tasks in them would otherwise show in no pane at all.
      body: <TaskList {...listProps} pane={p} options={options} showEmptyFolders={i === 0} />,
    };
  });

  const weight = (e: PaneEntry) => dragWeights?.[e.key] ?? e.weight;
  const paneStyle = (e: PaneEntry): React.CSSProperties => (e.open ? { flex: `${weight(e)} 1 0px` } : { flex: '0 0 auto' });

  /** The splitter above pane `i` resizes the nearest open pane above it and the nearest open one from `i` down. */
  const sashPair = (i: number): [PaneEntry, PaneEntry] | null => {
    const above = shown.slice(0, i).reverse().find((p) => p.open);
    const below = shown.slice(i).find((p) => p.open);
    return above && below ? [above, below] : null;
  };

  const startSash = (e: ReactMouseEvent, [above, below]: [PaneEntry, PaneEntry]) => {
    const a = paneRefs.current[above.key]?.getBoundingClientRect().height;
    const b = paneRefs.current[below.key]?.getBoundingClientRect().height;
    const rect = asideRef.current?.getBoundingClientRect();
    if (a === undefined || b === undefined || !rect) return;
    sash.current = {
      above: above.key,
      below: below.key,
      startY: e.clientY - rect.top,
      heightAbove: a,
      heightBelow: b,
      weightSum: weight(above) + weight(below),
    };
    onSashDown(e);
  };

  /** The sash's arrow keys: the same split a drag makes, moved `delta` px. */
  const nudgeSash = ([above, below]: [PaneEntry, PaneEntry], delta: number) => {
    const a = paneRefs.current[above.key]?.getBoundingClientRect().height;
    const b = paneRefs.current[below.key]?.getBoundingClientRect().height;
    if (a === undefined || b === undefined) return;
    const total = a + b;
    const next = Math.max(MIN_PANE_PX, Math.min(total - MIN_PANE_PX, a + delta));
    const sum = weight(above) + weight(below);
    onView(weightPatch({ [above.key]: (sum * next) / total, [below.key]: (sum * (total - next)) / total }));
  };

  return (
    <aside className="sidebar" ref={asideRef}>
      {shown.map((p, i) => {
        const pair = i > 0 ? sashPair(i) : null;
        return (
          <div
            key={p.key}
            ref={(el) => {
              paneRefs.current[p.key] = el;
            }}
            className={`sidebar-pane${i > 0 ? ' follows' : ''}`}
            style={paneStyle(p)}
          >
            {pair && (
              <div
                className="pane-sash"
                role="separator"
                aria-orientation="horizontal"
                aria-label={`Resize ${pair[0].title} and ${pair[1].title}`}
                // A focusable separator is a window splitter: it reports the upper pane's share of the pair.
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round((weight(pair[0]) / (weight(pair[0]) + weight(pair[1]))) * 100)}
                tabIndex={0}
                onMouseDown={(e) => startSash(e, pair)}
                onKeyDown={(e) => {
                  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
                  e.preventDefault();
                  nudgeSash(pair, e.key === 'ArrowUp' ? -SASH_STEP_PX : SASH_STEP_PX);
                }}
              />
            )}
            <div
              className="sidebar-header pane-header"
              onClick={p.onToggle}
              // The header is a button: Enter or Space opens and closes the pane.
              role="button"
              tabIndex={0}
              aria-expanded={p.open}
              onKeyDown={(e) => {
                if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
                e.preventDefault();
                p.onToggle();
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                p.onMenu();
              }}
            >
              <Chevron open={p.open} />
              <span className="pane-title">{p.title}</span>
              <span className="pane-count">{p.count}</span>
            </div>
            {p.open && p.body}
          </div>
        );
      })}
    </aside>
  );
}
