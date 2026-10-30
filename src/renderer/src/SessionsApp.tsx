import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { contextText, type ChatState } from '@shared/chat';
import type { MessageRow } from '@shared/messages';
import type { SessionSummary, SubagentInfo, UsageLimits } from '@shared/sessions';
import { waitedText } from '@shared/sessions';
import { ActivityPanel } from './components/ActivityPanel';
import { fmtClock } from './format';
import { ICONS } from './components/icons';
import { SplitToolButton, ToolButton } from './components/ToolButton';
import { ChatRow, ToolGroup, groupRows } from './components/ChatRows';
import { ChatView } from './components/ChatView';
import { useDragResize } from './components/hooks';
import { LargeTitle, Segmented } from './components/phone/PhoneList';
import { SessionIcon, SessionList, statusText, waitingOf } from './components/SessionList';
import { TerminalView } from './components/TerminalView';
import { platform } from './platform';
import { subscribe } from './events';
import { useSessionsWindow, type SessionsWindow } from './useSessionsWindow';
import { isPhone, usePageNav, type PageNavAction } from './web/page-nav';

const WIDTHS_KEY = 'sessions.widths';

/** "2 h 10 min" until a time; "now" once it's past. */
const untilText = (at: number, now: number) => (at <= now ? 'now' : waitedText(at - now));

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

function limitParts(limits: UsageLimits, now: number): string[] {
  const parts: string[] = [];
  if (limits.fiveHour) {
    parts.push(`5-hour limit ${Math.round(limits.fiveHour.used * 100)}%`);
    parts.push(`Resets in ${untilText(limits.fiveHour.resetsAt, now)}`);
  }
  if (limits.sevenDay) parts.push(`Weekly limit ${Math.round(limits.sevenDay.used * 100)}%`);
  return parts;
}

/** The window's bottom line: the session's harness and its context, then the account's usage limits. */
function SessionsStatusBar({ summary, chat, limits, now }: { summary?: SessionSummary; chat: ChatState | null; limits: UsageLimits; now: number }) {
  const left = chat ? [chat.harnessName] : summary ? [summary.harnessName] : [];
  const context = chat?.context ?? summary?.context;
  return (
    <div className="statusbar">
      {left.map((p) => (
        <span key={p}>{p}</span>
      ))}
      {context && <span>{contextText(context)}</span>}
      {replyParts(summary, now).map((p) => (
        <span key={p}>{p}</span>
      ))}
      <span className="spacer" />
      {limitParts(limits, now).map((p) => (
        <span key={p}>{p}</span>
      ))}
    </div>
  );
}

/** What a waiting or working session is about, in a line. */
function cardStatus(s: SessionSummary, now: number): string {
  if (s.waiting) return `${s.waiting.text} · ${waitedText(now - s.waiting.since)}`;
  return statusText(s);
}

/** A card's messages since the user's last one, scrolled to the newest. */
function CardMessages({ s }: { s: SessionSummary }) {
  const ref = useRef<HTMLDivElement>(null);
  const key = s.recent?.join('\n') ?? s.latest ?? '';
  useLayoutEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [key]);
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

/** A card's title: the session's state and name (and the Double Size button on the desktop), then where it runs and what it's doing. */
function CardTitle({ s, now, size }: { s: SessionSummary; now: number; size?: CardSize }) {
  return (
    <>
      <div className="overview-head">
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
        {s.kind === 'terminal' ? ' · Terminal' : s.kind === 'run' ? ' · Task run' : ''} · <span className={s.waiting ? 'warn' : ''}>{cardStatus(s, now)}</span>
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
function DashboardCard({ s, now, onOpen, size }: { s: SessionSummary; now: number; onOpen: (id: string) => void; size?: CardSize }) {
  const [reply, setReply] = useState('');
  const send = () => {
    if (!reply.trim()) return;
    window.looper.sessions.send([s.id], reply);
    setReply('');
  };
  return (
    <div
      className={cardClass(s, size)}
      onClick={() => onOpen(s.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        window.looper.sessions.showContextMenu(s.id, !!size);
      }}
    >
      <CardTitle s={s} now={now} size={size} />
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

/** The Overview on a phone: a summary card per session, the ones waiting for the user first. */
function Dashboard({ sessions, now, onOpen }: { sessions: SessionSummary[]; now: number; onOpen: (id: string) => void }) {
  if (sessions.length === 0) return <div className="empty">No chats are open.</div>;
  const waiting = waitingOf(sessions);
  const rest = sessions.filter((s) => !s.waiting);
  return (
    <div className="sessions-overview">
      {[...waiting, ...rest].map((s) => (
        <DashboardCard key={s.id} s={s} now={now} onOpen={onOpen} />
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
function ChatCard({ s, now, live, size, track, onOpen }: { s: SessionSummary; now: number; live: boolean; size: CardSize; track: TrackCard; onOpen: (id: string) => void }) {
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
      className={cardClass(s, size, ' overview-chat')}
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
        <CardTitle s={s} now={now} size={size} />
        {s.background > 0 && <div className="muted overview-meta">{backgroundText(s.background)}</div>}
      </div>
      {view ?? <CardMessages s={s} />}
    </div>
  );
}

/**
 * The Chats window's dashboard: a card per session in the list's order, so cards
 * don't move while you work in them. Each chat is a working chat; terminal
 * sessions and task runs are summaries. Any card can be twice its size.
 */
function ChatsDashboard({ s }: { s: SessionsWindow }) {
  const { sessions } = s.state;
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const [inView, track] = useCardsInView(root);
  const live = sessions.filter((x) => x.kind === 'chat' && inView.has(x.id)).map((x) => x.id);
  const liveKey = live.join('\n');
  // A layout effect, so the window takes the chats' events before the cards read them.
  useLayoutEffect(() => window.looper.sessions.showCards(live), [liveKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => () => window.looper.sessions.showCards([]), []);
  if (sessions.length === 0) return <div className="empty">No chats are open.</div>;
  const big = s.shown.bigCards;
  return (
    <div className="sessions-overview sessions-dashboard" ref={setRoot}>
      {sessions.map((x) => {
        const size = { big: big.includes(x.id), onToggle: () => s.toggleBig(x.id) };
        return x.kind === 'chat' ? (
          <ChatCard key={x.id} s={x} now={s.now} live={inView.has(x.id)} size={size} track={track} onOpen={s.setSelected} />
        ) : (
          <DashboardCard key={x.id} s={x} now={s.now} size={size} onOpen={s.setSelected} />
        );
      })}
    </div>
  );
}

/** A subagent's state as its tab's dot: pulsing while it runs, red when it failed. */
function SubagentMark({ status }: { status: SubagentInfo['status'] }) {
  return (
    <svg className={`session-icon ${status === 'running' ? 'working' : status === 'failed' ? 'failed' : 'ended'}`} width="14" height="14" viewBox="0 0 18 18" aria-hidden="true">
      <circle cx="9" cy="9" r="7" className="ring" fill="none" strokeWidth="2" />
      <circle cx="9" cy="9" r="3" className="core" />
    </svg>
  );
}

/** The conversation's tabs once the agent has started subagents: the main conversation, then one per subagent. */
function SubagentTabs({ subagents, following, onFollow }: { subagents: SubagentInfo[]; following: string | null; onFollow: (id: string | null) => void }) {
  return (
    <div className="subagent-tabs" role="tablist">
      <button role="tab" aria-selected={!following} className={`subagent-tab${following ? '' : ' active'}`} onClick={() => onFollow(null)}>
        Conversation
      </button>
      {subagents.map((a) => (
        <button
          key={a.agentId}
          role="tab"
          aria-selected={following === a.agentId}
          className={`subagent-tab${following === a.agentId ? ' active' : ''}`}
          title={`${a.description || a.type} (${a.type})`}
          onClick={() => onFollow(a.agentId)}
        >
          <SubagentMark status={a.status} />
          <span className="subagent-tab-label">{a.description || a.type}</span>
        </button>
      ))}
    </div>
  );
}

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
 * The Chats window's toolbar: the dashboard and Send to Chats, new
 * sessions (in the shown session's project, or a picked one), Stop, the
 * chat's Send Now and Close Conversation, and the session's folder.
 */
function SessionsToolbar({ s }: { s: SessionsWindow }) {
  const { summary, chat, stoppable } = s;
  const project = summary?.projectId;
  const fail = (e: Error) => void window.looper.showError(e.message);
  return (
    <div className="toolbar sessions-toolbar">
      <ToolButton icon={ICONS.dashboard} title="Dashboard" enabled onClick={() => s.setSelected(null)} pressed={!summary} />
      <ToolButton icon={ICONS.bullhorn} title="Send to Chats" enabled onClick={() => window.looper.sessions.openSend()} />
      <span className="toolbar-sep" />
      <SplitToolButton
        icon={ICONS.newChat}
        title={project ? `New Chat in ${summary!.groupName} (Ctrl+T)` : 'New Chat'}
        menuTitle="New Chat in Project"
        enabled
        onClick={project ? () => void window.looper.projects.newChat(project) : null}
        onMenu={(x, y) => window.looper.sessions.showNewMenu('chat', x, y)}
      />
      <SplitToolButton
        icon={ICONS.terminal}
        title={project ? `New Terminal in ${summary!.groupName}` : 'New Terminal'}
        menuTitle="New Terminal in Project"
        enabled
        onClick={project ? () => void window.looper.projects.newTerminal(project) : null}
        onMenu={(x, y) => window.looper.sessions.showNewMenu('terminal', x, y)}
      />
      <span className="toolbar-sep" />
      <ToolButton
        icon={ICONS.stopChat}
        title={summary?.kind === 'chat' ? 'Stop (Esc)' : 'Stop'}
        enabled={stoppable}
        onClick={() => void window.looper.sessions.stop(summary!.id).catch(fail)}
      />
      <ToolButton
        icon={ICONS.sendNow}
        title="Send Now (Ctrl+Enter)"
        enabled={(chat?.queued.length ?? 0) > 0}
        onClick={() => void window.looper.chat.sendNow(chat!.id).catch(fail)}
      />
      <ToolButton
        icon={ICONS.closeChat}
        title="Close Conversation (Ctrl+W)"
        enabled={!!summary && summary.kind !== 'run'}
        onClick={() => void window.looper.sessions.close(summary!.id)}
      />
      <span className="toolbar-sep" />
      <ToolButton icon={ICONS.folder} title="Open Working Directory" enabled={!!summary} onClick={() => void window.looper.openTaskWorkFolder(summary!.taskId)} />
    </div>
  );
}

/**
 * The Chats window: every chat and Looper terminal session (and, with Show
 * Task Runs on, each task run's agent), grouped by project, with the ones
 * waiting for the user first; the selected one in the middle; and what its
 * agent is doing on the right. `single`: a single chat's window (Open in New
 * Window), the chat panel alone, its activity pane hidden unless the View menu shows it.
 */
export function SessionsApp({ initial, single = false }: { initial?: string; single?: boolean }) {
  const s = useSessionsWindow(initial, single);
  if (isPhone) return <PhoneSessions s={s} single={single} />;
  return <DesktopSessions s={s} single={single} />;
}

/** The session shown: its chat, terminal, task run, or followed subagent; the Overview when none is. */
function SessionCenter({ s }: { s: SessionsWindow }) {
  const { summary, follow, followed, chat } = s;
  if (!summary) return s.single ? <div className="empty">Loading…</div> : <ChatsDashboard s={s} />;
  if (follow && followed) return <TranscriptView summary={summary} rows={s.subRows} waitingText="Waiting for the subagent's first message…" />;
  if (summary.kind === 'terminal') return <TerminalView key={summary.id} id={summary.id} />;
  if (summary.kind === 'run') return <TranscriptView key={summary.id} summary={summary} rows={s.activity?.rows ?? []} waitingText="Waiting for the agent's first message…" />;
  return chat ? <ChatView key={chat.id} state={chat} /> : <div className="empty">Loading…</div>;
}

/** The list's and the activity pane's widths, as last dragged. */
function savedWidths(): { left: number; right: number } {
  try {
    const saved = JSON.parse(localStorage.getItem(WIDTHS_KEY) ?? '') as { left: number; right: number };
    if (saved.left > 0 && saved.right > 0) return saved;
  } catch {
    /* the defaults */
  }
  return { left: 280, right: 400 };
}

function DesktopSessions({ s, single }: { s: SessionsWindow; single: boolean }) {
  const { state, selected, summary, chat, activity, shown, subagents } = s;
  const [widths, setWidths] = useState(savedWidths);
  const bodyRef = useRef<HTMLDivElement>(null);

  const saveWidths = (w: { left: number; right: number }) => {
    setWidths(w);
    localStorage.setItem(WIDTHS_KEY, JSON.stringify(w));
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
  const list = single ? '' : `${widths.left}px 5px `;

  return (
    <div className="sessions-app">
      {!single && shown.toolbar && <SessionsToolbar s={s} />}
      <div className="sessions-body" ref={bodyRef} style={{ gridTemplateColumns: pane ? `${list}1fr 5px ${widths.right}px` : `${list}1fr` }}>
        {!single && (
          <>
            <SessionList
              sessions={state.sessions}
              selected={selected}
              now={s.now}
              collapsed={shown.collapsed}
              onToggle={s.toggleGroup}
              onSelect={s.setSelected}
            />
            <div className="sidebar-divider" onMouseDown={dragLeft} />
          </>
        )}
        <main className="sessions-center">
          {summary && subagents.length > 0 && <SubagentTabs subagents={subagents} following={s.follow} onFollow={s.setFollow} />}
          <SessionCenter s={s} />
        </main>
        {pane && summary && (
          <>
            <div className="sidebar-divider" onMouseDown={dragRight} />
            <ActivityPanel
              sessionId={summary.id}
              taskId={summary.taskId}
              rows={s.watchedRows}
              attachments={s.attachments}
              background={activity?.background ?? []}
              subagents={subagents}
              gitProject={s.gitRepo ? summary.projectId : undefined}
              following={s.follow}
              onFollow={s.setFollow}
              pos={s.nowPos}
              onPos={s.setNowPos}
              now={s.now}
            />
          </>
        )}
      </div>
      {!single && shown.statusBar && <SessionsStatusBar summary={summary} chat={chat} limits={state.limits} now={s.now} />}
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
 * keyboard; the activity pane, with the status bar's facts, is a sheet. A
 * single chat's window is that chat's screen alone, and Back closes it.
 */
function PhoneSessions({ s, single }: { s: SessionsWindow; single: boolean }) {
  const { state, summary, chat, activity, subagents } = s;
  const [list, setList] = useState<PhoneList>('sessions');
  const [sheet, setSheet] = useState(false);
  useEffect(() => setSheet(false), [summary?.id]);
  const fail = (e: Error) => void window.looper.showError(e.message);

  const actions: PageNavAction[] = summary
    ? [
        ...(s.stoppable ? [{ id: 'stop', label: 'Stop', icon: 'stopChat', run: () => void window.looper.sessions.stop(summary.id).catch(fail) }] : []),
        ...((chat?.queued.length ?? 0) > 0 ? [{ id: 'send-now', label: 'Send Now', icon: 'sendNow', run: () => void window.looper.chat.sendNow(chat!.id).catch(fail) }] : []),
        { id: 'activity', label: 'Activity', run: () => setSheet(true) },
      ]
    : [
        { id: 'chat', label: 'New Chat', icon: 'newChat', run: () => window.looper.sessions.showNewMenu('chat', 0, 0) },
        { id: 'terminal', label: 'New Terminal', icon: 'terminal', run: () => window.looper.sessions.showNewMenu('terminal', 0, 0) },
        { id: 'send', label: 'Send to Chats', icon: 'bullhorn', run: () => window.looper.sessions.openSend() },
      ];
  const closeSheet = sheet ? () => setSheet(false) : undefined;
  usePageNav({
    title: summary ? summary.title : single ? undefined : 'Chats',
    back: summary && !single ? () => (sheet ? setSheet(false) : s.setSelected(null)) : closeSheet,
    actions: single && !summary ? [] : actions,
    largeTitle: platform === 'ios' && !summary && !single,
  });

  if (!summary && single) return <div className="empty">Loading…</div>;
  if (!summary) {
    return (
      <div className="phone-sessions phone-page">
        <div className="pg-scroll">
          <LargeTitle>Chats</LargeTitle>
          <div className="pg-segmented-wrap">
            <Segmented items={PHONE_LISTS} value={list} onChange={setList} label="Show" />
          </div>
          {list === 'sessions' ? (
            <section className="pg-group pg-sessions">
              <SessionList sessions={state.sessions} selected={null} now={s.now} collapsed={s.shown.collapsed} onToggle={s.toggleGroup} onSelect={s.setSelected} selectOnMenu={false} />
            </section>
          ) : (
            <Dashboard sessions={state.sessions} now={s.now} onOpen={s.setSelected} />
          )}
          {limitParts(state.limits, s.now).length > 0 && <p className="pg-group-footer">{limitParts(state.limits, s.now).join(' · ')}</p>}
        </div>
      </div>
    );
  }

  return (
    <div className={`phone-sessions phone-page phone-conversation kind-${summary.kind}`}>
      {subagents.length > 0 && <SubagentTabs subagents={subagents} following={s.follow} onFollow={s.setFollow} />}
      <main className="sessions-center">
        <SessionCenter s={s} />
      </main>
      {sheet && (
        <div className="pg-sheet-scrim" onClick={() => setSheet(false)}>
          <div className="pg-sheet" role="dialog" aria-label="Activity" onClick={(e) => e.stopPropagation()}>
            <div className="pg-sheet-grabber" aria-hidden="true" />
            <div className="pg-sheet-head">
              <span className="pg-sheet-title">Activity</span>
              {platform === 'ios' && (
                <button className="pg-sheet-done" onClick={() => setSheet(false)}>
                  Done
                </button>
              )}
            </div>
            <SessionsStatusBar summary={summary} chat={chat} limits={state.limits} now={s.now} />
            <ActivityPanel
              sessionId={summary.id}
              taskId={summary.taskId}
              rows={s.watchedRows}
              attachments={s.attachments}
              background={activity?.background ?? []}
              subagents={subagents}
              gitProject={s.gitRepo ? summary.projectId : undefined}
              following={s.follow}
              onFollow={(id) => {
                s.setFollow(id);
                setSheet(false);
              }}
              pos={s.nowPos}
              onPos={s.setNowPos}
              now={s.now}
            />
          </div>
        </div>
      )}
    </div>
  );
}

