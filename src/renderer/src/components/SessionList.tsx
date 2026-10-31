import { useState } from 'react';
import type { ReactNode } from 'react';
import type { SessionSummary } from '@shared/sessions';
import { waitingOf } from '@shared/sessions';
import { isPhone } from '../web/page-nav';
import { ContextRing } from './ContextRing';
import { GroupHeader } from './GroupHeader';
import { useListNav } from './hooks';
import { listContextMenu, parentIndex } from './list-nav';
import { WaitedFor } from './Live';
import { contextFraction } from './usage';

/** Status and context in one icon: the ring fills with the context, the dot says what the agent is doing. */
export function SessionIcon({ s }: { s: SessionSummary }) {
  const state = s.waiting?.reason === 'error' ? 'failed' : s.waiting && s.waiting.reason !== 'turn' ? 'waiting' : s.waiting?.reason === 'turn' ? 'done' : s.status;
  return (
    <svg className={`session-icon ${state}`} width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <ContextRing frac={contextFraction(s.context)} />
      <circle cx="9" cy="9" r="3" className="core" />
    </svg>
  );
}

/** A session's status as a few words. */
export function statusText(s: SessionSummary): string {
  if (s.status === 'starting') return 'Starting';
  if (s.status === 'working') return 'Working';
  if (s.status === 'ended') return 'Ended';
  return 'Ready';
}

function Row({
  s,
  id,
  selected,
  sub,
  live,
  onSelect,
  selectOnMenu,
}: {
  s: SessionSummary;
  id: string;
  selected: boolean;
  sub: ReactNode;
  /** The subtitle counts a live time. */
  live?: boolean;
  onSelect: (id: string) => void;
  selectOnMenu: boolean;
}) {
  return (
    <div
      id={id}
      role="treeitem"
      aria-selected={selected}
      aria-level={2}
      className={`session-row${selected ? ' selected' : ''}${s.waiting?.reason === 'turn' ? ' unread' : ''}`}
      onClick={() => onSelect(s.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        // On a phone a selection opens the chat: a long press only shows its menu (which names the session itself).
        if (selectOnMenu && !isPhone) onSelect(s.id);
        window.looper.sessions.showContextMenu(s.id);
      }}
    >
      <SessionIcon s={s} />
      <div className="session-row-text">
        <div className="session-title">{s.title}</div>
        <div className={`session-sub${s.waiting?.reason === 'error' ? ' error-text' : ''}${live ? ' live-only' : ''}`}>{sub}</div>
      </div>
    </div>
  );
}

/** The key a group's collapsed state is saved under. */
const WAITING_KEY = '@waiting';

/**
 * A group: a header with a chevron and its name (a click opens or closes it),
 * then its rows, none when it's closed. The header and the rows are siblings
 * (the phone's list styles depend on it); the tree levels say which is which.
 */
function Group({
  id,
  active,
  name,
  open,
  count,
  onToggle,
  children,
}: {
  id: string;
  /** The keyboard's active row. */
  active: boolean;
  name: string;
  open: boolean;
  count: number;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div role="group" aria-label={name}>
      <GroupHeader id={id} name={name} open={open} count={count} className={`session-group${active ? ' active' : ''}`} onToggle={onToggle} />
      {open && children}
    </div>
  );
}

/** One row the keyboard visits: a group's header, or a session in a group. */
type NavRow = { kind: 'group'; key: string; id: string; open: boolean } | { kind: 'session'; s: SessionSummary; id: string };

/**
 * The Chats window's list: Waiting for you (with `waitingFirst`), then each
 * project's or folder's sessions, each group closable. Up and Down move
 * through the sessions shown, and a click on the empty space below shows the dashboard.
 */
export function SessionList({
  sessions,
  selected,
  collapsed,
  waitingFirst,
  onToggle,
  onSelect,
  selectOnMenu = true,
}: {
  sessions: SessionSummary[];
  selected: string | null;
  /** The closed groups' keys: a project's id, or its name without one. */
  collapsed: string[];
  /** The sessions waiting for the user show again at the top, in Waiting for you. */
  waitingFirst: boolean;
  onToggle: (key: string) => void;
  onSelect: (id: string | null) => void;
  /** A right-click (a long press) selects the row before its menu shows; off where selecting opens it. */
  selectOnMenu?: boolean;
}) {
  const waiting = waitingFirst ? waitingOf(sessions) : [];
  const groups: { key: string; name: string; items: SessionSummary[] }[] = [];
  for (const s of sessions) {
    const key = s.projectId ?? s.groupName;
    const last = groups[groups.length - 1];
    if (last?.key === key) last.items.push(s);
    else groups.push({ key, name: s.groupName, items: [s] });
  }
  const isOpen = (key: string) => !collapsed.includes(key);
  const waitingId = (id: string) => `session-w-${id}`;
  // The rows the keyboard visits, top to bottom: each group's header, then its sessions while it's open.
  const rows: NavRow[] = [];
  if (waiting.length > 0) {
    rows.push({ kind: 'group', key: WAITING_KEY, id: 'session-group-w', open: isOpen(WAITING_KEY) });
    if (isOpen(WAITING_KEY)) for (const s of waiting) rows.push({ kind: 'session', s, id: waitingId(s.id) });
  }
  groups.forEach((g, gi) => {
    rows.push({ kind: 'group', key: g.key, id: `session-group-${gi}`, open: isOpen(g.key) });
    if (isOpen(g.key)) for (const s of g.items) rows.push({ kind: 'session', s, id: `session-${s.id}` });
  });
  // The active row is the selected session (its row in Waiting for you when it has one), or the header the keyboard last stopped on.
  const [activeGroup, setActiveGroup] = useState<string | null>(null);
  const groupAt = activeGroup === null ? -1 : rows.findIndex((r) => r.kind === 'group' && r.key === activeGroup);
  const at = groupAt >= 0 ? groupAt : rows.findIndex((r) => r.kind === 'session' && r.s.id === selected);
  const depths = rows.map((r) => (r.kind === 'group' ? 0 : 1));
  /** A click or key that selects a session (or none) ends the keyboard's stop on a header. */
  const pick = (id: string | null) => {
    setActiveGroup(null);
    onSelect(id);
  };
  const onKeyDown = useListNav({
    count: rows.length,
    index: at,
    onIndex: (i) => {
      const r = rows[i];
      if (r.kind === 'group') return setActiveGroup(r.key);
      pick(r.s.id);
    },
    onActivate: (i) => {
      const r = rows[i];
      if (r.kind === 'group') onToggle(r.key);
    },
    onDelete: (i) => {
      const r = rows[i];
      if (r.kind === 'session') void window.looper.sessions.close(r.s.id);
    },
    onMenu: (i) => {
      const r = rows[i];
      if (r.kind === 'session') window.looper.sessions.showContextMenu(r.s.id);
    },
    tree: {
      expanded: (i) => {
        const r = rows[i];
        return r.kind === 'group' ? r.open : undefined;
      },
      set: (i, open) => {
        const r = rows[i];
        if (r.kind === 'group' && r.open !== open) onToggle(r.key);
      },
      parent: (i) => parentIndex(depths, i),
    },
    scrollToId: at >= 0 ? rows[at].id : null,
  });
  const kindText = (s: SessionSummary) => (s.kind === 'terminal' ? 'Terminal · ' : s.kind === 'run' ? 'Task run · ' : '');
  return (
    <div
      className="session-list"
      role="tree"
      aria-label="Chats"
      tabIndex={0}
      aria-activedescendant={at >= 0 ? rows[at].id : undefined}
      onKeyDown={onKeyDown}
      onClick={(e) => {
        if (e.target === e.currentTarget) pick(null);
      }}
      // The keyboard's menu request (Shift+F10, the Menu key) lands on the list: it opens the active chat's menu.
      onContextMenu={(e) => listContextMenu(e, at, (i) => {
        const r = rows[i];
        if (r.kind === 'session') window.looper.sessions.showContextMenu(r.s.id);
      })}
    >
      {waiting.length > 0 && (
        <Group id="session-group-w" active={groupAt >= 0 && activeGroup === WAITING_KEY} name="Waiting for you" open={isOpen(WAITING_KEY)} count={waiting.length} onToggle={() => { setActiveGroup(WAITING_KEY); onToggle(WAITING_KEY); }}>
          {waiting.map((s) => (
            <Row
              key={`w-${s.id}`}
              s={s}
              id={`session-w-${s.id}`}
              selected={selected === s.id}
              sub={
                <>
                  {s.waiting!.text} · <WaitedFor since={s.waiting!.since} />
                </>
              }
              live
              onSelect={pick}
              selectOnMenu={selectOnMenu}
            />
          ))}
        </Group>
      )}
      {groups.map((g, gi) => (
        <Group
          key={g.key}
          id={`session-group-${gi}`}
          active={groupAt >= 0 && activeGroup === g.key}
          name={g.name}
          open={isOpen(g.key)}
          count={g.items.length}
          onToggle={() => {
            setActiveGroup(g.key);
            onToggle(g.key);
          }}
        >
          {g.items.map((s) => (
            <Row key={s.id} s={s} id={`session-${s.id}`} selected={selected === s.id} sub={kindText(s) + (s.latest ?? statusText(s))} onSelect={pick} selectOnMenu={selectOnMenu} />
          ))}
        </Group>
      ))}
      {sessions.length === 0 && (
        <div className="empty session-empty" role="treeitem" aria-disabled="true" aria-selected={false}>
          No chats are open.
        </div>
      )}
    </div>
  );
}
