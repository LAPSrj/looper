import { useEffect, useRef, useState } from 'react';
import type { ChatState } from '@shared/chat';
import type { MessageRow } from '@shared/messages';
import { canStop, dashboardOrder, placeCard, waitingOf, type SessionActivity, type SessionsState, type SessionSummary } from '@shared/sessions';
import { ViewSchema, type View } from '@shared/types';
import { openWorkflow } from '@shared/workflows';
import { useGitRepo } from './components/hooks';
import { subscribe } from './events';

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

/** The Chats window's View menu before the settings arrive. */
export const DEFAULT_SHOWN: View['sessions'] = ViewSchema.parse({}).sessions;

/** The session list's order, for F8/F9 and the other keys that step through it. */
function stepTo(sessions: SessionSummary[], selected: string | null, dir: 1 | -1, waiting: boolean): string | null {
  const list = waiting ? waitingOf(sessions) : sessions;
  if (list.length === 0) return selected;
  const at = list.findIndex((s) => s.id === selected);
  if (at === -1) return list[dir === 1 ? 0 : list.length - 1].id;
  return list[(at + dir + list.length) % list.length].id;
}

/**
 * The Chats window's state and commands, shared by its desktop and phone
 * views: every session, the one shown (null: the Overview), its chat or
 * activity, the followed subagent or open workflow, and the window's keys. `single`: a single
 * chat's window (Open in New Window), which shows `initial` only and takes no
 * keys that move through the list. `tab`: the main window's Chats tab, which
 * takes the keys and counts as looking at the session only while `active`.
 */
export function useSessionsWindow(initial?: string, single = false, tab?: { active: boolean }) {
  const active = tab?.active ?? true;
  const activeRef = useRef(active);
  activeRef.current = active;
  const [state, setState] = useState<SessionsState>({ sessions: [], limits: {} });
  const [loaded, setLoaded] = useState(false);
  const [selected, setSelected] = useState<string | null>(initial ?? null);
  const [chat, setChat] = useState<ChatState | null>(null);
  const [activity, setActivity] = useState<SessionActivity | null>(null);
  const [follow, setFollowed] = useState<string | null>(null);
  // The workflow run whose tab is open, and the agent whose tab is open inside it (null: its Overview).
  const [workflowOpen, setWorkflowOpen] = useState<{ runId: string; agentId: string | null } | null>(null);
  const workflow = openWorkflow(activity?.workflows ?? [], workflowOpen);
  // The conversation shown instead of the session's, which Now follows: a subagent's or a workflow agent's.
  const watchedAgent = follow ?? workflow?.agent?.agentId ?? null;
  /** Show a subagent's tab (null: the conversation's). */
  const setFollow = (id: string | null) => {
    setFollowed(id);
    setWorkflowOpen(null);
  };
  /** Show a workflow run's tab, at its Overview or one of its agents (null: the conversation's). */
  const showWorkflow = (runId: string | null, agentId: string | null = null) => {
    setFollowed(null);
    setWorkflowOpen(runId ? { runId, agentId } : null);
  };
  const [subRows, setSubRows] = useState<MessageRow[]>([]);
  // The tool call Now shows; null follows the latest.
  const [nowPos, setNowPos] = useState<number | null>(null);
  useEffect(() => setNowPos(null), [selected, watchedAgent]);
  const [view, setView] = useState<View | null>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    if (!single && !tab) document.title = 'Chats';
    void window.looper.sessions.state().then((s) => {
      setState(s);
      setLoaded(true);
    });
    void window.looper.info().then((i) => setView(i.settings.view));
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
      if (e.altKey || e.metaKey || !activeRef.current) return;
      if (single) {
        // The window's own chat: F6 between its panes, and Close Conversation.
        if (e.key === 'F6' && !e.ctrlKey) {
          take();
          focusPane(e.shiftKey ? -1 : 1);
        } else if (e.ctrlKey && !e.shiftKey && (e.key === 'F4' || (e.key === 'w' && shown?.kind !== 'terminal'))) {
          take();
          if (shown) void window.looper.sessions.close(shown.id);
        }
        return;
      }
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
      } else if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 't' && shown?.kind !== 'terminal') {
        // Ctrl+Shift+T is New Terminal in the project, as in the main window.
        take();
        if (shown?.projectId) void window.looper.projects.newTerminal(shown.projectId);
      } else if (e.ctrlKey && !e.shiftKey && (e.key === 't' || e.key === 'w') && shown?.kind !== 'terminal') {
        // In a terminal session Ctrl+T and Ctrl+W are the agent's (and the shell's).
        take();
        if (e.key === 'w' && shown) void window.looper.sessions.close(shown.id);
        else if (e.key === 't' && shown?.projectId) void window.looper.projects.newChat(shown.projectId);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      unsub();
      unsubUi();
      window.removeEventListener('keydown', onKey, true);
    };
  }, []);

  const summary = state.sessions.find((s) => s.id === selected);
  const gitRepo = useGitRepo(summary?.projectId);

  // A single chat's window is titled with the chat's name, which its first message gives it.
  useEffect(() => {
    if (single && summary) document.title = summary.title;
  }, [single, summary?.title]);

  // A closed session leaves the window on the Overview (a single chat's window closes with it).
  // A new one isn't in the list for a moment after it opens, so only one that was in it counts as closed.
  const listed = useRef(new Set<string>());
  useEffect(() => {
    for (const s of state.sessions) listed.current.add(s.id);
    if (!single && loaded && selected && !summary && listed.current.has(selected)) setSelected(null);
  }, [single, loaded, selected, summary, state.sessions]);
  // One that never turns up (it failed to start, or closed before it was listed) gives up and shows the dashboard.
  const waitingFor = !single && loaded && selected && !summary ? selected : null;
  useEffect(() => {
    if (!waitingFor) return;
    const t = setTimeout(() => setSelected((s) => (s === waitingFor ? null : s)), 15_000);
    return () => clearTimeout(t);
  }, [waitingFor]);

  useEffect(() => {
    setChat(null);
    setActivity(null);
    setFollowed(null);
    setWorkflowOpen(null);
    if (selected && activeRef.current) window.looper.sessions.seen(selected);
  }, [selected]);

  // The shown session's events come only while it shows (a Chats tab behind another tab gets none), so it's read again each time it does.
  useEffect(() => {
    window.looper.sessions.show(active ? selected : null);
    if (!selected || !active) return;
    void window.looper.chat.get(selected).then((c) => {
      if (c && c.id === selectedRef.current) setChat(c);
    });
    void window.looper.sessions.activity(selected).then((a) => {
      if (a && a.id === selectedRef.current) setActivity(a);
    });
  }, [selected, active]);

  // Looking at a session ends its wait for a finished turn or a notification.
  const waitKey = summary?.waiting ? `${summary.id}:${summary.waiting.reason}:${summary.waiting.since}` : '';
  useEffect(() => {
    if (!summary?.waiting || summary.waiting.reason === 'permission' || !active) return;
    if (document.hasFocus()) window.looper.sessions.seen(summary.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waitKey, active]);
  useEffect(() => {
    const onFocus = () => {
      if (selectedRef.current && activeRef.current) window.looper.sessions.seen(selectedRef.current);
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  // A followed subagent's (or open workflow agent's) conversation, read again while the window shows it.
  useEffect(() => {
    setSubRows([]);
    if (!watchedAgent || !summary) return;
    let live = true;
    const load = () =>
      void window.looper.runs.messages(summary.taskId, summary.id, watchedAgent).then((r) => {
        if (live && r.status === 'ok') setSubRows(r.rows.filter((row) => row.kind !== 'raw'));
      });
    load();
    const timer = setInterval(load, 1500);
    return () => {
      live = false;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchedAgent, summary?.id]);

  const rows = summary?.kind === 'chat' ? (chat ? [...chat.history, ...chat.rows] : []) : (activity?.rows ?? []);
  const attachments = rows.flatMap((r) => r.attachments ?? []);
  const followed = activity?.subagents.find((a) => a.agentId === follow);
  const watchedRows = watchedAgent ? subRows : rows;
  const shown = view?.sessions ?? DEFAULT_SHOWN;
  /** Change the window's saved View settings. */
  const setShown = (patch: Partial<View['sessions']>) => {
    if (view) void window.looper.updateSettings({ view: { ...view, sessions: { ...shown, ...patch } } });
  };
  const toggleGroup = (key: string) => {
    setShown({ collapsed: shown.collapsed.includes(key) ? shown.collapsed.filter((k) => k !== key) : [...shown.collapsed, key] });
  };
  /** A dashboard card at twice its size, or back; the closed sessions' ids go when one changes. */
  const toggleBig = (id: string) => {
    const big = shown.bigCards.includes(id);
    const bigCards = shown.bigCards.filter((x) => x !== id && state.sessions.some((s) => s.id === x));
    setShown({ bigCards: big ? bigCards : [...bigCards, id] });
  };
  /**
   * A dashboard card dragged before (or `after`) another: the order is saved
   * as every open session's, apart from the waiting ones put first, so the closed sessions' ids go.
   */
  const moveCard = (id: string, target: string, after: boolean) => {
    const ids = dashboardOrder(state.sessions, shown.cardOrder, false).map((s) => s.id);
    setShown({ cardOrder: placeCard(ids, id, target, after) });
  };
  const subagents = activity?.subagents ?? [];
  const stoppable = canStop(summary, chat?.runningCommands);

  return {
    single,
    state,
    selected,
    setSelected,
    summary,
    chat,
    activity,
    follow,
    setFollow,
    followed,
    workflow,
    showWorkflow,
    subRows,
    subagents,
    workflows: activity?.workflows ?? [],
    nowPos,
    setNowPos,
    view,
    shown,
    setShown,
    toggleGroup,
    toggleBig,
    moveCard,
    gitRepo,
    attachments,
    watchedRows,
    watchedAgent,
    stoppable,
  };
}

export type SessionsWindow = ReturnType<typeof useSessionsWindow>;
