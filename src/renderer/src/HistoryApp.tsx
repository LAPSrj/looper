import { useEffect, useMemo, useRef, useState } from 'react';
import { filterHistory, groupHistory, NO_HISTORY_COMMANDS, type HistoryFolderFilter, type HistoryItem } from '@shared/history';
import { ViewSchema, type Project, type Task, type View } from '@shared/types';
import { HISTORY_VIEWS } from '@shared/commands/build';
import type { CommandContext } from '@shared/commands/context';
import { ActivityPanel } from './components/ActivityPanel';
import { FindStrip, useFindFocus } from './components/FindBar';
import { commandToolbar, phoneNav, popupViewOptions } from './components/command-surfaces';
import { useCommandMenu, useCommandState } from './components/useCommands';
import { HistoryList } from './components/HistoryList';
import { HistoryDetail, useHistoryConversation, useHistoryList } from './components/HistoryPanes';
import { Inspector, useInspector } from './components/Inspector';
import { ListDetail } from './components/ListDetail';
import { NavBar } from './components/NavBar';
import { TreeListSection } from './components/phone/PhoneList';
import { useSplit } from './components/phone/PhoneSplit';
import { Toolbar } from './components/Toolbar';
import { subscribe } from './events';
import { isPhone } from './web/page-nav';
import { reportError } from './report-error';

const WIDTHS_KEY = 'history.widths';
const DEFAULT_VIEW: View['history'] = ViewSchema.parse({}).history;
const DEFAULT_RUN_FILTER: View['runFilter'] = ViewSchema.parse({}).runFilter;
/** Task History lists again this long after the last run record, so a run being written doesn't read the list again for each one. */
const RUNS_REFRESH_MS = 1000;


/**
 * The History window: the conversations on this computer on the left, newest
 * first, Looper's chats and terminal sessions and every Claude Code and Codex
 * one in the environments' folders, a page at a time; the selected one, read only, in
 * the middle with its subagents' tabs; and the activity pane on the right,
 * hidden until View → Activity Pane shows it. Edit → Find shows the find bar.
 * `runs`: Task History, the same window with every task's runs in the list
 * instead (newest first, with View → Task, Result, Show Skipped Runs and Show
 * Runs with No Action); a run that never started its agent has nothing to read.
 */
export function HistoryApp({ runs = false }: { runs?: boolean }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [view, setView] = useState<View['history']>(DEFAULT_VIEW);
  const [runFilter, setRunFilter] = useState<View['runFilter']>(DEFAULT_RUN_FILTER);
  const [task, setTask] = useState('');
  const [result, setResult] = useState('');
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
  const [activity, setActivity] = useState(false);
  // A phone or tablet: its own Activity, as its bar's button; the desktop's follows View → Activity Pane (`activity`).
  const split = useSplit();
  const panel = useInspector<'now'>('now', !!split?.inspector);
  const { items, more, loadingMore, showMore } = useHistoryList({
    ready: viewKnown,
    runs: runs ? { taskId: task, result, ...runFilter } : undefined,
    folder,
    refreshes,
    scan: !runs,
  });
  const { conv, follow, setFollow, subRows, commands, nowPos, setNowPos } = useHistoryConversation(selected);

  const openFind = () => {
    setFinding(true);
    findField.focus();
  };

  useEffect(() => {
    document.title = runs ? 'Task History' : 'History';
    void window.looper.projects.list().then(setProjects);
    if (runs) void window.looper.tasks.list().then(setTasks);
    void window.looper.info().then((i) => {
      setView(i.settings.view.history);
      setRunFilter(i.settings.view.runFilter);
      setViewKnown(true);
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = subscribe((e) => {
      if (e.type === 'settings') {
        setView(e.settings.view.history);
        setRunFilter(e.settings.view.runFilter);
      } else if (e.type === 'projects') setProjects(e.projects);
      else if (e.type === 'tasks' && runs) setTasks(e.tasks);
      else if (e.type === 'record' && runs) {
        clearTimeout(timer);
        timer = setTimeout(() => setRefreshes((n) => n + 1), RUNS_REFRESH_MS);
      }
    });
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [runs]);

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

  const taskChoices = useMemo(() => tasks.map((t) => ({ id: t.id, name: t.name })).sort((a, b) => a.name.localeCompare(b.name)), [tasks]);
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
      kind: runs ? 'runs' : 'chats',
      tasks: taskChoices,
      task,
      setTask,
      result,
      setResult,
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
  const rows = conv?.rows ?? [];
  const watched = follow ? subRows : rows;
  const noun = runs ? 'task run' : 'conversation';
  const emptyText =
    items === null ? 'Loading…' : found ? `No ${noun}’s messages contain “${query.trim()}”.` : query.trim() ? `No ${noun}’s title contains that.` : `No ${noun}s.`;
  const findStatus = searching ? 'Searching…' : found ? (found.size === 1 ? `1 ${noun}` : `${found.size} ${noun}s`) : '';

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
        title={split ? (item?.title ?? '') : runs ? 'Task History' : 'History'}
        actions={item ? nav.actions : []}
        more={nav.more}
        largeTitle={false}
        modal={panel.sheetOpen}
        split={split ? { width: split.lead, title: runs ? 'Task History' : 'History' } : undefined}
      />
      <ListDetail
        sides={{ storageKey: WIDTHS_KEY, left: { initial: 320, min: 200, max: 560 }, right: { initial: 400, min: 280, max: 720 }, minDetail: 480 }}
        split={split}
        open={!!item}
        onClose={() => setSelected(null)}
        detailTitle={item?.title}
        empty={runs ? 'Select a task run' : 'Select a conversation'}
        list={
          <TreeListSection>
            <HistoryList
              groups={groups}
              projects={projects}
              selected={selected}
              onSelect={setSelected}
              emptyText={emptyText}
              showPlace={view.groupBy !== 'folder'}
              runs={runs}
              more={more && !found}
              loadingMore={loadingMore}
              onMore={showMore}
              onEmptyMenu={isPhone ? undefined : () => popupViewOptions(commandContext, 'history', ['history-group', 'history-filter'])}
            />
          </TreeListSection>
        }
        detail={item && <HistoryDetail item={item} conv={conv} follow={follow} onFollow={setFollow} subRows={subRows} commands={commands} />}
        inspectorOpen={pane}        inspector={
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
