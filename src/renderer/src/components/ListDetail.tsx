import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { SplitLayout } from '../web/nav-stack';
import { isPhone } from '../web/page-nav';
import { NavBar } from './NavBar';
import { SplitEmpty, SplitView, useContainerSplit } from './phone/PhoneSplit';
import { SplitPane, useSideWidths, type PaneSize, type SideWidth } from './SplitPane';
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
  /** What the selected row shows. The desktop always draws it, so it has to handle "nothing selected" itself. */
  detail: ReactNode;
  /** A row is opened. Only phones and tablets read this: on the desktop the pane is always there. */
  open?: boolean;
  /** Back, where the detail is a screen of its own. */
  onClose?: () => void;
  /** The bar's title on that screen. */
  detailTitle?: string;
  /** What the list is called, for Back inside a panel, where the bar is out of reach. */
  backLabel?: string;
  /** The detail column with no row open (an Overview, or a sentence). */
  empty?: ReactNode;
  /** The detail is only a preview of what a row opens: on a phone or tablet a tap opens that, so there's only the list. */
  preview?: boolean;
  /** The desktop's panes. */
  panes?: PaneSize;
  tabs?: ListDetailTabs;
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
/** Inside a sheet or an inspector the frame's bar isn't this content's, so Back is drawn in place. */
export const InPanel = createContext(false);
/** What the ListDetail around an Inspector tells it: its columns on a phone or tablet, its splitter's drag on the desktop. */
export const InspectorHost = createContext<{ split?: SplitLayout | null; drag?: (e: React.MouseEvent) => void }>({});

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

function Mobile({ list: rows, detail, open = false, onClose, detailTitle, backLabel, empty, preview, split: given, inspector, onPushed, summary }: ListDetailProps) {
  const list = summary ? (
    <div className="list-summary">
      <TabBar tabs={[['summary', summary.label], ['list', summary.listLabel]] as const} active={summary.shown ? 'summary' : 'list'} onSelect={(id) => summary.onShown(id === 'summary')} />
      {summary.shown ? <div className="list-summary-body">{summary.body}</div> : rows}
    </div>
  ) : (
    rows
  );
  const ref = useRef<HTMLDivElement>(null);
  const measured = useContainerSplit(ref, given === undefined && !preview);
  const split = given !== undefined ? given : measured;
  const depth = useContext(Depth);
  const inPanel = useContext(InPanel);
  const pushed = !split && open && !preview;
  useEffect(() => onPushed?.(pushed), [pushed, onPushed]);
  if (preview) return <div className="list-detail">{list}</div>;
  const column = open ? (
    <Depth.Provider value={depth + 1}>
      {pushed && !inPanel && <NavBar title={detailTitle} back={onClose} order={20 + depth} />}
      {pushed && inPanel && onClose && <InlineBack label={backLabel ?? 'Back'} onBack={onClose} />}
      {detail}
    </Depth.Provider>
  ) : empty === undefined || typeof empty === 'string' ? (
    <SplitEmpty>{empty}</SplitEmpty>
  ) : (
    empty
  );
  return (
    <div className="list-detail" ref={ref}>
      <InspectorHost.Provider value={{ split }}>
        <SplitView split={split} shows={open ? 'detail' : 'lead'} lead={list} detail={split || open ? column : null} inspector={inspector} />
      </InspectorHost.Provider>
    </div>
  );
}

function InlineBack({ label, onBack }: { label: string; onBack: () => void }) {
  return (
    <button className="pg-inline-back" onClick={onBack}>
      <svg width="8" height="13" viewBox="0 0 8 13" aria-hidden="true">
        <path d="M6.5 1.5 1.5 6.5l5 5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {label}
    </button>
  );
}

/** Below this height (px) a list over its detail becomes tabs. */
const SHORT = 260;

function Desktop(props: ListDetailProps) {
  return props.sides ? <DesktopSides {...props} sides={props.sides} /> : <DesktopPanes {...props} />;
}

/** The list, the detail and the inspector as one window's body. */
function DesktopSides({ list, detail, inspector, inspectorOpen, sides }: ListDetailProps & { sides: NonNullable<ListDetailProps['sides']> }) {
  const ref = useRef<HTMLDivElement>(null);
  const { widths, dragLeft, dragRight } = useSideWidths(sides.storageKey, sides.left, sides.right, ref);
  // The list and the inspector shrink to their smallest widths before the detail drops under its least.
  const listTrack = list ? `minmax(${sides.left.min}px, ${widths.left}px) 5px ` : '';
  const columns = inspectorOpen ? `${listTrack}minmax(${sides.minDetail}px, 1fr) 5px minmax(${sides.right.min}px, ${widths.right}px)` : `${listTrack}1fr`;
  return (
    <div className="sessions-body" ref={ref} style={{ gridTemplateColumns: columns }}>
      {list && (
        <>
          {list}
          <div className="sidebar-divider" onMouseDown={dragLeft} />
        </>
      )}
      {detail}
      <InspectorHost.Provider value={{ drag: dragRight }}>{inspector}</InspectorHost.Provider>
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
