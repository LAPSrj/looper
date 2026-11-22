import { useState, type ComponentProps, type HTMLAttributes, type ReactNode } from 'react';
import type { ChatGroup, SessionSummary } from '@shared/sessions';
import { canToggleUnread, isUnread, placeCard, waitingOf, WAITING_GROUP_KEY as WAITING_KEY } from '@shared/sessions';
import { StatusRing } from './ContextRing';
import { EmptyState } from './EmptyState';
import { GroupHeader } from './GroupHeader';
import { useGroupedTree, type TreeRow } from './GroupedTree';
import { itemWindows } from './ListDetail';
import { useLeadingSwipe, type LeadingSwipe } from './phone/PhoneList';
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
  level = 2,
  extra,
  ...rest
}: {
  selected: boolean;
  /** Its depth in the tree: 1 in a list without groups. */
  level?: number;
  className?: string;
  icon?: ReactNode;
  title: string;
  sub: ReactNode;
  subClass?: string;
  subTitle?: string;
  /** Drawn after the text: a phone row's swipe action. */
  extra?: ReactNode;
} & Omit<HTMLAttributes<HTMLDivElement>, 'title'>) {
  return (
    <div {...rest} role="treeitem" aria-level={level} aria-selected={selected} className={`session-row${selected ? ' selected' : ''}${className}`}>
      {icon}
      <div className="session-row-text">
        {/* A title cut off shows whole as a tooltip (clipped-title.ts). */}
        <div className="session-title">
          {title}
        </div>
        <div className={`session-sub${subClass}`} title={subTitle}>
          {sub}
        </div>
      </div>
      {extra}
    </div>
  );
}

/** A phone's swipe to the right on a row: Mark as Unread, or Mark as Read once it's unread (the commands' own rules, canToggleUnread). */
export function unreadSwipe(s: SessionSummary): LeadingSwipe | undefined {
  if (!canToggleUnread(s)) return undefined;
  return isUnread(s) ? { label: 'Read', run: () => window.looper.sessions.seen(s.id) } : { label: 'Unread', run: () => window.looper.sessions.markUnread(s.id) };
}

/** A phone's row with a swipe to the right that shows an action (Mark as Unread). */
function SwipeSessionRow({ swipe, ...row }: { swipe: LeadingSwipe } & ComponentProps<typeof SessionRow>) {
  const sw = useLeadingSwipe(swipe);
  return <SessionRow {...row} {...sw.props} className={row.className + sw.className} extra={sw.action} />;
}


interface SessionGroup {
  key: string;
  name: string;
  count: number;
}

type GroupRow = Extract<TreeRow<SessionGroup, SessionSummary>, { kind: 'group' }>;
type ItemRow = Extract<TreeRow<SessionGroup, SessionSummary>, { kind: 'item' }>;

/** A row dragged in the list, by its session id: its data type, which a message box doesn't take as dropped text. */
const ROW_DRAG_TYPE = 'application/x-looper-chat-row';

/**
 * The Chats window's list: Waiting for you (with `waitingFirst`), then the
 * groups View → Group Chats By makes (`groups`, chatGroups), each closable;
 * Group Chats By None's one group has no header, and with `onReorder` its rows
 * are dragged into another order. Up and Down move through the sessions shown,
 * and a click on the empty space below shows the dashboard. The header and the
 * rows are siblings in each group (the phone's list styles depend on it).
 */
export function SessionList({
  sessions,
  groups,
  selected,
  collapsed,
  waitingFirst,
  onToggle,
  onSelect,
  onReorder,
  onEmptyMenu,
  swipe,
}: {
  sessions: SessionSummary[];
  groups: ChatGroup[];
  selected: string | null;
  /** The closed groups' keys (ChatGroup.key). */
  collapsed: string[];
  /** The sessions waiting for the user show again at the top, in Waiting for you. */
  waitingFirst: boolean;
  onToggle: (key: string) => void;
  onSelect: (id: string | null) => void;
  /** The rows of the group without a header were dragged into this order (session ids). */
  onReorder?: (ids: string[]) => void;
  /** A right-click on the empty space below the rows: the list's View options. */
  onEmptyMenu?: () => void;
  /** A phone's swipe to the right on a row: the action it shows, none for a row without one. */
  swipe?: (s: SessionSummary) => LeadingSwipe | undefined;
}) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; after: boolean } | null>(null);
  const isOpen = (key: string) => !collapsed.includes(key);
  const sections: { head: GroupRow | null; items: ItemRow[]; waiting: boolean; ids: string[] }[] = [];
  const section = (g: SessionGroup, id: string, items: SessionSummary[], itemId: (s: SessionSummary) => string, waiting = false) => {
    // Group Chats By None's group: rows alone, a step out.
    const head: GroupRow | null = g.name ? { kind: 'group', key: g.key, id, depth: 0, open: isOpen(g.key), group: g } : null;
    const open = !head || head.open;
    const rows: ItemRow[] = open ? items.map((s) => ({ kind: 'item', key: s.id, id: itemId(s), depth: head ? 1 : 0, item: s })) : [];
    sections.push({ head, waiting, items: rows, ids: items.map((s) => s.id) });
  };
  const waiting = waitingFirst ? waitingOf(sessions) : [];
  if (waiting.length > 0) section({ key: WAITING_KEY, name: 'Waiting for you', count: waiting.length }, 'session-group-w', waiting, (s) => `session-w-${s.id}`, true);
  groups.forEach((g, gi) => section({ key: g.key, name: g.name, count: g.items.length }, `session-group-${gi}`, g.items, (s) => `session-${s.id}`));
  /** A row's drag, in the group without a header: before or after the row under the pointer, by the half it's in. */
  const dragProps = (ids: string[], id: string): HTMLAttributes<HTMLDivElement> => {
    if (!onReorder) return {};
    const end = () => {
      setDragging(null);
      setDrop(null);
    };
    return {
      draggable: true,
      onDragStart: (e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData(ROW_DRAG_TYPE, id);
        setDragging(id);
      },
      onDragEnd: end,
      onDragOver: (e) => {
        if (!dragging || dragging === id || !e.dataTransfer.types.includes(ROW_DRAG_TYPE)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const r = e.currentTarget.getBoundingClientRect();
        const after = e.clientY > r.top + r.height / 2;
        setDrop((d) => (d?.id === id && d.after === after ? d : { id, after }));
      },
      onDrop: (e) => {
        e.preventDefault();
        if (dragging && drop && drop.id !== dragging) onReorder(placeCard(ids, dragging, drop.id, drop.after));
        end();
      },
    };
  };

  // A chat or a task run opens in a window of its own; terminal sessions stay in the Chats window.
  const opens = (s: SessionSummary) => itemWindows && s.kind !== 'terminal';
  const t = useGroupedTree<SessionGroup, SessionSummary>({
    rows: sections.flatMap((x) => (x.head ? [x.head, ...x.items] : x.items)),
    // Without groups, the keys that open and close them have nothing to do.
    tree: sections.some((x) => x.head),
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
    emptyMenu: onEmptyMenu,
  });

  return (
    <div className="session-list" role="tree" aria-label="Chats" {...t.listProps}>
      {sections.map(({ head, items, waiting: inWaiting, ids }) => {
        const rows = items.map((r) => {
            const s = r.item;
            const { onDoubleClick, ...props } = t.itemProps(r);
            const mark = drop?.id === s.id ? (drop.after ? ' drop-after' : ' drop-before') : '';
            const action = swipe?.(s);
            const row: ComponentProps<typeof SessionRow> = {
              ...props,
              ...(head ? {} : dragProps(ids, s.id)),
              level: head ? 2 : 1,
              onDoubleClick: opens(s) ? onDoubleClick : undefined,
              selected: r.key === selected,
              className: (s.waiting ? ' unread' : '') + mark,
              icon: <SessionIcon s={s} />,
              title: s.title,
              // The waiting rows count a live time.
              subClass: `${s.waiting?.reason === 'error' ? ' error-text' : ''}${inWaiting ? ' live-only' : ''}`,
              sub: inWaiting ? <SessionStatus s={s} /> : (sessionKind(s) ? `${sessionKind(s)} · ` : '') + (s.latest ?? statusText(s)),
            };
            return action ? <SwipeSessionRow key={r.id} swipe={action} {...row} /> : <SessionRow key={r.id} {...row} />;
          });
        if (!head) return rows;
        return (
          <div role="group" aria-label={head.group.name} key={head.key}>
            <GroupHeader {...t.groupProps(head)} name={head.group.name} count={head.group.count} className={`session-group${t.activeGroup === head.key ? ' active' : ''}`} />
            {rows}
          </div>
        );
      })}
      {sessions.length === 0 && (
        <EmptyState at="row" list="tree">
          {NO_CHATS}
        </EmptyState>
      )}
    </div>
  );
}
