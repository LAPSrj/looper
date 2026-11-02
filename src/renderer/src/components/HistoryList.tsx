import { useState } from 'react';
import { historySourceText, type HistoryGroup, type HistoryItem } from '@shared/history';
import type { Project } from '@shared/types';
import { fmtClock } from '../format';
import { MINUTE, useNow } from '../useNow';
import { GroupHeader } from './GroupHeader';
import { useListNav } from './hooks';
import { listContextMenu, parentIndex } from './list-nav';

type NavRow = { kind: 'group'; key: string; id: string; open: boolean } | { kind: 'item'; item: HistoryItem; id: string };

const fail = (e: Error) => void window.looper.showError(e.message);

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
  const [activeGroup, setActiveGroup] = useState<string | null>(null);
  const isOpen = (key: string) => !closed.includes(key);
  const toggle = (key: string) => setClosed((c) => (c.includes(key) ? c.filter((k) => k !== key) : [...c, key]));
  const rows: NavRow[] = [];
  groups.forEach((g, gi) => {
    rows.push({ kind: 'group', key: g.key, id: `history-group-${gi}`, open: isOpen(g.key) });
    if (isOpen(g.key)) for (const item of g.items) rows.push({ kind: 'item', item, id: `history-${item.id}` });
  });
  const groupAt = activeGroup === null ? -1 : rows.findIndex((r) => r.kind === 'group' && r.key === activeGroup);
  const at = groupAt >= 0 ? groupAt : rows.findIndex((r) => r.kind === 'item' && r.item.id === selected);
  const depths = rows.map((r) => (r.kind === 'group' ? 0 : 1));
  const pick = (id: string) => {
    setActiveGroup(null);
    onSelect(id);
  };
  const menu = (id: string) => window.looper.history.showContextMenu(id);
  const onKeyDown = useListNav({
    count: rows.length,
    index: at,
    onIndex: (i) => {
      const r = rows[i];
      if (r.kind === 'group') setActiveGroup(r.key);
      else pick(r.item.id);
    },
    onActivate: (i) => {
      const r = rows[i];
      if (r.kind === 'group') toggle(r.key);
      else void window.looper.history.run(r.item.id, 'chat').catch(fail);
    },
    onMenu: (i) => {
      const r = rows[i];
      if (r.kind === 'item') menu(r.item.id);
    },
    tree: {
      expanded: (i) => {
        const r = rows[i];
        return r.kind === 'group' ? r.open : undefined;
      },
      set: (i, open) => {
        const r = rows[i];
        if (r.kind === 'group' && r.open !== open) toggle(r.key);
      },
      parent: (i) => parentIndex(depths, i),
    },
    scrollToId: at >= 0 ? rows[at].id : null,
  });
  const place = (item: HistoryItem) =>
    !showPlace ? '' : ((item.projectId ? projects.find((p) => p.id === item.projectId)?.name : undefined) ?? item.folder.split(/[\\/]/).filter(Boolean).pop() ?? '');
  return (
    <div
      className="session-list history-list"
      role="tree"
      aria-label="Conversations"
      tabIndex={0}
      aria-activedescendant={at >= 0 ? rows[at].id : undefined}
      onKeyDown={onKeyDown}
      onContextMenu={(e) =>
        listContextMenu(e, at, (i) => {
          const r = rows[i];
          if (r.kind === 'item') menu(r.item.id);
        })
      }
    >
      {groups.map((g, gi) => (
        <div role="group" aria-label={g.title} key={g.key}>
          <GroupHeader
            id={`history-group-${gi}`}
            name={g.title}
            open={isOpen(g.key)}
            count={g.items.length}
            className={`session-group${groupAt >= 0 && activeGroup === g.key ? ' active' : ''}`}
            onToggle={() => {
              setActiveGroup(g.key);
              toggle(g.key);
            }}
          />
          {isOpen(g.key) &&
            g.items.map((item) => (
              <div
                key={item.id}
                id={`history-${item.id}`}
                role="treeitem"
                aria-selected={selected === item.id}
                aria-level={2}
                className={`session-row${selected === item.id ? ' selected' : ''}`}
                onClick={() => pick(item.id)}
                onDoubleClick={() => void window.looper.history.run(item.id, 'chat').catch(fail)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  pick(item.id);
                  menu(item.id);
                }}
              >
                <div className="session-row-text">
                  <div className="session-title" title={item.title}>
                    {item.title}
                  </div>
                  <div className="session-sub" title={item.folder || undefined}>
                    {[place(item), fmtClock(item.lastActive, now), historySourceText(item)].filter(Boolean).join(' · ')}
                  </div>
                </div>
              </div>
            ))}
        </div>
      ))}
      {groups.length === 0 && (
        <div className="empty session-empty" role="treeitem" aria-disabled="true" aria-selected={false}>
          {emptyText}
        </div>
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
