import { useRef, useState } from 'react';
import { Chevron } from './icons';
import type { ReactNode } from 'react';
import type { Environment, Project, ProjectFolder, Task, TaskFolder, TaskRuntime, View } from '@shared/types';
import { ALL_FILTERS, PANES, passesFilter } from '@shared/panes';
import { pressKeys } from './list-nav';
import { ProjectList } from './ProjectList';
import { showPaneMenu, showProjectsListMenu } from './row-menus';
import { Splitter } from './SplitPane';
import { TaskList } from './TaskList';

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
  above: string;
  below: string;
  startY: number;
  heightAbove: number;
  heightBelow: number;
  weightSum: number;
}

/** A sidebar pane's header: its title and count, and a right-click shows its menu. With `onToggle` it is a button that opens and closes the pane. */
export function PaneHeader({ title, count, onMenu, open, onToggle }: { title: string; count?: number; onMenu: () => void; open?: boolean; onToggle?: () => void }) {
  return (
    <div
      className={onToggle ? 'sidebar-header pane-header' : 'sidebar-header'}
      onClick={onToggle}
      role={onToggle && 'button'}
      tabIndex={onToggle && 0}
      aria-expanded={onToggle && open}
      onKeyDown={onToggle && pressKeys(onToggle)}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu();
      }}
    >
      {onToggle && <Chevron open={open} />}
      <span className="pane-title">{title}</span>
      {count !== undefined && <span className="pane-count">{count}</span>}
    </div>
  );
}

/** One pane of a PaneStack. */
export interface StackPane {
  key: string;
  title: string;
  count?: number;
  onMenu: () => void;
  body: ReactNode;
  /** With `onToggle` the header opens and closes the pane. */
  open?: boolean;
  onToggle?: () => void;
  /** Its share of the height the open panes have (1 when unset). */
  weight?: number;
}

/**
 * A sidebar's panes, stacked, each under its header. With `onWeights` a
 * splitter between two open panes resizes them, and their new weights are
 * passed to it once the drag or key press is done.
 */
export function PaneStack({ panes, onWeights }: { panes: StackPane[]; onWeights?: (weights: Record<string, number>) => void }) {
  const asideRef = useRef<HTMLElement>(null);
  const paneRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const sash = useRef<SashDrag | null>(null);
  // Weights while a splitter is dragged; passed on when it is released.
  const [dragWeights, setDragWeights] = useState<Record<string, number> | null>(null);

  if (panes.length === 1 && !panes[0].onToggle) {
    const [p] = panes;
    return (
      <aside className="sidebar">
        <PaneHeader title={p.title} count={p.count} onMenu={p.onMenu} />
        {p.body}
      </aside>
    );
  }

  const isOpen = (p: StackPane) => p.open ?? true;
  const weight = (p: StackPane) => dragWeights?.[p.key] ?? p.weight ?? 1;
  const paneStyle = (p: StackPane): React.CSSProperties => (isOpen(p) ? { flex: `${weight(p)} 1 0px` } : { flex: '0 0 auto' });
  const heights = ([above, below]: [StackPane, StackPane]) => {
    const a = paneRefs.current[above.key]?.getBoundingClientRect().height;
    const b = paneRefs.current[below.key]?.getBoundingClientRect().height;
    return a === undefined || b === undefined ? null : [a, b];
  };

  /** The splitter above pane `i` resizes the nearest open pane above it and the nearest open one from `i` down. */
  const sashPair = (i: number): [StackPane, StackPane] | null => {
    const above = panes.slice(0, i).reverse().find(isOpen);
    const below = panes.slice(i).find(isOpen);
    return above && below ? [above, below] : null;
  };

  /** The pair's weights (adding up to `sum`) that give the upper pane `upper` px of their `total`. */
  const split = ([above, below]: [StackPane, StackPane], sum: number, upper: number, total: number) => ({
    [above.key]: (sum * upper) / total,
    [below.key]: (sum * (total - upper)) / total,
  });
  const fit = (above: number, total: number) => Math.max(MIN_PANE_PX, Math.min(total - MIN_PANE_PX, above));

  return (
    <aside className="sidebar" ref={asideRef}>
      {panes.map((p, i) => {
        const pair = onWeights && i > 0 ? sashPair(i) : null;
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
              <Splitter
                className="pane-sash"
                axis="y"
                label={`Resize ${pair[0].title} and ${pair[1].title}`}
                // It reports the upper pane's share of the pair.
                value={{ now: (weight(pair[0]) / (weight(pair[0]) + weight(pair[1]))) * 100, min: 0, max: 100 }}
                containerRef={asideRef}
                onDragStart={(e) => {
                  const h = heights(pair);
                  const rect = asideRef.current?.getBoundingClientRect();
                  if (!h || !rect) return false;
                  sash.current = { above: pair[0].key, below: pair[1].key, startY: e.clientY - rect.top, heightAbove: h[0], heightBelow: h[1], weightSum: weight(pair[0]) + weight(pair[1]) };
                }}
                onDrag={(y) => {
                  const s = sash.current;
                  if (!s) return;
                  const total = s.heightAbove + s.heightBelow;
                  setDragWeights(split(pair, s.weightSum, fit(s.heightAbove + y - s.startY, total), total));
                }}
                onDragEnd={() => {
                  sash.current = null;
                  if (dragWeights) onWeights?.(dragWeights);
                  setDragWeights(null);
                }}
                onStep={(dir) => {
                  const h = heights(pair);
                  if (!h) return;
                  const total = h[0] + h[1];
                  onWeights?.(split(pair, weight(pair[0]) + weight(pair[1]), fit(h[0] + dir * SASH_STEP_PX, total), total));
                }}
              />
            )}
            <PaneHeader title={p.title} count={p.count} onMenu={p.onMenu} open={isOpen(p)} onToggle={p.onToggle} />
            {isOpen(p) && p.body}
          </div>
        );
      })}
    </aside>
  );
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
    <PaneStack
      panes={[
        {
          key: 'projects',
          title: 'Projects',
          count: projects.length,
          onMenu: showProjectsListMenu,
          body: (
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
          ),
        },
      ]}
    />
  );
}

/** The Tasks tab's task list: one list of every task, or the Tasks, Goals and Watchers panes stacked. */
export function Sidebar({ tasks, folders, layout, runtimes, selected, onSelect, view, onView }: Props) {
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
      <PaneStack
        panes={[{ key: 'single', title: 'Tasks', count: singleCount, onMenu: () => showPaneMenu(), body: <TaskList {...listProps} pane={null} options={view.single} showEmptyFolders /> }]}
      />
    );
  }

  const shown: StackPane[] = PANES.filter((p) => view.panes[p.id].visible).map((p, i) => {
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

  /** Stores the pane weights in the view. */
  const onWeights = (weights: Record<string, number>) => {
    const panes = { ...view.panes };
    for (const p of PANES) {
      const weight = weights[p.id];
      if (weight !== undefined) panes[p.id] = { ...panes[p.id], weight };
    }
    onView({ panes });
  };

  return <PaneStack panes={shown} onWeights={onWeights} />;
}
