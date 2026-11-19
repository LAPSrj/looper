import type { HTMLAttributes, ReactNode } from 'react';
import type { SessionSummary } from '@shared/sessions';
import { sessionGroupKey, waitingOf } from '@shared/sessions';
import { StatusRing } from './ContextRing';
import { EmptyState } from './EmptyState';
import { GroupHeader } from './GroupHeader';
import { useGroupedTree, type TreeRow } from './GroupedTree';
import { itemWindows } from './ListDetail';
import { WaitedFor } from './Live';
import { contextFraction } from './usage';

/** What the Chats window's list and dashboard say with no session open. */
export const NO_CHATS = 'No chats are open.';

/**
 * Status and context in one icon: the ring fills with the context, the dot says what the agent is doing.
 * Out of its usage limit the dot is red; once the limit has reset it's green and larger, until the user looks.
 */
export function SessionIcon({ s }: { s: SessionSummary }) {
  const state = s.limit?.restored
    ? 'restored'
    : s.limit || s.waiting?.reason === 'error'
      ? 'failed'
      : s.waiting && s.waiting.reason !== 'turn'
        ? 'waiting'
        : s.waiting?.reason === 'turn'
          ? 'done'
          : s.status;
  return <StatusRing state={state} frac={contextFraction(s.context)} size={18} />;
}

/** A session's status as a few words. */
export function statusText(s: SessionSummary): string {
  if (s.status === 'starting') return 'Starting';
  if (s.status === 'working') return 'Working';
  if (s.status === 'ended') return 'Ended';
  return 'Ready';
}

/** What kind of session it is, when it isn't a chat the user started: "Terminal", "Started by …", "Task run"; '' for a chat. */
export function sessionKind(s: SessionSummary): string {
  return s.kind === 'terminal' ? 'Terminal' : s.startedBy !== undefined ? `Started by ${s.startedBy}` : s.kind === 'run' ? 'Task run' : '';
}

/** A phone card's short words for why a session waits; the question itself shows in full below it. */
const WAIT_LABELS: Record<NonNullable<SessionSummary['waiting']>['reason'], string | null> = {
  permission: 'Needs permission',
  notification: 'Waiting for you',
  error: 'Needs a look',
  turn: null,
};

/** Why a session waits and for how long ("Needs permission · 3 min"), or its status. `brief`: the reason's short words. */
export function SessionStatus({ s, brief = false }: { s: SessionSummary; brief?: boolean }) {
  if (!s.waiting) return <>{statusText(s)}</>;
  return (
    <>
      {(brief && WAIT_LABELS[s.waiting.reason]) || s.waiting.text} · <WaitedFor since={s.waiting.since} />
    </>
  );
}

/** A conversation's row in a tree list (Chats, History): its icon, its title, and a second line. */
export function SessionRow({
  selected,
  className = '',
  icon,
  title,
  sub,
  subClass = '',
  subTitle,
  ...rest
}: {
  selected: boolean;
  className?: string;
  icon?: ReactNode;
  title: string;
  sub: ReactNode;
  subClass?: string;
  subTitle?: string;
} & Omit<HTMLAttributes<HTMLDivElement>, 'title'>) {
  return (
    <div {...rest} role="treeitem" aria-level={2} aria-selected={selected} className={`session-row${selected ? ' selected' : ''}${className}`}>
      {icon}
      <div className="session-row-text">
        <div className="session-title" title={title}>
          {title}
        </div>
        <div className={`session-sub${subClass}`} title={subTitle}>
          {sub}
        </div>
      </div>
    </div>
  );
}

/** The key a group's collapsed state is saved under. */
const WAITING_KEY = '@waiting';

interface SessionGroup {
  key: string;
  name: string;
  count: number;
}

type GroupRow = Extract<TreeRow<SessionGroup, SessionSummary>, { kind: 'group' }>;
type ItemRow = Extract<TreeRow<SessionGroup, SessionSummary>, { kind: 'item' }>;

/**
 * The Chats window's list: Waiting for you (with `waitingFirst`), then each
 * project's or folder's sessions, each group closable. Up and Down move
 * through the sessions shown, and a click on the empty space below shows the dashboard.
 * The header and the rows are siblings in each group (the phone's list styles depend on it).
 */
export function SessionList({
  sessions,
  selected,
  collapsed,
  waitingFirst,
  onToggle,
  onSelect,
}: {
  sessions: SessionSummary[];
  selected: string | null;
  /** The closed groups' keys: a project's id, or its name without one. */
  collapsed: string[];
  /** The sessions waiting for the user show again at the top, in Waiting for you. */
  waitingFirst: boolean;
  onToggle: (key: string) => void;
  onSelect: (id: string | null) => void;
}) {
  const isOpen = (key: string) => !collapsed.includes(key);
  const sections: { head: GroupRow; items: ItemRow[]; waiting: boolean }[] = [];
  const section = (g: SessionGroup, id: string, items: SessionSummary[], itemId: (s: SessionSummary) => string, waiting = false) => {
    const head: GroupRow = { kind: 'group', key: g.key, id, depth: 0, open: isOpen(g.key), group: g };
    sections.push({ head, waiting, items: head.open ? items.map((s) => ({ kind: 'item', key: s.id, id: itemId(s), depth: 1, item: s })) : [] });
  };
  const waiting = waitingFirst ? waitingOf(sessions) : [];
  if (waiting.length > 0) section({ key: WAITING_KEY, name: 'Waiting for you', count: waiting.length }, 'session-group-w', waiting, (s) => `session-w-${s.id}`, true);
  const groups: { key: string; name: string; items: SessionSummary[] }[] = [];
  for (const s of sessions) {
    const key = sessionGroupKey(s);
    const last = groups[groups.length - 1];
    if (last?.key === key) last.items.push(s);
    else groups.push({ key, name: s.groupName, items: [s] });
  }
  groups.forEach((g, gi) => section({ key: g.key, name: g.name, count: g.items.length }, `session-group-${gi}`, g.items, (s) => `session-${s.id}`));

  // A chat or a task run opens in a window of its own; terminal sessions stay in the Chats window.
  const opens = (s: SessionSummary) => itemWindows && s.kind !== 'terminal';
  const t = useGroupedTree<SessionGroup, SessionSummary>({
    rows: sections.flatMap((x) => [x.head, ...x.items]),
    selected,
    onSelect: (s) => onSelect(s.id),
    onDeselect: () => onSelect(null),
    toggle: (g) => onToggle(g.key),
    onOpen: (s) => {
      if (opens(s)) window.looper.openItemWindow('chat', s.id);
    },
    onDelete: (r) => {
      if (r.kind === 'item') void window.looper.sessions.close(r.item.id);
    },
    onRename: (r) => {
      if (r.kind === 'item' && r.item.kind !== 'run') window.looper.sessions.openRename(r.item.id);
    },
    itemMenu: (s) => window.looper.sessions.showContextMenu(s.id),
    // Waiting for you has no menu.
    groupMenu: (g) => {
      if (g.key !== WAITING_KEY) window.looper.sessions.showGroupContextMenu(g.key);
    },
  });

  return (
    <div className="session-list" role="tree" aria-label="Chats" {...t.listProps}>
      {sections.map(({ head, items, waiting: inWaiting }) => (
        <div role="group" aria-label={head.group.name} key={head.key}>
          <GroupHeader {...t.groupProps(head)} name={head.group.name} count={head.group.count} className={`session-group${t.activeGroup === head.key ? ' active' : ''}`} />
          {items.map((r) => {
            const s = r.item;
            const { onDoubleClick, ...props } = t.itemProps(r);
            return (
              <SessionRow
                key={r.id}
                {...props}
                onDoubleClick={opens(s) ? onDoubleClick : undefined}
                selected={r.key === selected}
                className={s.waiting?.reason === 'turn' ? ' unread' : ''}
                icon={<SessionIcon s={s} />}
                title={s.title}
                // The waiting rows count a live time.
                subClass={`${s.waiting?.reason === 'error' ? ' error-text' : ''}${inWaiting ? ' live-only' : ''}`}
                sub={inWaiting ? <SessionStatus s={s} /> : (sessionKind(s) ? `${sessionKind(s)} · ` : '') + (s.latest ?? statusText(s))}
              />
            );
          })}
        </div>
      ))}
      {sessions.length === 0 && (
        <EmptyState at="row" list="tree">
          {NO_CHATS}
        </EmptyState>
      )}
    </div>
  );
}
