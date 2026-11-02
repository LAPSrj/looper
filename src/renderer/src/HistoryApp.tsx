import { useEffect, useMemo, useRef, useState } from 'react';
import {
  filterHistory,
  groupHistory,
  NO_HISTORY_COMMANDS,
  type HistoryCommand,
  type HistoryCommands,
  type HistoryConversation,
  type HistoryItem,
} from '@shared/history';
import type { MessageRow } from '@shared/messages';
import { ViewSchema, type Project, type View } from '@shared/types';
import { DESKTOP_ONLY } from '@shared/ui-platform';
import { ActivityPanel } from './components/ActivityPanel';
import { AddonSearchBox } from './components/AddonPane';
import { ChatRow, ToolGroup, groupRows } from './components/ChatRows';
import { HistoryList } from './components/HistoryList';
import { useDragResize } from './components/hooks';
import { Tabs, type TabItem } from './components/Tabs';
import { Toolbar } from './components/Toolbar';
import type { ToolbarGroup } from './components/toolbar-model';
import { subscribe } from './events';

const WIDTHS_KEY = 'history.widths';
const DEFAULT_VIEW: View['history'] = ViewSchema.parse({}).history;

function savedWidths(): { left: number; right: number } {
  try {
    const saved = JSON.parse(localStorage.getItem(WIDTHS_KEY) ?? '') as { left: number; right: number };
    if (saved.left > 0 && saved.right > 0) return saved;
  } catch {
    /* the defaults */
  }
  return { left: 320, right: 400 };
}

const fail = (e: Error) => void window.looper.showError(e.message);

/** The conversation in the middle, read only: its rows as a chat shows them. */
function ConversationView({ rows, ctx, empty }: { rows: MessageRow[]; ctx: { taskId: string; runId: string }; empty: string }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // A conversation opens at its end, where it left off.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [rows]);
  return (
    <div className="chat-app">
      <div className="chat-scroll" ref={scrollRef}>
        {groupRows(rows).map((item) =>
          item.kind === 'tools' ? <ToolGroup key={item.rows[0].id} rows={item.rows} ctx={ctx} /> : <ChatRow key={item.row.id} row={item.row} ctx={ctx} />,
        )}
        {rows.length === 0 && <div className="muted">{empty}</div>}
      </div>
    </div>
  );
}

/**
 * The History window: every project's conversations on the left, Looper's
 * recorded runs and the ones started in Claude Code or Codex outside it; the
 * selected one, read only, in the middle with its subagents' tabs; and the
 * activity pane on the right, hidden until View → Activity Pane shows it.
 */
export function HistoryApp() {
  const [items, setItems] = useState<HistoryItem[] | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [view, setView] = useState<View['history']>(DEFAULT_VIEW);
  const [projectId, setProjectId] = useState('');
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<ReadonlySet<string> | null>(null);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [conv, setConv] = useState<HistoryConversation | null>(null);
  const [follow, setFollow] = useState<string | null>(null);
  const [subRows, setSubRows] = useState<MessageRow[]>([]);
  const [commands, setCommands] = useState<HistoryCommands>(NO_HISTORY_COMMANDS);
  const [activity, setActivity] = useState(false);
  const [nowPos, setNowPos] = useState<number | null>(null);
  const [widths, setWidths] = useState(savedWidths);
  const bodyRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  /** The list: the cached conversations at once, then what the folders hold now. */
  const load = () => {
    void window.looper.history.list(false).then((list) => setItems((prev) => prev ?? list));
    void window.looper.history.list(true).then(setItems, fail);
  };

  const loadCommands = () => {
    const id = selectedRef.current;
    if (!id) return setCommands(NO_HISTORY_COMMANDS);
    void window.looper.history.commands(id).then((c) => {
      if (selectedRef.current === id) setCommands(c);
    });
  };

  useEffect(() => {
    document.title = 'History';
    load();
    void window.looper.projects.list().then(setProjects);
    void window.looper.info().then((i) => setView(i.settings.view.history));
    const unsub = subscribe((e) => {
      if (e.type === 'settings') setView(e.settings.view.history);
      else if (e.type === 'projects') setProjects(e.projects);
      // A chat or terminal opening or closing on a conversation changes what Continue offers.
      else if (e.type === 'sessions') loadCommands();
    });
    const unsubUi = window.looper.onUi((e) => {
      if (e.type === 'history-activity') setActivity(e.checked);
      else if (e.type === 'history-refresh') load();
      else if (e.type === 'history-find') searchRef.current?.focus();
    });
    return () => {
      unsub();
      unsubUi();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    window.looper.history.select(selected);
    setConv(null);
    setFollow(null);
    setNowPos(null);
    loadCommands();
    if (!selected) return;
    void window.looper.history.read(selected).then((c) => {
      if (selectedRef.current === selected) setConv(c ?? { rows: [], subagents: [] });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  // A subagent's conversation, in its tab.
  useEffect(() => {
    setSubRows([]);
    setNowPos(null);
    if (!follow || !selected) return;
    void window.looper.history.read(selected, follow).then((c) => {
      if (selectedRef.current === selected) setSubRows(c?.rows ?? []);
    });
  }, [follow, selected]);

  // Typing filters by title; Enter searches the messages, until the text changes.
  const typed = (text: string) => {
    setQuery(text);
    setFound(null);
  };
  const searchMessages = () => {
    const q = query.trim();
    if (!q) return setFound(null);
    setSearching(true);
    void window.looper.history
      .search(q)
      .then((ids) => setFound(new Set(ids)), fail)
      .finally(() => setSearching(false));
  };

  const shown = useMemo(() => filterHistory(items ?? [], { projectId, showRuns: view.showRuns, title: query, found }), [items, projectId, view.showRuns, query, found]);
  const groups = useMemo(() => groupHistory(shown, view.groupBy, projects, Date.now()), [shown, view.groupBy, projects]);
  const item = items?.find((i) => i.id === selected);

  const run = (command: HistoryCommand) => () => {
    if (selected) void window.looper.history.run(selected, command).catch(fail);
  };
  const toolbar: ToolbarGroup[] = [
    {
      id: 'continue',
      items: [
        { id: 'chat', label: 'Continue in Chat', icon: 'chat', labeled: true, enabled: commands.chat, run: run('chat') },
        { id: 'compact', label: 'Continue Compacted', icon: 'compact', enabled: commands.compact, run: run('compact') },
        { id: 'terminal', label: 'Continue in Terminal', icon: 'terminal', enabled: commands.terminal, run: run('terminal') },
      ],
    },
    {
      id: 'session',
      items: [
        { id: 'copy-id', label: 'Copy Session ID', icon: 'copy', enabled: !!commands.sessionId, run: run('copy-id') },
        { id: 'open-folder', label: 'Open Working Directory', icon: 'folder', platforms: DESKTOP_ONLY, enabled: commands.folder, run: run('open-folder') },
      ],
    },
  ];

  const saveWidths = (w: { left: number; right: number }) => {
    setWidths(w);
    localStorage.setItem(WIDTHS_KEY, JSON.stringify(w));
  };
  const dragLeft = useDragResize({
    axis: 'x',
    containerRef: bodyRef,
    onDrag: (pos) => saveWidths({ ...widths, left: Math.min(560, Math.max(200, pos)) }),
  });
  const dragRight = useDragResize({
    axis: 'x',
    containerRef: bodyRef,
    onDrag: (pos, rect) => saveWidths({ ...widths, right: Math.min(720, Math.max(280, rect.width - pos)) }),
  });

  const pane = activity && !!item && !!conv;
  const subagents = conv?.subagents ?? [];
  const followed = subagents.find((a) => a.agentId === follow);
  const rows = conv?.rows ?? [];
  const watched = follow ? subRows : rows;
  const ctx = { taskId: item?.taskId ?? '', runId: item?.runId ?? '' };
  const tabs: TabItem[] = [
    { id: 'conversation', label: 'Conversation', dividerAfter: true },
    ...subagents.map((a) => ({ id: `agent:${a.agentId}`, label: a.description || a.type, title: `${a.description || a.type} (${a.type})`, status: a.status })),
  ];
  const emptyText =
    items === null ? 'Loading…' : searching ? 'Searching…' : found ? `No conversation’s messages contain “${query.trim()}”.` : query.trim() ? 'No conversation’s title contains that.' : 'No conversations.';

  return (
    <div className="sessions-app history-app">
      <Toolbar groups={toolbar} className="sessions-toolbar history-toolbar">
        <select className="history-project" aria-label="Project" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          <option value="">All Projects</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <div
          className="history-search"
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            searchMessages();
          }}
        >
          <AddonSearchBox value={query} onChange={typed} placeholder="Search" inputRef={(el) => (searchRef.current = el)} />
        </div>
      </Toolbar>
      <div
        className="sessions-body"
        ref={bodyRef}
        style={{ gridTemplateColumns: `minmax(200px, ${widths.left}px) 5px minmax(480px, 1fr)${pane ? ` 5px minmax(280px, ${widths.right}px)` : ''}` }}
      >
        <HistoryList groups={groups} projects={projects} selected={selected} onSelect={setSelected} emptyText={emptyText} />
        <div className="sidebar-divider" onMouseDown={dragLeft} />
        <main className="sessions-center">
          {!item ? (
            <div className="empty">No conversation is selected.</div>
          ) : !conv ? (
            <div className="empty">Loading…</div>
          ) : (
            <>
              {subagents.length > 0 && (
                <Tabs
                  tabs={tabs}
                  active={follow ? `agent:${follow}` : 'conversation'}
                  onSelect={(id) => setFollow(id === 'conversation' ? null : id.slice('agent:'.length))}
                  label="Conversation and agents"
                  className="subagent-tabs"
                  ctrlTab
                />
              )}
              {follow && followed ? (
                <ConversationView key={`${item.id}:${follow}`} rows={subRows} ctx={ctx} empty="The subagent has no messages." />
              ) : (
                <ConversationView key={item.id} rows={rows} ctx={ctx} empty="The conversation has no messages." />
              )}
            </>
          )}
        </main>
        {pane && item && (
          <>
            <div className="sidebar-divider" onMouseDown={dragRight} />
            <ActivityPanel
              sessionId={item.runId ?? ''}
              taskId={item.taskId}
              rows={watched}
              rowsAgent={follow}
              attachments={watched.flatMap((r) => r.attachments ?? [])}
              background={[]}
              only={['now', 'files']}
              subagents={subagents}
              following={follow}
              onFollow={setFollow}
              onOpenWorkflow={() => undefined}
              working={false}
              pos={nowPos}
              onPos={setNowPos}
            />
          </>
        )}
      </div>
    </div>
  );
}
