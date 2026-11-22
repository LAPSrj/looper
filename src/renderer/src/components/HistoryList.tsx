import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { historySourceText, type HistoryGroup, type HistoryItem } from '@shared/history';
import { baseName } from '@shared/paths';
import type { Project } from '@shared/types';
import { fmtClock, resultLabel } from '../format';
import { MINUTE, useNow } from '../useNow';
import { EmptyState } from './EmptyState';
import { GroupHeader } from './GroupHeader';
import { useGroupedTree, type TreeRow } from './GroupedTree';
import { groupHeight, rowDrawn, rowOffset, scrollToShow, windowGroups, type ListMetrics } from './list-window';
import { SessionRow } from './SessionList';
import { reportError } from '../report-error';
import { isPhone } from '../web/page-nav';

type GroupRow = Extract<TreeRow<HistoryGroup, HistoryItem>, { kind: 'group' }>;
type ItemRow = Extract<TreeRow<HistoryGroup, HistoryItem>, { kind: 'item' }>;

/** From this many conversations a desktop list draws only the rows in view, plus OVERSCAN rows on each side. */
const WINDOW_FROM = 40;
const OVERSCAN = 8;
/** The scroll position is read in steps of this many rows, which OVERSCAN covers, so scrolling draws again only when the drawn rows change. */
const STEP = 4;

/**
 * Which rows of the list to draw (list-window.ts): the ones the scroll position shows. The rows' height is
 * measured from the drawn ones, and a keyboard move to an active row that isn't drawn scrolls it to, which
 * draws it, then brings it fully into view (the list keys scroll to a row by its element).
 */
function useListWindow(list: RefObject<HTMLDivElement | null>, sizes: number[], on: boolean, activeFlat: number, activeId: string | null) {
  const [view, setView] = useState({ top: 0, height: 1000 });
  const metrics = useRef<ListMetrics>({ base: 6, headH: 34, rowH: 50, overscan: OVERSCAN });
  const pending = useRef<string | null>(null);
  const read = () => {
    const el = list.current;
    if (!el) return;
    const step = metrics.current.rowH * STEP;
    const top = Math.floor(el.scrollTop / step) * step;
    setView((v) => (v.top === top && v.height === el.clientHeight ? v : { top, height: el.clientHeight }));
  };
  useLayoutEffect(() => {
    const el = list.current;
    if (!on || !el) return;
    const m = metrics.current;
    m.base = parseFloat(getComputedStyle(el).paddingTop) || 0;
    const head = el.querySelector<HTMLElement>('.group-header');
    if (head) m.headH = head.getBoundingClientRect().height + (parseFloat(getComputedStyle(head).marginTop) || 0);
    const rows = el.querySelectorAll<HTMLElement>('.session-row');
    if (rows.length) {
      const a = rows[0].getBoundingClientRect();
      const b = rows[1]?.getBoundingClientRect();
      m.rowH = b && rows[1].parentElement === rows[0].parentElement && b.top > a.top ? b.top - a.top : a.height || m.rowH;
    }
    // The row a keyboard move scrolled to is drawn now: show all of it.
    const id = pending.current;
    const row = id ? document.getElementById(id) : null;
    if (row) {
      pending.current = null;
      row.scrollIntoView({ block: 'nearest' });
    }
  });
  useEffect(() => {
    const el = list.current;
    if (!on || !el) return;
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on]);
  // The active row isn't drawn: scroll to where it sits, and the scroll draws it.
  useEffect(() => {
    const el = list.current;
    pending.current = null;
    if (!on || !el || activeFlat < 0 || !activeId || document.getElementById(activeId)) return;
    const at = rowOffset(sizes, activeFlat, metrics.current);
    const to = at && scrollToShow(at, el.scrollTop, el.clientHeight);
    if (to === null) return;
    pending.current = activeId;
    el.scrollTop = to;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFlat, activeId, on]);
  return { ranges: on ? windowGroups(sizes, view.top, view.height, metrics.current) : null, metrics: metrics.current, onScroll: read };
}

/**
 * The History window's list: the conversations in their groups (by date or
 * by folder), each group closable. A row has the conversation's title, then
 * (grouped by date) its project or its folder's name, when it was last
 * active and where it came from; in Task History (`runs`) the task and the
 * run's result. Up and Down move through it, Enter and a
 * double-click continue it in a chat, and a right-click has its commands.
 * Show More, at its end, reads the next older conversations.
 */
export function HistoryList({
  groups,
  projects,
  selected,
  onSelect,
  emptyText,
  showPlace,
  runs = false,
  more,
  loadingMore,
  onMore,
  onEmptyMenu,
}: {
  groups: HistoryGroup[];
  projects: Pick<Project, 'id' | 'name'>[];
  selected: string | null;
  onSelect: (id: string) => void;
  emptyText: string;
  /** The row names its project or folder: the groups don't. */
  showPlace: boolean;
  /** Task History: a row says which task and how the run went, in place of where it came from. */
  runs?: boolean;
  more: boolean;
  loadingMore: boolean;
  onMore: () => void;
  /** A right-click on the empty space below the rows: the list's View options. */
  onEmptyMenu?: () => void;
}) {
  // Its second line counts minutes.
  const now = useNow(MINUTE);
  const [closed, setClosed] = useState<string[]>([]);
  const toggle = (g: HistoryGroup) => setClosed((c) => (c.includes(g.key) ? c.filter((k) => k !== g.key) : [...c, g.key]));
  const list = useRef<HTMLDivElement | null>(null);
  const sections = groups.map((g, gi) => {
    const head: GroupRow = { kind: 'group', key: g.key, id: `history-group-${gi}`, depth: 0, open: !closed.includes(g.key), group: g };
    const items: ItemRow[] = head.open ? g.items.map((item) => ({ kind: 'item', key: item.id, id: `history-${item.id}`, depth: 1, item })) : [];
    return { head, items };
  });
  const rows = sections.flatMap((s) => [s.head, ...s.items]);
  const t = useGroupedTree({
    rows,
    selected,
    onSelect: (item) => onSelect(item.id),
    toggle,
    onOpen: (item) => void window.looper.history.run(item.id, 'chat').catch(reportError),
    itemMenu: (item) => window.looper.history.showContextMenu(item.id),
    emptyMenu: onEmptyMenu,
  });
  const place = (item: HistoryItem) =>
    !showPlace ? '' : ((item.projectId ? projects.find((p) => p.id === item.projectId)?.name : undefined) ?? baseName(item.folder));
  const sizes = sections.map((s) => s.items.length);
  const win = useListWindow(list, sizes, !isPhone && sizes.reduce((a, b) => a + b, 0) > WINDOW_FROM, t.index, t.index >= 0 ? rows[t.index].id : null);
  const { ranges, metrics } = win;
  const gap = (key: string, height: number) => <div key={key} aria-hidden style={{ height }} />;
  const body: ReactNode[] = [];
  /** The height of the groups left out since the last one drawn. */
  let skipped = 0;
  const flush = (key: string) => {
    if (skipped > 0) body.push(gap(`gap-${key}`, skipped));
    skipped = 0;
  };
  sections.forEach(({ head, items }, gi) => {
    const range = ranges ? ranges[gi] : { from: 0, to: items.length };
    if (!range) {
      skipped += groupHeight(items.length, metrics);
      return;
    }
    flush(head.key);
    body.push(
      <div role="group" aria-label={head.group.title} key={head.key}>
        <GroupHeader
          {...t.groupProps(head)}
          name={head.group.title}
          count={head.group.items.length}
          className={`session-group${t.activeGroup === head.key ? ' active' : ''}`}
          aria-setsize={sections.length}
          aria-posinset={gi + 1}
        />
        {range.from > 0 && gap('before', range.from * metrics.rowH)}
        {items.slice(range.from, range.to).map((r, j) => (
          <SessionRow
            key={r.key}
            {...t.itemProps(r)}
            aria-setsize={items.length}
            aria-posinset={range.from + j + 1}
            selected={r.key === selected}
            title={r.item.title}
            sub={(runs
              ? [r.item.taskName, r.item.result && resultLabel(r.item.result), fmtClock(r.item.lastActive, now), place(r.item)]
              : [place(r.item), fmtClock(r.item.lastActive, now), historySourceText(r.item)]
            )
              .filter(Boolean)
              .join(' · ')}
            subTitle={r.item.folder || undefined}
          />
        ))}
        {range.to < items.length && gap('after', (items.length - range.to) * metrics.rowH)}
      </div>,
    );
  });
  flush('end');
  return (
    <div
      className="session-list history-list"
      role="tree"
      aria-label={runs ? 'Task runs' : 'Conversations'}
      {...t.listProps}
      ref={list}
      onScroll={win.onScroll}
      // A row that isn't drawn has no element for the active descendant to name.
      aria-activedescendant={rowDrawn(sizes, ranges, t.index) ? t.listProps['aria-activedescendant'] : undefined}
    >
      {body}
      {groups.length === 0 && (
        <EmptyState at="row" list="tree">
          {emptyText}
        </EmptyState>
      )}
      {more && (
        <div className="history-more">
          <button className="btn small" disabled={loadingMore} onClick={onMore}>
            {loadingMore ? 'Loading…' : 'Show More'}
          </button>
        </div>
      )}
    </div>
  );
}
