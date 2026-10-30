import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { contextText, type ChatState } from '@shared/chat';
import type { MessageRow } from '@shared/messages';
import type { SessionActivity, SessionsState, SessionSummary, SubagentInfo, UsageLimits } from '@shared/sessions';
import { waitedText } from '@shared/sessions';
import type { View } from '@shared/types';
import { ActivityPanel } from './components/ActivityPanel';
import { fmtClock } from './format';
import { ICONS } from './components/icons';
import { SplitToolButton, ToolButton } from './components/ToolButton';
import { ChatRow, ToolGroup, groupRows } from './components/ChatRows';
import { ChatView } from './components/ChatView';
import { useDragResize, useGitRepo } from './components/hooks';
import { SessionIcon, SessionList, statusText, waitingOf } from './components/SessionList';
import { TerminalView } from './components/TerminalView';
import { subscribe } from './events';

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
 * F6 and Shift+F6, as in Windows apps: the focus moves to the next or
 * previous pane (the session list, the conversation, the activity pane),
 * into its message box, terminal or selected tab.
 */
function focusPane(dir: 1 | -1): void {
  const panes = [
    { el: document.querySelector<HTMLElement>('.session-list'), target: (el: HTMLElement) => el },
    {
      el: document.querySelector<HTMLElement>('.sessions-center'),
      target: (el: HTMLElement) => el.querySelector<HTMLElement>('textarea:not(:disabled), input:not(:disabled), [tabindex="0"]'),
    },
    {
      el: document.querySelector<HTMLElement>('.activity-panel'),
      target: (el: HTMLElement) => el.querySelector<HTMLElement>('.tab.active') ?? el.querySelector<HTMLElement>('button'),
    },
  ].filter((p): p is { el: HTMLElement; target: (el: HTMLElement) => HTMLElement | null } => !!p.el);
  if (panes.length === 0) return;
  const at = panes.findIndex((p) => p.el.contains(document.activeElement));
  for (let n = 1; n <= panes.length; n++) {
    const p = panes[(((at === -1 ? (dir === 1 ? -1 : 0) : at) + dir * n) % panes.length + panes.length) % panes.length];
    const target = p.target(p.el);
    if (target) {
      target.focus();
      return;
    }
  }
}

/** The session list's order, for F8/F9 and the other keys that step through it. */
function stepTo(sessions: SessionSummary[], selected: string | null, dir: 1 | -1, waiting: boolean): string | null {
  const list = waiting ? waitingOf(sessions) : sessions;
  if (list.length === 0) return selected;
  const at = list.findIndex((s) => s.id === selected);
  if (at === -1) return list[dir === 1 ? 0 : list.length - 1].id;
  return list[(at + dir + list.length) % list.length].id;
}

/**
 * The Sessions window: every chat and Looper terminal session, grouped by
 * project, with the ones waiting for the user first; the selected one in the
 * middle; and what its agent is doing on the right.
 */
export function SessionsApp({ initial }: { initial?: string }) {
  const [state, setState] = useState<SessionsState>({ sessions: [], limits: {} });
  const [loaded, setLoaded] = useState(false);
  const [selected, setSelected] = useState<string | null>(initial ?? null);
  const [chat, setChat] = useState<ChatState | null>(null);
  const [activity, setActivity] = useState<SessionActivity | null>(null);
  const [follow, setFollow] = useState<string | null>(null);
  const [subRows, setSubRows] = useState<MessageRow[]>([]);
  // The tool call Now shows; null follows the latest.
  const [nowPos, setNowPos] = useState<number | null>(null);
  useEffect(() => setNowPos(null), [selected, follow]);
  const [now, setNow] = useState(Date.now());
  const [widths, setWidths] = useState<{ left: number; right: number }>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(WIDTHS_KEY) ?? '') as { left: number; right: number };
      if (saved.left > 0 && saved.right > 0) return saved;
    } catch {
      /* the defaults */
    }
    return { left: 280, right: 400 };
  });
  const [view, setView] = useState<View | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    document.title = 'Sessions';
    void window.looper.sessions.state().then((s) => {
      setState(s);
      setLoaded(true);
    });
    void window.looper.info().then((i) => setView(i.settings.view));
    const tick = setInterval(() => setNow(Date.now()), 15_000);
    const unsub = subscribe((e) => {
      if (e.type === 'sessions') setState(e.state);
      else if (e.type === 'chat' && e.state.id === selectedRef.current) setChat(e.state);
      else if (e.type === 'session:activity' && e.activity.id === selectedRef.current) setActivity(e.activity);
      else if (e.type === 'settings') setView(e.settings.view);
    });
    const unsubUi = window.looper.onUi((e) => {
      if (e.type === 'sessions-select') setSelected(e.id);
      else if (e.type === 'sessions-dashboard') setSelected(null);
      else if (e.type === 'sessions-nav') setSelected(stepTo(stateRef.current.sessions, selectedRef.current, e.dir, e.waiting));
      else if (e.type === 'sessions-pane') focusPane(e.dir);
    });
    // Capture phase, so a terminal doesn't get the keys the window takes.
    const onKey = (e: KeyboardEvent) => {
      const shown = stateRef.current.sessions.find((s) => s.id === selectedRef.current);
      const take = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      if (e.altKey || e.metaKey) return;
      // The keys without Fn: Ctrl+PageUp/PageDown, and with Shift for the waiting sessions.
      if (e.ctrlKey && (e.key === 'PageUp' || e.key === 'PageDown')) {
        take();
        setSelected(stepTo(stateRef.current.sessions, selectedRef.current, e.key === 'PageDown' ? 1 : -1, e.shiftKey));
      } else if (e.key === 'F6' && !e.ctrlKey) {
        take();
        focusPane(e.shiftKey ? -1 : 1);
      } else if (e.ctrlKey && !e.shiftKey && /^[1-9]$/.test(e.key)) {
        // As in browsers: Ctrl+1 to Ctrl+8 the session at that place in project order (Waiting for you aside), Ctrl+9 the last.
        const list = stateRef.current.sessions;
        const target = e.key === '9' ? list.at(-1) : list[Number(e.key) - 1];
        if (!target) return;
        take();
        setSelected(target.id);
      } else if (e.ctrlKey && !e.shiftKey && e.key === 'F4') {
        take();
        if (shown) void window.looper.sessions.close(shown.id);
      } else if (e.ctrlKey && !e.shiftKey && (e.key === 't' || e.key === 'w') && shown?.kind !== 'terminal') {
        // In a terminal session Ctrl+T and Ctrl+W are the agent's (and the shell's).
        take();
        if (e.key === 'w' && shown) void window.looper.sessions.close(shown.id);
        else if (e.key === 't' && shown?.projectId) void window.looper.projects.newChat(shown.projectId);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      clearInterval(tick);
      unsub();
      unsubUi();
      window.removeEventListener('keydown', onKey, true);
    };
  }, []);

  const summary = state.sessions.find((s) => s.id === selected);
  const gitRepo = useGitRepo(summary?.projectId);

  // A closed session leaves the window on the Overview. A new one isn't in the list
  // for a moment after it opens, so only one that was in it counts as closed.
  const listed = useRef(new Set<string>());
  useEffect(() => {
    for (const s of state.sessions) listed.current.add(s.id);
    if (loaded && selected && !summary && listed.current.has(selected)) setSelected(null);
  }, [loaded, selected, summary, state.sessions]);

  useEffect(() => {
    window.looper.sessions.show(selected);
    setChat(null);
    setActivity(null);
    setFollow(null);
    if (!selected) return;
    window.looper.sessions.seen(selected);
    void window.looper.chat.get(selected).then((c) => {
      if (c && c.id === selectedRef.current) setChat(c);
    });
    void window.looper.sessions.activity(selected).then((a) => {
      if (a && a.id === selectedRef.current) setActivity(a);
    });
  }, [selected]);

  // Looking at a session ends its wait for a finished turn or a notification.
  const waitKey = summary?.waiting ? `${summary.id}:${summary.waiting.reason}:${summary.waiting.since}` : '';
  useEffect(() => {
    if (!summary?.waiting || summary.waiting.reason === 'permission') return;
    if (document.hasFocus()) window.looper.sessions.seen(summary.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waitKey]);
  useEffect(() => {
    const onFocus = () => {
      if (selectedRef.current) window.looper.sessions.seen(selectedRef.current);
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  // A followed subagent's conversation, read again while the window shows it.
  useEffect(() => {
    setSubRows([]);
    if (!follow || !summary) return;
    let live = true;
    const load = () =>
      void window.looper.runs.messages(summary.taskId, summary.id, follow).then((r) => {
        if (live && r.status === 'ok') setSubRows(r.rows.filter((row) => row.kind !== 'raw'));
      });
    load();
    const timer = setInterval(load, 1500);
    return () => {
      live = false;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [follow, summary?.id]);

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

  const rows = summary?.kind === 'chat' ? (chat ? [...chat.history, ...chat.rows] : []) : (activity?.rows ?? []);
  const attachments = rows.flatMap((r) => r.attachments ?? []);
  const followed = activity?.subagents.find((a) => a.agentId === follow);
  const watchedRows = follow ? subRows : rows;
  const shown = view?.sessions ?? { toolbar: true, activityPane: true, statusBar: true, collapsed: [] };
  const pane = !!summary && shown.activityPane;
  const toggleGroup = (key: string) => {
    if (!view) return;
    const collapsed = shown.collapsed.includes(key) ? shown.collapsed.filter((k) => k !== key) : [...shown.collapsed, key];
    void window.looper.updateSettings({ view: { ...view, sessions: { ...shown, collapsed } } });
  };

  const subagents = activity?.subagents ?? [];
  let center;
  if (!summary) center = <Dashboard sessions={state.sessions} now={now} onOpen={setSelected} />;
  else if (follow && followed) center = <SubagentView summary={summary} rows={subRows} />;
  else if (summary.kind === 'terminal') center = <TerminalView key={summary.id} id={summary.id} />;
  else center = chat ? <ChatView key={chat.id} state={chat} /> : <div className="empty">Loading…</div>;

  return (
    <div className="sessions-app">
      {shown.toolbar && <SessionsToolbar summary={summary} chat={chat} onDashboard={() => setSelected(null)} />}
      <div
        className="sessions-body"
        ref={bodyRef}
        style={{ gridTemplateColumns: pane ? `${widths.left}px 5px 1fr 5px ${widths.right}px` : `${widths.left}px 5px 1fr` }}
      >
        <SessionList
          sessions={state.sessions}
          selected={selected}
          now={now}
          collapsed={shown.collapsed}
          onToggle={toggleGroup}
          onSelect={setSelected}
        />
        <div className="sidebar-divider" onMouseDown={dragLeft} />
        <main className="sessions-center">
          {summary && subagents.length > 0 && <SubagentTabs subagents={subagents} following={follow} onFollow={setFollow} />}
          {center}
        </main>
        {pane && summary && (
          <>
            <div className="sidebar-divider" onMouseDown={dragRight} />
            <ActivityPanel
              sessionId={summary.id}
              taskId={summary.taskId}
              rows={watchedRows}
              attachments={attachments}
              background={activity?.background ?? []}
              subagents={subagents}
              gitProject={gitRepo ? summary.projectId : undefined}
              following={follow}
              onFollow={setFollow}
              pos={nowPos}
              onPos={setNowPos}
              now={now}
            />
          </>
        )}
      </div>
      {shown.statusBar && <SessionsStatusBar summary={summary} chat={chat} limits={state.limits} now={now} />}
    </div>
  );
}
