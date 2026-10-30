import { useEffect, useLayoutEffect, useRef, useState } from 'react';
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

/** One session on the dashboard: its state, the agent's messages since the user's last one, and Allow/Deny or a reply box at the bottom. */
function DashboardCard({ s, now, onOpen }: { s: SessionSummary; now: number; onOpen: (id: string) => void }) {
  const [reply, setReply] = useState('');
  const send = () => {
    if (!reply.trim()) return;
    window.looper.sessions.send([s.id], reply);
    setReply('');
  };
  return (
    <div
      className={`overview-card${s.waiting && s.waiting.reason !== 'turn' ? ' waiting' : ''}`}
      onClick={() => onOpen(s.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        window.looper.sessions.showContextMenu(s.id);
      }}
    >
      <div className="overview-head">
        <SessionIcon s={s} />
        <span className="overview-title">{s.title}</span>
      </div>
      <div className="muted overview-meta">
        {s.groupName} · {s.harnessName}
        {s.kind === 'terminal' ? ' · Terminal' : ''} · <span className={s.waiting ? 'warn' : ''}>{cardStatus(s, now)}</span>
      </div>
      <CardMessages s={s} />
      {s.background > 0 && (
        <div className="muted">{s.background === 1 ? '1 running in the background' : `${s.background} running in the background`}</div>
      )}
      <div className="overview-actions" onClick={(e) => e.stopPropagation()}>
        {s.permissionId ? (
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

/** The dashboard: a card per session, the ones waiting for the user first. */
function Dashboard({ sessions, now, onOpen }: { sessions: SessionSummary[]; now: number; onOpen: (id: string) => void }) {
  if (sessions.length === 0) return <div className="empty">No sessions are open.</div>;
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

/** A subagent's conversation in the middle, read again while it runs. */
function SubagentView({ summary, rows }: { summary: SessionSummary; rows: MessageRow[] }) {
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
        {rows.length === 0 && <div className="muted">Waiting for the subagent's first message…</div>}
      </div>
    </div>
  );
}

/**
 * The Sessions window's toolbar: the dashboard and Send to Sessions, new
 * sessions (in the shown session's project, or a picked one), Stop, the
 * chat's Send Now and Close Conversation, and the session's folder.
 */
function SessionsToolbar({ summary, chat, onDashboard }: { summary?: SessionSummary; chat: ChatState | null; onDashboard: () => void }) {
  const project = summary?.projectId;
  const fail = (e: Error) => void window.looper.showError(e.message);
  const stoppable = summary?.status === 'working' || summary?.waiting?.reason === 'permission';
  return (
    <div className="toolbar sessions-toolbar">
      <ToolButton icon={ICONS.dashboard} title="Dashboard" enabled onClick={onDashboard} pressed={!summary} />
      <ToolButton icon={ICONS.bullhorn} title="Send to Sessions" enabled onClick={() => window.looper.sessions.openSend()} />
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
        enabled={!!summary}
        onClick={() => void window.looper.sessions.close(summary!.id)}
      />
      <span className="toolbar-sep" />
      <ToolButton icon={ICONS.folder} title="Open Working Directory" enabled={!!summary} onClick={() => void window.looper.openTaskWorkFolder(summary!.taskId)} />
    </div>
  );
}

/**
 * The Sessions window: every chat and Looper terminal session, grouped by
 * project, with the ones waiting for the user first; the selected one in the
 * middle; and what its agent is doing on the right.
 */
export function SessionsApp({ initial }: { initial?: string }) {
  const s = useSessionsWindow(initial);
  return isPhone ? <PhoneSessions s={s} /> : <DesktopSessions s={s} />;
}

/** The session shown: its chat, terminal, or followed subagent; the Overview when none is. */
function SessionCenter({ s }: { s: SessionsWindow }) {
  const { summary, follow, followed, chat } = s;
  if (!summary) return <Dashboard sessions={s.state.sessions} now={s.now} onOpen={s.setSelected} />;
  if (follow && followed) return <SubagentView summary={summary} rows={s.subRows} />;
  if (summary.kind === 'terminal') return <TerminalView key={summary.id} id={summary.id} />;
  return chat ? <ChatView key={chat.id} state={chat} /> : <div className="empty">Loading…</div>;
}

function DesktopSessions({ s }: { s: SessionsWindow }) {
  const { state, selected, summary, chat, activity, shown, subagents } = s;
  const [widths, setWidths] = useState<{ left: number; right: number }>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(WIDTHS_KEY) ?? '') as { left: number; right: number };
      if (saved.left > 0 && saved.right > 0) return saved;
    } catch {
      /* the defaults */
    }
    return { left: 280, right: 400 };
  });
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

  const pane = !!summary && shown.activityPane;

  return (
    <div className="sessions-app">
      {shown.toolbar && <SessionsToolbar summary={summary} chat={chat} onDashboard={() => s.setSelected(null)} />}
      <div
        className="sessions-body"
        ref={bodyRef}
        style={{ gridTemplateColumns: pane ? `${widths.left}px 5px 1fr 5px ${widths.right}px` : `${widths.left}px 5px 1fr` }}
      >
        <SessionList
          sessions={state.sessions}
          selected={selected}
          now={s.now}
          collapsed={shown.collapsed}
          onToggle={s.toggleGroup}
          onSelect={s.setSelected}
        />
        <div className="sidebar-divider" onMouseDown={dragLeft} />
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
      {shown.statusBar && <SessionsStatusBar summary={summary} chat={chat} limits={state.limits} now={s.now} />}
    </div>
  );
}

type PhoneList = 'sessions' | 'overview';
const PHONE_LISTS: [PhoneList, string][] = [
  ['sessions', 'Sessions'],
  ['overview', 'Overview'],
];

/**
 * The Sessions window on a phone: the session list (or the Overview, as a
 * list), then a session's own screen. A chat's message box stays above the
 * keyboard; the activity pane, with the status bar's facts, is a sheet.
 */
function PhoneSessions({ s }: { s: SessionsWindow }) {
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
        { id: 'send', label: 'Send to Sessions', icon: 'bullhorn', run: () => window.looper.sessions.openSend() },
      ];
  usePageNav({
    title: summary ? summary.title : 'Sessions',
    back: summary ? () => (sheet ? setSheet(false) : s.setSelected(null)) : sheet ? () => setSheet(false) : undefined,
    actions,
    largeTitle: platform === 'ios' && !summary,
  });

  if (!summary) {
    return (
      <div className="phone-sessions phone-page">
        <div className="pg-scroll">
          <LargeTitle>Sessions</LargeTitle>
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

