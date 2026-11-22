import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { SplitLayout } from '../web/nav-stack';
import { isPhone } from '../web/page-nav';
import { EmptyState } from './EmptyState';
import { NavBar } from './NavBar';
import { SplitView, useContainerSplit } from './phone/PhoneSplit';
import { Segmented } from './phone/PhoneList';
import { SplitPane, Splitter, useSideWidths, type PaneSize, type SideSplitter, type SideWidth } from './SplitPane';
import { TabBar } from './ui';

/** The desktop always has a row selected, and it shows; on a phone or tablet a selection opens the row, so nothing starts selected. */
export const selectsFirstRow = !isPhone;
/** A right-click selects the row before its menu; a long press mustn't, because there a selection opens the row. */
export const selectsOnMenu = !isPhone;
/** A window of an item's own (Open in New Window): on a phone or tablet the item already is its own screen. */
export const itemWindows = !isPhone;

/** A list over its detail that gets too short for both becomes these tabs (a first tab of its own for `head`). */
export interface ListDetailTabs {
  list: string;
  detail: string;
  head?: { label: string; body: ReactNode };
}

export interface ListDetailProps {
  list: ReactNode;
  /** What the selected row shows; null when no row is selected, where the desktop's pane draws `empty`. */
  detail: ReactNode;
  /** A row is opened. Only phones and tablets read this: on the desktop the pane is always there, and `detail` says what's in it. */
  open?: boolean;
  /** Back, where the detail is a screen of its own. */
  onClose?: () => void;
  /** The bar's title on that screen. */
  detailTitle?: string;
  /** The detail column with no row open (an Overview, or a sentence): a phone's or tablet's while `open` is off, the desktop's while `detail` is null. */
  empty?: ReactNode;
  /** The detail is only a preview of what a row opens: on a phone or tablet a tap opens that, so there's only the list. */
  preview?: boolean;
  /** The desktop's panes. */
  panes?: PaneSize;
  tabs?: ListDetailTabs;
  /** A phone's or tablet's detail under the list on one screen, where the desktop's `panes.axis` 'y' does that; unset: beside it where there's room, else pushed over it. */
  stacked?: boolean;
  /** A window whose bar splits over its columns: the window's own layout (useSplit), in place of measuring. */
  split?: SplitLayout | null;
  /** The window's inspector (Inspector), at the trailing edge of the columns. */
  inspector?: ReactNode;
  /** Whether it shows, for the desktop's third column. */
  inspectorOpen?: boolean;
  /** A window that is these panes (Chats, History): on the desktop the list and the inspector at the sides, with saved widths, in place of `panes`. */
  sides?: { storageKey: string; left: SideWidth; right: SideWidth; minDetail: number };
  /** The detail covers the list, or stops covering it. */
  onPushed?: (pushed: boolean) => void;
  /**
   * What the list adds up to (a run's result). A phone or tablet shows it as a
   * first tab before the list's own; the desktop's list already shows it in its rows.
   */
  summary?: ListSummary;
}

export interface ListSummary {
  label: string;
  /** The list's tab. */
  listLabel: string;
  body: ReactNode;
  /** The summary's tab is the one shown. */
  shown: boolean;
  onShown: (shown: boolean) => void;
}

/** How many pushed details this one is inside: a deeper one's bar goes over the shallower one's. */
const Depth = createContext(0);
/**
 * The detail is a screen of its own with Back, title and subtitle in a bar (a phone's pushed detail, in the frame's
 * bar or a sheet's): what it would head itself with (a console's name and state) goes in the bar with NavBar instead.
 */
export const DetailInBar = createContext(false);
/** What the ListDetail around an Inspector tells it: its columns on a phone or tablet, its splitter on the desktop. */
export const InspectorHost = createContext<{ split?: SplitLayout | null; splitter?: SideSplitter }>({});

/**
 * A list and what its selected row shows, by role. The desktop draws two panes
 * with a splitter. A phone or tablet draws two columns where this component has
 * the room (iPad from 700 px, Android from 840 dp), and otherwise the list, with
 * the detail pushed over it and Back to return. A screen says what the list and
 * the detail are and never checks the platform (scratch/platforms.md).
 */
export function ListDetail(props: ListDetailProps) {
  return isPhone ? <Mobile {...props} /> : <Desktop {...props} />;
}

function Mobile({ list: rows, detail, open = false, onClose, detailTitle, empty, preview, split: given, inspector, onPushed, summary, stacked = false }: ListDetailProps) {
  const list = summary ? (
    <div className="list-summary">
      <div className="pg-segmented-wrap">
        <Segmented
          items={[['summary', summary.label], ['list', summary.listLabel]] as const}
          value={summary.shown ? 'summary' : 'list'}
          onChange={(id) => summary.onShown(id === 'summary')}
          label="Show"
        />
      </div>
      {summary.shown ? <div className="list-summary-body">{summary.body}</div> : rows}
    </div>
  ) : (
    rows
  );
  const ref = useRef<HTMLDivElement>(null);
  const measured = useContainerSplit(ref, given === undefined && !preview);
  const split = given !== undefined ? given : measured;
  const depth = useContext(Depth);
  const pushed = !split && open && !preview && !stacked;
  useEffect(() => onPushed?.(pushed), [pushed, onPushed]);
  if (preview) return <div className="list-detail">{list}</div>;
  const column = open ? (
    <Depth.Provider value={depth + 1}>
      {/* In a sheet or the iPad's inspector column, NavBar goes to that panel's bar (PanelNavContext). */}
      {pushed && <NavBar title={detailTitle} back={onClose} order={20 + depth} />}
      <DetailInBar.Provider value={pushed}>{detail}</DetailInBar.Provider>
    </Depth.Provider>
  ) : empty === undefined || typeof empty === 'string' ? (
    <EmptyState at="detail">{empty}</EmptyState>
  ) : (
    empty
  );
  return (
    <div className="list-detail" ref={ref}>
      <InspectorHost.Provider value={{ split }}>
        <SplitView split={split} shows={open ? 'detail' : 'lead'} lead={list} detail={split || open || stacked ? column : null} inspector={inspector} stacked={stacked} />
      </InspectorHost.Provider>
    </div>
  );
}

/** Below this height (px) a list over its detail becomes tabs. */
const SHORT = 260;

function Desktop(props: ListDetailProps) {
  const { detail, empty } = props;
  const p =
    detail === null || detail === undefined || detail === false
      ? {
          ...props,
          detail: typeof empty === 'string' ? <EmptyState at="detail">{empty}</EmptyState> : empty,
        }
      : props;
  return p.sides ? <DesktopSides {...p} sides={p.sides} /> : <DesktopPanes {...p} />;
}

/** A splitter's width: the grid's gap column between two panes. */
const SPLITTER_PX = 5;

/**
 * The list, the detail and the inspector as one window's body. Each keeps its least width. When the three
 * don't fit, the inspector (View → Activity Pane) takes the detail's place over the whole center column, as a view
 * the command switches to and back; once the window has room for all three it sits beside the detail again.
 */
function DesktopSides({ list, detail, inspector, inspectorOpen, sides }: ListDetailProps & { sides: NonNullable<ListDetailProps['sides']> }) {
  const ref = useRef<HTMLDivElement>(null);
  const { widths, left, right } = useSideWidths(sides.storageKey, sides.left, sides.right, ref);
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setWidth(el.clientWidth);
    read();
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const beside = width === null || width >= (list ? sides.left.min + SPLITTER_PX : 0) + sides.minDetail + SPLITTER_PX + sides.right.min;
  const over = !!inspectorOpen && !beside;
  // The list and the inspector shrink to their smallest widths before the detail drops under its least.
  const listTrack = list ? `minmax(${sides.left.min}px, ${widths.left}px) ${SPLITTER_PX}px ` : '';
  const columns = inspectorOpen && beside ? `${listTrack}minmax(${sides.minDetail}px, 1fr) ${SPLITTER_PX}px minmax(${sides.right.min}px, ${widths.right}px)` : `${listTrack}1fr`;
  return (
    <div className="sessions-body" ref={ref} style={{ gridTemplateColumns: columns }}>
      {list && (
        <>
          {list}
          <Splitter className="sidebar-divider" axis="x" {...left} />
        </>
      )}
      {!over && detail}
      {inspectorOpen && <InspectorHost.Provider value={{ splitter: over ? undefined : right }}>{inspector}</InspectorHost.Provider>}
    </div>
  );
}

function DesktopPanes({ list, detail, panes = { axis: 'y', initial: 50, unit: '%' }, tabs }: ListDetailProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [short, setShort] = useState(false);
  const [picked, setPicked] = useState<'head' | 'list' | 'detail'>(tabs?.head ? 'head' : 'list');
  const shrinks = !!tabs && panes.axis === 'y';
  useLayoutEffect(() => {
    const el = ref.current;
    if (!shrinks || !el) return;
    const measure = () => setShort(el.clientHeight < SHORT);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [shrinks]);
  const together = <SplitPane {...panes} first={list} second={detail} />;
  if (!tabs) return together;
  const items: ['head' | 'list' | 'detail', string][] = [];
  if (tabs.head) items.push(['head', tabs.head.label]);
  items.push(['list', tabs.list]);
  if (short) items.push(['detail', tabs.detail]);
  // The Diff tab goes away once there's room for both again.
  const active = !short && picked === 'detail' ? 'list' : picked;
  return (
    <div className="list-detail-tabs" ref={ref}>
      {items.length > 1 && <TabBar tabs={items} active={active} onSelect={setPicked} className="list-detail-tabbar" />}
      <div className="list-detail-tabbody">{active === 'head' ? tabs.head?.body : short ? (active === 'list' ? list : detail) : together}</div>
    </div>
  );
}
