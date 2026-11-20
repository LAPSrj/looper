import { useEffect, useMemo, useRef, useState } from 'react';
import {
  filterHistory,
  groupHistory,
  HISTORY_PAGE,
  NO_HISTORY_COMMANDS,
  type HistoryCommands,
  type HistoryConversation,
  type HistoryFolderFilter,
  type HistoryItem,
  type HistoryList as HistoryListResult,
} from '@shared/history';
import type { MessageRow } from '@shared/messages';
import { ViewSchema, type Project, type View } from '@shared/types';
import { HISTORY_VIEWS } from '@shared/commands/build';
import type { CommandContext } from '@shared/commands/context';
import { ActivityPanel } from './components/ActivityPanel';
import { EmptyState } from './components/EmptyState';
import { FindStrip, useFindFocus } from './components/FindBar';
import { commandToolbar, phoneNav } from './components/command-surfaces';
import { useCommandMenu, useCommandState } from './components/useCommands';
import { HistoryList } from './components/HistoryList';
import { SubagentTabs } from './components/SubagentIcon';
import { Inspector, useInspector } from './components/Inspector';
import { ListDetail } from './components/ListDetail';
import { NavBar } from './components/NavBar';
import { TreeListSection } from './components/phone/PhoneList';
import { useSplit } from './components/phone/PhoneSplit';
import { Toolbar } from './components/Toolbar';
import { TranscriptView } from './components/Transcript';
import { subscribe } from './events';
import { isPhone } from './web/page-nav';
import { reportError } from './report-error';

const WIDTHS_KEY = 'history.widths';
const DEFAULT_VIEW: View['history'] = ViewSchema.parse({}).history;


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
  const findField = useFindFocus();
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
  // A phone or tablet: its own Activity, as its bar's button; the desktop's follows View → Activity Pane (`activity`).
  const split = useSplit();
  const panel = useInspector<'now'>('now', !!split?.inspector);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const loads = useRef(0);
  const freshDone = useRef(0);
  const scanning = useRef(false);
  /** The current load's calls, by request number: what each one's list so far does. */
  const progress = useRef(new Map<number, (l: HistoryListResult) => void>());
  /** The filters the last load listed with, and the list it shows. */
  const lastFilters = useRef('');
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const loadCommands = () => {
    const id = selectedRef.current;
    if (!id) return setCommands(NO_HISTORY_COMMANDS);
    void window.looper.history.commands(id).then((c) => {
      if (selectedRef.current === id) setCommands(c);
    });
  };

  const openFind = () => {
    setFinding(true);
    findField.focus();
  };

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
      if (e.type === 'history-progress') progress.current.get(e.request)?.(e.list);
    });
    return () => {
      unsub();
      unsubUi();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The list: what the engine knows at once, then, on opening and on F5, what the folders hold now. The latest load wins.
  // Each call's list shows as the engine reads it (history-progress), so the first conversations show while the rest are read.
  useEffect(() => {
    if (!viewKnown) return;
    const n = ++loads.current;
    const o = { limit, showRuns: view.showRuns, folder };
    // A filter or Show More while the folders are read waits for them too, so it doesn't list the old files.
    const fresh = refreshes !== freshDone.current || scanning.current;
    freshDone.current = refreshes;
    let freshIn = false;
    // How many conversations show now: a list on its way never shows fewer than that. With the same
    // filters (Show More, Refresh) the list already shown counts; a filter changed lists other conversations.
    const filters = JSON.stringify([view.showRuns, folder]);
    let shown = filters === lastFilters.current ? (itemsRef.current?.length ?? -1) : -1;
    lastFilters.current = filters;
    const take = (l: HistoryListResult, partial: boolean) => {
      if (n !== loads.current) return;
      shown = l.items.length;
      setItems(l.items);
      setMore(partial || l.more);
      // A list on its way ends in a greyed Loading… where Show More goes, until the rest is read.
      if (partial) setLoadingMore(true);
    };
    const quickReq = n * 2;
    const freshReq = n * 2 + 1;
    progress.current.clear();
    progress.current.set(quickReq, (l) => {
      if (!freshIn && l.items.length > shown) take(l, true);
    });
    progress.current.set(freshReq, (l) => {
      if (!freshIn && l.items.length > shown) take(l, true);
    });
    const quick = window.looper.history.list({ ...o, fresh: false, request: quickReq }).then((l) => {
      if (!freshIn && l.items.length >= shown) take(l, false);
    }, reportError);
    if (!fresh) {
      void quick.finally(() => n === loads.current && setLoadingMore(false));
      return;
    }
    scanning.current = true;
    void window.looper.history
      .list({ ...o, fresh: true, request: freshReq })
      .then((l) => {
        freshIn = true;
        take(l, false);
      }, reportError)
      .finally(() => {
        scanning.current = false;
        if (n === loads.current) setLoadingMore(false);
      });
  }, [viewKnown, view.showRuns, folder, limit, refreshes]);

  useEffect(() => {
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
      .then((ids) => setFound(new Set(ids)), reportError)
      .finally(() => setSearching(false));
  };
  const closeFind = () => {
    setFinding(false);
    setQuery('');
    setFound(null);
  };

  const shown = useMemo(() => filterHistory(items ?? [], { title: query, found }), [items, query, found]);
  const groups = useMemo(() => groupHistory(shown, view.groupBy, projects, Date.now()), [shown, view.groupBy, projects]);
  // A conversation stays open if a newer list no longer holds it (the folders' scan comes in after the first list, with more recent ones).
  const opened = useRef<HistoryItem | null>(null);
  const listed = items?.find((i) => i.id === selected);
  if (listed) opened.current = listed;
  const item = listed ?? (opened.current?.id === selected ? opened.current : undefined);

  const commandState = useCommandState();
  const commandContext: CommandContext = {
    ...commandState,
    history: {
      selected,
      commands: item ? commands : NO_HISTORY_COMMANDS,
      shown: view,
      setShown: (patch) => {
        if (commandState.settings) commandState.setView({ history: { ...commandState.settings.view.history, ...patch } });
      },
      folder,
      setFolder,
      activity: !!item && (activity || panel.open),
      setActivity: (on) => (isPhone ? panel.toggle() : setActivity(on)),
      refresh: () => setRefreshes((n) => n + 1),
      find: openFind,
    },
  };
  useCommandMenu(HISTORY_VIEWS, commandContext);
  const toolbar = commandToolbar(HISTORY_VIEWS, commandContext);
  const nav = phoneNav(['historyItem', 'history'], commandContext);

  const pane = (activity || panel.open) && !!item && !!conv;
  const subagents = conv?.subagents ?? [];
  const followed = subagents.find((a) => a.agentId === follow);
  const rows = conv?.rows ?? [];
  const watched = follow ? subRows : rows;
  const ctx = { taskId: item?.taskId ?? '', runId: item?.runId ?? '' };
  const emptyText =
    items === null ? 'Loading…' : found ? `No conversation’s messages contain “${query.trim()}”.` : query.trim() ? 'No conversation’s title contains that.' : 'No conversations.';
  const findStatus = searching ? 'Searching…' : found ? (found.size === 1 ? '1 conversation' : `${found.size} conversations`) : '';

  return (
    <div className="sessions-app history-app">
      <Toolbar groups={toolbar} className="sessions-toolbar" />
      {finding && (
        <FindStrip query={query} onQuery={typed} status={findStatus} onEnter={searchMessages} onClose={closeFind} inputRef={findField.inputRef}>
          <button className="btn small" disabled={!query.trim() || searching} onClick={searchMessages}>
            Search Messages
          </button>
        </FindStrip>
      )}
      <NavBar
        title={split ? (item?.title ?? '') : 'History'}
        actions={item ? nav.actions : []}
        more={nav.more}
        largeTitle={false}
        modal={panel.sheetOpen}
        split={split ? { width: split.lead, title: 'History' } : undefined}
      />
      <ListDetail
        sides={{ storageKey: WIDTHS_KEY, left: { initial: 320, min: 200, max: 560 }, right: { initial: 400, min: 280, max: 720 }, minDetail: 480 }}
        split={split}
        open={!!item}
        onClose={() => setSelected(null)}
        detailTitle={item?.title}
        empty="Select a conversation"
        list={
          <TreeListSection>
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
          </TreeListSection>
        }
        detail={
          item && (
            <main className="sessions-center">
              {!conv ? (
                <EmptyState>Loading…</EmptyState>
              ) : (
                <>
                  {subagents.length > 0 && <SubagentTabs agents={subagents} follow={follow} onFollow={setFollow} />}
                  {follow && followed ? (
                    <TranscriptView key={`${item.id}:${follow}`} taskId={ctx.taskId} runId={ctx.runId} rows={subRows} waitingText="The subagent has no messages." rowMenu={false} />
                  ) : (
                    <TranscriptView key={item.id} taskId={ctx.taskId} runId={ctx.runId} rows={rows} scriptCalls={conv?.scriptCalls} waitingText="The conversation has no messages." rowMenu={false} />
                  )}
                  {commands.chat && (
                    <div className="history-continue">
                      <button className="btn primary" onClick={() => void window.looper.history.run(item.id, 'chat').catch(reportError)}>
                        Continue in Chat
                      </button>
                    </div>
                  )}
                </>
              )}
            </main>
          )
        }
        inspectorOpen={pane}
        inspector={
          item && (
            <Inspector title="Activity" open={pane} onClose={panel.dismiss}>
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
                onFollow={(id) => {
                  setFollow(id);
                  panel.dismiss();
                }}
                onOpenWorkflow={() => undefined}
                working={false}
                pos={nowPos}
                onPos={setNowPos}
                scriptCalls={follow ? undefined : conv?.scriptCalls}
              />
            </Inspector>
          )
        }
      />
    </div>
  );
}
