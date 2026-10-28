import { useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import { addonPaneKey, matchesSearch, type AddonInfo, type AddonPaneItem } from '@shared/addons';
import type { Task, TaskFolder, TaskRuntime, View } from '@shared/types';
import { PANES, passesFilter, type PaneId } from '@shared/panes';
import { AddonPaneList, type AddonPaneState, type AddonSelection } from './AddonPane';
import { TaskList } from './TaskList';
import { useDragResize } from './hooks';

interface Props {
  tasks: Task[];
  folders: TaskFolder[];
  layout: Record<string, string[]>;
  runtimes: Record<string, TaskRuntime>;
  selected: string | null;
  now: number;
  onSelect: (id: string | null) => void;
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
  onToggle?: () => void;
  onMenu: () => void;
  body: ReactNode;
}

const isTaskPane = (key: string): key is PaneId => PANES.some((p) => p.id === key);

/**
 * The task list (one list of every task, or the Tasks / Goals / Watchers
 * panes stacked), with the installed addons' panes below it.
 */
export function Sidebar({
  tasks,
  folders,
  layout,
  runtimes,
  selected,
  now,
  onSelect,
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
    now,
    onSelect,
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

  if (view.sidebar === 'single' && !addonEntries.length) {
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
            collapsible: false,
            open: true,
            weight: view.singleWeight,
            onMenu: () => window.looper.showPaneContextMenu({}),
            body: <TaskList {...listProps} pane={null} options={view.single} showEmptyFolders />,
          },
        ]
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
            style={{ flex: p.open ? `${weight(p)} 1 0px` : '0 0 auto' }}
          >
            {pair && <div className="pane-sash" onMouseDown={(e) => startSash(e, pair)} />}
            <div
              className={p.collapsible ? 'sidebar-header pane-header' : 'sidebar-header'}
              onClick={p.onToggle}
              onContextMenu={(e) => {
                e.preventDefault();
                p.onMenu();
              }}
            >
              {p.collapsible && (
                <svg
                  className={`chev${p.open ? ' open' : ''}`}
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
              )}
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
