import { useEffect, useMemo, useRef, useState } from 'react';
import type { BuilderState, BuilderTest } from '@shared/builder';
import { describeCron } from '@shared/cron';
import { effortLabel, harnessModels, permissionLabel } from '@shared/environments';
import type { MessageRow } from '@shared/messages';
import type { Environment, Harness, Task } from '@shared/types';
import { baseName } from '@shared/paths';
import { definitionOf, diffDefinitions } from '@shared/versions';
import { useSelectText, type RowCtx } from './components/ChatRows';
import { groupRows } from './components/chat-groups';
import { ChatStatus, Conversation, type ConversationHandle, type ConversationPart } from './components/Conversation';
import { FindBar, useFindFocus, useFindHighlights, type FindState } from './components/FindBar';
import { useChatsSettings } from './components/hooks';
import { Inspector, useInspector } from './components/Inspector';
import { InspectorHost } from './components/ListDetail';
import { Toolbar } from './components/Toolbar';
import { MessageBox } from './components/MessageBox';
import { PropertyList, type Property } from './components/PropertyList';
import { useSplit } from './components/phone/PhoneSplit';
import { EmptyWindow, TabBar } from './components/ui';
import { useXterm } from './components/xterm';
import { subscribe } from './events';
import { fmtDateTime } from './format';
import { settingLabel, settingValue } from './taskSettings';
import { INSPECTOR_WIDTH } from './web/nav-stack';
import { isPhone } from './web/page-nav';
import { reportError } from './report-error';

type Rec = Record<string, unknown>;

const obj = (v: unknown): Rec | undefined => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);

/** When the task runs, in words, from the draft as written (it may not validate yet). */
function triggerText(raw: Rec): string {
  const t = obj(raw.trigger);
  const mode = str(t?.mode) ?? 'schedule';
  let text: string;
  if (mode === 'manual') text = 'Manually only';
  else if (mode === 'watcher') text = 'On events from the watcher command';
  else {
    const s = obj(t?.schedule);
    const cron = str(s?.cron);
    text = cron ? describeCron(cron) : 'On a schedule (not set yet)';
    if (str(s?.timezone)) text += ` (${s!.timezone})`;
  }
  const stop = obj(t?.stopOn);
  if (mode !== 'manual' && stop?.enabled !== false && str(stop?.at)) text += `, until ${fmtDateTime(stop!.at as string)}`;
  return text;
}

/** The labels the task editor shows for the agent's settings. */
function agentFields(raw: Rec, environments: Environment[]): [string, string][] {
  const a = obj(raw.agent) ?? {};
  const env = environments.find((e) => e.id === raw.environmentId);
  const harness: Harness | undefined = env
    ? (env.harnesses.find((h) => h.id === a.harnessId) ?? (a.harnessId ? undefined : env.harnesses[0]))
    : undefined;
  const kind = harness?.kind;
  const model = str(a.model);
  const entry = harness && model ? harnessModels(harness).find((m) => m.id === model) : undefined;
  const effort = str(a.effort)
    ? effortLabel(kind, a.effort as string)
    : entry?.defaultEffort
      ? `Default (${effortLabel(kind, entry.defaultEffort)})`
      : 'Default';
  const permission = typeof a.permissionMode === 'string' ? a.permissionMode : 'auto';
  return [
    ['Harness', harness?.name ?? String(a.harnessId ?? '')],
    ['Model', model ? (entry?.name ?? model) : 'Default'],
    ['Effort', effort],
    ['Permission mode', permissionLabel(kind, permission)],
    ['Session type', a.mode === 'headless' ? 'Headless' : 'Interactive terminal'],
  ];
}

function testTitle(t: BuilderTest): string {
  const kind = t.kind === 'check' ? 'Check test' : 'Access test';
  const status = t.status === 'running' ? 'Running' : t.status === 'passed' ? 'Passed' : 'Failed';
  return `${kind} ${t.id}: ${status}`;
}

type PanelTab = 'task' | 'tests' | 'files' | 'changes';

function DraftPanel({ state, environments, stored }: { state: BuilderState; environments: Environment[]; stored?: Task }) {
  const [tab, setTab] = useState<PanelTab>('task');
  const raw = state.draft.raw ?? {};
  const check = obj(raw.check);
  const checkOn = !!check && check.enabled !== false;
  const watcher = obj(obj(raw.trigger)?.watcher);
  const prompt = str(obj(raw.agent)?.prompt);
  const valid = draftValid(state);
  const diffs = stored ? diffDefinitions(definitionOf(stored), raw) : [];
  const changeCount = diffs.length + state.changedFiles.length;
  const tabs: [PanelTab, string][] = [
    ['task', 'Task'],
    ['tests', state.tests.length ? `Tests (${state.tests.length})` : 'Tests'],
    ['files', state.files.length ? `Files (${state.files.length})` : 'Files'],
    ...(stored ? [['changes', changeCount ? `Changes (${changeCount})` : 'Changes'] as [PanelTab, string]] : []),
  ];

  const prop = (label: string, value: React.ReactNode, className?: string): Property => ({ label, value, className });
  const list = (items: Parameters<typeof PropertyList>[0]['items']) => <PropertyList className="props builder-props" items={items} />;

  return (
    <aside className="builder-panel">
      <TabBar tabs={tabs} active={tab} onSelect={setTab} className="builder-tabs" />
      <div className="builder-panel-body">
        {tab === 'task' &&
          list([
            prop('Name', str(raw.name) ?? 'Not named yet', str(raw.name) ? undefined : 'muted'),
            prop('Runs', triggerText(raw)),
            !!watcher && obj(raw.trigger)?.mode === 'watcher' && prop('Watcher command', str(watcher.command) ?? '(not set)', 'mono'),
            prop('Working directory', str(raw.cwd) ?? state.setup.cwd, 'mono'),
            prop('Check', checkOn ? (str(check?.command) ?? '(not set)') : 'None', checkOn ? 'mono' : 'muted'),
            ...agentFields(raw, environments).map(([name, value]) => prop(name, value)),
            prompt ? prop('Prompt', <div className="builder-prompt">{prompt}</div>) : prop('Prompt', 'Not written yet', 'muted'),
            state.draft.errors.length === 0
              ? prop('Validation', valid ? 'Valid' : 'Not checked yet')
              : prop(
                  'Validation',
                  <ul className="builder-list">
                    {state.draft.errors.map((e, i) => (
                      <li key={i}>{e}</li>
                    ))}
                  </ul>,
                  'error-text',
                ),
          ])}
        {tab === 'tests' &&
          (state.tests.length === 0 ? (
            <div className="muted">No tests yet.</div>
          ) : (
            list(
              state.tests.map((t) =>
                prop(
                  testTitle(t),
                  <>
                    <div className={t.status === 'failed' ? 'error-text' : undefined}>{t.summary}</div>
                    {t.operations && (
                      <ul className="builder-list">
                        {t.operations.map((o, i) => (
                          <li key={i} className={o.allowed ? undefined : 'error-text'}>
                            {o.allowed ? 'Allowed' : 'Not allowed'}: {o.operation}
                            {o.detail && <div className="muted">{o.detail}</div>}
                          </li>
                        ))}
                      </ul>
                    )}
                  </>,
                ),
              ),
            )
          ))}
        {tab === 'files' &&
          (state.files.length === 0 ? (
            <div className="muted">The agent hasn't written any files yet.</div>
          ) : (
            list(state.files.map((f) => prop(baseName(f), f, 'mono muted')))
          ))}
        {tab === 'changes' &&
          (changeCount === 0 ? (
            <div className="muted">Nothing changed yet.</div>
          ) : (
            list([
              ...diffs.map((d) => {
                const a = settingValue(d.path, d.a, definitionOf(stored!) as unknown as Rec, environments);
                const b = settingValue(d.path, d.b, raw, environments);
                return prop(settingLabel(d.path), a !== undefined && b !== undefined ? `${a} → ${b}` : 'Changed');
              }),
              ...state.changedFiles.map((f) => prop(baseName(f), 'File changed')),
            ])
          ))}
      </div>
    </aside>
  );
}

const draftValid = (state: BuilderState) => state.draft.errors.length === 0 && !!state.draft.task;


/** Shown under the agent's reply once the draft is valid and unsaved: Create… or Update… opens the editor on it. */
function DraftCard({ state }: { state: BuilderState }) {
  const update = !!state.taskId;
  return (
    <div className="chat-card">
      <span>{update ? 'The draft is ready to update the task.' : 'The draft is ready to create the task.'}</span>
      <button className="btn primary" onClick={() => void window.looper.builder.review(state.id).catch(reportError)}>
        {update ? 'Update…' : 'Create…'}
      </button>
    </div>
  );
}

/** Save, Undo/Redo through the builder's changes, and the task's Version History, with their keys. */
function useBuilderCommands(state: BuilderState) {
  const busy = state.status === 'working' || state.status === 'starting';
  const canSave = state.unsaved && draftValid(state) && !busy;
  const { canUndo, canRedo } = state.history;
  const act = (fn: () => Promise<unknown>) => () => void fn().catch(reportError);

  // Ctrl+Z and Ctrl+Y belong to the message box while it has the focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey || e.metaKey) return;
      const key = e.key.toLowerCase();
      const typing = e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement;
      if (key === 's') {
        e.preventDefault();
        if (canSave) void window.looper.builder.save(state.id).catch(reportError);
      } else if (!typing && key === 'z' && !e.shiftKey && canUndo) {
        e.preventDefault();
        void window.looper.builder.undo(state.id).catch(reportError);
      } else if (!typing && (key === 'y' || (key === 'z' && e.shiftKey)) && canRedo) {
        e.preventDefault();
        void window.looper.builder.redo(state.id).catch(reportError);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state.id, canSave, canUndo, canRedo]);

  return {
    canSave,
    canUndo,
    canRedo,
    save: act(() => window.looper.builder.save(state.id)),
    undo: act(() => window.looper.builder.undo(state.id)),
    redo: act(() => window.looper.builder.redo(state.id)),
    versions: act(() => window.looper.versions.open(state.taskId!)),
  };
}

/**
 * The builder's commands: on the desktop a toolbar of Save, Undo and Redo, and Version History; on a phone or
 * tablet Save is the bar's confirming action, the draft has its button, and the rest is in More.
 */
function BuilderBar({ state, onDraft, onFind, modal, beside }: { state: BuilderState; onDraft: () => void; onFind?: () => void; modal: boolean; beside: boolean }) {
  const c = useBuilderCommands(state);
  return (
    <Toolbar
      className="builder-toolbar"
      groups={[
        { id: 'save', items: [{ id: 'save', label: 'Save', shortcut: 'Ctrl+S', icon: 'save', enabled: c.canSave, run: c.save }] },
        {
          id: 'edit',
          items: [
            { id: 'undo', label: 'Undo', shortcut: 'Ctrl+Z', icon: 'undo', enabled: c.canUndo, run: c.undo },
            { id: 'redo', label: 'Redo', shortcut: 'Ctrl+Y', icon: 'redo', enabled: c.canRedo, run: c.redo },
          ],
        },
        { id: 'versions', items: [{ id: 'versions', label: 'Version History', icon: 'history', enabled: !!state.taskId, run: c.versions }] },
      ]}
      nav={{
        confirm: { label: 'Save', disabled: !c.canSave, run: c.save },
        actions: [{ id: 'draft', label: beside ? 'Show or Hide Draft' : 'Draft', icon: 'activity', run: onDraft }],
        toolbar: [
          {
            id: 'edit',
            items: [
              { id: 'undo', label: 'Undo', enabled: c.canUndo, run: c.undo },
              { id: 'redo', label: 'Redo', enabled: c.canRedo, run: c.redo },
              { id: 'versions', label: 'Version History', icon: 'history', enabled: !!state.taskId, run: c.versions },
            ],
          },
          ...(onFind ? [{ id: 'find', items: [{ id: 'find', label: 'Find', icon: 'search' as const, run: onFind }] }] : []),
        ],
        modal,
      }}
    />
  );
}

/** Right-click on a row: copy it, or select its text. */
function showRowMenu(row: MessageRow, selectText: string | undefined): void {
  window.looper.showMessageContextMenu({ taskId: '', runId: '', selectText, text: (row.kind === 'tool' ? (row.result ?? row.text) : row.text) || undefined });
}

function Chat({ state, findAsked }: { state: BuilderState; findAsked: number }) {
  const [text, setText] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const conversation = useRef<ConversationHandle>(null);
  const selectText = useSelectText(state.id);
  const taskId = state.taskId ?? '';
  const ctx = useMemo<RowCtx>(() => ({ taskId, runId: '', onContextMenu: (e, row) => showRowMenu(row, selectText(e)) }), [taskId, selectText]);
  const { expandThinking } = useChatsSettings();
  const items = useMemo(() => groupRows(state.rows, expandThinking), [state.rows, expandThinking]);
  const parts = useMemo<ConversationPart[]>(() => [{ key: '', items }], [items]);

  const [find, setFind] = useState<FindState | null>(null);
  const findField = useFindFocus();
  const matches = useFindHighlights(scrollRef, find, setFind, () => conversation.current?.leaveEnd());
  const openFind = () => {
    setFind((f) => f ?? { query: window.getSelection()?.toString().trim() ?? '', index: 0 });
    findField.focus();
  };
  // The phone's More → Find, asked after this view showed.
  const asked = useRef(findAsked);
  useEffect(() => {
    if (findAsked === asked.current) return;
    asked.current = findAsked;
    openFind();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findAsked]);
  // Ctrl+F opens the find bar, Esc closes it, F3 and Shift+F3 step through the matches.
  const finding = find !== null;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (e.key.toLowerCase() === 'f' && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) openFind();
      else if (e.key === 'Escape' && finding) setFind(null);
      else if (e.key === 'F3' && finding) setFind((f) => (f ? { ...f, index: f.index + (e.shiftKey ? -1 : 1) } : f));
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finding]);

  const send = () => {
    const t = text.trim();
    if (!t || state.status === 'ended') return;
    window.looper.builder.send(state.id, t);
    // A phone without its computer (web/start.ts marks it) shows its own alert; the message stays to send later.
    if ('stale' in document.documentElement.dataset) return;
    setText('');
    conversation.current?.toEnd();
  };

  const showCard = state.status === 'ready' && state.unsaved && draftValid(state);
  return (
    <section className="builder-chat">
      {find && <FindBar find={find} matches={matches} onChange={setFind} onClose={() => setFind(null)} inputRef={findField.inputRef} />}
      <Conversation
        ref={conversation}
        id={state.id}
        parts={parts}
        ctx={ctx}
        endKey={`${state.rows.length}/${state.status}/${state.unsaved}`}
        scrollRef={scrollRef}
        drawAll={finding}
        replyCard={showCard && <DraftCard state={state} />}
      >
        <ChatStatus state={state} />
      </Conversation>
      <MessageBox
        text={text}
        onText={setText}
        placeholder={state.mode === 'edit' ? 'Describe what to change' : 'Describe the task you want Looper to run'}
        shortPlaceholder={state.mode === 'edit' ? undefined : 'Describe the task'}
        canSend={!!text.trim() && state.status !== 'ended'}
        onSend={send}
        disabled={state.status === 'ended'}
        autoFocus
      />
    </section>
  );
}

/** Terminal view: the harness's own interactive session. */
function BuilderTerminal({ state }: { state: BuilderState }) {
  const id = state.id;
  const builder = window.looper.builder;
  const { ref, keys } = useXterm(id, {
    replay: (term) =>
      builder.output(id).then((data) => {
        if (data) term.write(data);
      }),
    live: (e, term) => {
      if (e.type === 'builder:data' && e.id === id) term.write(e.data);
    },
    write: (d) => builder.write(id, d),
    resize: (cols, rows) => builder.resize(id, cols, rows),
    attachFiles: (files) => builder.attachFiles(id, files),
    showMenu: (hasSelection) => builder.showContextMenu(id, hasSelection),
  });
  return (
    <section className="builder-chat">
      <div className="terminal builder-terminal" ref={ref} />
      {keys}
      {state.status === 'ended' && <ChatStatus state={state} />}
    </section>
  );
}

/** The task builder's window: the conversation, and the draft panel beside it, or a phone's sheet (Inspector). */
export function BuilderApp({ id }: { id: string }) {
  const [state, setState] = useState<BuilderState | null | undefined>(undefined);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [stored, setStored] = useState<Task | undefined>(undefined);
  const taskId = state?.taskId;
  const beside = !!useSplit(isPhone);
  const panel = useInspector('draft', beside);
  const [findAsked, setFindAsked] = useState(0);

  useEffect(() => {
    void window.looper.info().then((i) => setEnvironments(i.settings.environments));
    void window.looper.builder.get(id).then((s) => {
      setState(s);
      if (s) document.title = s.mode === 'edit' && s.setup.taskId ? 'Edit Task with Agent' : 'New Task with Agent';
    });
    return subscribe((e) => {
      if (e.type === 'builder' && e.state.id === id) setState(e.state);
      else if (e.type === 'settings') setEnvironments(e.settings.environments);
    });
  }, [id]);

  // The saved task, for the Changes tab: the builder's edits are measured against it.
  useEffect(() => {
    if (!taskId) {
      setStored(undefined);
      return;
    }
    const load = () => void window.looper.tasks.list().then((tasks) => setStored(tasks.find((t) => t.id === taskId)));
    load();
    return subscribe((e) => {
      if (e.type === 'tasks' || (e.type === 'versions' && e.taskId === taskId)) load();
    });
  }, [taskId]);

  if (!state) return <EmptyWindow gone={state === null && 'This conversation with the agent was closed.'} />;
  return (
    <div className="builder-app">
      <BuilderBar
        state={state}
        onDraft={panel.toggle}
        onFind={state.view === 'chat' ? () => setFindAsked((n) => n + 1) : undefined}
        modal={panel.sheetOpen}
        beside={beside}
      />
      <div className="builder" style={{ '--split-inspector': `${INSPECTOR_WIDTH}px` } as React.CSSProperties}>
        {state.view === 'terminal' ? <BuilderTerminal state={state} /> : <Chat state={state} findAsked={findAsked} />}
        {isPhone ? (
          <InspectorHost.Provider value={{ split: beside ? { lead: 0, inspector: INSPECTOR_WIDTH } : null }}>
            <Inspector title="Draft" open={panel.open} onClose={panel.dismiss}>
              <DraftPanel state={state} environments={environments} stored={stored} />
            </Inspector>
          </InspectorHost.Provider>
        ) : (
          <DraftPanel state={state} environments={environments} stored={stored} />
        )}
      </div>
    </div>
  );
}
