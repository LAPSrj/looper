import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { contextText, type ChatState } from '@shared/chat';
import type { MessageRow } from '@shared/messages';
import type { SessionSummary, UsageLimits } from '@shared/sessions';
import { tabStatus } from '@shared/workflows';
import { dashboardOrder, waitedText } from '@shared/sessions';
import { ActivityPanel, type ActivityTab } from './components/ActivityPanel';
import { fmtClock } from './format';
import { WaitedFor } from './components/Live';
import { MINUTE, useNow } from './useNow';
import { ICONS } from './components/icons';
import { ToolButton } from './components/ToolButton';
import { Toolbar } from './components/Toolbar';
import type { ToolbarGroup } from './components/toolbar-model';
import { DESKTOP_ONLY, NOT_MOBILE } from '@shared/ui-platform';
import { SHORTCUTS, hint } from '@shared/shortcuts';
import { ChatRow, ToolGroup, groupRows } from './components/ChatRows';
import { ChatView } from './components/ChatView';
import { sendsOnEnter } from './components/composer';
import { useDragResize } from './components/hooks';
import { useAutoGrow } from './components/phone/auto-grow';
import { Group, LargeTitle, Row, Segmented } from './components/phone/PhoneList';
import { PhoneSheet } from './components/phone/PhoneSheet';
import { SplitEmpty, SplitView, useSplit } from './components/phone/PhoneSplit';
import { TerminalOverlay } from './components/phone/TerminalOverlay';
import { AccountLimits, UsagePanel } from './components/phone/UsagePanel';
import { SessionIcon, SessionList, statusText } from './components/SessionList';
import { groupStatusText, subagentTabs } from './components/subagents';
import { contextFraction, limitFacts, usageLabel } from './components/usage';
import { TerminalView } from './components/TerminalView';
import { Tabs, type TabItem } from './components/Tabs';
import { PhoneWorkflow, WorkflowAgentBack, WorkflowOverview } from './components/WorkflowView';
import { platform } from './platform';
import { chatMore, terminalTitle } from './phone-lists';
import { subscribe } from './events';
import { useSessionsWindow, type SessionsWindow } from './useSessionsWindow';
import { isPhone, usePageNav, type PageNavAction } from './web/page-nav';

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

/** The window's bottom line: the session's harness and its context, then the account's usage limits. */
function SessionsStatusBar({ summary, chat, limits }: { summary?: SessionSummary; chat: ChatState | null; limits: UsageLimits }) {
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
function CardMessages({ s }: { s: SessionSummary }) {
  const ref = useRef<HTMLDivElement>(null);
  const key = s.recent?.join('\n') ?? s.latest ?? '';
  useLayoutEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [key]);
  if (isPhone) {
    const last = s.recent?.length ? s.recent[s.recent.length - 1] : s.latest;
    const question = s.waiting && s.waiting.reason !== 'turn' ? s.waiting.text : null;
    return (
      <div className="overview-messages">
        {question && <div className="overview-question">{question}</div>}
        {last && <div className="overview-msg overview-last">{last}</div>}
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

/** A desktop dashboard card's size: twice the normal one, or back. */
interface CardSize {
  big: boolean;
  onToggle: () => void;
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

const cardClass = (s: SessionSummary, size: CardSize | undefined, extra = '') =>
  `overview-card${extra}${size?.big ? ' big' : ''}${s.waiting && s.waiting.reason !== 'turn' ? ' waiting' : ''}`;

/**
 * One session on the dashboard as a summary: its state, the agent's messages since the
 * user's last one, and Allow/Deny or a reply box at the bottom. A terminal session's
 * and a task run's card on the desktop, and every card on a phone.
 */
export function DashboardCard({ s, onOpen, size, drag }: { s: SessionSummary; onOpen: (id: string) => void; size?: CardSize; drag?: CardDrag }) {
  const [reply, setReply] = useState('');
  const replyBox = useRef<HTMLTextAreaElement>(null);
  useAutoGrow(replyBox, reply, 120, isPhone);
  const send = () => {
    if (!reply.trim()) return;
    window.looper.sessions.send([s.id], reply);
    setReply('');
  };
  return (
    <div
      data-id={s.id}
      className={cardClass(s, size) + (drag?.mark ?? '')}
      onClick={() => onOpen(s.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        window.looper.sessions.showContextMenu(s.id, !!size);
      }}
    >
      <CardTitle s={s} size={size} drag={drag} />
      <CardMessages s={s} />
      {s.background > 0 && <div className="muted">{backgroundText(s.background)}</div>}
      <div className="overview-actions" onClick={(e) => e.stopPropagation()}>
        {s.kind === 'run' ? null : s.permissionId ? (
          <>
            <button className="btn primary small" onClick={() => window.looper.chat.answer(s.id, s.permissionId!, true)}>
              Allow
            </button>
            <button className="btn small" onClick={() => window.looper.chat.answer(s.id, s.permissionId!, false)}>
              Deny
            </button>
          </>
        ) : (
          s.status !== 'ended' && (
            <>
              {isPhone ? (
                // On a phone Enter is a line break; Send, or Ctrl+Enter from a hardware keyboard, sends.
                <textarea
                  ref={replyBox}
                  rows={1}
                  value={reply}
                  placeholder="Reply"
                  onChange={(e) => setReply(e.target.value)}
                  onKeyDown={(e) => {
                    if (sendsOnEnter(e, true)) {
                      e.preventDefault();
                      send();
                    }
                  }}
                />
              ) : (
                <input
                  value={reply}
                  placeholder="Reply"
                  onChange={(e) => setReply(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      send();
                    }
                  }}
                />
              )}
              <button className="btn small" disabled={!reply.trim()} onClick={send}>
                Send
              </button>
            </>
          )
        )}
      </div>
    </div>
  );
}

/** The Overview on a phone: a summary card per session, in the desktop dashboard's order. */
function Dashboard({ s }: { s: SessionsWindow }) {
  const { sessions } = s.state;
  if (sessions.length === 0) return <div className="empty">No chats are open.</div>;
  return (
    <div className="sessions-overview">
      {dashboardOrder(sessions, s.shown.cardOrder, s.shown.waitingFirst).map((x) => (
        <DashboardCard key={x.id} s={x} onOpen={s.setSelected} />
      ))}
    </div>
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

/** A chat's state while its card is in view: read once, then kept current by its own chat events only. */
function useCardChat(id: string, live: boolean): ChatState | null {
  const [chat, setChat] = useState<ChatState | null>(null);
  useEffect(() => {
    setChat(null);
    if (!live) return;
    let current = true;
    const unsub = subscribe((e) => {
      if (e.type === 'chat' && e.state.id === id) setChat(e.state);
    });
    // An event that came first is newer than what was read.
    void window.looper.chat.get(id).then((c) => {
      if (current && c) setChat((prev) => prev ?? c);
    });
    return () => {
      current = false;
      unsub();
    };
  }, [id, live]);
  return live ? chat : null;
}

/**
 * A chat on the desktop dashboard: its title bar (a click opens the chat, a right-click
 * its menu), then the chat itself, as in the window's middle without the activity pane.
 * Out of view, the card shows the agent's latest messages instead.
 */
function ChatCard({
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
  const chat = useCardChat(s.id, live);
  // The card's title changes with every status and minute; the chat only with its own events.
  const view = useMemo(() => chat && <ChatView state={chat} embedded />, [chat]);
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
      className={cardClass(s, size, ' overview-chat') + drag.mark}
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

/**
 * The Chats window's dashboard: a card per session in the order the cards
 * were dragged to (the list's for the others), so cards don't move while you
 * work in them, unless Waiting Chats First puts the waiting ones first. Each
 * chat is a working chat; terminal sessions and task runs are summaries. Any
 * card can be twice its size.
 */
function ChatsDashboard({ s }: { s: SessionsWindow }) {
  const { sessions } = s.state;
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const [inView, track] = useCardsInView(root);
  const [dragging, setDragging] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; after: boolean } | null>(null);
  const live = sessions.filter((x) => x.kind === 'chat' && inView.has(x.id)).map((x) => x.id);
  const liveKey = live.join('\n');
  // A layout effect, so the window takes the chats' events before the cards read them.
  useLayoutEffect(() => window.looper.sessions.showCards(live), [liveKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => () => window.looper.sessions.showCards([]), []);
  if (sessions.length === 0) return <div className="empty">No chats are open.</div>;
  const big = s.shown.bigCards;
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
      ref={setRoot}
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
      {dashboardOrder(sessions, s.shown.cardOrder, s.shown.waitingFirst).map((x) => {
        const size = { big: big.includes(x.id), onToggle: () => s.toggleBig(x.id) };
        return x.kind === 'chat' ? (
          <ChatCard key={x.id} s={x} live={inView.has(x.id)} size={size} drag={dragOf(x.id)} track={track} onOpen={s.setSelected} />
        ) : (
          <DashboardCard key={x.id} s={x} size={size} drag={dragOf(x.id)} onOpen={s.setSelected} />
        );
      })}
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

/** A conversation read from its transcript in the middle (a subagent's, or a task run's agent), read again while it runs. */
function TranscriptView({ summary, rows, waitingText }: { summary: SessionSummary; rows: MessageRow[]; waitingText: string }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  useEffect(() => {
    const el = scrollRef.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [rows.length]);
  const ctx = { taskId: summary.taskId, runId: summary.id };
  return (
    <div className="chat-app">
      <div
        className="chat-scroll"
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {groupRows(rows).map((item) =>
          item.kind === 'tools' ? <ToolGroup key={item.rows[0].id} rows={item.rows} ctx={ctx} /> : <ChatRow key={item.row.id} row={item.row} ctx={ctx} />,
        )}
        {rows.length === 0 && <div className="muted">{waitingText}</div>}
      </div>
    </div>
  );
}

/**
 * The Chats window's toolbar as data: the dashboard and Send to Chats, new
 * sessions (in the shown session's project, or a picked one), Stop, the
 * chat's Send Now and Close Conversation, the session's folder, and the
 * activity pane. The desktop draws it; a phone's More menu offers it
 * (pass it to usePageNav as `toolbar`).
 */
export function sessionsToolbarGroups(s: SessionsWindow): ToolbarGroup[] {
  const { summary, chat, stoppable, shown } = s;
  const project = summary?.projectId;
  const fail = (e: Error) => void window.looper.showError(e.message);
  return [
    {
      id: 'views',
      items: [
        { id: 'dashboard', label: 'Dashboard', icon: 'dashboard', pressed: !summary, run: () => s.setSelected(null) },
        { id: 'send-to-chats', label: 'Send to Chats', icon: 'bullhorn', run: () => window.looper.sessions.openSend() },
      ],
    },
    {
      id: 'new',
      items: [
        {
          id: 'new-chat',
          label: project ? `New Chat in ${summary!.groupName}` : 'New Chat',
          shortcut: project ? hint(SHORTCUTS.newChat) : undefined,
          icon: 'newChat',
          run: project ? () => void window.looper.projects.newChat(project) : null,
          menu: { label: 'New Chat in Project', open: (x, y) => window.looper.sessions.showNewMenu('chat', x, y) },
        },
        {
          id: 'new-terminal',
          label: project ? `New Terminal in ${summary!.groupName}` : 'New Terminal',
          shortcut: project ? hint(SHORTCUTS.newTerminal) : undefined,
          icon: 'terminal',
          run: project ? () => void window.looper.projects.newTerminal(project) : null,
          menu: { label: 'New Terminal in Project', open: (x, y) => window.looper.sessions.showNewMenu('terminal', x, y) },
        },
      ],
    },
    {
      id: 'session',
      items: [
        {
          id: 'stop',
          label: 'Stop',
          shortcut: summary?.kind === 'chat' ? 'Esc' : undefined,
          icon: 'stopChat',
          enabled: stoppable,
          run: () => void window.looper.sessions.stop(summary!.id).catch(fail),
        },
        {
          id: 'send-now',
          label: 'Send Now',
          shortcut: 'Ctrl+Enter',
          icon: 'sendNow',
          enabled: (chat?.queued.length ?? 0) > 0,
          run: () => void window.looper.chat.sendNow(chat!.id).catch(fail),
        },
        {
          id: 'close-conversation',
          label: 'Close Conversation',
          shortcut: 'Ctrl+W',
          icon: 'closeChat',
          enabled: !!summary && summary.kind !== 'run',
          run: () => void window.looper.sessions.close(summary!.id),
        },
      ],
    },
    {
      id: 'folder',
      platforms: DESKTOP_ONLY,
      items: [{ id: 'open-work-folder', label: 'Open Working Directory', icon: 'folder', enabled: !!summary, run: () => void window.looper.openTaskWorkFolder(summary!.taskId) }],
    },
    {
      // A phone shows the activity in a sheet, from its own bar button.
      id: 'panes',
      platforms: NOT_MOBILE,
      items: [
        {
          id: 'activity-pane',
          label: 'Activity Pane',
          icon: 'activity',
          enabled: !!summary,
          pressed: !!summary && shown.activityPane,
          run: () => s.setShown({ activityPane: !shown.activityPane }),
        },
      ],
    },
  ];
}

function SessionsToolbar({ s }: { s: SessionsWindow }) {
  return <Toolbar groups={sessionsToolbarGroups(s)} className="sessions-toolbar" />;
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
  if (!summary) return s.single ? <div className="empty">Loading…</div> : <ChatsDashboard s={s} />;
  if (workflow) {
    const { run, agent } = workflow;
    const openAgent = (id: string | null) => s.showWorkflow(run.runId, id);
    const props = { run, taskId: summary.taskId, sessionId: summary.id, onAgent: openAgent };
    const agentView = agent && <TranscriptView key={agent.agentId} summary={summary} rows={s.subRows} waitingText="Waiting for the agent's first message…" />;
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
  if (follow && followed) return <TranscriptView summary={summary} rows={s.subRows} waitingText="Waiting for the subagent's first message…" />;
  if (summary.kind === 'terminal') return <TerminalView key={summary.id} id={summary.id} />;
  if (summary.kind === 'run') return <TranscriptView key={summary.id} summary={summary} rows={s.activity?.rows ?? []} waitingText="Waiting for the agent's first message…" />;
  return chat ? <ChatView key={chat.id} state={chat} /> : <div className="empty">Loading…</div>;
}

/** The list's and the activity pane's widths, as last dragged. */
function savedWidths(key: string): { left: number; right: number } {
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? '') as { left: number; right: number };
    if (saved.left > 0 && saved.right > 0) return saved;
  } catch {
    /* the defaults */
  }
  return { left: 280, right: 400 };
}

function DesktopSessions({ s, single }: { s: SessionsWindow; single: boolean }) {
  const { state, selected, summary, chat, activity, shown, subagents } = s;
  const widthsKey = single ? WINDOW_WIDTHS_KEY : WIDTHS_KEY;
  const [widths, setWidths] = useState(() => savedWidths(widthsKey));
  const bodyRef = useRef<HTMLDivElement>(null);

  const saveWidths = (w: { left: number; right: number }) => {
    setWidths(w);
    localStorage.setItem(widthsKey, JSON.stringify(w));
  };
  const dragLeft = useDragResize({
    axis: 'x',
    containerRef: bodyRef,
    onDrag: (pos) => saveWidths({ ...widths, left: Math.min(480, Math.max(200, pos)) }),
  });
  const dragRight = useDragResize({
    axis: 'x',
    containerRef: bodyRef,
    onDrag: (pos, rect) => saveWidths({ ...widths, right: Math.min(720, Math.max(280, rect.width - pos)) }),
  });

  const pane = !!summary && (single ? shown.windowActivityPane : shown.activityPane);
  // The list and the Activity pane shrink to their smallest widths before the conversation drops under 480 px.
  const list = single ? '' : `minmax(200px, ${widths.left}px) 5px `;

  return (
    <div className="sessions-app">
      {!single && shown.toolbar && <SessionsToolbar s={s} />}
      <div
        className="sessions-body"
        ref={bodyRef}
        style={{ gridTemplateColumns: pane ? `${list}minmax(${single ? 0 : 480}px, 1fr) 5px minmax(280px, ${widths.right}px)` : `${list}1fr` }}
      >
        {!single && (
          <>
            <SessionList
              sessions={state.sessions}
              selected={selected}
              collapsed={shown.collapsed}
              waitingFirst={shown.waitingFirst}
              onToggle={s.toggleGroup}
              onSelect={s.setSelected}
            />
            <div className="sidebar-divider" onMouseDown={dragLeft} />
          </>
        )}
        <main className="sessions-center">
          {summary && hasTabs(s) && <SubagentTabs s={s} />}
          <SessionCenter s={s} />
        </main>
        {pane && summary && (
          <>
            <div className="sidebar-divider" onMouseDown={dragRight} />
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
          </>
        )}
      </div>
      {(single ? shown.windowStatusBar : shown.statusBar) && <SessionsStatusBar summary={summary} chat={chat} limits={state.limits} />}
    </div>
  );
}

type PhoneList = 'sessions' | 'overview';
const PHONE_LISTS: [PhoneList, string][] = [
  ['sessions', 'Chats'],
  ['overview', 'Overview'],
];

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
  const [list, setList] = useState<PhoneList>('sessions');
  const [sheet, setSheet] = useState<{ kind: 'activity'; tab: ActivityTab } | { kind: 'usage' } | null>(null);
  useEffect(() => setSheet(null), [summary?.id]);
  const closesWindow = single || opened;
  // iPad: the list in a leading column and the conversation beside it; Activity a trailing inspector when there's room.
  const split = useSplit(!single);
  const [inspector, setInspector] = useState<{ open: boolean; tab: ActivityTab; n: number }>({ open: true, tab: 'now', n: 0 });
  const inspectorShown = !!split?.inspector && inspector.open && !!summary;
  // A conversation that isn't listed yet (a new chat or terminal is on its way) shows "Starting…" instead of the list.
  const starting = !summary && !!s.selected && !single;
  const listed = useRef(false);
  useEffect(() => {
    if (summary) listed.current = true;
    // With the list beside it (iPad), the window stays and shows the list (useSessionsWindow drops the selection).
    else if (opened && listed.current && !split) window.close();
  }, [summary, opened, split]);
  // A conversation that never turns up (it closed before this window loaded) gives up and shows the list.
  useEffect(() => {
    if (!starting) return;
    const t = setTimeout(() => s.setSelected(null), 15_000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [starting]);
  const fail = (e: Error) => void window.looper.showError(e.message);
  // A row of the conversation (Subagents, Workflows) opens Activity on its list: the inspector when it fits, else the sheet.
  const openActivity = (tab: ActivityTab = 'now') =>
    split?.inspector ? setInspector((i) => ({ open: true, tab, n: i.n + 1 })) : setSheet({ kind: 'activity', tab });
  // The bar's Activity button shows or hides the inspector, or opens the sheet.
  const toggleActivity = () => (split?.inspector ? setInspector((i) => ({ ...i, open: !i.open })) : openActivity());

  const listActions: PageNavAction[] = [
    // The toolbar's ids: the More menu leaves these out.
    { id: 'new-chat', label: 'New Chat', icon: 'newChat', run: () => window.looper.sessions.showNewMenu('chat', 0, 0) },
    { id: 'new-terminal', label: 'New Terminal', icon: 'terminal', run: () => window.looper.sessions.showNewMenu('terminal', 0, 0) },
    { id: 'send-to-chats', label: 'Send to Chats', icon: 'bullhorn', run: () => window.looper.sessions.openSend() },
  ];
  // A chat's Stop and Send Now are in its message box; a terminal session has no message box, so its Stop stays in the bar.
  const actions: PageNavAction[] = summary
    ? [
        ...(s.stoppable && summary.kind !== 'chat' ? [{ id: 'stop', label: 'Stop', icon: 'stopChat', run: () => void window.looper.sessions.stop(summary.id).catch(fail) }] : []),
        { id: 'activity', label: 'Activity', icon: 'activity', run: toggleActivity },
        {
          id: 'usage',
          label: usageLabel(chat?.context ?? summary.context, state.limits),
          ring: { context: contextFraction(chat?.context ?? summary.context), used: state.limits.fiveHour?.used ?? null },
          run: () => setSheet({ kind: 'usage' }),
        },
      ]
    : split
      ? []
      : listActions;
  // A workflow is a page pushed over the conversation, and its agent's conversation one over the workflow; a subagent's is one over the conversation.
  const workflow = s.workflow;
  const subagent = s.follow && s.followed ? s.followed : null;
  const back = (): void => {
    if (sheet) setSheet(null);
    else if (workflow) s.showWorkflow(workflow.agent ? workflow.run.runId : null);
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
  usePageNav(
    split
      ? {
          // iPad: the bar over the list has its title and buttons; the rest is the conversation's.
          title: title ?? '',
          back: summary && (sheet || workflow || s.follow) ? back : undefined,
          actions,
          largeTitle: false,
          split: {
            width: split.lead,
            title: 'Chats',
            actions: listActions,
            largeTitle: platform === 'ios',
            inspector: inspectorShown ? { width: split.inspector, title: 'Activity' } : undefined,
          },
          toolbar: sessionsToolbarGroups(s),
          more: summary ? chatMore(summary.kind) : undefined,
          modal: !!sheet,
        }
      : {
          title: title ?? (single ? undefined : 'Chats'),
          back: summary && (!closesWindow || sheet || workflow || s.follow) ? back : undefined,
          actions: single && !summary ? [] : actions,
          // The list's large title; a conversation on its way has none to scroll past.
          largeTitle: platform === 'ios' && !summary && !single && !starting,
          toolbar: sessionsToolbarGroups(s),
          // A designed More menu for a conversation: only what applies to it (phone-lists.ts chatMore).
          more: summary ? chatMore(summary.kind) : undefined,
          // The Activity and Usage sheets are drawn in the page: the frame's bar stays out of reach under them.
          modal: !!sheet,
        },
  );

  const sessionsList = (
    <div className="pg-scroll">
      <LargeTitle>Chats</LargeTitle>
      <div className="pg-segmented-wrap">
        <Segmented items={PHONE_LISTS} value={list} onChange={setList} label="Show" />
      </div>
      {list === 'sessions' ? (
        <section className="pg-group pg-sessions">
          <SessionList
            sessions={state.sessions}
            selected={split ? s.selected : null}
            collapsed={s.shown.collapsed}
            waitingFirst={s.shown.waitingFirst}
            onToggle={s.toggleGroup}
            onSelect={s.setSelected}
            selectOnMenu={false}
          />
        </section>
      ) : (
        <Dashboard s={s} />
      )}
      <AccountLimits limits={state.limits} />
    </div>
  );
  // Activity, in the sheet (closes when it opens a page) or the inspector (stays).
  const activityPanel = (closes: boolean, tab: ActivityTab) =>
    summary && (
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
          if (closes) setSheet(null);
        }}
        onOpenWorkflow={(runId) => {
          s.showWorkflow(runId);
          if (closes) setSheet(null);
        }}
        pos={s.nowPos}
        onPos={s.setNowPos}
        initialTab={tab}
      />
    );
  const sheets = summary && (
    <>
      {sheet?.kind === 'usage' && (
        <PhoneSheet title="Usage" detent="medium" onClose={() => setSheet(null)}>
          <UsagePanel summary={summary} chat={chat} limits={state.limits} />
        </PhoneSheet>
      )}
      {sheet?.kind === 'activity' && (
        <PhoneSheet title="Activity" onClose={() => setSheet(null)}>
          {activityPanel(true, sheet.tab)}
        </PhoneSheet>
      )}
    </>
  );

  if (split) {
    return (
      <div className="phone-sessions phone-page split">
        <SplitView
          split={split}
          lead={sessionsList}
          detail={
            summary ? (
              <div className={`pg-split-pane phone-conversation kind-${summary.kind}`}>
                {!workflow && !s.follow && <ConversationAgents s={s} onOpen={openActivity} />}
                <main className="sessions-center">
                  <SessionCenter s={s} />
                </main>
              </div>
            ) : starting ? (
              <div className="pg-split-pane phone-starting">
                <TerminalOverlay kind="starting" />
              </div>
            ) : (
              <SplitEmpty>No Chat Selected</SplitEmpty>
            )
          }
          inspector={inspectorShown ? <Fragment key={inspector.n}>{activityPanel(false, inspector.tab)}</Fragment> : undefined}
        />
        {sheets}
      </div>
    );
  }

  if (!summary && single) return <div className="empty">Loading…</div>;
  if (starting) {
    return (
      <div className="phone-sessions phone-page phone-starting">
        <TerminalOverlay kind="starting" />
      </div>
    );
  }
  if (!summary) {
    return <div className="phone-sessions phone-page">{sessionsList}</div>;
  }

  return (
    <div className={`phone-sessions phone-page phone-conversation kind-${summary.kind}`}>
      {!workflow && !s.follow && <ConversationAgents s={s} onOpen={openActivity} />}
      <main className="sessions-center">
        <SessionCenter s={s} />
      </main>
      {sheets}
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

