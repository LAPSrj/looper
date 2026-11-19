import { useState } from 'react';
import { historySourceText, type HistoryGroup, type HistoryItem } from '@shared/history';
import { baseName } from '@shared/paths';
import type { Project } from '@shared/types';
import { fmtClock } from '../format';
import { MINUTE, useNow } from '../useNow';
import { EmptyState } from './EmptyState';
import { GroupHeader } from './GroupHeader';
import { useGroupedTree, type TreeRow } from './GroupedTree';
import { SessionRow } from './SessionList';
import { reportError } from '../report-error';

type GroupRow = Extract<TreeRow<HistoryGroup, HistoryItem>, { kind: 'group' }>;
type ItemRow = Extract<TreeRow<HistoryGroup, HistoryItem>, { kind: 'item' }>;

/**
 * The History window's list: the conversations in their groups (by date or
 * by folder), each group closable. A row has the conversation's title, then
 * (grouped by date) its project or its folder's name, when it was last
 * active and where it came from. Up and Down move through it, Enter and a
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
  more,
  loadingMore,
  onMore,
}: {
  groups: HistoryGroup[];
  projects: Pick<Project, 'id' | 'name'>[];
  selected: string | null;
  onSelect: (id: string) => void;
  emptyText: string;
  /** The row names its project or folder: the groups don't. */
  showPlace: boolean;
  more: boolean;
  loadingMore: boolean;
  onMore: () => void;
}) {
  // Its second line counts minutes.
  const now = useNow(MINUTE);
  const [closed, setClosed] = useState<string[]>([]);
  const toggle = (g: HistoryGroup) => setClosed((c) => (c.includes(g.key) ? c.filter((k) => k !== g.key) : [...c, g.key]));
  const sections = groups.map((g, gi) => {
    const head: GroupRow = { kind: 'group', key: g.key, id: `history-group-${gi}`, depth: 0, open: !closed.includes(g.key), group: g };
    const items: ItemRow[] = head.open ? g.items.map((item) => ({ kind: 'item', key: item.id, id: `history-${item.id}`, depth: 1, item })) : [];
    return { head, items };
  });
  const t = useGroupedTree({
    rows: sections.flatMap((s) => [s.head, ...s.items]),
    selected,
    onSelect: (item) => onSelect(item.id),
    toggle,
    onOpen: (item) => void window.looper.history.run(item.id, 'chat').catch(reportError),
    itemMenu: (item) => window.looper.history.showContextMenu(item.id),
  });
  const place = (item: HistoryItem) =>
    !showPlace ? '' : ((item.projectId ? projects.find((p) => p.id === item.projectId)?.name : undefined) ?? baseName(item.folder));
  return (
    <div className="session-list history-list" role="tree" aria-label="Conversations" {...t.listProps}>
      {sections.map(({ head, items }) => (
        <div role="group" aria-label={head.group.title} key={head.key}>
          <GroupHeader
            {...t.groupProps(head)}
            name={head.group.title}
            count={head.group.items.length}
            className={`session-group${t.activeGroup === head.key ? ' active' : ''}`}
          />
          {items.map((r) => (
            <SessionRow
              key={r.key}
              {...t.itemProps(r)}
              selected={r.key === selected}
              title={r.item.title}
              sub={[place(r.item), fmtClock(r.item.lastActive, now), historySourceText(r.item)].filter(Boolean).join(' · ')}
              subTitle={r.item.folder || undefined}
            />
          ))}
        </div>
      ))}
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
