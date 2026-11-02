import { useEffect, useMemo, useRef, useState } from 'react';
import {
  filterHistory,
  groupHistory,
  HISTORY_PAGE,
  NO_HISTORY_COMMANDS,
  type HistoryCommand,
  type HistoryCommands,
  type HistoryConversation,
  type HistoryFolderFilter,
  type HistoryItem,
  type HistoryList as HistoryListResult,
} from '@shared/history';
import type { MessageRow } from '@shared/messages';
import { ViewSchema, type Project, type View } from '@shared/types';
import { DESKTOP_ONLY, NOT_MOBILE } from '@shared/ui-platform';
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
 * The History window: the conversations on this computer on the left, newest
 * first, Looper's recorded runs and every Claude Code and Codex one in the
 * environments' folders, a page at a time; the selected one, read only, in
 * the middle with its subagents' tabs; and the activity pane on the right,
 * hidden until View → Activity Pane shows it. Edit → Find shows the find bar.
 */
export function HistoryApp() {
  const [items, setItems] = useState<HistoryItem[] | null>(null);
  const [more, setMore] = useState(false);
  const [limit, setLimit] = useState(HISTORY_PAGE);
  const [loadingMore, setLoadingMore] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [view, setView] = useState<View['history']>(DEFAULT_VIEW);
  const [viewKnown, setViewKnown] = useState(false);
  const [folder, setFolder] = useState<HistoryFolderFilter>('');
  /** F5: each one reads the folders again. */
  const [refreshes, setRefreshes] = useState(1);
  const [finding, setFinding] = useState(false);
  /** Edit → Find counts up: the find box takes the focus and selects what it holds, once it shows. */
  const [findFocus, setFindFocus] = useState(0);
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
  const loads = useRef(0);
  const freshDone = useRef(0);
  const scanning = useRef(false);

  const loadCommands = () => {
    const id = selectedRef.current;
    if (!id) return setCommands(NO_HISTORY_COMMANDS);
    void window.looper.history.commands(id).then((c) => {
      if (selectedRef.current === id) setCommands(c);
    });
  };

  const openFind = () => {
    setFinding(true);
    setFindFocus((n) => n + 1);
  };
  useEffect(() => {
    if (!findFocus) return;
    searchRef.current?.focus();
    searchRef.current?.select();
  }, [findFocus]);

  useEffect(() => {
    document.title = 'History';
    void window.looper.projects.list().then(setProjects);
    void window.looper.info().then((i) => {
      setView(i.settings.view.history);
      setViewKnown(true);
    });
    const unsub = subscribe((e) => {
      if (e.type === 'settings') setView(e.settings.view.history);
      else if (e.type === 'projects') setProjects(e.projects);
      // A chat or terminal opening or closing on a conversation changes what Continue offers.
      else if (e.type === 'sessions') loadCommands();
    });
    const unsubUi = window.looper.onUi((e) => {
      if (e.type === 'history-activity') setActivity(e.checked);
      else if (e.type === 'history-refresh') setRefreshes((n) => n + 1);
      else if (e.type === 'history-folder') setFolder(e.folder);
      else if (e.type === 'history-find') openFind();
    });
    return () => {
      unsub();
      unsubUi();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The list: what the engine knows at once, then, on opening and on F5, what the folders hold now. The latest load wins.
  useEffect(() => {
    if (!viewKnown) return;
    const n = ++loads.current;
    const o = { limit, showRuns: view.showRuns, folder };
    // A filter or Show More while the folders are read waits for them too, so it doesn't list the old files.
    const fresh = refreshes !== freshDone.current || scanning.current;
    freshDone.current = refreshes;
    let freshIn = false;
    const take = (l: HistoryListResult) => {
      if (n !== loads.current) return;
      setItems(l.items);
      setMore(l.more);
    };
    const quick = window.looper.history.list({ ...o, fresh: false }).then((l) => {
      if (!freshIn) take(l);
    }, fail);
    if (!fresh) {
      void quick.finally(() => n === loads.current && setLoadingMore(false));
      return;
    }
    scanning.current = true;
    void window.looper.history
      .list({ ...o, fresh: true })
      .then((l) => {
        freshIn = true;
        take(l);
      }, fail)
      .finally(() => {
        scanning.current = false;
        if (n === loads.current) setLoadingMore(false);
      });
  }, [viewKnown, view.showRuns, folder, limit, refreshes]);

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

  // Typing filters by title; Search Messages reads the listed conversations' messages, until the text changes.
  const typed = (text: string) => {
    setQuery(text);
    setFound(null);
  };
  const searchMessages = () => {
    const q = query.trim();
    if (!q || !items) return setFound(null);
    setSearching(true);
    void window.looper.history
      .search(
        q,
        items.map((i) => i.id),
      )
      .then((ids) => setFound(new Set(ids)), fail)
      .finally(() => setSearching(false));
  };
  const closeFind = () => {
    setFinding(false);
    setQuery('');
    setFound(null);
  };

  const shown = useMemo(() => filterHistory(items ?? [], { title: query, found }), [items, query, found]);
  const groups = useMemo(() => groupHistory(shown, view.groupBy, projects, Date.now()), [shown, view.groupBy, projects]);
  const item = items?.find((i) => i.id === selected);

  const run = (command: HistoryCommand) => () => {
    if (selected) void window.looper.history.run(selected, command).catch(fail);
  };
  const toolbar: ToolbarGroup[] = [
    {
      id: 'continue',
      items: [
        { id: 'chat', label: 'Continue in Chat', icon: 'chat', enabled: commands.chat, run: run('chat') },
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
    {
      id: 'panes',
      platforms: NOT_MOBILE,
      items: [{ id: 'activity-pane', label: 'Activity Pane', icon: 'activity', enabled: !!item, pressed: !!item && activity, run: () => window.looper.history.toggleActivity() }],
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
    items === null ? 'Loading…' : found ? `No conversation’s messages contain “${query.trim()}”.` : query.trim() ? 'No conversation’s title contains that.' : 'No conversations.';
  const findStatus = searching ? 'Searching…' : found ? (found.size === 1 ? '1 conversation' : `${found.size} conversations`) : '';

  return (
    <div className="sessions-app history-app">
      <Toolbar groups={toolbar} className="sessions-toolbar" />
      {finding && (
        <div
          className="chat-find"
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              searchMessages();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              closeFind();
            }
          }}
        >
          <AddonSearchBox value={query} onChange={typed} placeholder="Find" inputRef={(el) => (searchRef.current = el)} />
          <span className="muted">{findStatus}</span>
          <button className="btn small" disabled={!query.trim() || searching} onClick={searchMessages}>
            Search Messages
          </button>
          <button className="btn small" onClick={closeFind}>
            Close
          </button>
        </div>
      )}
      <div
        className="sessions-body"
        ref={bodyRef}
        style={{ gridTemplateColumns: `minmax(200px, ${widths.left}px) 5px minmax(480px, 1fr)${pane ? ` 5px minmax(280px, ${widths.right}px)` : ''}` }}
      >
        <HistoryList
          groups={groups}
          projects={projects}
          selected={selected}
          onSelect={setSelected}
          emptyText={emptyText}
          showPlace={view.groupBy !== 'folder'}
          more={more && !found}
          loadingMore={loadingMore}
          onMore={() => {
            setLoadingMore(true);
            setLimit((l) => l + HISTORY_PAGE);
          }}
        />
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
