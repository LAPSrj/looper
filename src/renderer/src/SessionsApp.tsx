import { Fragment, lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
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
import { chatInteractive, type ChatState } from '@shared/chat';
import type { MessageRow } from '@shared/messages';
import type { SessionActivity, SessionSummary, SlashCommand, UsageLimits } from '@shared/sessions';
import { tabStatus } from '@shared/workflows';
import { canStop, dashboardOrder, liveCards, showsConversation } from '@shared/sessions';
import type { EngineEvent } from '@shared/types';
import { ActivityPanel, type ActivityTab } from './components/ActivityPanel';
import { fmtClock } from './format';
import { MINUTE, useNow } from './useNow';
import { StatusBar } from './components/StatusBar';
import { Toolbar } from './components/Toolbar';
import { commandToolbar, phoneNav } from './components/command-surfaces';
import { useCommandMenu, useCommandState } from './components/useCommands';
import { ChatView } from './components/ChatView';
import { PermissionButtons } from './components/PermissionCard';
import { useDragResize } from './components/hooks';
import { atEnd, useStayAtEnd } from './components/newest-first';
import { Inspector, useInspector } from './components/Inspector';
import { ListDetail } from './components/ListDetail';
import { Composer } from './components/Composer';
import type { MessageBoxStop } from './components/MessageBox';
import { QueuedGuidanceActions, RunGuidance, SubagentConversation, TranscriptView } from './components/Transcript';
import { reportError } from './report-error';
import { OverviewSwitch, type OverviewChoice } from './components/phone/OverviewSwitch';
import { LargeTitle } from './components/phone/PhoneList';
import { PhoneSheet } from './components/phone/PhoneSheet';
import { ReorderSheet } from './components/phone/ReorderSheet';
import { useSplit } from './components/phone/PhoneSplit';
import { TerminalOverlay } from './components/phone/TerminalOverlay';
import { UsagePanel } from './components/phone/UsagePanel';
import { NO_CHATS, SessionIcon, SessionList, SessionStatus, sessionKind } from './components/SessionList';
import { EmptyState } from './components/EmptyState';
import { runningText, subagentTabs } from './components/subagents';
import { SubagentTabs } from './components/SubagentIcon';
import { contextFraction, factLine, limitFacts, sessionFacts, sessionLimits, usageLabel, type Fact } from './components/usage';
import { WorkflowView } from './components/WorkflowView';
import { terminalTitle } from './phone-lists';
import { getChat, subscribe } from './events';
import { useSessionsWindow, type SessionsWindow } from './useSessionsWindow';
import { isPhone } from './web/page-nav';
import type { PageNavAction } from './web/nav-bar-model';
import type { SplitLayout } from './web/nav-stack';
import { NavBar } from './components/NavBar';

// The terminal emulator was a quarter of the main chunk, and only a terminal session needs it.
const TerminalView = lazy(() => import('./components/TerminalView').then((m) => ({ default: m.TerminalView })));

/** Where the panes' widths are saved: the Chats window's, and a single chat's window's apart. */
const WIDTHS_KEY = 'sessions.widths';
const WINDOW_WIDTHS_KEY = 'sessions.window.widths';

const factSpans = (facts: Fact[]) =>
  facts.map((f) => (
    <span key={f.label} className={f.live ? 'live-only' : undefined}>
      {factLine(f)}
    </span>
  ));

/**
 * The window's bottom line: the session's harness and its context, then the usage limits of the account its harness runs on.
 * `children` follow at the end (the main window's own, on its Chats tab).
 */
export function SessionsStatusBar({ summary, chat, limits, children }: { summary?: SessionSummary; chat: ChatState | null; limits: UsageLimits; children?: React.ReactNode }) {
  // Every time on it counts minutes.
  const now = useNow(MINUTE);
  const facts = sessionFacts(
    {
      harness: chat?.harnessName ?? summary?.harnessName,
      context: chat?.context ?? summary?.context,
      lastReplyAt: summary?.lastReplyAt,
      cacheUntil: summary?.cacheUntil,
    },
    now,
    fmtClock,
  );
  return (
    <StatusBar
      end={
        <>
          {factSpans(limitFacts(limits, now))}
          {children}
        </>
      }
    >
      {factSpans(facts)}
    </StatusBar>
  );
}

/** A card's messages: those since the user's last one, following the newest unless scrolled up, on a phone as on the desktop. */
function CardMessages({ s }: { s: SessionSummary }) {
  const ref = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const key = s.recent?.join('\n') ?? s.latest ?? '';
  useStayAtEnd(ref, atBottom, key);
  return (
    <div
      className="overview-messages"
      ref={ref}
      onScroll={(e) => {
        atBottom.current = atEnd(e.currentTarget);
      }}
    >
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
          <Toolbar
            inline
            className="overview-tools"
            onClick={(e) => e.stopPropagation()}
            groups={[{ id: 'size', items: [{ id: 'size', label: size.big ? 'Normal Size' : 'Double Size', icon: size.big ? 'normalSize' : 'doubleSize', run: size.onToggle }] }]}
          />
        )}
      </div>
      <div className="muted overview-meta">
        {s.groupName} · {s.harnessName}
        {sessionKind(s) && ` · ${sessionKind(s)}`} ·{' '}
        <span className={s.waiting ? 'warn live-only' : ''}>
          <SessionStatus s={s} brief={isPhone} />
        </span>
      </div>
    </>
  );
}

const backgroundText = (n: number) => (n === 1 ? '1 running in the background' : `${n} running in the background`);

const cardClass = (s: SessionSummary, extra = '') =>
  `overview-card${extra}${s.waiting && s.waiting.reason !== 'turn' ? ' waiting' : ''}`;

/** A session's Stop beside its message box, by the toolbar's rule. */
const stopOf = (s: SessionSummary): MessageBoxStop => ({ enabled: canStop(s), run: () => void window.looper.sessions.stop(s.id).catch(reportError) });

/**
 * A terminal session on the dashboard as a summary: its state, the agent's
 * messages since the user's last one, and Allow/Deny or the message box at the
 * bottom (a chat's, Send above Stop), whose message is typed into the terminal.
 */
function TerminalCard({ s, onOpen, size, drag }: { s: SessionSummary; onOpen: (id: string) => void; size?: CardSize; drag?: CardDrag }) {
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  // The skills come with the transcript's first read: asked again as the session goes on.
  useEffect(() => {
    let live = true;
    void window.looper.sessions.commands(s.id).then((list) => live && setCommands(list));
    return () => {
      live = false;
    };
  }, [s.id, s.status]);
  const keep = (e: React.MouseEvent) => e.stopPropagation();
  let bottom: React.ReactNode = null;
  const permissionId = s.permissionId;
  if (permissionId) {
    bottom = (
      <div className="overview-actions" onClick={keep}>
        <PermissionButtons answer={(allow) => window.looper.chat.answer(s.id, permissionId, allow)} />
      </div>
    );
  } else if (s.status !== 'ended') {
    // A click in the box stays in the box; anywhere else on the card opens it.
    bottom = (
      <div className="overview-composer" onClick={keep}>
        <Composer terminal={{ summary: s, commands, stop: stopOf(s) }} />
      </div>
    );
  }
  return (
    <div
      data-id={s.id}
      className={cardClass(s, ' overview-reply') + (drag?.mark ?? '') + (size?.big ? ' big' : '')}
      style={size?.area}
      onClick={() => onOpen(s.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        window.looper.sessions.showContextMenu(s.id, !!size);
      }}
    >
      <CardTitle s={s} size={size} drag={drag} />
      <CardMessages s={s} />
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
  // Only the cards near the screen show their conversation, as on the desktop's dashboard.
  const [root, setRoot] = useState<HTMLElement | null>(null);
  const [inView, track] = useCardsInView(root);
  if (sessions.length === 0) return <EmptyState>{NO_CHATS}</EmptyState>;
  const big = shown.bigCards;
  const toggleBig = (id: string) => {
    const others = big.filter((x) => x !== id && sessions.some((c) => c.id === x));
    setShown({ bigCards: big.includes(id) ? others : [...others, id] });
  };
  return (
    <>
      <div className="sessions-overview" ref={(el) => setRoot(el?.closest<HTMLElement>('.pg-scroll') ?? null)}>
        {dashboardOrder(sessions, shown.cardOrder, shown.waitingFirst).map((x) => {
          const size = { big: big.includes(x.id), onToggle: () => toggleBig(x.id), area: {} };
          return showsConversation(x) ? (
            <LiveCard key={x.id} s={x} live={inView.has(x.id)} size={size} track={track} onOpen={onOpen} />
          ) : (
            <TerminalCard key={x.id} s={x} onOpen={onOpen} size={size} />
          );
        })}
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

const readChat = getChat;
const chatEvent = (e: EngineEvent, id: string) => (e.type === 'chat' && e.state.id === id ? e.state : undefined);
/** A task run's conversation comes with its activity, as for the run the Chats tab shows. */
const readActivity = (id: string) => window.looper.sessions.activity(id);
const activityEvent = (e: EngineEvent, id: string) => (e.type === 'session:activity' && e.activity.id === id ? e.activity : undefined);

const NO_ROWS: MessageRow[] = [];

/**
 * A task run's conversation and its message box, in the Chats view or on a
 * dashboard card (`embedded`): guidance waiting for the agent shows at its end
 * with Edit and Cancel, the rows' menu quotes into the box, and the box shows
 * Queue while the agent is in a turn.
 */
function RunConversation({ s, activity, embedded = false }: { s: SessionSummary; activity: SessionActivity | null; embedded?: boolean }) {
  const rows = activity?.rows ?? NO_ROWS;
  return (
    <TranscriptView
      taskId={s.taskId}
      runId={s.id}
      rows={rows}
      pendingGuidance={activity?.pendingGuidance}
      pendingStatus={<QueuedGuidanceActions taskId={s.taskId} runId={s.id} />}
      waitingText="Waiting for the agent's first message…"
      quote
      embedded={embedded}
      footer={
        <RunGuidance
          key={s.id}
          taskId={s.taskId}
          runId={s.id}
          question={s.question ?? null}
          permission={s.permission}
          recheck={`${s.status}\n${s.latest ?? ''}`}
          stop={stopOf(s)}
          commands={activity?.commands}
          agent={activity?.agent}
          working={s.status === 'working'}
          queued={!!activity?.pendingGuidance}
          rows={rows}
        />
      }
    />
  );
}

/**
 * A chat or task run on the dashboard: its title bar (a click opens it, a
 * right-click its menu), then the conversation itself, as in the window's middle
 * without the activity pane: a chat with its message box, a task run with its
 * guidance box. Out of view, the card shows the agent's latest messages instead.
 * A phone's card is the desktop's: its conversation scrolls inside it, and the
 * title opens the chat. `drag` only on the desktop, where cards are dragged to
 * another place.
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
  drag?: CardDrag;
  track: TrackCard;
  onOpen: (id: string) => void;
}) {
  const chat = useCardFeed(s.id, live && s.kind === 'chat', readChat, chatEvent);
  const activity = useCardFeed(s.id, live && s.kind === 'run', readActivity, activityEvent);
  // The card's title changes with every status and minute; the conversation only with its own events.
  const chatView = useMemo(() => chat && <ChatView state={chat} embedded />, [chat]);
  const question = s.question ?? null;
  const permissionId = s.permission?.id;
  const recheck = `${s.status}\n${s.latest ?? ''}`;
  const stoppable = canStop(s);
  const runView = useMemo(
    () => activity && <RunConversation s={s} activity={activity} embedded />,
    // The card's run reads only these of the summary.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activity, s.taskId, s.id, question, permissionId, recheck, stoppable],
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
      className={cardClass(s, ' overview-chat') + (drag?.mark ?? '') + (size.big ? ' big' : '')}
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
  if (sessions.length === 0) return <EmptyState>{NO_CHATS}</EmptyState>;
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
          <TerminalCard key={x.id} s={x} size={size} drag={dragOf(x.id)} onOpen={s.setSelected} />
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
function ConversationTabs({ s }: { s: SessionsWindow }) {
  return (
    <SubagentTabs
      agents={subagentTabs(s.subagents, s.follow)}
      follow={s.follow}
      onFollow={s.setFollow}
      closable
      workflows={s.workflows}
      openRun={s.workflow?.run.runId ?? null}
      onWorkflow={s.showWorkflow}
      terminal={s.chat && chatInteractive(s.chat) ? { open: s.terminal, onOpen: () => s.showTerminal(true) } : undefined}
    />
  );
}

/** The conversation's tab strip, once there's more than the conversation to show: an interactive chat's terminal, subagents or workflows. */
const hasTabs = (s: SessionsWindow): boolean =>
  (!!s.chat && chatInteractive(s.chat)) || subagentTabs(s.subagents, s.follow).length + s.workflows.length > 0;

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
  const { state, summary, chat, shown } = s;
  const limits = sessionLimits(state, summary);
  // A window opened on a conversation (a tap on the main window's Chats tab or its Dashboard) is that conversation's screen: Back closes it.
  const opened = !!initial;
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
  // A conversation that isn't listed yet (a new chat or terminal is on its way) shows "Starting…" instead of the list.
  const starting = !summary && !!s.selected && !single;
  const listed = useRef(false);
  useEffect(() => {
    if (summary) listed.current = true;
    // On a phone, the shown conversation closed. Not one on its way (Compact or Fork shows the new chat before it's
    // listed), which shows "Starting…" until it is. With the list beside it (iPad), the window stays and
    // shows the list (useSessionsWindow drops the selection).
    else if (isPhone && opened && listed.current && !split && !starting) window.close();
  }, [summary, opened, split, starting]);

  // The menus, the toolbar and a phone's bar, from the one list. A phone's Activity and Usage sheets answer for what the desktop's pane and status bar do.
  const commandState = useCommandState();
  const commands: CommandContext = {
    ...commandState,
    chats: s.chatsContext(
      isPhone
        ? {
            activityOpen: panel.open,
            toggleActivity: panel.toggle,
            showUsage: () => setUsage(true),
            usageLabel: summary ? usageLabel(chat?.context ?? summary.context, limits, summary.lastReplyAt ? summary.cacheUntil : undefined, Date.now()) : undefined,
            usageRing: summary
              ? {
                  context: contextFraction(chat?.context ?? summary.context),
                  fiveHour: limits.fiveHour,
                  sevenDay: limits.sevenDay,
                  cache: summary.lastReplyAt && summary.cacheUntil !== undefined ? { from: summary.lastReplyAt, until: summary.cacheUntil } : undefined,
                }
              : undefined,
          }
        : undefined,
    ),
  };
  useCommandMenu(isPhone ? null : single ? CHAT_WINDOW_VIEWS : CHATS_WINDOW_VIEWS, commands);
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
    else if (s.terminal) s.showTerminal(false);
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
  // What runs beside the conversation, under its title (the bar's Activity button lists them).
  const processes = (s.activity?.background ?? []).filter((b) => b.kind === 'command' && b.status === 'running').length;
  const subtitle =
    summary && !workflow && !s.follow ? (runningText(s.subagents.map((a) => a.status), s.workflows.map((r) => tabStatus(r.status)), processes) ?? undefined) : undefined;
  const pageBack = summary && (!closesWindow || sheet || workflow || s.follow || s.terminal) ? back : undefined;
  const bar = (
    <NavBar
      {...(split
        ? {
            // iPad: the bar over the list has its title and buttons; the rest is the conversation's.
            title: title ?? '',
            subtitle,
            back: summary && (sheet || workflow || s.follow) ? back : undefined,
            actions,
            largeTitle: false,
            split: {
              width: split.lead,
              title: 'Chats',
              actions: listNav.actions,
              largeTitle: true,
              inspector: panel.open && split.inspector && summary ? { width: split.inspector, title: 'Activity' } : undefined,
            },
            toolbar: reorderGroup,
            more,
            modal: sheet,
          }
        : {
            title: title ?? (single ? undefined : 'Chats'),
            subtitle,
            back: pageBack,
            actions: single && !summary ? [] : actions,
            // The list's large title; a conversation on its way has none to scroll past.
            largeTitle: !summary && !single && !starting,
            toolbar: reorderGroup,
            more,
            // The Activity and Usage sheets are drawn in the page: the frame's bar stays out of reach under them.
            modal: sheet,
          })}
    />
  );

  // A phone's list, as a list or as the Overview's cards.
  const phoneList = (
    <div className="pg-scroll">
      <LargeTitle>Chats</LargeTitle>
      <OverviewSwitch
        listLabel="Chats"
        list={
          <section className="pg-group pg-sessions">
            <SessionList
              sessions={state.sessions}
              selected={split ? s.selected : null}
              collapsed={shown.collapsed}
              waitingFirst={shown.waitingFirst}
              onToggle={s.toggleGroup}
              onSelect={s.setSelected}
            />
          </section>
        }
        value={listShow}
        onChange={setListShow}
        overview={<PhoneOverview sessions={state.sessions} shown={shown} setShown={s.setShown} onOpen={s.setSelected} reordering={reordering} onReordered={() => setReordering(false)} />}
      />
    </div>
  );

  const page = isPhone ? `phone-sessions phone-page${split ? ' split' : summary ? ` phone-conversation kind-${summary.kind}` : starting ? ' phone-starting' : ''}` : 'sessions-app';
  return (
    <div className={page}>
      {bar}
      {!isPhone && (single ? shown.windowToolbar : shown.toolbar) && <SessionsToolbar c={commands} single={single} />}
      {/* A window opened on its conversation never shows the list without a column for it: Back closes the window. */}
      <SessionsBody s={s} single={single} phone={isPhone ? { split, list: closesWindow && !split ? null : phoneList, panel, back: pageBack, title } : undefined} />
      {(single ? shown.windowStatusBar : shown.statusBar) && <SessionsStatusBar summary={summary} chat={chat} limits={limits} />}
      {summary && usage && (
        <PhoneSheet title="Usage" onClose={() => setUsage(false)}>
          <UsagePanel summary={summary} chat={chat} limits={limits} />
        </PhoneSheet>
      )}
    </div>
  );
}

/** What the Chats window's body takes on a phone or tablet: its columns, its list, its Activity sheet, and Back from a conversation. */
interface PhoneChats {
  split: SplitLayout | null;
  list: React.ReactNode;
  panel: ReturnType<typeof useInspector<ActivityTab>>;
  back?: () => void;
  title?: string;
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
  if (!summary) return s.single || s.selected ? <EmptyState>Loading…</EmptyState> : <ChatsDashboard s={s} />;
  if (workflow) {
    const { run, agent } = workflow;
    return (
      <WorkflowView
        run={run}
        agent={agent}
        agentView={agent && <TranscriptView key={agent.agentId} taskId={summary.taskId} runId={summary.id} rows={s.subRows} waitingText="Waiting for the agent's first message…" />}
        taskId={summary.taskId}
        sessionId={summary.id}
        onAgent={(id) => s.showWorkflow(run.runId, id)}
      />
    );
  }
  if (follow && followed) {
    // A chat on Claude Code that hasn't ended takes messages for its running subagents.
    if (summary.kind === 'chat' && chat?.harnessKind === 'claude-code' && chat.status !== 'ended') {
      return <SubagentConversation key={followed.agentId} taskId={summary.taskId} runId={summary.id} rows={s.subRows} chat={chat} agent={followed} />;
    }
    return <TranscriptView taskId={summary.taskId} runId={summary.id} rows={s.subRows} waitingText="Waiting for the subagent's first message…" />;
  }
  // A terminal session, or an interactive chat's Terminal tab.
  if (summary.kind === 'terminal' || (s.terminal && summary.kind === 'chat')) {
    return (
      <Suspense fallback={null}>
        <TerminalView key={summary.id} id={summary.id} />
      </Suspense>
    );
  }
  if (summary.kind === 'run') return <RunConversation key={summary.id} s={summary} activity={s.activity} />;
  return chat ? <ChatView key={chat.id} state={chat} /> : <EmptyState>Loading…</EmptyState>;
}

/**
 * The Chats window's panes, as in the main window's Chats tab: the session list, the session shown, and its
 * activity pane. A single chat's window has the session alone, with its activity pane when the View menu shows
 * it. On a phone or tablet (`phone`) the list is a screen and a conversation is pushed over it, or the two are
 * columns side by side; Activity is a sheet or a trailing column; the conversation's agents are pages, not tabs.
 */
export function SessionsBody({ s, single = false, phone }: { s: SessionsWindow; single?: boolean; phone?: PhoneChats }) {
  const { state, selected, summary, activity, shown, subagents } = s;
  const pane = !!summary && (phone ? phone.panel.open : single ? shown.windowActivityPane : shown.activityPane);
  const starting = !summary && !!selected && !single;
  // Opening a page from a sheet takes the sheet away; a column stays.
  const dismiss = () => phone?.panel.dismiss();
  const center = (
    <main className="sessions-center">
      {!phone && summary && hasTabs(s) && <ConversationTabs s={s} />}
      <SessionCenter s={s} />
    </main>
  );
  let detail: React.ReactNode = center;
  if (phone?.split) detail = summary ? <div className={`pg-split-pane phone-conversation kind-${summary.kind}`}>{center}</div> : <div className="pg-split-pane phone-starting">{starting && <TerminalOverlay />}</div>;
  else if (phone && starting) detail = <TerminalOverlay />;

  return (
    <ListDetail
      sides={{ storageKey: single ? WINDOW_WIDTHS_KEY : WIDTHS_KEY, left: { initial: 280, min: 200, max: 480 }, right: { initial: 400, min: 280, max: 720 }, minDetail: single ? 0 : 480 }}
      split={phone?.split}
      open={single || !!summary || starting}
      onClose={phone?.back}
      detailTitle={phone?.title}
      empty="Select a chat"
      list={
        !single &&
        (phone ? phone.list : (
          <SessionList
            sessions={state.sessions}
            selected={selected}
            collapsed={shown.collapsed}
            waitingFirst={shown.waitingFirst}
            onToggle={s.toggleGroup}
            onSelect={s.setSelected}
          />
        ))
      }
      detail={detail}
      inspectorOpen={pane}
      inspector={
        summary && (
          <Inspector title="Activity" open={pane} onClose={phone?.panel.dismiss}>
            <Fragment key={phone?.panel.showKey}>
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
                  dismiss();
                }}
                onOpenWorkflow={(runId) => {
                  s.showWorkflow(runId);
                  dismiss();
                }}
                workflowRun={s.workflow?.run ?? null}
                onOpenWorkflowAgent={(runId, agentId) => {
                  s.showWorkflow(runId, agentId);
                  dismiss();
                }}
                working={summary.status === 'working'}
                pos={s.nowPos}
                onPos={s.setNowPos}
                initialTab={phone?.panel.tab}
              />
            </Fragment>
          </Inspector>
        )
      }
    />
  );
}

