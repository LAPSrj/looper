import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { BuilderState, BuilderTest } from '@shared/builder';
import { describeCron } from '@shared/cron';
import { EFFORT_LEVELS, PERMISSION_MODES, harnessModels } from '@shared/environments';
import type { Environment, Harness, Task } from '@shared/types';
import { definitionOf, diffDefinitions, fileName } from '@shared/versions';
import { ChatRow, ToolGroup, groupRows } from './components/ChatRows';
import { Icon } from './components/Icon';
import { TabBar } from './components/ui';
import { openXterm } from './components/xterm';
import { subscribe } from './events';
import { fmtDateTime } from './format';
import { settingLabel, settingValue } from './taskSettings';

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
  const efforts = kind && kind !== 'custom' ? EFFORT_LEVELS[kind] : [];
  const effortLabel = (v: string | undefined) => (v ? (efforts.find(([x]) => x === v)?.[1] ?? v) : undefined);
  const effort = str(a.effort)
    ? effortLabel(a.effort as string)!
    : entry?.defaultEffort
      ? `Default (${effortLabel(entry.defaultEffort)})`
      : 'Default';
  const modes = kind && kind !== 'custom' ? PERMISSION_MODES[kind] : [];
  const permission = typeof a.permissionMode === 'string' ? a.permissionMode : 'auto';
  return [
    ['Harness', harness?.name ?? String(a.harnessId ?? '')],
    ['Model', model ? (entry?.name ?? model) : 'Default'],
    ['Effort', effort],
    ['Permission mode', modes.find(([v]) => v === permission)?.[1] ?? permission],
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

  const field = (name: string, value: React.ReactNode, className?: string) => (
    <div className="builder-field" key={name}>
      <div className="builder-label">{name}</div>
      <div className={className}>{value}</div>
    </div>
  );

  return (
    <aside className="builder-panel">
      <TabBar tabs={tabs} active={tab} onSelect={setTab} className="builder-tabs" />
      <div className="builder-panel-body">
        {tab === 'task' && (
          <>
            {field('Name', str(raw.name) ?? 'Not named yet', str(raw.name) ? undefined : 'muted')}
            {field('Runs', triggerText(raw))}
            {watcher && obj(raw.trigger)?.mode === 'watcher' && field('Watcher command', str(watcher.command) ?? '(not set)', 'mono')}
            {field('Working directory', str(raw.cwd) ?? state.setup.cwd, 'mono')}
            {field('Check', checkOn ? (str(check?.command) ?? '(not set)') : 'None', checkOn ? 'mono' : 'muted')}
            {agentFields(raw, environments).map(([name, value]) => field(name, value))}
            <div className="builder-field">
              <div className="builder-label">Prompt</div>
              {prompt ? <div className="builder-prompt">{prompt}</div> : <div className="muted">Not written yet</div>}
            </div>
            <div className="builder-field">
              <div className="builder-label">Validation</div>
              {state.draft.errors.length === 0 ? (
                <div>{valid ? 'Valid' : 'Not checked yet'}</div>
              ) : (
                <ul className="builder-list error-text">
                  {state.draft.errors.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
        {tab === 'tests' &&
          (state.tests.length === 0 ? (
            <div className="muted">No tests yet.</div>
          ) : (
            state.tests.map((t) => (
              <div className="builder-field" key={t.id}>
                <div className={`builder-label${t.status === 'failed' ? ' error-text' : ''}`}>{testTitle(t)}</div>
                <div>{t.summary}</div>
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
              </div>
            ))
          ))}
        {tab === 'files' &&
          (state.files.length === 0 ? (
            <div className="muted">The agent hasn't written any files yet.</div>
          ) : (
            state.files.map((f) => field(fileName(f), f, 'mono muted'))
          ))}
        {tab === 'changes' &&
          (changeCount === 0 ? (
            <div className="muted">Nothing changed yet.</div>
          ) : (
            <>
              {diffs.map((d) => {
                const a = settingValue(d.path, d.a, definitionOf(stored!) as unknown as Rec, environments);
                const b = settingValue(d.path, d.b, raw, environments);
                return field(settingLabel(d.path), a !== undefined && b !== undefined ? `${a} → ${b}` : 'Changed');
              })}
              {state.changedFiles.map((f) => field(fileName(f), 'File changed'))}
            </>
          ))}
      </div>
    </aside>
  );
}

const draftValid = (state: BuilderState) => state.draft.errors.length === 0 && !!state.draft.task;

const reportError = (e: Error) => window.looper.showError(e.message);

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

const TOOLBAR_ICONS = {
  save: (
    <>
      <path d="M2.5 3.5a1 1 0 0 1 1-1h7.3l2.7 2.7v7.3a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1Z" />
      <path d="M5 2.5v3h5v-3M5 13.5v-4h6v4" />
    </>
  ),
  undo: (
    <>
      <path d="M5.5 3 2.5 6l3 3" />
      <path d="M2.5 6h6.5a3.5 3.5 0 0 1 0 7H6" />
    </>
  ),
  redo: (
    <>
      <path d="m10.5 3 3 3-3 3" />
      <path d="M13.5 6H7a3.5 3.5 0 0 0 0 7h3" />
    </>
  ),
  history: (
    <>
      <path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9" />
      <path d="M2.5 2.5V5H5" />
      <path d="M8 5v3l2 1.5" />
    </>
  ),
};

/** Save, Undo/Redo through the builder's changes, and the task's Version History. */
function BuilderToolbar({ state }: { state: BuilderState }) {
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

  const button = (icon: React.ReactNode, title: string, enabled: boolean, onClick: () => void) => (
    <button title={title} aria-label={title} disabled={!enabled} onClick={onClick}>
      <Icon>{icon}</Icon>
    </button>
  );
  return (
    <div className="toolbar builder-toolbar">
      {button(TOOLBAR_ICONS.save, 'Save (Ctrl+S)', canSave, act(() => window.looper.builder.save(state.id)))}
      <span className="toolbar-sep" />
      {button(TOOLBAR_ICONS.undo, 'Undo (Ctrl+Z)', canUndo, act(() => window.looper.builder.undo(state.id)))}
      {button(TOOLBAR_ICONS.redo, 'Redo (Ctrl+Y)', canRedo, act(() => window.looper.builder.redo(state.id)))}
      <span className="toolbar-sep" />
      {button(TOOLBAR_ICONS.history, 'Version History', !!state.taskId, act(() => window.looper.versions.open(state.taskId!)))}
    </div>
  );
}

/** One line above the input: what the session is doing, or why it ended. */
function ChatStatus({ state }: { state: BuilderState }) {
  if (state.status === 'working') return <div className="chat-status muted">{state.harnessName} is working…</div>;
  if (state.status === 'starting') return <div className="chat-status muted">Starting {state.harnessName}…</div>;
  if (state.status === 'ended') return <div className="chat-status error-text">{state.error ?? 'The session ended.'}</div>;
  return null;
}

function Chat({ state }: { state: BuilderState }) {
  const [text, setText] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const ctx = { taskId: state.taskId ?? '', runId: '' };

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [state.rows.length, state.status, state.unsaved]);

  const send = () => {
    const t = text.trim();
    if (!t || state.status === 'ended') return;
    window.looper.builder.send(state.id, t);
    setText('');
    atBottom.current = true;
  };

  const placeholder = state.mode === 'edit' ? 'Describe what to change' : 'Describe the task you want Looper to run';
  const items = groupRows(state.rows);
  const showCard = state.status === 'ready' && state.unsaved && draftValid(state);
  const last = items.at(-1);
  const cardUnder = showCard && last?.kind === 'row' && last.row.kind === 'agent';
  return (
    <section className="builder-chat">
      <div
        className="chat-scroll"
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {items.map((item, i) =>
          item.kind === 'tools' ? (
            <ToolGroup key={item.rows[0].id} rows={item.rows} ctx={ctx} />
          ) : cardUnder && i === items.length - 1 ? (
            // The card takes the reply's width: both stretch to the wider of the two.
            <div className="chat-agent-group" key={item.row.id}>
              <ChatRow row={item.row} ctx={ctx} />
              <DraftCard state={state} />
            </div>
          ) : (
            <ChatRow key={item.row.id} row={item.row} ctx={ctx} />
          ),
        )}
        {showCard && !cardUnder && <DraftCard state={state} />}
      </div>
      <ChatStatus state={state} />
      <div className="chat-composer">
        <textarea
          value={text}
          placeholder={placeholder}
          rows={3}
          autoFocus
          disabled={state.status === 'ended'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button className="btn primary" disabled={!text.trim() || state.status === 'ended'} onClick={send}>
          Send
        </button>
      </div>
    </section>
  );
}

/** Terminal view: the harness's own interactive session. */
function BuilderTerminal({ state }: { state: BuilderState }) {
  const ref = useRef<HTMLDivElement>(null);
  const id = state.id;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { term, fit } = openXterm(el);
    let loaded = false;
    void window.looper.builder.output(id).then((data) => {
      if (data) term.write(data);
      loaded = true;
      window.looper.builder.resize(id, term.cols, term.rows);
    });
    const unsub = subscribe((e) => {
      if (loaded && e.type === 'builder:data' && e.id === id) term.write(e.data);
    });
    const onData = term.onData((d) => window.looper.builder.write(id, d));
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
        window.looper.builder.resize(id, term.cols, term.rows);
      } catch {
        /* element hidden */
      }
    });
    ro.observe(el);
    term.focus();
    return () => {
      unsub();
      onData.dispose();
      ro.disconnect();
      term.dispose();
    };
  }, [id]);
  return (
    <section className="builder-chat">
      <div className="terminal builder-terminal" ref={ref} />
      {state.status === 'ended' && <ChatStatus state={state} />}
    </section>
  );
}

/** The task builder's window: the conversation on the left, the draft panel on the right. */
export function BuilderApp({ id }: { id: string }) {
  const [state, setState] = useState<BuilderState | null | undefined>(undefined);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [stored, setStored] = useState<Task | undefined>(undefined);
  const taskId = state?.taskId;

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

  if (state === undefined) return <div className="empty">Loading…</div>;
  if (state === null) return <div className="empty">This conversation with the agent was closed.</div>;
  return (
    <div className="builder-app">
      <BuilderToolbar state={state} />
      <div className="builder">
        {state.view === 'terminal' ? <BuilderTerminal state={state} /> : <Chat state={state} />}
        <DraftPanel state={state} environments={environments} stored={stored} />
      </div>
    </div>
  );
}
