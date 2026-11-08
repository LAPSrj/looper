import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import {
  autoRowHeight,
  columnTracks,
  columnWidths,
  gapBars,
  placeCards,
  resetSize,
  rowCount,
  rowHeights,
  sizeColumn,
  sizeRow,
  type GapBar,
} from '@shared/card-grid';
import { CHAT_WINDOW_VIEWS, CHATS_WINDOW_VIEWS } from '@shared/commands/build';
import type { CommandContext } from '@shared/commands/context';
import { contextText, type ChatState } from '@shared/chat';
import type { SessionSummary, UsageLimits } from '@shared/sessions';
import { tabStatus } from '@shared/workflows';
import { canStop, dashboardOrder, liveCards, showsConversation, waitedText } from '@shared/sessions';
import type { EngineEvent } from '@shared/types';
import { ActivityPanel, type ActivityTab } from './components/ActivityPanel';
import { fmtClock } from './format';
import { WaitedFor } from './components/Live';
import { MINUTE, useNow } from './useNow';
import { ICONS } from './components/icons';
import { ToolButton } from './components/ToolButton';
import { Toolbar } from './components/Toolbar';
import { commandToolbar, phoneNav } from './components/command-surfaces';
import { useCommandMenu, useCommandState } from './components/useCommands';
import { ChatView, PermissionButtons } from './components/ChatView';
import { sendsOnEnter } from './components/composer-text';
import { useDragResize } from './components/hooks';
import { Inspector, useInspector } from './components/Inspector';
import { ListDetail } from './components/ListDetail';
import { MessageBox, type MessageBoxStop } from './components/MessageBox';
import { RunGuidance, SubagentConversation, TranscriptView } from './components/Transcript';
import { useAutoGrow } from './components/phone/auto-grow';
import { OverviewSwitch, type OverviewChoice } from './components/phone/OverviewSwitch';
import { Group, LargeTitle, Row } from './components/phone/PhoneList';
import { PhoneSheet } from './components/phone/PhoneSheet';
import { ReorderSheet } from './components/phone/ReorderSheet';
import { useSplit } from './components/phone/PhoneSplit';
import { TerminalOverlay } from './components/phone/TerminalOverlay';
import { UsagePanel } from './components/phone/UsagePanel';
import { SessionIcon, SessionList, statusText } from './components/SessionList';
import { groupStatusText, subagentTabs } from './components/subagents';
import { SubagentIcon } from './components/SubagentIcon';
import { contextFraction, limitFacts, sessionLimits, usageLabel } from './components/usage';
import { TerminalView } from './components/TerminalView';
import { Tabs, type TabItem } from './components/Tabs';
import { PhoneWorkflow, WorkflowAgentBack, WorkflowOverview } from './components/WorkflowView';
import { platform } from './platform';
import { terminalTitle } from './phone-lists';
import { subscribe } from './events';
import { useSessionsWindow, type SessionsWindow } from './useSessionsWindow';
import { isPhone } from './web/page-nav';
import type { PageNavAction } from './web/nav-bar-model';
import { NavBar } from './components/NavBar';

/** Where the panes' widths are saved: the Chats window's, and a single chat's window's apart. */
const WIDTHS_KEY = 'sessions.widths';
const WINDOW_WIDTHS_KEY = 'sessions.window.widths';

/** When the agent last replied and whether its prompt cache still lasts. */
function replyParts(s: SessionSummary | undefined, now: number): string[] {
  if (!s?.lastReplyAt) return [];
  const parts = [`Last reply ${fmtClock(s.lastReplyAt, now)}`];
  if (s.cacheUntil !== undefined) {
    const left = s.cacheUntil - now;
    parts.push(left <= 0 ? 'Cache expired' : left < 60_000 ? 'Cached for less than a minute' : `Cached for ${waitedText(left)}`);
  }
  return parts;
}

const limitParts = (limits: UsageLimits, now: number): string[] => limitFacts(limits, now).map((f) => `${f.label} ${f.value}`);

/**
 * The window's bottom line: the session's harness and its context, then the usage limits of the account its harness runs on.
 * `children` follow at the end (the main window's own, on its Chats tab).
 */
export function SessionsStatusBar({ summary, chat, limits, children }: { summary?: SessionSummary; chat: ChatState | null; limits: UsageLimits; children?: React.ReactNode }) {
  // Every time on it counts minutes.
  const now = useNow(MINUTE);
  const left = chat ? [chat.harnessName] : summary ? [summary.harnessName] : [];
  const context = chat?.context ?? summary?.context;
  return (
    <div className="statusbar">
      {left.map((p) => (
        <span key={p}>{p}</span>
      ))}
      {context && <span>{contextText(context)}</span>}
      {replyParts(summary, now).map((p) => (
        <span key={p} className={p.startsWith('Cache') ? 'live-only' : undefined}>
          {p}
        </span>
      ))}
      <span className="spacer" />
      {limitParts(limits, now).map((p) => (
        <span key={p}>{p}</span>
      ))}
      {children}
    </div>
  );
}

/** A phone card's meta line names why a session waits; the question itself is shown in full below it. */
const WAIT_LABELS: Record<NonNullable<SessionSummary['waiting']>['reason'], string | null> = {
  permission: 'Needs permission',
  notification: 'Waiting for you',
  error: 'Needs a look',
  turn: null,
};

/** What a waiting or working session is about, in a line. */
function CardStatus({ s }: { s: SessionSummary }) {
  if (s.waiting) {
    return (
      <>
        {(isPhone && WAIT_LABELS[s.waiting.reason]) || s.waiting.text} · <WaitedFor since={s.waiting.since} />
      </>
    );
  }
  return <>{statusText(s)}</>;
}

/**
 * A card's messages. The desktop shows those since the user's last one, scrolled
 * to the newest. A phone shows the question a waiting session asks in full, then the
 * agent's last message as whole lines, at most four, with an ellipsis after them.
 */
function CardMessages({ s, big }: { s: SessionSummary; big?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const key = s.recent?.join('\n') ?? s.latest ?? '';
  useLayoutEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [key]);
  if (isPhone) {
    // Cards don't scroll inside on a phone or tablet (Material: Cards), so Double Size shows more of the chat in place.
    const shown = big && s.recent?.length ? s.recent : [s.recent?.length ? s.recent[s.recent.length - 1] : s.latest].filter(Boolean);
    const question = s.waiting && s.waiting.reason !== 'turn' ? s.waiting.text : null;
    return (
      <div className="overview-messages">
        {question && <div className="overview-question">{question}</div>}
        {shown.map((m, i) => (
          <div key={i} className="overview-msg overview-last">
            {m}
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="overview-messages" ref={ref}>
      {s.recent?.length ? (
        s.recent.map((m, i) => (
          <div key={i} className="overview-msg">
            {m}
          </div>
        ))
      ) : s.latest ? (
        <div className="overview-msg muted">{s.latest}</div>
      ) : null}
    </div>
  );
}

/** A desktop dashboard card's size: twice the normal one, or back; `area` is where it goes in the dashboard's grid. */
interface CardSize {
  big: boolean;
  onToggle: () => void;
  area: React.CSSProperties;
}

/** A desktop dashboard card dragged by its title to another place; `mark` shows where a dragged card would go. */
interface CardDrag {
  start: (e: React.DragEvent<HTMLElement>) => void;
  end: () => void;
  mark: string;
}

/** A card's title: the session's state and name (and the Double Size button on the desktop), then where it runs and what it's doing. */
function CardTitle({ s, size, drag }: { s: SessionSummary; size?: CardSize; drag?: CardDrag }) {
  return (
    <>
      <div className="overview-head" draggable={!!drag} onDragStart={drag?.start} onDragEnd={drag?.end}>
        <SessionIcon s={s} />
        <span className="overview-title">{s.title}</span>
        {size && (
          <span className="toolbar overview-tools" onClick={(e) => e.stopPropagation()}>
            <ToolButton
              icon={size.big ? ICONS.normalSize : ICONS.doubleSize}
              title={size.big ? 'Normal Size' : 'Double Size'}
              enabled
              onClick={size.onToggle}
            />
          </span>
        )}
      </div>
      <div className="muted overview-meta">
        {s.groupName} · {s.harnessName}
        {s.kind === 'terminal' ? ' · Terminal' : s.kind === 'run' ? ' · Task run' : ''} · <span className={s.waiting ? 'warn live-only' : ''}><CardStatus s={s} /></span>
      </div>
    </>
  );
}

const backgroundText = (n: number) => (n === 1 ? '1 running in the background' : `${n} running in the background`);

const cardClass = (s: SessionSummary, extra = '') =>
  `overview-card${extra}${s.waiting && s.waiting.reason !== 'turn' ? ' waiting' : ''}`;

const fail = (e: Error) => void window.looper.showError(e.message);

/** A session's Stop beside its message box, by the toolbar's rule. */
const stopOf = (s: SessionSummary): MessageBoxStop => ({ enabled: canStop(s), run: () => void window.looper.sessions.stop(s.id).catch(fail) });

/**
 * One session on the dashboard as a summary: its state, the agent's messages since the
 * user's last one, and Allow/Deny or a reply box at the bottom: on the desktop a chat's
 * message box, Send above Stop. A terminal session's card on the desktop, and every
 * card on a phone.
 */
export function DashboardCard({ s, onOpen, size, drag }: { s: SessionSummary; onOpen: (id: string) => void; size?: CardSize; drag?: CardDrag }) {
  const [reply, setReply] = useState('');
  const replyBox = useRef<HTMLTextAreaElement>(null);
  useAutoGrow(replyBox, reply, 120, isPhone);
  const run = s.kind === 'run';
  const send = () => {
    const text = reply.trim();
    if (!text) return;
    // A task run's agent takes the reply as guidance, the answer to its question while it asks one.
    if (run) void sendRunGuidance(s, text).then(() => setReply(''), fail);
    else {
      window.looper.sessions.send([s.id], reply);
      setReply('');
    }
  };
  const placeholder = run ? (s.question !== undefined ? 'Answer' : 'Guidance') : 'Reply';
  const keep = (e: React.MouseEvent) => e.stopPropagation();
  let bottom: React.ReactNode = null;
  if (s.permissionId) {
    bottom = (
      <div className="overview-actions" onClick={keep}>
        <PermissionButtons chatId={s.id} permissionId={s.permissionId} />
      </div>
    );
  } else if (s.status !== 'ended' && isPhone) {
    // On a phone Enter is a line break; Send, or Ctrl+Enter from a hardware keyboard, sends.
    bottom = (
      <div className="overview-actions" onClick={keep}>
        <textarea
          ref={replyBox}
          rows={1}
          value={reply}
          placeholder={placeholder}
          onChange={(e) => setReply(e.target.value)}
          onKeyDown={(e) => {
            if (sendsOnEnter(e, true)) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button className="btn small" disabled={!reply.trim()} onClick={send}>
          Send
        </button>
      </div>
    );
  } else if (s.status !== 'ended') {
    bottom = (
      <div className="overview-composer" onClick={keep}>
        <MessageBox text={reply} onText={setReply} placeholder={placeholder} canSend={!!reply.trim()} onSend={send} stop={stopOf(s)} />
      </div>
    );
  }
  return (
    <div
      data-id={s.id}
      className={cardClass(s, isPhone ? '' : ' overview-reply') + (drag?.mark ?? '') + (size?.big ? ' big' : '')}
      style={size?.area}
      onClick={() => onOpen(s.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        window.looper.sessions.showContextMenu(s.id, !!size);
      }}
    >
      <CardTitle s={s} size={size} drag={drag} />
      <CardMessages s={s} big={size?.big} />
      {s.background > 0 && <div className="muted">{backgroundText(s.background)}</div>}
      {bottom}
    </div>
  );
}

/** The Overview on a phone: a summary card per session, in the desktop dashboard's order. */
export function PhoneOverview({
  sessions,
  shown,
  setShown,
  onOpen,
  reordering,
  onReordered,
}: {
  sessions: SessionSummary[];
  shown: SessionsWindow['shown'];
  setShown: (patch: Partial<SessionsWindow['shown']>) => void;
  onOpen: (id: string) => void;
  /** The bar's Reorder was picked: the cards' sheet shows, until it closes. */
  reordering: boolean;
  onReordered: () => void;
}) {
  if (sessions.length === 0) return <div className="empty">No chats are open.</div>;
  const big = shown.bigCards;
  const toggleBig = (id: string) => {
    const others = big.filter((x) => x !== id && sessions.some((c) => c.id === x));
    setShown({ bigCards: big.includes(id) ? others : [...others, id] });
  };
  return (
    <>
      <div className="sessions-overview">
        {dashboardOrder(sessions, shown.cardOrder, shown.waitingFirst).map((x) => (
          <DashboardCard key={x.id} s={x} onOpen={onOpen} size={{ big: big.includes(x.id), onToggle: () => toggleBig(x.id), area: {} }} />
        ))}
      </div>
      {reordering && (
        <ReorderSheet
          title="Reorder Cards"
          sections={[{ key: 'cards', items: dashboardOrder(sessions, shown.cardOrder, false).map((x) => ({ key: x.id, title: x.title, sub: x.groupName })) }]}
          onReorder={(_section, keys) => setShown({ cardOrder: keys })}
          onClose={onReordered}
        />
      )}
    </>
  );
}

type TrackCard = (id: string) => (el: HTMLElement | null) => void;

/**
 * The cards within a screen's height of the dashboard's view, by session id: only
 * those show their chat. `track(id)` is the ref that has a card watched.
 */
function useCardsInView(root: HTMLElement | null): [ReadonlySet<string>, TrackCard] {
  const [inView, setInView] = useState<ReadonlySet<string>>(() => new Set());
  const els = useRef(new Map<string, HTMLElement>());
  const refs = useRef(new Map<string, (el: HTMLElement | null) => void>());
  const observer = useRef<IntersectionObserver | null>(null);
  useLayoutEffect(() => {
    if (!root) return;
    const io = new IntersectionObserver(
      (entries) =>
        setInView((prev) => {
          const next = new Set(prev);
          for (const e of entries) {
            const id = (e.target as HTMLElement).dataset.id;
            if (id && e.isIntersecting) next.add(id);
            else if (id) next.delete(id);
          }
          return next.size === prev.size && [...next].every((id) => prev.has(id)) ? prev : next;
        }),
      { root, rootMargin: '100% 0px' },
    );
    observer.current = io;
    for (const el of els.current.values()) io.observe(el);
    return () => {
      io.disconnect();
      observer.current = null;
    };
  }, [root]);
  // One ref per card, so a card isn't unobserved and observed again on every render.
  const track: TrackCard = (id) => {
    let ref = refs.current.get(id);
    if (!ref) {
      ref = (el) => {
        const old = els.current.get(id);
        if (old) observer.current?.unobserve(old);
        els.current.delete(id);
        if (el) {
          els.current.set(id, el);
          observer.current?.observe(el);
          return;
        }
        refs.current.delete(id);
        setInView((prev) => {
          if (!prev.has(id)) return prev;
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      };
      refs.current.set(id, ref);
    }
    return ref;
  };
  return [inView, track];
}

/**
 * A card's conversation while it's in view: read once (`read`), then kept current by
 * its own events only (`of` picks them). `read` and `of` are module constants.
 */
function useCardFeed<T>(id: string, live: boolean, read: (id: string) => Promise<T | null>, of: (e: EngineEvent, id: string) => T | undefined): T | null {
  const [value, setValue] = useState<T | null>(null);
  useEffect(() => {
    setValue(null);
    if (!live) return;
    let current = true;
    const unsub = subscribe((e) => {
      const v = of(e, id);
      if (v) setValue(() => v);
    });
    // An event that came first is newer than what was read.
    void read(id).then((v) => {
      if (current && v) setValue((prev) => prev ?? v);
    });
    return () => {
      current = false;
      unsub();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, live]);
  return live ? value : null;
}

const readChat = (id: string) => window.looper.chat.get(id);
const chatEvent = (e: EngineEvent, id: string) => (e.type === 'chat' && e.state.id === id ? e.state : undefined);
/** A task run's conversation comes with its activity, as for the run the Chats tab shows. */
const readActivity = (id: string) => window.looper.sessions.activity(id);
const activityEvent = (e: EngineEvent, id: string) => (e.type === 'session:activity' && e.activity.id === id ? e.activity : undefined);

/**
 * A chat or task run on the desktop dashboard: its title bar (a click opens it, a
 * right-click its menu), then the conversation itself, as in the window's middle
 * without the activity pane: a chat with its message box, a task run with its
 * guidance box. Out of view, the card shows the agent's latest messages instead.
 */
function LiveCard({
  s,
  live,
  size,
  drag,
  track,
  onOpen,
}: {
  s: SessionSummary;
  live: boolean;
  size: CardSize;
  drag: CardDrag;
  track: TrackCard;
  onOpen: (id: string) => void;
}) {
  const chat = useCardFeed(s.id, live && s.kind === 'chat', readChat, chatEvent);
  const activity = useCardFeed(s.id, live && s.kind === 'run', readActivity, activityEvent);
  // The card's title changes with every status and minute; the conversation only with its own events.
  const chatView = useMemo(() => chat && <ChatView state={chat} embedded />, [chat]);
  const question = s.question ?? null;
  const recheck = `${s.status}\n${s.latest ?? ''}`;
  const stoppable = canStop(s);
  const runView = useMemo(
    () =>
      activity && (
        <TranscriptView
          taskId={s.taskId}
          runId={s.id}
          rows={activity.rows ?? []}
          pendingGuidance={activity.pendingGuidance}
          waitingText="Waiting for the agent's first message…"
          footer={<RunGuidance taskId={s.taskId} runId={s.id} question={question} recheck={recheck} stop={stopOf(s)} />}
        />
      ),
    // stopOf(s) reads only the id and `stoppable`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activity, s.taskId, s.id, question, recheck, stoppable],
  );
  const view = chatView ?? runView;
  // Working in a card is looking at it: a finished turn or a notification stops waiting,
  // when the focus comes into the card and when one comes while it's there.
  const cardRef = useRef<HTMLDivElement | null>(null);
  const seen = () => {
    if (s.waiting && s.waiting.reason !== 'permission') window.looper.sessions.seen(s.id);
  };
  const waitKey = s.waiting ? `${s.waiting.reason}:${s.waiting.since}` : '';
  useEffect(() => {
    if (document.hasFocus() && cardRef.current?.contains(document.activeElement)) seen();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waitKey]);
  // Stable, as track's refs are, so the card isn't watched afresh on every render.
  const trackRef = track(s.id);
  const ref = useCallback(
    (el: HTMLDivElement | null) => {
      cardRef.current = el;
      trackRef(el);
    },
    [trackRef],
  );
  return (
    <div
      ref={ref}
      data-id={s.id}
      className={cardClass(s, ' overview-chat') + drag.mark}
      style={size.area}
      onFocus={seen}
    >
      <div
        className="overview-bar"
        onClick={() => onOpen(s.id)}
        onContextMenu={(e) => {
          e.preventDefault();
          window.looper.sessions.showContextMenu(s.id, true);
        }}
      >
        <CardTitle s={s} size={size} drag={drag} />
        {s.background > 0 && <div className="muted overview-meta">{backgroundText(s.background)}</div>}
      </div>
      {view ?? <CardMessages s={s} />}
    </div>
  );
}

/** A dragged dashboard card's data type: its session id, which a message box doesn't take as dropped text. */
const CARD_DRAG_TYPE = 'application/x-looper-card';

/** An element's content box (inside its padding), kept current. */
function useContentSize(el: HTMLElement | null): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    if (!el) return;
    const measure = () => {
      const cs = getComputedStyle(el);
      const width = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const height = el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      setSize((s) => (s.width === width && s.height === height ? s : { width, height }));
    };
    // Measured before the first paint, so the cards don't show in one column first.
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return size;
}

/** The dashboard's column widths and row heights in pixels, from the first (0: automatic). */
interface GridSizes {
  columns: number[];
  rows: number[];
}

/**
 * The dashboard's gaps dragged to size its columns and rows: `sizes` are the
 * saved ones, or the dragged ones while a gap is dragged (saved with the
 * window's View settings when the mouse is released). `start` is a gap's
 * mouse-down, `reset` its double-click, which makes its column or row automatic.
 */
function useGapResize(s: SessionsWindow, rootRef: RefObject<HTMLDivElement | null>) {
  const saved: GridSizes = { columns: s.shown.cardColumns, rows: s.shown.cardRows };
  const [draft, setDraft] = useState<GridSizes | null>(null);
  const draftRef = useRef<GridSizes | null>(null);
  // Kept until the settings come back with it, so the dragged sizes don't flick back meanwhile.
  const savedKey = `${saved.columns.join()}/${saved.rows.join()}`;
  useEffect(() => {
    draftRef.current = null;
    setDraft(null);
  }, [savedKey]);
  const drag = useRef<{ bar: GapBar; start: number; size: number; shown: number[]; room: number; moved: boolean } | null>(null);
  const [active, setActive] = useState<GapBar | null>(null);
  const onDrag = (pos: number) => {
    const d = drag.current;
    const el = rootRef.current;
    if (!d || !el) return;
    const size = d.size + (d.bar.axis === 'x' ? pos : pos + el.scrollTop) - d.start;
    const cur = draftRef.current ?? saved;
    const next =
      d.bar.axis === 'x'
        ? { ...cur, columns: sizeColumn(cur.columns, d.shown, d.bar.index, Math.min(size, d.room)) }
        : { ...cur, rows: sizeRow(cur.rows, d.bar.index, size) };
    d.moved = true;
    draftRef.current = next;
    setDraft(next);
  };
  const onEnd = () => {
    const moved = drag.current?.moved;
    drag.current = null;
    setActive(null);
    const d = draftRef.current;
    if (moved && d) s.setShown({ cardColumns: d.columns, cardRows: d.rows });
  };
  const dragX = useDragResize({ axis: 'x', containerRef: rootRef, onDrag, onEnd });
  const dragY = useDragResize({ axis: 'y', containerRef: rootRef, onDrag, onEnd });
  const sizes = draft ?? saved;
  /** A gap's mouse-down: `widths` and `heights` are the columns' and rows' as shown, `width` the dashboard's. */
  const start = (e: React.MouseEvent, bar: GapBar, widths: number[], heights: number[], width: number) => {
    const el = rootRef.current;
    if (e.button !== 0 || !el) return;
    const r = el.getBoundingClientRect();
    const x = bar.axis === 'x';
    const size = x ? widths[bar.index] : heights[bar.index];
    // A column is at most as wide as the room from its left edge to the dashboard's right one.
    drag.current = { bar, start: x ? e.clientX - r.left : e.clientY - r.top + el.scrollTop, size, shown: widths, room: width - (bar.at - size), moved: false };
    setActive(bar);
    (x ? dragX : dragY)(e);
  };
  const reset = (bar: GapBar) =>
    s.setShown(bar.axis === 'x' ? { cardColumns: resetSize(sizes.columns, bar.index) } : { cardRows: resetSize(sizes.rows, bar.index) });
  return { sizes, active, start, reset };
}

/**
 * The Chats window's dashboard: a card per session in the order the cards
 * were dragged to (the list's for the others), so cards don't move while you
 * work in them, unless Waiting Chats First puts the waiting ones first. Each
 * chat is a working chat and each task run its conversation with its guidance
 * box; terminal sessions are summaries. Any card can be twice its size. The
 * gaps between the cards are dragged to size the columns and rows.
 */
function ChatsDashboard({ s }: { s: SessionsWindow }) {
  const { sessions } = s.state;
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const setRoots = useCallback((el: HTMLDivElement | null) => {
    rootRef.current = el;
    setRoot(el);
  }, []);
  const [inView, track] = useCardsInView(root);
  const box = useContentSize(root);
  const grid = useGapResize(s, rootRef);
  const [dragging, setDragging] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; after: boolean } | null>(null);
  const live = liveCards(sessions, inView);
  const liveKey = live.join('\n');
  // A layout effect, so the window takes the chats' and runs' events before the cards read them.
  useLayoutEffect(() => window.looper.sessions.showCards(live), [liveKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => () => window.looper.sessions.showCards([]), []);
  if (sessions.length === 0) return <div className="empty">No chats are open.</div>;
  const big = s.shown.bigCards;
  const cards = dashboardOrder(sessions, s.shown.cardOrder, s.shown.waitingFirst);
  const widths = columnWidths(grid.sizes.columns, box.width);
  const places = placeCards(cards.map((x) => big.includes(x.id)), widths.length);
  const heights = rowHeights(grid.sizes.rows, rowCount(places), autoRowHeight(box.height));
  const bars = gapBars(places, widths, heights);
  const endDrag = () => {
    setDragging(null);
    setDrop(null);
  };
  const dragOf = (id: string): CardDrag => ({
    start: (e) => {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData(CARD_DRAG_TYPE, id);
      const card = e.currentTarget.closest('.overview-card');
      if (card) {
        const r = card.getBoundingClientRect();
        e.dataTransfer.setDragImage(card, e.clientX - r.left, e.clientY - r.top);
      }
      // After the drag has started: Chromium drops a drag whose element changes in dragstart.
      setTimeout(() => setDragging(id));
    },
    end: endDrag,
    mark: drop?.id === id ? (drop.after ? ' drop-after' : ' drop-before') : dragging === id ? ' dragging' : '',
  });
  return (
    <div
      className="sessions-overview sessions-dashboard"
      ref={setRoots}
      style={{ gridTemplateColumns: columnTracks(grid.sizes.columns, box.width), gridTemplateRows: heights.map((h) => `${h}px`).join(' ') }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(CARD_DRAG_TYPE)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        // Before or after the card under the pointer, by the half it's in.
        const card = (e.target as HTMLElement).closest<HTMLElement>('.overview-card');
        const id = card?.dataset.id;
        if (!card || !id || id === dragging) {
          setDrop(null);
          return;
        }
        const r = card.getBoundingClientRect();
        const after = e.clientX > r.left + r.width / 2;
        setDrop((d) => (d?.id === id && d.after === after ? d : { id, after }));
      }}
      onDrop={(e) => {
        const id = e.dataTransfer.getData(CARD_DRAG_TYPE);
        if (!id) return;
        e.preventDefault();
        if (drop && drop.id !== id) s.moveCard(id, drop.id, drop.after);
        endDrag();
      }}
    >
      {cards.map((x, i) => {
        const p = places[i];
        const area = { gridColumn: `${p.col + 1} / span ${p.cols}`, gridRow: `${p.row + 1} / span ${p.rows}` };
        const size = { big: big.includes(x.id), onToggle: () => s.toggleBig(x.id), area };
        return showsConversation(x) ? (
          <LiveCard key={x.id} s={x} live={inView.has(x.id)} size={size} drag={dragOf(x.id)} track={track} onOpen={s.setSelected} />
        ) : (
          <DashboardCard key={x.id} s={x} size={size} drag={dragOf(x.id)} onOpen={s.setSelected} />
        );
      })}
      {bars.map((bar) => (
        <div
          key={`${bar.axis}${bar.index}:${bar.from}`}
          className={`card-gap ${bar.axis}${grid.active?.axis === bar.axis && grid.active.index === bar.index ? ' active' : ''}`}
          style={bar.axis === 'x' ? { left: bar.at, top: bar.from, height: bar.length } : { top: bar.at, left: bar.from, width: bar.length }}
          onMouseDown={(e) => grid.start(e, bar, widths, heights, box.width)}
          onDoubleClick={() => grid.reset(bar)}
        />
      ))}
    </div>
  );
}

/**
 * The conversation's tabs once the agent has started subagents or workflows:
 * the main conversation, then a tab for each running subagent and the open one
 * (running first), then one per workflow run. The open finished subagent's tab
 * has a close button; the rest are in the Activity pane's Subagents list.
 */
function SubagentTabs({ s }: { s: SessionsWindow }) {
  const { workflows, follow } = s;
  const subagents = subagentTabs(s.subagents, follow);
  const openRun = s.workflow?.run.runId ?? null;
  const active = openRun ? `run:${openRun}` : follow ? `agent:${follow}` : 'conversation';
  const tabs: TabItem[] = [
    { id: 'conversation', label: 'Conversation', dividerAfter: true },
    ...subagents.map((a) => ({
      id: `agent:${a.agentId}`,
      label: a.description || a.type,
      title: `${a.description || a.type} (${a.type})`,
      status: a.status,
      mark: <SubagentIcon a={a} />,
      onClose: follow === a.agentId && a.status !== 'running' ? () => s.setFollow(null) : undefined,
    })),
    ...workflows.map((run) => ({ id: `run:${run.runId}`, label: run.name, title: `${run.name} (workflow)`, status: tabStatus(run.status) })),
  ];
  const select = (id: string) => {
    if (id === 'conversation') s.setFollow(null);
    else if (id.startsWith('agent:')) s.setFollow(id.slice('agent:'.length));
    else s.showWorkflow(id.slice('run:'.length));
  };
  return <Tabs tabs={tabs} active={active} onSelect={select} label="Conversation and agents" className="subagent-tabs" ctrlTab />;
}

/** The conversation's tab strip, once there's more than the conversation to show. */
const hasTabs = (s: SessionsWindow): boolean => subagentTabs(s.subagents, s.follow).length + s.workflows.length > 0;

/** Send guidance to a task run's agent, which it gets mid-run; rejects with the reason it can't take it. */
const sendRunGuidance = (s: SessionSummary, text: string): Promise<void> => window.looper.sendGuidance(s.taskId, s.id, text);

/** The Chats window's toolbar; a single chat's window has only its conversation's buttons. */
function SessionsToolbar({ c, single }: { c: CommandContext; single: boolean }) {
  return <Toolbar groups={commandToolbar(single ? ['conversation'] : ['new', 'chats', 'conversation'], c)} className="sessions-toolbar" />;
}

/**
 * The Chats window: every chat and Looper terminal session (and, with Show
 * Task Runs on, each task run's agent), grouped by project or folder, with the
 * ones waiting for the user first (View → Waiting Chats First); the selected one in the middle; and what its
 * agent is doing on the right. `single`: a single chat's window (Open in New
 * Window), the chat panel alone, its activity pane hidden unless the View menu shows it.
 */
export function SessionsApp({ initial, single = false }: { initial?: string; single?: boolean }) {
  const s = useSessionsWindow(initial, single);
  if (isPhone) return <PhoneSessions s={s} single={single} opened={!!initial} />;
  return <DesktopSessions s={s} single={single} />;
}

/**
 * The session shown: its chat, terminal, task run, followed subagent or open
 * workflow; the Overview when none is. A workflow shows its own tabs (its
 * Overview, then one per agent); on a phone its Overview and each agent's
 * conversation are pages of their own instead.
 */
function SessionCenter({ s }: { s: SessionsWindow }) {
  const { summary, follow, followed, chat, workflow } = s;
  // A conversation on its way (a new or compacted chat) isn't listed for a moment: the dashboard would flash up meanwhile.
  if (!summary) return s.single || s.selected ? <div className="empty">Loading…</div> : <ChatsDashboard s={s} />;
  if (workflow) {
    const { run, agent } = workflow;
    const openAgent = (id: string | null) => s.showWorkflow(run.runId, id);
    const props = { run, taskId: summary.taskId, sessionId: summary.id, onAgent: openAgent };
    const agentView = agent && <TranscriptView key={agent.agentId} taskId={summary.taskId} runId={summary.id} rows={s.subRows} waitingText="Waiting for the agent's first message…" />;
    if (isPhone) return agentView || <PhoneWorkflow {...props} />;
    return (
      <div className="workflow-view">
        {agentView ? (
          <>
            <WorkflowAgentBack run={run} agent={agent} onBack={() => openAgent(null)} />
            {agentView}
          </>
        ) : (
          <WorkflowOverview {...props} />
        )}
      </div>
    );
  }
  if (follow && followed) {
    // A chat on Claude Code that hasn't ended takes messages for its running subagents.
    if (summary.kind === 'chat' && chat?.harnessKind === 'claude-code' && chat.status !== 'ended') {
      return <SubagentConversation key={followed.agentId} taskId={summary.taskId} runId={summary.id} rows={s.subRows} chat={chat} agent={followed} />;
    }
    return <TranscriptView taskId={summary.taskId} runId={summary.id} rows={s.subRows} waitingText="Waiting for the subagent's first message…" />;
  }
  if (summary.kind === 'terminal') return <TerminalView key={summary.id} id={summary.id} />;
  if (summary.kind === 'run') {
    return (
      <TranscriptView
        key={summary.id}
        taskId={summary.taskId}
        runId={summary.id}
        rows={s.activity?.rows ?? []}
        pendingGuidance={s.activity?.pendingGuidance}
        waitingText="Waiting for the agent's first message…"
        footer={
          <RunGuidance taskId={summary.taskId} runId={summary.id} question={summary.question ?? null} recheck={`${summary.status}\n${summary.latest ?? ''}`} stop={stopOf(summary)} />
        }
      />
    );
  }
  return chat ? <ChatView key={chat.id} state={chat} /> : <div className="empty">Loading…</div>;
}

function DesktopSessions({ s, single }: { s: SessionsWindow; single: boolean }) {
  const { state, summary, chat, shown } = s;
  const commandState = useCommandState();
  const commands: CommandContext = { ...commandState, chats: s.chatsContext() };
  useCommandMenu(single ? CHAT_WINDOW_VIEWS : CHATS_WINDOW_VIEWS, commands);
  return (
    <div className="sessions-app">
      {(single ? shown.windowToolbar : shown.toolbar) && <SessionsToolbar c={commands} single={single} />}
      <SessionsBody s={s} single={single} />
      {(single ? shown.windowStatusBar : shown.statusBar) && <SessionsStatusBar summary={summary} chat={chat} limits={sessionLimits(state, summary)} />}
    </div>
  );
}

/**
 * The Chats window's panes, as in the main window's Chats tab: the session
 * list, the session shown, and its activity pane. A single chat's window has
 * the session alone, with its activity pane when the View menu shows it.
 */
export function SessionsBody({ s, single = false }: { s: SessionsWindow; single?: boolean }) {
  const { state, selected, summary, activity, shown, subagents } = s;
  const pane = !!summary && (single ? shown.windowActivityPane : shown.activityPane);

  return (
    <ListDetail
      sides={{ storageKey: single ? WINDOW_WIDTHS_KEY : WIDTHS_KEY, left: { initial: 280, min: 200, max: 480 }, right: { initial: 400, min: 280, max: 720 }, minDetail: single ? 0 : 480 }}
      list={
        !single && (
          <SessionList
            sessions={state.sessions}
            selected={selected}
            collapsed={shown.collapsed}
            waitingFirst={shown.waitingFirst}
            onToggle={s.toggleGroup}
            onSelect={s.setSelected}
          />
        )
      }
      detail={
        <main className="sessions-center">
          {summary && hasTabs(s) && <SubagentTabs s={s} />}
          <SessionCenter s={s} />
        </main>
      }
      inspectorOpen={pane}
      inspector={
        summary && (
          <Inspector title="Activity" open={pane}>
            <ActivityPanel
              sessionId={summary.id}
              taskId={summary.taskId}
              rows={s.watchedRows}
              rowsAgent={s.watchedAgent}
              attachments={s.attachments}
              background={activity?.background ?? []}
              subagents={subagents}
              gitProject={s.gitRepo ? summary.projectId : undefined}
              following={s.follow}
              onFollow={s.setFollow}
              onOpenWorkflow={(runId) => s.showWorkflow(runId)}
              workflowRun={s.workflow?.run ?? null}
              onOpenWorkflowAgent={(runId, agentId) => s.showWorkflow(runId, agentId)}
              working={summary.status === 'working'}
              pos={s.nowPos}
              onPos={s.setNowPos}
            />
          </Inspector>
        )
      }
    />
  );
}

/**
 * The Chats window on a phone: the session list (or the Overview, as a
 * list), then a session's own screen. A chat's message box stays above the
 * keyboard; the activity pane, and the usage panel with the status bar's facts,
 * are sheets. A single chat's window is that chat's screen alone, and Back closes it.
 * So is a window opened on a conversation (`opened`: a tap on the main window's Chats
 * tab or its Dashboard): the list is the tab's, so Back, or closing the conversation,
 * closes the window and returns there.
 */
function PhoneSessions({ s, single, opened }: { s: SessionsWindow; single: boolean; opened: boolean }) {
  const { state, summary, chat, activity, subagents } = s;
  const limits = sessionLimits(state, summary);
  const closesWindow = single || opened;
  // iPad: the list in a leading column and the conversation beside it; Activity a trailing inspector when there's room.
  const split = useSplit(!single);
  const [listShow, setListShow] = useState<OverviewChoice>('list');
  const [reordering, setReordering] = useState(false);
  const reorderGroup = !summary && state.sessions.length > 1 && listShow === 'overview' ? [{ id: 'cards', items: [{ id: 'reorder-cards', label: 'Reorder', run: () => setReordering(true) }] }] : [];
  const panel = useInspector<ActivityTab>('now', !!split?.inspector);
  const [usage, setUsage] = useState(false);
  useEffect(() => {
    panel.dismiss();
    setUsage(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summary?.id]);
  const sheet = panel.sheetOpen || usage;
  const inspectorShown = !!split?.inspector && panel.open && !!summary;
  // A conversation that isn't listed yet (a new chat or terminal is on its way) shows "Starting…" instead of the list.
  const starting = !summary && !!s.selected && !single;
  const listed = useRef(false);
  useEffect(() => {
    if (summary) listed.current = true;
    // With the list beside it (iPad), the window stays and shows the list (useSessionsWindow drops the selection).
    else if (opened && listed.current && !split) window.close();
  }, [summary, opened, split]);

  // The bar and More, from the one list: the Activity sheet and the Usage sheet answer for what the desktop's status bar and pane do.
  const commandState = useCommandState();
  const commands: CommandContext = {
    ...commandState,
    chats: s.chatsContext({
      activityOpen: panel.open,
      toggleActivity: panel.toggle,
      showUsage: () => setUsage(true),
      usageLabel: summary ? usageLabel(chat?.context ?? summary.context, limits) : undefined,
      usageRing: summary ? { context: contextFraction(chat?.context ?? summary.context), used: limits.fiveHour?.used ?? null } : undefined,
    }),
  };
  useCommandMenu(null, commands);
  const listNav = phoneNav(['chats'], commands);
  const conversationNav = phoneNav(['conversation'], commands);
  const actions: PageNavAction[] = summary ? conversationNav.actions : split ? [] : listNav.actions;
  const more = summary ? conversationNav.more : listNav.more;
  // A workflow is a page pushed over the conversation, and its agent's conversation one over the workflow; a subagent's is one over the conversation.
  const workflow = s.workflow;
  const subagent = s.follow && s.followed ? s.followed : null;
  const back = (): void => {
    if (sheet) {
      panel.dismiss();
      setUsage(false);
    } else if (workflow) s.showWorkflow(workflow.agent ? workflow.run.runId : null);
    else if (s.follow) s.setFollow(null);
    else s.setSelected(null);
  };
  const title = workflow
    ? (workflow.agent?.label ?? workflow.run.name)
    : subagent
      ? subagent.description || subagent.type
      : summary
        ? summary.kind === 'terminal'
          ? terminalTitle(summary)
          : summary.title
        : undefined;
  const bar = (
    <NavBar
      {...(split
      ? {
          // iPad: the bar over the list has its title and buttons; the rest is the conversation's.
          title: title ?? '',
          back: summary && (sheet || workflow || s.follow) ? back : undefined,
          actions,
          largeTitle: false,
          split: {
            width: split.lead,
            title: 'Chats',
            actions: listNav.actions,
            largeTitle: platform === 'ios',
            inspector: inspectorShown ? { width: split.inspector, title: 'Activity' } : undefined,
          },
          toolbar: reorderGroup,
          more,
          modal: sheet,
        }
      : {
          title: title ?? (single ? undefined : 'Chats'),
          back: summary && (!closesWindow || sheet || workflow || s.follow) ? back : undefined,
          actions: single && !summary ? [] : actions,
          // The list's large title; a conversation on its way has none to scroll past.
          largeTitle: platform === 'ios' && !summary && !single && !starting,
          toolbar: reorderGroup,
          more,
          // The Activity and Usage sheets are drawn in the page: the frame's bar stays out of reach under them.
          modal: sheet,
        })}
    />
  );

  const sessionsList = (
    <div className="pg-scroll">
      <LargeTitle>Chats</LargeTitle>
      <OverviewSwitch
        listLabel="Chats"
        list={
          <section className="pg-group pg-sessions">
            <SessionList
              sessions={state.sessions}
              selected={split ? s.selected : null}
              collapsed={s.shown.collapsed}
              waitingFirst={s.shown.waitingFirst}
              onToggle={s.toggleGroup}
              onSelect={s.setSelected}
            />
          </section>
        }
        value={listShow}
        onChange={setListShow}
        overview={<PhoneOverview sessions={state.sessions} shown={s.shown} setShown={s.setShown} onOpen={s.setSelected} reordering={reordering} onReordered={() => setReordering(false)} />}
      />
    </div>
  );
  // Activity: opening a page from it takes a sheet away, and an inspector stays.
  const activityPanel = summary && (
    <Inspector title="Activity" open={panel.open} onClose={panel.dismiss}>
      <Fragment key={panel.showKey}>
        <ActivityPanel
          sessionId={summary.id}
          taskId={summary.taskId}
          rows={s.watchedRows}
          rowsAgent={s.watchedAgent}
          attachments={s.attachments}
          background={activity?.background ?? []}
          subagents={subagents}
          gitProject={s.gitRepo ? summary.projectId : undefined}
          following={s.follow}
          onFollow={(id) => {
            s.setFollow(id);
            panel.dismiss();
          }}
          onOpenWorkflow={(runId) => {
            s.showWorkflow(runId);
            panel.dismiss();
          }}
          working={summary.status === 'working'}
          pos={s.nowPos}
          onPos={s.setNowPos}
          initialTab={panel.tab}
        />
      </Fragment>
    </Inspector>
  );
  const usageSheet = summary && usage && (
    <PhoneSheet title="Usage" detent="medium" onClose={() => setUsage(false)}>
      <UsagePanel summary={summary} chat={chat} limits={limits} />
    </PhoneSheet>
  );

  if (split) {
    return (
      <div className="phone-sessions phone-page split">
        {bar}
        <ListDetail
          split={split}
          list={sessionsList}
          open={!!summary || starting}
          detail={
            summary ? (
              <div className={`pg-split-pane phone-conversation kind-${summary.kind}`}>
                {!workflow && !s.follow && <ConversationAgents s={s} onOpen={panel.show} />}
                <main className="sessions-center">
                  <SessionCenter s={s} />
                </main>
              </div>
            ) : (
              <div className="pg-split-pane phone-starting">
                <TerminalOverlay />
              </div>
            )
          }
          empty="No Chat Selected"
          inspector={activityPanel}
        />
        {usageSheet}
      </div>
    );
  }

  if (!summary && single) {
    return (
      <div className="empty">
        {bar}
        Loading…
      </div>
    );
  }
  if (starting) {
    return (
      <div className="phone-sessions phone-page phone-starting">
        {bar}
        <TerminalOverlay />
      </div>
    );
  }
  if (!summary) {
    return (
      <div className="phone-sessions phone-page">
        {bar}
        {sessionsList}
      </div>
    );
  }

  return (
    <div className={`phone-sessions phone-page phone-conversation kind-${summary.kind}`}>
      {bar}
      {!workflow && !s.follow && <ConversationAgents s={s} onOpen={panel.show} />}
      <main className="sessions-center">
        <SessionCenter s={s} />
      </main>
      {activityPanel}
      {usageSheet}
    </div>
  );
}

/**
 * On a phone the conversation has no tab strip: a row for its subagents and one
 * for its workflow runs, each with a count and plain-text status, open the
 * Activity sheet on the list (a subagent or workflow opens as a page of its own).
 */
function ConversationAgents({ s, onOpen }: { s: SessionsWindow; onOpen: (tab: ActivityTab) => void }) {
  if (s.subagents.length + s.workflows.length === 0) return null;
  return (
    <div className="conversation-agents">
      <Group>
        {s.subagents.length > 0 && <Row title="Subagents" value={groupStatusText(s.subagents.map((a) => a.status))} chevron onOpen={() => onOpen('subagents')} />}
        {s.workflows.length > 0 && <Row title="Workflows" value={groupStatusText(s.workflows.map((r) => tabStatus(r.status)))} chevron onOpen={() => onOpen('background')} />}
      </Group>
    </div>
  );
}

