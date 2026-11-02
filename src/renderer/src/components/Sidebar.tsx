import { useRef, useState } from 'react';
import { Chevron } from './icons';
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import { addonPaneKey, matchesSearch, type AddonInfo, type AddonPaneItem } from '@shared/addons';
import type { UiEvent } from '@shared/api';
import type { Environment, Project, Task, TaskFolder, TaskRuntime, View } from '@shared/types';
import { ALL_FILTERS, PANES, passesFilter, type PaneId } from '@shared/panes';
import { AddonPaneList, type AddonPaneState, type AddonSelection } from './AddonPane';
import { ProjectList } from './ProjectList';
import { TaskList } from './TaskList';
import { useDragResize } from './hooks';

interface Props {
  tasks: Task[];
  folders: TaskFolder[];
  layout: Record<string, string[]>;
  runtimes: Record<string, TaskRuntime>;
  selected: string | null;
  onSelect: (id: string | null) => void;
  /** The main window's task commands, for the list's Delete key. */
  onCommand: (type: UiEvent['type']) => void;
  view: View;
  onView: (patch: Partial<View>) => void;
  addons: AddonInfo[];
  addonPanes: Record<string, AddonPaneState>;
  addonSelected: AddonSelection | null;
  onAddonSelect: (sel: AddonSelection, item: AddonPaneItem) => void;
  onAddonRetry: (addonId: string) => void;
}

/** A pane never shrinks below its header and about one row. */
const MIN_PANE_PX = 72;
/** A pane that fits its content keeps room for its header and about three rows when its share is smaller. */
const FIT_PANE_MIN_PX = 160;
/** One arrow press on a focused splitter moves it this far. */
const SASH_STEP_PX = 24;
/** The single task list's key among the panes. */
const SINGLE = 'single';
const DEFAULT_ADDON_PANE = { visible: true, collapsed: false, weight: 1 };

/** The pair of panes a splitter drag resizes, measured when the drag starts. */
interface SashDrag {
  above: string;
  below: string;
  startY: number;
  heightAbove: number;
  heightBelow: number;
  weightSum: number;
}

interface PaneEntry {
  key: string;
  title: string;
  /** Unset: the header shows no count. */
  count?: number | string;
  /** A header that collapses the pane on click, with its chevron. */
  collapsible: boolean;
  open: boolean;
  weight: number;
  /** Sized to its content, up to its share of the height: a short list shows whole and the task list gets the rest. */
  fit?: boolean;
  onToggle?: () => void;
  onMenu: () => void;
  body: ReactNode;
}

const isTaskPane = (key: string): key is PaneId => PANES.some((p) => p.id === key);

/** The Projects tab's list of projects, under its header (a right-click there: Group By and New Project). */
export function ProjectsSidebar({
  projects,
  selected,
  onSelect,
  environments,
  view,
}: {
  projects: Project[];
  selected: string | null;
  onSelect: (id: string) => void;
  environments: Environment[];
  view: View;
}) {
  return (
    <aside className="sidebar">
      <div
        className="sidebar-header"
        onContextMenu={(e) => {
          e.preventDefault();
          window.looper.projects.showContextMenu('');
        }}
      >
        <span className="pane-title">Projects</span>
        <span className="pane-count">{projects.length}</span>
      </div>
      <ProjectList
        projects={projects}
        groupBy={view.projectsPane.groupBy}
        environments={environments}
        selected={selected}
        compact={view.taskList === 'compact'}
        onSelect={onSelect}
      />
    </aside>
  );
}

/** The Tasks tab's task list (one list of every task, or the Tasks / Goals / Watchers panes stacked), and the installed addons' panes below it. */
export function Sidebar({
  tasks,
  folders,
  layout,
  runtimes,
  selected,
  onSelect,
  onCommand,
  view,
  onView,
  addons,
  addonPanes,
  addonSelected,
  onAddonSelect,
  onAddonRetry,
}: Props) {
  const asideRef = useRef<HTMLElement>(null);
  const paneRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const sash = useRef<SashDrag | null>(null);
  // Weights while a splitter is dragged; saved to the view when it is released.
  const [dragWeights, setDragWeights] = useState<Record<string, number> | null>(null);
  // Each addon pane's search, by pane key.
  const [queries, setQueries] = useState<Record<string, string>>({});

  /** The view patch that stores these pane weights. */
  const weightPatch = (weights: Record<string, number>): Partial<View> => {
    const patch: Partial<View> = {};
    for (const [key, weight] of Object.entries(weights)) {
      if (key === SINGLE) patch.singleWeight = weight;
      else if (isTaskPane(key)) patch.panes = { ...(patch.panes ?? view.panes), [key]: { ...view.panes[key], weight } };
      else {
        const prev = patch.addonPanes ?? view.addonPanes;
        patch.addonPanes = { ...prev, [key]: { ...(prev[key] ?? DEFAULT_ADDON_PANE), weight } };
      }
    }
    return patch;
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
    onCommand,
    compact: view.taskList === 'compact',
    autoOpenFolders: view.autoOpenFolders,
  };

  const addonEntries: PaneEntry[] = addons.filter((a) => a.enabled).flatMap((a) =>
    a.panes.flatMap((p): PaneEntry[] => {
      const key = addonPaneKey(a.id, p.id);
      const state = view.addonPanes[key] ?? DEFAULT_ADDON_PANE;
      if (!state.visible) return [];
      const pane = addonPanes[key];
      const query = queries[key] ?? '';
      const items = pane?.status === 'ready' ? pane.content.items : [];
      const shown = items.filter((it) => matchesSearch(it, query)).length;
      return [
        {
          key,
          title: p.title,
          count: a.status === 'running' && pane?.status === 'ready' ? (query.trim() ? `${shown} of ${items.length}` : items.length) : undefined,
          collapsible: true,
          open: !state.collapsed,
          weight: state.weight,
          fit: true,
          onToggle: () => onView({ addonPanes: { ...view.addonPanes, [key]: { ...state, collapsed: !state.collapsed } } }),
          onMenu: () =>
            window.looper.addons.showMenu(a.id, p.id, pane?.status === 'ready' ? (pane.content.menu ?? []) : [], { header: true }),
          body: (
            <AddonPaneList
              addon={a}
              pane={p.id}
              state={pane}
              selected={addonSelected?.addonId === a.id && addonSelected.pane === p.id ? addonSelected.item : null}
              compact={view.taskList === 'compact'}
              query={query}
              onQuery={(q) => setQueries((m) => ({ ...m, [key]: q }))}
              onSelect={(item) => onAddonSelect({ addonId: a.id, pane: p.id, item: item.id }, item)}
              onRetry={() => onAddonRetry(a.id)}
            />
          ),
        },
      ];
    }),
  );

  const singleCount = tasks.filter((t) => passesFilter(t, view.single, ALL_FILTERS)).length;
  if (view.sidebar === 'single' && view.single.visible && !addonEntries.length) {
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
          <span className="pane-count">{singleCount}</span>
        </div>
        <TaskList {...listProps} pane={null} options={view.single} showEmptyFolders />
      </aside>
    );
  }

  const taskEntries: PaneEntry[] =
    view.sidebar === 'single'
      ? [
          {
            key: SINGLE,
            title: 'Tasks',
            count: singleCount,
            collapsible: true,
            open: !view.single.collapsed,
            weight: view.singleWeight,
            onToggle: () => onView({ single: { ...view.single, collapsed: !view.single.collapsed } }),
            onMenu: () => window.looper.showPaneContextMenu({}),
            body: <TaskList {...listProps} pane={null} options={view.single} showEmptyFolders />,
          },
        ].filter(() => view.single.visible)
      : PANES.filter((p) => view.panes[p.id].visible).map((p, i) => {
          const options = view.panes[p.id];
          return {
            key: p.id,
            title: p.title,
            count: tasks.filter((t) => p.member(t) && passesFilter(t, options, p.filters)).length,
            collapsible: true,
            open: !options.collapsed,
            weight: options.weight,
            onToggle: () => onView({ panes: { ...view.panes, [p.id]: { ...options, collapsed: !options.collapsed } } }),
            onMenu: () => window.looper.showPaneContextMenu({ pane: p.id }),
            // Folders with no tasks in them would otherwise show in no pane at all.
            body: <TaskList {...listProps} pane={p} options={options} showEmptyFolders={i === 0} />,
          };
        });

  const shown = [...taskEntries, ...addonEntries];
  const weight = (e: PaneEntry) => dragWeights?.[e.key] ?? e.weight;
  // A pane that fits its content needs a pane that fills the rest; with none open they all share the height by weight.
  const filling = shown.some((e) => e.open && !e.fit);
  const openWeight = shown.reduce((sum, e) => sum + (e.open ? weight(e) : 0), 0);
  const paneStyle = (e: PaneEntry): React.CSSProperties =>
    !e.open
      ? { flex: '0 0 auto' }
      : e.fit && filling
        ? { flex: '0 1 auto', maxHeight: `max(${((weight(e) / openWeight) * 100).toFixed(2)}%, ${FIT_PANE_MIN_PX}px)` }
        : { flex: `${weight(e)} 1 0px` };

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
              className={p.collapsible ? 'sidebar-header pane-header' : 'sidebar-header'}
              onClick={p.onToggle}
              // A collapsible header is a button: Enter or Space opens and closes the pane.
              role={p.collapsible ? 'button' : undefined}
              tabIndex={p.collapsible ? 0 : undefined}
              aria-expanded={p.collapsible ? p.open : undefined}
              onKeyDown={(e) => {
                if (!p.collapsible || e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
                e.preventDefault();
                p.onToggle?.();
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                p.onMenu();
              }}
            >
              {p.collapsible && <Chevron open={p.open} />}
              <span className="pane-title">{p.title}</span>
              {p.count !== undefined && <span className="pane-count">{p.count}</span>}
            </div>
            {p.open && p.body}
          </div>
        );
      })}
    </aside>
  );
}
