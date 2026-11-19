import { useEffect, useState, type ReactNode } from 'react';
import { useThumbnail } from './hooks';
import { findToolCall, toolCallTitle, type AddonInfo, type AddonToolCall } from '@shared/addons';
import type { Attachment } from '@shared/chat';
import { effortLabel } from '@shared/environments';
import type { MessageRow, SentFile } from '@shared/messages';
import { baseName, dirName } from '@shared/paths';
import type { BackgroundTask, SubagentInfo } from '@shared/sessions';
import { WORKFLOW_STATUS_TEXT, workflowAgents, type WorkflowRun } from '@shared/workflows';
import { stripAnsi } from '../format';
import { useAddonList } from '../live-state';
import { AgentRow, tokensText, WorkflowAgentList } from './AgentRows';
import { AttachmentList, SentFileList } from './ChatRows';
import { WaitedFor } from './Live';
import { changeRows, writtenLines, type EditorLine } from './editor-lines';
import { gitTabLabel } from '@shared/git';
import { GitView, useGitStatus } from './GitView';
import { AddonScreenView } from './AddonScreen';
import { AddonProjectTabView, useAddonProjectTabs, type AddonProjectTabId } from './AddonProjectTabs';
import { RowList } from './DataTable';
import { EmptyState } from './EmptyState';
import { Markdown, MessageBody } from './Markdown';
import { Section } from './Section';
import { newestFirst } from './subagents';
import { Toolbar } from './Toolbar';
import { CodeBlock, CodeText, DiffRows, ParamTable, ToolImage, ToolInputView, ToolResultView, gutterLines, useHighlight } from './ToolContent';
import { TabBar } from './ui';

export type ActivityTab = 'now' | 'background' | 'subagents' | 'files' | 'git' | AddonProjectTabId;
type Tab = ActivityTab;

/** Tools that change a file (Delete and Patch are Codex's). */
const CHANGES = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Delete', 'Patch']);

const IMAGE_RE = /\.(png|jpe?g|gif|webp)$/i;
const MARKDOWN_RE = /\.(md|markdown)$/i;

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const inputOf = (row: MessageRow): Record<string, unknown> =>
  row.input !== null && typeof row.input === 'object' && !Array.isArray(row.input) ? (row.input as Record<string, unknown>) : {};

/** A tool call's title and what it worked on: an addon's own title, else the tool and its file, command or preview. */
function callTitle(row: MessageRow, addons: AddonInfo[]): { title: string | undefined; subject: string } {
  const custom = row.tool ? findToolCall(addons, row.tool) : undefined;
  if (custom?.call.title) return { title: toolCallTitle(custom.call.title, inputOf(row)), subject: '' };
  return { title: row.tool, subject: row.file ?? str(inputOf(row).command)?.split('\n')[0] ?? row.preview };
}

/**
 * The Markdown document a call read or wrote, which Now shows formatted: a
 * finished Read's lines (without the notes the harness adds after them), or
 * a Write's content. Null for any other call; an edit keeps its diff.
 */
function markdownDoc(row: MessageRow): string | null {
  if (!MARKDOWN_RE.test(row.file ?? '') || row.resultError) return null;
  if (row.tool === 'Write') return str(inputOf(row).content) ?? null;
  if (row.tool !== 'Read' || row.result === undefined) return null;
  const lines = gutterLines(row.result);
  return lines ? lines.filter((l) => l.n !== '').map((l) => l.text).join('\n') : null;
}

/** The main agent's name in a message's From and To. */
const MAIN_AGENT = 'Main agent';

/** A message between agents, as an email: who sent it, to whom, its subject, and the message in Markdown. */
interface Mail {
  from: string;
  to: string;
  subject?: string;
  /** The call's other parameters, as more header rows. */
  rest: [string, unknown][];
  text: string;
}

/**
 * A call that's a message between agents: SendMessage (to another agent,
 * by its id), SubagentHandback (a subagent's final report, to the agent that
 * started it), or an Agent call's prompt (to the subagent it starts). `from`
 * is the agent whose conversation it's in; `nameOf` names an agent by its id.
 */
function mailOf(row: MessageRow, from: string, nameOf: (id: string) => string): Mail | null {
  const input = inputOf(row);
  const rest = (shown: string[]) => Object.entries(input).filter(([k]) => !shown.includes(k));
  const message = str(input.message);
  if (row.tool === 'SendMessage' && message) {
    const to = str(input.to);
    // Claude Code records `type`, `recipient`, `recipient_kind` and `content` as copies of the fields above.
    const shown = ['to', 'summary', 'message', 'type', 'recipient', 'recipient_kind', 'content'];
    return { from, to: to ? nameOf(to) : '', subject: str(input.summary), rest: rest(shown), text: message };
  }
  if (row.tool === 'SubagentHandback' && message) return { from, to: MAIN_AGENT, rest: rest(['message']), text: message };
  const prompt = str(input.prompt);
  if ((row.tool === 'Agent' || row.tool === 'Task') && prompt) {
    const to = str(input.subagent_type) ?? 'Subagent';
    return { from, to, subject: str(input.description), rest: rest(['subagent_type', 'description', 'prompt']), text: prompt };
  }
  return null;
}

const headerValue = (v: unknown): string => (typeof v === 'string' ? v : (JSON.stringify(v) ?? String(v)));

/** A message between agents as an email: its header rows, then the message formatted. */
function MailView({ mail }: { mail: Mail }) {
  const rows: [string, string][] = [
    ['From', mail.from],
    ['To', mail.to],
    ...(mail.subject ? ([['Subject', mail.subject]] as [string, string][]) : []),
    ...mail.rest.map(([k, v]) => [k, headerValue(v)] as [string, string]),
  ];
  return (
    <div className="now-mail">
      <table className="now-mail-head">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <th scope="row">{k}</th>
              <td>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="now-mail-body">
        <MessageBody text={mail.text} />
      </div>
    </div>
  );
}

/** A Markdown file as a document: formatted, on a page of a readable width. */
function DocScreen({ text }: { text: string }) {
  return (
    <div className="now-doc">
      <div className="now-doc-page">
        <Markdown text={text} breaks={false} />
      </div>
    </div>
  );
}

/**
 * Every tool call of the conversation, one row each: the tool, what it worked
 * on, and "Running" or "Failed". The shown call is selected; Up and Down move
 * the selection, a click or Enter shows the call on the screen.
 */
function CallList({
  tools,
  index,
  addons,
  onIndex,
  onShow,
}: {
  tools: MessageRow[];
  index: number;
  addons: AddonInfo[];
  onIndex: (i: number) => void;
  onShow: (i: number) => void;
}) {
  const state = (t: MessageRow) => (t.result === undefined ? 'Running' : t.resultError ? 'Failed' : undefined);
  return (
    <RowList
      rows={tools}
      rowKey={(t) => t.id}
      idPrefix="now-call"
      selected={tools[index]?.id ?? null}
      onSelect={(_, n) => onIndex(n)}
      onOpen={(t) => onShow(tools.indexOf(t))}
      activateOnClick
      autoFocus
      label="Tool calls"
      listClass="now-calls"
      rowClass="now-call"
      empty={null}
      row={(t) => {
        const { title, subject } = callTitle(t, addons);
        return (
          <>
            <span className="now-call-tool">{title}</span>
            <span className="mono now-call-subject">{subject}</span>
            {state(t) && <span className={`now-call-state ${t.resultError ? 'error-text' : 'muted'}`}>{state(t)}</span>}
          </>
        );
      }}
      phoneRow={(t) => {
        const { title, subject } = callTitle(t, addons);
        return { title, sub: subject, value: state(t), valueTone: t.resultError ? 'error' : undefined, chevron: false };
      }}
    />
  );
}

/** The file in an editor: its lines with their numbers, colored for its language. */
function EditorScreen({ file, lines, note }: { file?: string; lines: EditorLine[]; note?: string }) {
  const html = useHighlight(
    lines.map((l) => l.text),
    file,
  );
  return (
    <div className="now-editor">
      <div className="now-editor-lines">
        {lines.map((l, i) => (
          <div key={i} className="now-editor-line">
            <span className="now-editor-gutter">{l.n}</span>
            <CodeText className="now-editor-text" html={html?.[i]} text={l.text} />
          </div>
        ))}
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

/**
 * One tool call as the agent's screen: the file it read, the change it made,
 * the command and its output, a message to another agent as an email, a
 * Markdown file as a document (or its source, with `source`).
 */
function NowScreen({
  row,
  taskId,
  runId,
  agentId,
  addons,
  source,
  nameOf,
}: {
  row: MessageRow;
  taskId: string;
  runId: string;
  agentId?: string;
  addons: AddonInfo[];
  source: boolean;
  /** An agent's name by its id; null: the main agent. */
  nameOf: (id: string | null) => string;
}) {
  const ctx = { taskId, runId, agentId };
  const running = row.result === undefined;
  const custom = row.tool ? findToolCall(addons, row.tool) : undefined;
  const { title, subject } = callTitle(row, addons);
  const image = row.tool === 'Read' && !running && (!!row.image || (!row.resultError && IMAGE_RE.test(row.file ?? '')));
  const lines = row.tool === 'Read' && !running && !image ? gutterLines(row.result ?? '') : null;
  const changed = row.tool && CHANGES.has(row.tool) ? changeRows(row) : null;
  const written = row.tool && CHANGES.has(row.tool) ? writtenLines(row) : null;
  const doc = source ? null : markdownDoc(row);
  const mail = custom ? null : mailOf(row, nameOf(agentId ?? null), nameOf);
  let body;
  let screen = true;
  if (custom) {
    screen = false;
    body = <AddonCallScreen row={row} ctx={ctx} addon={custom.addon} call={custom.call} />;
  } else if (doc !== null) {
    body = <DocScreen text={doc} />;
  } else if (mail) {
    screen = false;
    body = (
      <>
        <MailView mail={mail} />
        {running ? (
          runningNote(row)
        ) : (
          row.result?.trim() && (
            <div className="now-result">
              <ToolResultView row={row} ctx={ctx} />
            </div>
          )
        )}
      </>
    );
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
    body = <EditorScreen file={row.file} lines={lines} />;
  } else if (changed) {
    body = (
      <div className="now-diff">
        <DiffRows rows={changed} file={row.file} />
      </div>
    );
  } else if (written) {
    body = <EditorScreen file={row.file} lines={written} />;
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

/** A file's thumbnail when it's an image. */
function FileThumb({ path, taskId }: { path: string; taskId: string }) {
  const thumb = useThumbnail(IMAGE_RE.test(path) ? () => window.looper.sessions.fileThumbnail(taskId, path) : null, [taskId, path]);
  return thumb ? <img className="file-thumb" src={thumb} alt="" /> : null;
}

/** A background command's or workflow's state: "Running for 3 min" counts whole minutes, from a minute on. */
function BackgroundStatus({ b }: { b: BackgroundTask }) {
  const started = b.startedAt ? Date.parse(b.startedAt) : NaN;
  const status = WORKFLOW_STATUS_TEXT[b.status];
  return b.status !== 'running' || Number.isNaN(started) ? <>{status}</> : <WaitedFor since={started} label={status} />;
}

/** The end of a background command's output, read again every few seconds while it runs. */
function BackgroundOutput({ b, sessionId }: { b: BackgroundTask; sessionId: string }) {
  const [output, setOutput] = useState<string | null>(null);
  useEffect(() => {
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
  }, [b.status, sessionId, b.id]);
  return <pre className="output bg-output">{output === null ? 'The output can’t be read.' : stripAnsi(output) || 'No output yet.'}</pre>;
}

const effortText = (a: SubagentInfo) => (a.effort ? effortLabel('claude-code', a.effort) : undefined);
const contextText = (a: SubagentInfo) => (a.contextTokens !== undefined ? tokensText(a.contextTokens) : undefined);

/** The tool call Now shows: the one at `pos`, or the latest when it's null. */
export function nowIndex(count: number, pos: number | null): number {
  return pos === null ? count - 1 : Math.min(pos, count - 1);
}

/**
 * The Sessions window's right panel: Now shows the agent's latest tool call
 * like its screen (the toolbar goes back through earlier ones, the last one
 * follows new calls, and the list shows them all), Subagents lists each one's
 * agent, model, effort and context, newest first, Files lists what it sent the
 * user and worked on, and Background shows the commands and workflows that run
 * in the background (a workflow's item opens its tab beside the conversation).
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
  projectId,
  initialTab = 'now',
  only,
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
  /** The session's project: the started addons' project tabs show it, after Looper's own. */
  projectId?: string;
  /** The tab it opens on (the phone's Subagents row opens it on Subagents). */
  initialTab?: Tab;
  /** The tabs it shows; unset: all of them. A past conversation (History) has nothing in the background. */
  only?: Tab[];
}) {
  const [picked, setTab] = useState<Tab>(initialTab);
  const addonTabs = useAddonProjectTabs(projectId).filter((t) => !only || only.includes(t.id));
  const addonTab = addonTabs.find((t) => t.id === picked);
  const tab = (picked === 'git' && !gitProject) || (picked.startsWith('addon:') && !addonTab) ? 'now' : picked;
  const git = useGitStatus(gitProject, !!working || background.some((b) => b.status === 'running') || subagents.some((a) => a.status === 'running'));
  const { addons } = useAddonList();
  const tools = rows.filter((r) => r.kind === 'tool');
  const i = nowIndex(tools.length, pos);
  const row = tools[i];
  const step = (to: number) => onPos(to >= tools.length - 1 ? null : Math.max(0, to));
  // Now as a list of every tool call instead of the one call's screen; a Markdown file as its source.
  const [listView, setListView] = useState(false);
  const [mdSource, setMdSource] = useState(false);
  const agentNames = new Map<string, string>([
    ...subagents.map((a) => [a.agentId, a.description || a.type] as [string, string]),
    ...(workflowRun ? workflowAgents(workflowRun).map((a) => [a.agentId, a.label] as [string, string]) : []),
  ]);
  const nameOf = (id: string | null) => (id === null ? MAIN_AGENT : (agentNames.get(id) ?? id));

  const files = new Map<string, { changed: boolean; index: number }>();
  tools.forEach((t, n) => {
    if (!t.file) return;
    const prev = files.get(t.file);
    files.set(t.file, { changed: (prev?.changed ?? false) || CHANGES.has(t.tool ?? ''), index: n });
  });
  const changed = [...files].filter(([, f]) => f.changed);
  const read = [...files].filter(([, f]) => !f.changed);
  // The files the agent sent the user (SendUserFile), each once.
  const received = [...new Map(rows.flatMap((r) => r.sent?.files ?? []).map((f) => [f.path, f] as [string, SentFile])).values()];
  const showFile = (index: number) => {
    setTab('now');
    step(index);
  };
  // Subagents are in their own tab, background ones too.
  const own = background.filter((b) => b.kind !== 'agent');
  const running = own.filter((b) => b.status === 'running');
  const finished = own.filter((b) => b.status !== 'running').slice(0, 5);
  // Each list's selected row, for its keys, and the background commands whose output is open.
  const [sel, setSel] = useState<{ background: string | null; file: string | null; agent: string | null }>({ background: null, file: null, agent: null });
  const [openOutput, setOpenOutput] = useState<ReadonlySet<string>>(new Set());

  const openBackground = (b: BackgroundTask) => {
    if (b.workflowRunId) onOpenWorkflow(b.workflowRunId);
    else if (b.outputFile)
      setOpenOutput((s) => {
        const next = new Set(s);
        if (!next.delete(b.id)) next.add(b.id);
        return next;
      });
  };
  const backgroundList = (title: string, list: BackgroundTask[]) =>
    list.length > 0 && (
      <Section className="activity-section" title={title}>
        <RowList
          bare
          rows={list}
          rowKey={(b) => b.id}
          idPrefix={`background-${title.toLowerCase()}`}
          label={title}
          listClass="pane-rows"
          rowClass={title === 'Running' ? 'bg-item running' : 'bg-item'}
          selected={sel.background}
          onSelect={(b) => setSel((p) => ({ ...p, background: b.id }))}
          onOpen={openBackground}
          activateOnClick
          onMenu={(b) => window.looper.showMessageContextMenu({ taskId, runId: sessionId, file: b.outputFile, text: b.command })}
          empty={null}
          row={(b) => (
            <>
              <div className="bg-item-head">
                <span className={`bg-status${b.status === 'failed' ? ' error-text' : ''}${b.status === 'running' ? ' live-only' : ''}`}>
                  <BackgroundStatus b={b} />
                </span>
                <span className="bg-label">{b.label}</span>
                <span className="muted bg-kind">{b.kind === 'workflow' ? 'Workflow' : ''}</span>
              </div>
              {b.summary && b.status !== 'running' && <div className="muted bg-summary">{b.summary}</div>}
              {openOutput.has(b.id) && <BackgroundOutput b={b} sessionId={sessionId} />}
            </>
          )}
          phoneRow={(b) => ({
            title: b.label,
            sub: (
              <>
                <BackgroundStatus b={b} />
                {b.kind === 'workflow' ? ' · Workflow' : ''}
                {b.summary && b.status !== 'running' ? ` · ${b.summary}` : ''}
              </>
            ),
            tone: b.status === 'failed' ? 'error' : b.status === 'running' ? undefined : 'muted',
            chevron: !!b.workflowRunId,
            detail: openOutput.has(b.id) && <BackgroundOutput b={b} sessionId={sessionId} />,
          })}
        />
      </Section>
    );
  const fileList = (title: string, list: [string, { index: number }][]) =>
    list.length > 0 && (
      <Section className="activity-section" title={title}>
        <RowList
          bare
          rows={list}
          rowKey={([p]) => p}
          idPrefix={`file-${title.toLowerCase()}`}
          label={title}
          listClass="pane-rows"
          rowClass="file-item"
          selected={sel.file}
          onSelect={([p]) => setSel((s) => ({ ...s, file: p }))}
          onOpen={([, f]) => showFile(f.index)}
          activateOnClick
          onMenu={([p]) => window.looper.showMessageContextMenu({ taskId, runId: sessionId, file: p })}
          empty={null}
          row={([p]) => (
            <>
              <FileThumb path={p} taskId={taskId} />
              <div className="file-item-text">
                <div>{baseName(p)}</div>
                <div className="muted mono file-dir">{dirName(p)}</div>
              </div>
            </>
          )}
          phoneRow={([p]) => ({ lead: <FileThumb path={p} taskId={taskId} />, title: baseName(p), sub: dirName(p), chevron: false })}
        />
      </Section>
    );

  return (
    <aside className="activity-panel">
      <TabBar
        tabs={(
          [
            ['now', 'Now'],
            ['background', running.length ? `Background (${running.length})` : 'Background'],
            ['subagents', subagents.length ? `Subagents (${subagents.length})` : 'Subagents'],
            ['files', 'Files'],
            ...(gitProject ? ([['git', gitTabLabel(git.status?.repo ? git.status.changes : undefined)]] as [Tab, string][]) : []),
            ...addonTabs.map((t) => [t.id, t.title] as [Tab, string]),
          ] as [Tab, string][]
        ).filter(([t]) => !only || only.includes(t))}
        active={tab}
        onSelect={setTab}
        className="activity-tabs"
        label="Activity"
      />
      <div className="activity-body">
        {tab === 'now' &&
          (row ? (
            <>
              <Toolbar
                inline
                className="pane-toolbar"
                groups={[
                  {
                    id: 'calls',
                    items: [
                      { id: 'previous', label: 'Previous Tool Call', icon: 'previous', enabled: i > 0, run: () => step(i - 1) },
                      { id: 'next', label: 'Next Tool Call', icon: 'next', enabled: i < tools.length - 1, run: () => step(i + 1) },
                      { id: 'latest', label: 'Follow the Latest Tool Call', icon: 'latest', pressed: pos === null, run: () => onPos(null) },
                    ],
                  },
                  {
                    id: 'view',
                    items: [
                      { id: 'list', label: 'Tool Call List', icon: 'list', pressed: listView, run: () => setListView((v) => !v) },
                      ...(!listView && markdownDoc(row) !== null ? [{ id: 'source', label: 'Markdown Source', icon: 'source', pressed: mdSource, run: () => setMdSource((v) => !v) }] : []),
                    ],
                  },
                ]}
              >
                <span className="muted now-place">
                  {i + 1} of {tools.length}
                </span>
              </Toolbar>
              {listView ? (
                <CallList
                  tools={tools}
                  index={i}
                  addons={addons}
                  onIndex={step}
                  onShow={(n) => {
                    step(n);
                    setListView(false);
                  }}
                />
              ) : (
                <NowScreen row={row} taskId={taskId} runId={sessionId} agentId={rowsAgent ?? undefined} addons={addons} source={mdSource} nameOf={nameOf} />
              )}
            </>
          ) : (
            <EmptyState>The agent hasn't used a tool yet.</EmptyState>
          ))}
        {tab === 'background' && (
          <div className="background-tab">
            {running.length === 0 && finished.length === 0 && <div className="muted background-none">Nothing is running in the background.</div>}
            {backgroundList('Running', running)}
            {backgroundList('Finished', finished)}
          </div>
        )}
        {tab === 'subagents' && (
          <div className="subagent-list">
            {subagents.length > 0 && (
              <Section className="activity-section">
                <RowList
                  bare
                  rows={newestFirst(subagents)}
                  rowKey={(a) => a.agentId}
                  idPrefix="subagent"
                  label="Subagents"
                  listClass="pane-rows"
                  rowClass="subagent-item"
                  selected={following}
                  onSelect={(a) => onFollow(a.agentId)}
                  onMenu={(a) => window.looper.showMessageContextMenu({ taskId, runId: sessionId, agentId: a.agentId, label: a.description })}
                  empty={null}
                  row={(a) => (
                    <AgentRow
                      label={a.description || a.type}
                      status={a.status}
                      facts={[
                        { label: 'Agent', value: a.type },
                        { label: 'Model', value: a.modelId ?? a.model ?? 'Not known yet', className: 'mono' },
                        { label: 'Effort', value: effortText(a) ?? 'Not known yet' },
                        { label: 'Context', value: contextText(a) ?? 'Not known yet' },
                      ]}
                    />
                  )}
                  phoneRow={(a) => ({
                    title: a.description || a.type,
                    sub: [a.type, a.modelId ?? a.model, effortText(a), contextText(a)].filter(Boolean).join(' · '),
                    value: WORKFLOW_STATUS_TEXT[a.status],
                    valueTone: a.status === 'failed' ? 'error' : undefined,
                    chevron: false,
                  })}
                />
              </Section>
            )}
            {workflowRun && workflowAgents(workflowRun).length > 0 && (
              <Section className="activity-section" title="Workflow">
                <WorkflowAgentList
                  agents={workflowAgents(workflowRun)}
                  label="Workflow"
                  idPrefix="workflow-agent"
                  listClass="pane-rows"
                  selected={sel.agent}
                  onSelect={(agent) => setSel((p) => ({ ...p, agent }))}
                  onOpen={(agentId) => onOpenWorkflowAgent?.(workflowRun.runId, agentId)}
                  taskId={taskId}
                  sessionId={sessionId}
                />
              </Section>
            )}
            {subagents.length === 0 && !workflowRun?.phases.some((p) => p.agents.length > 0) && <EmptyState>{working ? 'No subagents yet.' : 'No subagents.'}</EmptyState>}
          </div>
        )}
        {tab === 'files' && (
          <div className="files-tab">
            {received.length > 0 && (
              <Section className="activity-section" title="Received">
                <SentFileList files={received} ctx={{ taskId, runId: sessionId }} />
              </Section>
            )}
            {fileList('Changed', changed)}
            {fileList('Read', read)}
            {attachments.length > 0 && (
              <Section className="activity-section" title="Attached">
                <AttachmentList items={attachments} />
              </Section>
            )}
            {files.size === 0 && attachments.length === 0 && received.length === 0 && <EmptyState>No files yet.</EmptyState>}
          </div>
        )}
        {tab === 'git' && gitProject && <GitView projectId={gitProject} watch={git} narrow />}
        {addonTab && projectId && tab === addonTab.id && <AddonProjectTabView shown={addonTab} projectId={projectId} narrow />}
      </div>
    </aside>
  );
}
