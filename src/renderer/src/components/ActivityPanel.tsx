import { useEffect, useState, type ReactNode } from 'react';
import { findToolCall, toolCallTitle, type AddonInfo, type AddonToolCall } from '@shared/addons';
import { formatTokens, type Attachment } from '@shared/chat';
import { EFFORT_LEVELS } from '@shared/environments';
import type { MessageRow } from '@shared/messages';
import type { BackgroundTask, SubagentInfo } from '@shared/sessions';
import { waitedText } from '@shared/sessions';
import { WORKFLOW_STATUS_TEXT, tabStatus, workflowAgents, type WorkflowRun } from '@shared/workflows';
import { stripAnsi } from '../format';
import { MINUTE, useNow } from '../useNow';
import { AttachmentList } from './ChatRows';
import { changeLines, type EditorLine } from './editor-lines';
import { gitTabLabel } from '@shared/git';
import { GitView, useGitStatus } from './GitView';
import { AddonScreenView } from './AddonScreen';
import { MessageBody } from './Markdown';
import { isPhone } from '../web/page-nav';
import { StatusMark } from './StatusMark';
import { ToolButton } from './ToolButton';
import { CodeBlock, CodeText, ParamTable, ToolImage, ToolInputView, ToolResultView, gutterLines, useHighlight } from './ToolContent';
import { TabBar } from './ui';

export type ActivityTab = 'now' | 'background' | 'subagents' | 'files' | 'git';
type Tab = ActivityTab;

/** Tools that change a file (Delete and Patch are Codex's). */
const CHANGES = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Delete', 'Patch']);

/** The Now tab's toolbar icons. */
const NAV_ICONS = {
  previous: <path d="M10 3.5 5.5 8l4.5 4.5" />,
  next: <path d="M6 3.5 10.5 8 6 12.5" />,
  latest: <path d="M4 3.5 8.5 8 4 12.5M12 3v10" />,
};
const IMAGE_RE = /\.(png|jpe?g|gif|webp)$/i;

const baseName = (p: string) => p.split(/[\\/]/).pop() || p;
const dirName = (p: string) => p.slice(0, Math.max(0, p.length - baseName(p).length)).replace(/[\\/]$/, '');

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const inputOf = (row: MessageRow): Record<string, unknown> =>
  row.input !== null && typeof row.input === 'object' && !Array.isArray(row.input) ? (row.input as Record<string, unknown>) : {};

/** The file in an editor: its lines with their numbers, colored for its language, added and removed ones marked. */
function EditorScreen({ file, lines, note }: { file?: string; lines: EditorLine[]; note?: string }) {
  const html = useHighlight(
    lines.map((l) => l.text),
    file,
  );
  return (
    <div className="now-editor">
      <div className="now-editor-lines">
        {lines.map((l, i) =>
          l.kind === 'gap' ? (
            <div key={i} className="now-editor-gap">
              ⋯
            </div>
          ) : (
            <div key={i} className={`now-editor-line${l.kind === 'ctx' ? '' : ` diff-${l.kind}`}`}>
              <span className="now-editor-gutter">{l.n}</span>
              <span className="now-editor-mark">{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ''}</span>
              <CodeText className="now-editor-text" html={html?.[i]} text={l.text} />
            </div>
          ),
        )}
        {note && <div className="now-editor-note">{note}</div>}
      </div>
    </div>
  );
}

/** A command in a terminal: the prompt and the command line, then its output; a cursor while it runs. Its description is the screen's title. */
function TerminalScreen({ row }: { row: MessageRow }) {
  const input = inputOf(row);
  const command = str(input.command) ?? row.text;
  const prompt = row.tool === 'PowerShell' ? 'PS> ' : '$ ';
  const output = row.result === undefined ? undefined : stripAnsi(row.result).replace(/\n+$/, '');
  return (
    <div className="now-terminal">
      <div>
        <span className="now-term-prompt">{prompt}</span>
        {command}
      </div>
      {output === undefined ? (
        row.background ? (
          <div className="now-term-comment">Running in the background…</div>
        ) : (
          <span className="now-term-cursor" />
        )
      ) : (
        <>
          {output && <div>{output}</div>}
          <div>
            <span className="now-term-prompt">{prompt}</span>
          </div>
        </>
      )}
    </div>
  );
}

const TERMINALS = new Set(['Bash', 'PowerShell']);

const runningNote = (row: MessageRow) => (
  <div className="muted now-result">{row.background ? 'Running in the background…' : 'Running…'}</div>
);

/** A result's JSON as a table: a list of objects with a column per field, an object with a row per field; null for anything else. */
function resultTable(text: string): ReactNode {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (Array.isArray(value) && value.length > 0 && value.every((v) => v !== null && typeof v === 'object' && !Array.isArray(v))) {
    const rows = value as Record<string, unknown>[];
    const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    const cell = (v: unknown) => (v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v));
    return (
      <table className="now-table">
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {cols.map((c) => (
                <td key={c}>{cell(r[c])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return <ParamTable entries={Object.entries(value)} />;
  return null;
}

/** A tool call an addon says how to show (its toolCalls): its title, the parameters it picked, and the result in the form it asked for. */
function AddonCallScreen({ row, ctx, addon, call }: { row: MessageRow; ctx: { taskId: string; runId: string; agentId?: string }; addon: AddonInfo; call: AddonToolCall }) {
  const input = inputOf(row);
  const params: [string, unknown][] = call.params ? call.params.filter((k) => k in input).map((k) => [k, input[k]]) : Object.entries(input);
  const result = row.result ?? '';
  let shown;
  if (call.result === 'text') shown = <pre className="output">{result}</pre>;
  else if (call.result === 'markdown') shown = <MessageBody text={result} />;
  else if (call.result === 'code') shown = <CodeBlock text={result} file={row.file} language={call.language} />;
  else if (call.result === 'image') shown = <ToolImage row={row} taskId={ctx.taskId} runId={ctx.runId} agentId={ctx.agentId} />;
  else if (call.result === 'table') shown = resultTable(result) ?? <pre className="output">{result}</pre>;
  else if (call.result && addon.status === 'running')
    shown = (
      <AddonScreenView
        addonId={addon.id}
        addonName={addon.name}
        view={call.result.view}
        params={{ tool: row.tool, input, result, error: !!row.resultError }}
        mode="inline"
      />
    );
  else shown = <ToolResultView row={row} ctx={ctx} />;
  return (
    <>
      <ParamTable entries={params} />
      {row.result === undefined && !row.image ? runningNote(row) : <div className={params.length ? 'now-result' : undefined}>{shown}</div>}
    </>
  );
}

/** One tool call as the agent's screen: the file it read, the change it made, the command and its output. */
function NowScreen({ row, taskId, runId, agentId, addons }: { row: MessageRow; taskId: string; runId: string; agentId?: string; addons: AddonInfo[] }) {
  const ctx = { taskId, runId, agentId };
  const running = row.result === undefined;
  const custom = row.tool ? findToolCall(addons, row.tool) : undefined;
  const title = custom?.call.title ? toolCallTitle(custom.call.title, inputOf(row)) : row.tool;
  const subject = custom?.call.title ? '' : (row.file ?? row.preview);
  const image = row.tool === 'Read' && !running && (!!row.image || (!row.resultError && IMAGE_RE.test(row.file ?? '')));
  const lines = row.tool === 'Read' && !running && !image ? gutterLines(row.result ?? '') : null;
  const changed = row.tool && CHANGES.has(row.tool) ? changeLines(row) : null;
  let body;
  let screen = true;
  if (custom) {
    screen = false;
    body = <AddonCallScreen row={row} ctx={ctx} addon={custom.addon} call={custom.call} />;
  } else if (row.tool && TERMINALS.has(row.tool)) {
    body = <TerminalScreen row={row} />;
  } else if (row.tool === 'Read' && running) {
    body = <EditorScreen file={row.file} lines={[]} note="Reading…" />;
  } else if (image) {
    screen = false;
    body = <ToolImage row={row} taskId={taskId} runId={runId} agentId={agentId} />;
  } else if (row.tool === 'Skill') {
    // The skill's name is the title; its content is the result.
    screen = false;
    const rest = Object.entries(inputOf(row)).filter(([k]) => k !== 'skill');
    body = (
      <>
        <ParamTable entries={rest} />
        {running ? (
          runningNote(row)
        ) : (
          <div className={rest.length ? 'now-result' : undefined}>
            <ToolResultView row={row} ctx={ctx} />
          </div>
        )}
      </>
    );
  } else if (lines) {
    body = <EditorScreen file={row.file} lines={lines.map((l) => ({ ...l, kind: 'ctx' }))} />;
  } else if (changed) {
    body = <EditorScreen file={row.file} lines={changed} />;
  } else if (row.tool === 'Delete') {
    body = <EditorScreen file={row.file} lines={[]} note="Deleted." />;
  } else if (row.tool === 'Read' || (row.tool && CHANGES.has(row.tool))) {
    screen = false;
    body = row.tool === 'Read' ? <ToolResultView row={row} ctx={ctx} /> : <ToolInputView row={row} />;
  } else {
    screen = false;
    body = (
      <>
        <ToolInputView row={row} />
        {row.result !== undefined ? (
          <div className="now-result">
            <ToolResultView row={row} ctx={ctx} />
          </div>
        ) : (
          runningNote(row)
        )}
      </>
    );
  }
  return (
    <div className="now-screen">
      <div className="now-title">
        <span className={`now-tool${subject ? '' : ' now-tool-only'}`}>{title}</span>
        {subject && <span className="mono now-subject">{subject}</span>}
        {row.resultError && <span className="error-text">Failed</span>}
      </div>
      <div className={`now-body${screen ? ' now-body-screen' : ''}`}>{body}</div>
    </div>
  );
}

/** A file the agent worked on: an image shows as a thumbnail. */
function FileItem({ path, taskId, runId, onShow }: { path: string; taskId: string; runId: string; onShow: () => void }) {
  const [thumb, setThumb] = useState<string | null>(null);
  useEffect(() => {
    if (!IMAGE_RE.test(path)) return;
    void window.looper.sessions.fileThumbnail(taskId, path).then(setThumb);
  }, [taskId, path]);
  return (
    <div
      className="file-item"
      onClick={onShow}
      onContextMenu={(e) => {
        e.preventDefault();
        window.looper.showMessageContextMenu({ taskId, runId, file: path, text: path });
      }}
    >
      {thumb && <img className="file-thumb" src={thumb} alt="" />}
      <div className="file-item-text">
        <div>{baseName(path)}</div>
        <div className="muted mono file-dir">{dirName(path)}</div>
      </div>
    </div>
  );
}

/** One background command or subagent; opened, the end of its output, read again every few seconds. */
function BackgroundItem({
  b,
  sessionId,
  taskId,
  onOpenWorkflow,
}: {
  b: BackgroundTask;
  sessionId: string;
  taskId: string;
  /** A workflow's item opens its tab beside the conversation. */
  onOpenWorkflow: (runId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [output, setOutput] = useState<string | null>(null);
  useEffect(() => {
    if (!open || !b.outputFile) return;
    let live = true;
    const load = () =>
      void window.looper.sessions.backgroundOutput(sessionId, b.id).then((t) => {
        if (live) setOutput(t);
      });
    load();
    const timer = b.status === 'running' ? setInterval(load, 2000) : null;
    return () => {
      live = false;
      if (timer) clearInterval(timer);
    };
  }, [open, b.outputFile, b.status, sessionId, b.id]);
  const activate = b.workflowRunId ? () => onOpenWorkflow(b.workflowRunId!) : b.outputFile ? () => setOpen((o) => !o) : undefined;
  const started = b.startedAt ? Date.parse(b.startedAt) : NaN;
  // The text counts whole minutes, from a minute on.
  const now = useNow(b.status === 'running' && !Number.isNaN(started) ? MINUTE : null);
  const status =
    b.status === 'running'
      ? `Running${Number.isNaN(started) || now - started < 60_000 ? '' : ` for ${waitedText(now - started)}`}`
      : b.status === 'completed'
        ? 'Completed'
        : b.status === 'failed'
          ? 'Failed'
          : 'Stopped';
  return (
    <div
      className={`bg-item ${b.status}`}
      onContextMenu={(e) => {
        e.preventDefault();
        window.looper.showMessageContextMenu({ taskId, runId: sessionId, file: b.outputFile, text: b.command });
      }}
    >
      <div
        className="bg-item-head"
        role={activate ? 'button' : undefined}
        tabIndex={activate ? 0 : undefined}
        aria-expanded={b.workflowRunId || !b.outputFile ? undefined : open}
        onClick={activate}
        onKeyDown={
          activate &&
          ((e) => {
            if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
            e.preventDefault();
            activate();
          })
        }
      >
        <span className={`bg-status${b.status === 'failed' ? ' error-text' : ''}${b.status === 'running' ? ' live-only' : ''}`}>{status}</span>
        <span className="bg-label">{b.label}</span>
        <span className="muted bg-kind">{b.kind === 'agent' ? 'Subagent' : b.kind === 'workflow' ? 'Workflow' : ''}</span>
        {isPhone && b.workflowRunId && (
          <svg className="pg-chevron" width="8" height="13" viewBox="0 0 8 13" aria-hidden="true">
            <path d="M1.5 1.5 6.5 6.5l-5 5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </div>
      {b.summary && b.status !== 'running' && <div className="muted bg-summary">{b.summary}</div>}
      {open && <pre className="output bg-output">{output === null ? 'The output can’t be read.' : stripAnsi(output) || 'No output yet.'}</pre>}
    </div>
  );
}

/** The installed addons, kept current: their toolCalls say how some tool calls show on Now. */
function useAddonList(): AddonInfo[] {
  const [addons, setAddons] = useState<AddonInfo[]>([]);
  useEffect(() => {
    void window.looper.addons
      .list()
      .then(setAddons)
      .catch(() => undefined);
    return window.looper.addons.onEvent((e) => {
      if (e.type === 'addons') setAddons(e.addons);
    });
  }, []);
  return addons;
}

/** The tool call Now shows: the one at `pos`, or the latest when it's null. */
export function nowIndex(count: number, pos: number | null): number {
  return pos === null ? count - 1 : Math.min(pos, count - 1);
}

/**
 * The Sessions window's right panel: Now shows the agent's latest tool call
 * like its screen (the toolbar goes back through earlier ones, and the last
 * one follows new calls), Subagents lists each one's agent, model, effort and
 * context, Files lists what it worked on, and Background shows what runs in
 * the background (a workflow's item opens its tab beside the conversation).
 */
export function ActivityPanel({
  sessionId,
  taskId,
  rows,
  rowsAgent,
  attachments,
  background,
  subagents,
  following,
  onFollow,
  onOpenWorkflow,
  workflowRun,
  onOpenWorkflowAgent,
  working,
  pos,
  onPos,
  gitProject,
  initialTab = 'now',
}: {
  sessionId: string;
  taskId: string;
  /** The conversation being watched: the session's, or the followed subagent's or open workflow agent's. */
  rows: MessageRow[];
  /** Whose conversation `rows` is: the subagent's or workflow agent's id; null for the session's. */
  rowsAgent: string | null;
  attachments: Attachment[];
  background: BackgroundTask[];
  subagents: SubagentInfo[];
  following: string | null;
  onFollow: (agentId: string | null) => void;
  /** Show a workflow run's tab beside the conversation (its Background item was clicked). */
  onOpenWorkflow: (runId: string) => void;
  /** The workflow run open beside the conversation: its agents are listed in Subagents. */
  workflowRun?: WorkflowRun | null;
  /** Show one of its agents' conversations. */
  onOpenWorkflowAgent?: (runId: string, agentId: string) => void;
  /** The session is working: Subagents says "No subagents yet." while one may still start. */
  working?: boolean;
  /** The tool call Now shows; null follows the latest. */
  pos: number | null;
  onPos: (pos: number | null) => void;
  /** The session's project, when its folder is in a git repository: the Git tab shows it. */
  gitProject?: string;
  /** The tab it opens on (the phone's Subagents row opens it on Subagents). */
  initialTab?: Tab;
}) {
  const [picked, setTab] = useState<Tab>(initialTab);
  const tab = picked === 'git' && !gitProject ? 'now' : picked;
  const git = useGitStatus(gitProject);
  const addons = useAddonList();
  const tools = rows.filter((r) => r.kind === 'tool');
  const i = nowIndex(tools.length, pos);
  const row = tools[i];
  const step = (to: number) => onPos(to >= tools.length - 1 ? null : Math.max(0, to));

  const files = new Map<string, { changed: boolean; index: number }>();
  tools.forEach((t, n) => {
    if (!t.file) return;
    const prev = files.get(t.file);
    files.set(t.file, { changed: (prev?.changed ?? false) || CHANGES.has(t.tool ?? ''), index: n });
  });
  const changed = [...files].filter(([, f]) => f.changed);
  const read = [...files].filter(([, f]) => !f.changed);
  const showFile = (index: number) => {
    setTab('now');
    step(index);
  };
  const running = background.filter((b) => b.status === 'running');
  const finished = background.filter((b) => b.status !== 'running').slice(0, 5);

  return (
    <aside className="activity-panel">
      <TabBar
        tabs={[
          ['now', 'Now'],
          ['background', running.length ? `Background (${running.length})` : 'Background'],
          ['subagents', subagents.length ? `Subagents (${subagents.length})` : 'Subagents'],
          ['files', 'Files'],
          ...(gitProject ? ([['git', gitTabLabel(git.status?.repo ? git.status.changes : undefined)]] as [Tab, string][]) : []),
        ]}
        active={tab}
        onSelect={setTab}
        className="activity-tabs"
        label="Activity"
      />
      <div className="activity-body">
        {tab === 'now' &&
          (row ? (
            <>
              <div className="toolbar pane-toolbar">
                <ToolButton icon={NAV_ICONS.previous} title="Previous Tool Call" enabled={i > 0} onClick={() => step(i - 1)} />
                <ToolButton icon={NAV_ICONS.next} title="Next Tool Call" enabled={i < tools.length - 1} onClick={() => step(i + 1)} />
                <ToolButton icon={NAV_ICONS.latest} title="Follow the Latest Tool Call" enabled onClick={() => onPos(null)} pressed={pos === null} />
                <span className="muted now-place">
                  {i + 1} of {tools.length}
                </span>
              </div>
              <NowScreen row={row} taskId={taskId} runId={sessionId} agentId={rowsAgent ?? undefined} addons={addons} />
            </>
          ) : (
            <div className="empty">The agent hasn't used a tool yet.</div>
          ))}
        {tab === 'background' && (
          <div className="background-tab">
            {running.length === 0 && finished.length === 0 && <div className="muted background-none">Nothing is running in the background.</div>}
            {running.length > 0 && <div className="pane-title files-heading">Running</div>}
            {running.map((b) => (
              <BackgroundItem key={b.id} b={b} sessionId={sessionId} taskId={taskId} onOpenWorkflow={onOpenWorkflow} />
            ))}
            {finished.length > 0 && <div className="pane-title files-heading">Finished</div>}
            {finished.map((b) => (
              <BackgroundItem key={b.id} b={b} sessionId={sessionId} taskId={taskId} onOpenWorkflow={onOpenWorkflow} />
            ))}
          </div>
        )}
        {tab === 'subagents' && (
          <div className="subagent-list">
            {subagents.map((a) => (
              <div
                key={a.agentId}
                className={`subagent-item${following === a.agentId ? ' selected' : ''}`}
                onClick={() => onFollow(a.agentId)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  window.looper.showMessageContextMenu({ taskId, runId: sessionId, agentId: a.agentId, label: a.description });
                }}
              >
                <div className="subagent-head">
                  <span className="subagent-desc">{a.description || a.type}</span>
                  <span className={a.status === 'failed' ? 'error-text' : 'muted'}>
                    {a.status === 'running' ? 'Running' : a.status === 'done' ? 'Done' : 'Failed'}
                  </span>
                </div>
                <dl className="subagent-facts">
                  <dt>Agent</dt>
                  <dd>{a.type}</dd>
                  <dt>Model</dt>
                  <dd className="mono">{a.modelId ?? a.model ?? 'Not known yet'}</dd>
                  <dt>Effort</dt>
                  <dd>{a.effort ? (EFFORT_LEVELS['claude-code'].find(([v]) => v === a.effort)?.[1] ?? a.effort) : 'Not known yet'}</dd>
                  <dt>Context</dt>
                  <dd>{a.contextTokens !== undefined ? `${formatTokens(a.contextTokens)} tokens` : 'Not known yet'}</dd>
                  <dt>Runs</dt>
                  <dd>{a.background ? 'In the background' : 'In the foreground'}</dd>
                </dl>
              </div>
            ))}
            {workflowRun && workflowAgents(workflowRun).length > 0 && (
              <>
                <div className="pane-title files-heading">Workflow</div>
                {workflowAgents(workflowRun).map((a) => (
                  <div
                    key={a.agentId}
                    className="subagent-item"
                    role="button"
                    tabIndex={0}
                    onClick={() => onOpenWorkflowAgent?.(workflowRun.runId, a.agentId)}
                    onKeyDown={(e) => {
                      if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
                      e.preventDefault();
                      onOpenWorkflowAgent?.(workflowRun.runId, a.agentId);
                    }}
                  >
                    <div className="subagent-head">
                      <StatusMark status={tabStatus(a.status)} />
                      <span className="subagent-desc">{a.label}</span>
                      <span className={a.status === 'failed' ? 'error-text' : 'muted'}>{WORKFLOW_STATUS_TEXT[a.status]}</span>
                    </div>
                  </div>
                ))}
              </>
            )}
            {subagents.length === 0 && !workflowRun?.phases.some((p) => p.agents.length > 0) && <div className="empty">{working ? 'No subagents yet.' : 'No subagents.'}</div>}
          </div>
        )}
        {tab === 'files' && (
          <div className="files-tab">
            {changed.length > 0 && <div className="pane-title files-heading">Changed</div>}
            {changed.map(([p, f]) => (
              <FileItem key={p} path={p} taskId={taskId} runId={sessionId} onShow={() => showFile(f.index)} />
            ))}
            {read.length > 0 && <div className="pane-title files-heading">Read</div>}
            {read.map(([p, f]) => (
              <FileItem key={p} path={p} taskId={taskId} runId={sessionId} onShow={() => showFile(f.index)} />
            ))}
            {attachments.length > 0 && (
              <>
                <div className="pane-title files-heading">Attached</div>
                <AttachmentList items={attachments} />
              </>
            )}
            {files.size === 0 && attachments.length === 0 && <div className="empty">No files yet.</div>}
          </div>
        )}
        {tab === 'git' && gitProject && <GitView projectId={gitProject} watch={git} narrow />}
      </div>
    </aside>
  );
}
