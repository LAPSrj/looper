import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useThumbnail } from './hooks';
import { findToolCall, toolCallTitle, type AddonInfo, type AddonToolCall } from '@shared/addons';
import type { Attachment } from '@shared/chat';
import { effortLabel } from '@shared/environments';
import { parseInspected } from '@shared/inspect';
import { CHANGE_TOOLS, SENT_IMAGE_RE, type MessageRow, type SentFile } from '@shared/messages';
import { baseName, dirName } from '@shared/paths';
import type { BackgroundTask, SubagentInfo } from '@shared/sessions';
import { WORKFLOW_STATUS_TEXT, tabStatus, workflowAgents, type WorkflowRun } from '@shared/workflows';
import { fmtClock, stripAnsi } from '../format';
import { isPhone } from '../web/page-nav';
import { useAddonList } from '../live-state';
import { AgentRow, tokensText, WorkflowAgentList } from './AgentRows';
import { BackgroundConsole, useBackgroundStatus } from './BackgroundConsole';
import { AttachmentList, CHEVRON, localScriptCalls, ScriptCallBox, SentFileList, type RowCtx } from './ChatRows';
import { languageOf } from './code-languages';
import { reportError } from '../report-error';
import { bytesView, FileViewContent } from '../web/file-view';
import type { FileView } from '../web/file-flows';
import { imageType, VIEWER_MAX_BYTES, viewerKind } from '../web/dialog-flows';
import { SplitPane } from './SplitPane';
import { changeRows, writtenLines, type EditorLine } from './editor-lines';
import { gitTabLabel } from '@shared/git';
import { GitView, useGitStatus } from './GitView';
import { AddonScreenView } from './AddonScreen';
import { AddonProjectTabView, useAddonProjectTabs, type AddonProjectTabId } from './AddonProjectTabs';
import { RowList } from './DataTable';
import type { ListMenuItem } from './RowList';
import { EmptyState } from './EmptyState';
import { ListDetail, selectsFirstRow } from './ListDetail';
import { NavBar, PanelPushedContext } from './NavBar';
import { Markdown, MessageBody } from './Markdown';
import { Section } from './Section';
import { newestFirst } from './subagents';
import { BottomToolbar } from './BottomToolbar';
import { Toolbar } from './Toolbar';
import { CodeBlock, CodeText, DiffRows, ParamTable, ToolImage, ToolInputView, ToolResultView, gutterLines, useHighlight } from './ToolContent';
import { TabBar } from './ui';

export type ActivityTab = 'now' | 'background' | 'subagents' | 'files' | 'git' | AddonProjectTabId;
type Tab = ActivityTab;


const IMAGE_RE = /\.(png|jpe?g|gif|webp)$/i;
const MARKDOWN_RE = /\.(md|markdown)$/i;

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const inputOf = (row: MessageRow): Record<string, unknown> =>
  row.input !== null && typeof row.input === 'object' && !Array.isArray(row.input) ? (row.input as Record<string, unknown>) : {};

/** A tool call's title and what it worked on: an addon's own title, else the tool and its file, command or preview. */
function callTitle(row: MessageRow, addons: AddonInfo[]): { title: string | undefined; subject: string } {
  const custom = row.tool ? findToolCall(addons, row.tool) : undefined;
  if (custom?.call.title) return { title: toolCallTitle(custom.call.title, inputOf(row)), subject: '' };
  // Its screen shows the caption: the title names the files.
  if (row.tool === 'SendUserFile') {
    const files = sentFilesOf(row);
    // The tool's name and what it worked on, as Read and Edit have them, not a sentence about it.
    return { title: row.tool, subject: files.map((f) => f.name).join(', ') };
  }
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

/** The files a SendUserFile call sent, or names before its result says what was delivered. */
function sentFilesOf(row: MessageRow): SentFile[] {
  if (row.sent) return row.sent.files;
  const input = inputOf(row);
  const files = Array.isArray(input.files) ? input.files.filter((f): f is string => typeof f === 'string' && f.trim() !== '') : [];
  return files.map((f) => ({ path: f.trim(), name: baseName(f.trim()), inline: SENT_IMAGE_RE.test(f) && input.display !== 'attach' }));
}


/** A sent file as Now shows it, read whole, as the Preview window shows it; null for a kind it doesn't show. */
function useSentFileView(f: SentFile, taskId: string): FileView | null {
  const kind = viewerKind(f.name, (n) => !!languageOf(n));
  const [read, setRead] = useState<Pick<FileView, 'url' | 'text' | 'data'> | { error: string } | null>(null);
  useEffect(() => {
    if (!kind) return;
    let live = true;
    setRead(null);
    window.looper.sessions
      .readSentFile(taskId, f.path, VIEWER_MAX_BYTES[kind])
      .then((r): Promise<Pick<FileView, 'url' | 'text' | 'data'> | { error: string }> => ('error' in r ? Promise.resolve(r) : bytesView(r.data, kind, imageType(f.name))))
      .then(
        (r) => live && setRead(r),
        (e: unknown) => live && setRead({ error: e instanceof Error ? e.message : String(e) }),
      );
    return () => {
      live = false;
    };
  }, [taskId, f.path, kind, f.name]);
  return useMemo(() => {
    if (!kind) return null;
    const shown = read && !('error' in read) ? read : null;
    const nothing = () => undefined;
    return {
      kind,
      url: shown?.url ?? null,
      text: shown?.text ?? null,
      data: shown?.data ?? null,
      error: read && 'error' in read ? read.error : '',
      htmlPage: (html: string, load: boolean) => window.looper.sessions.previewPage(html, load, { taskId, path: f.path }),
      toDevice: nothing,
      toHost: nothing,
      askDownload: nothing,
    };
  }, [kind, read, f.name, f.path, taskId]);
}

/** One sent file on Now: shown as Now shows a file, a Markdown one as a document; a double-click opens it in the Preview window (or its default program, for a kind Preview doesn't show). */
function SentFileView({ f, ctx, named }: { f: SentFile; ctx: RowCtx; named: boolean }) {
  const view = useSentFileView(f, ctx.taskId);
  const open = () => void window.looper.sessions.openFile(ctx.taskId, ctx.runId, f.path, false).catch(reportError);
  let shown: ReactNode;
  if (!view) shown = <SentFileList files={[f]} ctx={ctx} />;
  else if (view.kind === 'markdown' && view.text !== null) shown = <Markdown text={view.text} breaks={false} />;
  else shown = <FileViewContent view={view} name={f.name} classes={{ note: 'muted', text: 'now-sent-text' }} image={(url) => <img className="now-sent-image" src={url} alt={f.name} />} />;
  return (
    <div className="now-sent-file" onDoubleClick={open}>
      {named && <div className="muted now-sent-name">{f.name}</div>}
      <div className={view && ['image', 'pdf', 'docx', 'pptx'].includes(view.kind) ? 'now-sent-pages' : 'now-doc-page'}>{shown}</div>
    </div>
  );
}

/** A SendUserFile call as the files it sent, each on a page as Now shows a document, under the caption. */
function SentFilesScreen({ row, ctx }: { row: MessageRow; ctx: RowCtx }) {
  const files = sentFilesOf(row);
  // A phone lists every file of the call as the conversation does (thumbnails and cards): whole files, one page each, left a call's later files unseen.
  const caption = row.sent?.caption ?? str(inputOf(row).caption);
  return (
    <div className="now-doc now-sent">
      {caption && (
        <div className="now-sent-caption">
          <MessageBody text={caption} />
        </div>
      )}
      {isPhone ? <SentFileList files={files} ctx={ctx} /> : files.map((f) => <SentFileView key={f.path} f={f} ctx={ctx} named={files.length > 1} />)}
    </div>
  );
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

/** A parameter's name as a row label: `run_in_background` and `runInBackground` as "Run in background". */
const headerLabel = (k: string): string => {
  const words = k.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

const headerValue = (v: unknown): string => (typeof v === 'string' ? v : (JSON.stringify(v) ?? String(v)));

/** The first letter of a name, in capitals: the initial in a sender's avatar. */
const initialOf = (name: string): string => (/\p{L}|\p{N}/u.exec(name)?.[0] ?? '?').toUpperCase();

/** A hue (0 to 359) taken from a name, so the same sender has the same avatar color in every view, as Gmail's initials do. */
const avatarHue = (name: string): number => {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
};

/** What a message without a subject shows where its subject would be, as Gmail does on every device. */
const NO_SUBJECT = '(no subject)';

/** A message that comes back in the thread: a notice from Looper that the call failed, or the subagent's report. As in Gmail, a reply doesn't repeat the thread's subject: its subject line is only a notice's own. */
interface MailReply {
  from: string;
  to: string;
  subject: string;
  body: ReactNode;
}

/**
 * One message of a thread, as an email client shows it: the sender's round initial, the sender, the time at the
 * trailing edge, "to" the recipient with a toggle for the details (the call's other parameters), the subject, then
 * the message. The first message's subject is the thread's, so it is above the sender, as in Gmail on every device.
 */
function MailMessage({ from, to, time, ts, subject, first, details, children }: { from: string; to: string; time?: string; ts?: string; subject?: string; first?: boolean; details?: [string, unknown][]; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const rows: [string, string][] = [
    ['From', from],
    ['To', to],
    ...(details ?? []).map(([k, v]) => [headerLabel(k), headerValue(v)] as [string, string]),
  ];
  return (
    <section className={`now-mail-msg${first ? ' first' : ''}`}>
      <div className="now-mail-head">
        <span className="now-mail-avatar" style={{ '--hue': avatarHue(from) } as CSSProperties} aria-hidden="true">
          {initialOf(from)}
        </span>
        <div className="now-mail-meta">
          <div className="now-mail-line">
            <span className="now-mail-from">{from}</span>
            {time && (
              <time className="now-mail-time muted" dateTime={ts}>
                {time}
              </time>
            )}
          </div>
          <div className="now-mail-to muted">
            {to && (
              <span>
                to {to}
              </span>
            )}
            {details && details.length > 0 && (
              <button
                className={`now-mail-toggle${open ? ' open' : ''}`}
                aria-label={open ? 'Hide details' : 'Show details'}
                aria-expanded={open}
                onClick={() => setOpen((d) => !d)}
              >
                {CHEVRON}
              </button>
            )}
          </div>
        </div>
      </div>
      {open && (
        <table className="now-mail-details">
          <tbody>
            {rows.map(([k, v]) => (
              <tr key={k}>
                <th scope="row">{k}</th>
                <td>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {(subject || first) && <h2 className={`now-mail-subject${subject ? '' : ' empty'}`}>{subject ?? NO_SUBJECT}</h2>}
      <div className="now-mail-body">{children}</div>
    </section>
  );
}

/**
 * A message between agents as Gmail shows it (the web message view on the desktop, the Gmail app on phones and tablets): the
 * message, and under it, in the same thread, what came back: Looper's "Undelivered" notice when the call failed.
 * The call's own success is not shown; the message being there says it was sent.
 */
function MailView({ mail, ts, reply }: { mail: Mail; ts?: string; reply?: MailReply }) {
  const when = ts ? Date.parse(ts) : NaN;
  return (
    <div className="now-mail">
      <MailMessage from={mail.from} to={mail.to} time={Number.isNaN(when) ? undefined : fmtClock(when, Date.now())} ts={ts} subject={mail.subject} first details={mail.rest}>
        <MessageBody text={mail.text} />
      </MailMessage>
      {reply && (
        <MailMessage from={reply.from} to={reply.to} subject={reply.subject}>
          {reply.body}
        </MailMessage>
      )}
    </div>
  );
}

/**
 * What came back for a message: a failed call is an "Undelivered" notice from Looper with the error; an Agent call
 * that finished is the subagent's report as its reply. A call that went through has nothing (Claude Code's "Message
 * queued for delivery…" says only that), nor does one that started an agent in the background.
 */
function mailReplyOf(row: MessageRow, mail: Mail, ctx: RowCtx): MailReply | undefined {
  if (row.result === undefined) return undefined;
  if (row.resultError) {
    return {
      from: 'Looper',
      to: mail.from,
      subject: `Undelivered: ${mail.subject ?? NO_SUBJECT}`,
      body: (
        <>
          <p className="now-mail-notice">{mail.to ? `Your message to ${mail.to} wasn’t delivered.` : 'Your message wasn’t delivered.'}</p>
          <ToolResultView row={row} ctx={ctx} />
        </>
      ),
    };
  }
  if ((row.tool === 'Agent' || row.tool === 'Task') && !row.background && row.result.trim()) {
    return { from: mail.to, to: mail.from, subject: '', body: <ToolResultView row={row} ctx={ctx} /> };
  }
  return undefined;
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

/** A call's state in a list: "Running" or "Failed", else nothing. */
const callState = (t: MessageRow) => (t.result === undefined ? 'Running' : t.resultError ? 'Failed' : undefined);

/** Where a REPL call's script calls are read from, and what showing one does. */
interface ScriptView {
  ctx: RowCtx;
  agentId?: string;
  onShow: (repl: MessageRow, index: number) => void;
  /** The call the REPL call's lower half shows; unset, it follows the script's latest. */
  shown?: number;
  onShown?: (index: number | undefined) => void;
}

/** A Code Mode script's calls in a box of their own, newest last (ScriptCallBox): a click shows one; `shown` is selected. */
function ScriptCallRows({ repl, script, addons, shown, className }: { repl: MessageRow; script: ScriptView; addons: AddonInfo[]; shown?: number; className: string }) {
  return (
    <ScriptCallBox key={repl.toolUseId} toolUseId={repl.toolUseId!} count={repl.calls!.count} running={repl.calls!.running} ctx={script.ctx} agentId={script.agentId} className={className}>
      {(calls, start) =>
        calls.map((t, n) => {
          const { title, subject } = callTitle(t, addons);
          const show = () => script.onShow(repl, start + n);
          return (
            <div
              key={t.id}
              className={`now-call${start + n === shown ? ' selected' : ''}`}
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation();
                show();
              }}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return;
                e.stopPropagation();
                show();
              }}
            >
              <span className="now-call-tool">{title}</span>
              <span className="mono now-call-subject">{subject}</span>
              {callState(t) && <span className={`now-call-state ${t.resultError ? 'error-text' : 'muted'}`}>{callState(t)}</span>}
            </div>
          );
        })
      }
    </ScriptCallBox>
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
  expanded,
  onToggle,
  script,
  shownCall,
}: {
  tools: MessageRow[];
  index: number;
  addons: AddonInfo[];
  onIndex: (i: number) => void;
  onShow: (i: number) => void;
  /** The REPL calls whose script calls show under them, by tool_use id. */
  expanded: ReadonlySet<string>;
  onToggle: (repl: MessageRow) => void;
  script: ScriptView;
  /** The script call Now shows, under its REPL call. */
  shownCall: { repl: string; index: number } | null;
}) {
  const state = callState;
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
        const calls = t.calls && t.toolUseId ? t.calls : null;
        const open = !!calls && expanded.has(t.toolUseId!);
        const line = (
          <>
            {calls && (
              <button
                className={`now-call-toggle${open ? ' open' : ''}`}
                aria-label={open ? 'Hide the script’s calls' : 'Show the script’s calls'}
                aria-expanded={open}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggle(t);
                }}
              >
                {CHEVRON}
              </button>
            )}
            <span className="now-call-tool">{title}</span>
            <span className="mono now-call-subject">{subject}</span>
            {state(t) && <span className={`now-call-state ${t.resultError ? 'error-text' : 'muted'}`}>{state(t)}</span>}
          </>
        );
        if (!open) return line;
        // Open, the REPL call's line is the row's own (the selection and the focus frame it), and its calls are in a box under it.
        return (
          <>
            <div className="now-call-head">{line}</div>
            <ScriptCallRows
              repl={t}
              script={script}
              addons={addons}
              shown={shownCall && shownCall.repl === t.toolUseId ? shownCall.index : undefined}
              className="now-script-sub"
            />
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

/** The failed calls a script's console keeps as lines of their own, the newest. */
const FAILURES_SHOWN = 20;

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** A line of the console that shows one of the script's calls below it: a click or Enter. */
function CallLine({ onShow, selected, className, children }: { onShow?: () => void; selected?: boolean; className?: string; children: ReactNode }) {
  if (!onShow) return <div className={className}>{children}</div>;
  return (
    <div
      className={`now-console-call${selected ? ' selected' : ''}${className ? ` ${className}` : ''}`}
      role="button"
      tabIndex={0}
      onClick={onShow}
      onKeyDown={(e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        onShow();
      }}
    >
      {children}
    </div>
  );
}

/** A call the script made that failed, as the console keeps it: the tool, what it worked on and the first line of its error. */
function FailedCallLine({ repl, index, script, addons, version }: { repl: MessageRow; index: number; script: ScriptView; addons: AddonInfo[]; version: unknown }) {
  const { call } = useScriptCall(script, repl.toolUseId, index, version);
  const read = call && call !== 'gone' ? call : null;
  const { title, subject } = read ? callTitle(read, addons) : { title: `Call ${index + 1}`, subject: '' };
  const error = read?.result?.trim().split('\n')[0].slice(0, 200);
  return (
    <CallLine onShow={() => script.onShown?.(index >= (repl.calls?.count ?? 0) - 1 ? undefined : index)} selected={script.shown === index}>
      <span className="now-console-verb now-console-error">Failed</span>
      {title} {subject}
      {error && <span className="now-term-comment">: {error}</span>}
    </CallLine>
  );
}

/**
 * A REPL call as a script run in a console: the script at the prompt, the calls that failed, one line that follows
 * the call the script is making and then counts its calls, the lines it logged, and what it returned. A call's line
 * shows that call in the panel below.
 */
function ScriptConsole({ row, script, addons }: { row: MessageRow; script?: ScriptView; addons: AddonInfo[] }) {
  const code = (str(inputOf(row).code) ?? row.text).replace(/\n+$/, '').split('\n');
  const html = useHighlight(code, 'script.js');
  const running = row.result === undefined;
  const calls = row.calls && row.toolUseId ? row.calls : undefined;
  const lower = script && calls ? script : undefined;
  const latest = useScriptCall(lower, row.toolUseId, running && calls ? calls.count - 1 : -1, 0).call;
  const latestTitle = latest && latest !== 'gone' ? callTitle(latest, addons) : null;
  const failures = calls?.failures ?? [];
  const shownFailures = failures.slice(-FAILURES_SHOWN);
  const changedFiles = calls?.files?.filter((f) => f.changed).length ?? 0;

  // What it returned: a string as its text, any other value as indented JSON; the error that ended it as it reads.
  const parsed = running || row.resultError ? null : parseInspected(row.result ?? '');
  const json = parsed !== null && typeof parsed.value !== 'string';
  const value = running ? '' : parsed === null ? (row.result ?? '') : typeof parsed.value === 'string' ? parsed.value : (JSON.stringify(parsed.value, null, 2) ?? String(parsed.value));
  const valueLines = value.replace(/\n+$/, '').split('\n');
  const valueHtml = useHighlight(json ? valueLines : [], undefined, 'json');

  // A terminal keeps its end in view while the reader is there.
  const scroller = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && atEnd.current) el.scrollTop = el.scrollHeight;
  }, [code.length, html, calls?.count, failures.length, latestTitle?.subject, running, row.logs, value, valueHtml]);

  return (
    <div
      ref={scroller}
      className="now-terminal now-console"
      onScroll={(e) => {
        const el = e.currentTarget;
        atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 4;
      }}
    >
      {code.map((text, n) => (
        <div key={n} className="now-console-line">
          <span className="now-term-prompt now-console-prompt">{n === 0 ? '>' : ''}</span>
          <CodeText className="now-console-text" html={html?.[n]} text={text} />
        </div>
      ))}
      {lower && failures.length > shownFailures.length && <div className="now-term-comment">{plural(failures.length - shownFailures.length, 'earlier call')} failed</div>}
      {lower && shownFailures.map((index) => <FailedCallLine key={index} repl={row} index={index} script={lower} addons={addons} version={running ? 0 : calls!.count} />)}
      {running ? (
        <CallLine onShow={calls ? () => lower?.onShown?.(undefined) : undefined}>
          <span className="now-console-verb">Running</span>
          {calls && (
            <>
              {plural(calls.count, 'call')}
              {latestTitle && <span className="now-term-comment"> · </span>}
              {latestTitle && `${latestTitle.title} ${latestTitle.subject}`}{' '}
            </>
          )}
          <span className="now-term-cursor" />
        </CallLine>
      ) : (
        calls && (
          <CallLine onShow={lower ? () => lower.onShown?.(undefined) : undefined}>
            <span className="now-console-verb">Finished</span>
            {[plural(calls.count, 'call'), calls.failed ? `${calls.failed} failed` : '', changedFiles ? `${plural(changedFiles, 'file')} changed` : ''].filter(Boolean).join(', ')}
          </CallLine>
        )
      )}
      {!running && row.logs && <div>{stripAnsi(row.logs).replace(/\n+$/, '')}</div>}
      {!running &&
        (row.resultError ? (
          <div className="now-console-error">{value}</div>
        ) : (
          value.trim() !== '' &&
          valueLines.map((text, n) => (
            <div key={n} className="now-console-line">
              <span className="now-term-comment now-console-prompt">{n === 0 ? '<' : ''}</span>
              <CodeText className="now-console-text" html={valueHtml?.[n]} text={text} />
            </div>
          ))
        ))}
      {!running && (
        <div>
          <span className="now-term-prompt">&gt;</span>
        </div>
      )}
    </div>
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
  script,
  inner,
}: {
  row: MessageRow;
  taskId: string;
  runId: string;
  agentId?: string;
  addons: AddonInfo[];
  source: boolean;
  /** An agent's name by its id; null: the main agent. */
  nameOf: (id: string | null) => string;
  /** A REPL call's script calls, under its code. */
  script?: ScriptView;
  /** A script's call under its REPL call's screen: it keeps its title row, since the bar is the outer call's. */
  inner?: boolean;
}) {
  const ctx = { taskId, runId, agentId };
  const running = row.result === undefined;
  const custom = row.tool ? findToolCall(addons, row.tool) : undefined;
  const { title, subject } = callTitle(row, addons);
  const image = row.tool === 'Read' && !running && (!!row.image || (!row.resultError && IMAGE_RE.test(row.file ?? '')));
  const lines = row.tool === 'Read' && !running && !image ? gutterLines(row.result ?? '') : null;
  const changed = row.tool && CHANGE_TOOLS.has(row.tool) ? changeRows(row) : null;
  const written = row.tool && CHANGE_TOOLS.has(row.tool) ? writtenLines(row) : null;
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
        <MailView mail={mail} ts={row.ts} reply={mailReplyOf(row, mail, ctx)} />
        {running && runningNote(row)}
      </>
    );
  } else if (row.tool === 'SendUserFile' && !row.resultError && sentFilesOf(row).length) {
    body = <SentFilesScreen row={row} ctx={ctx} />;
  } else if (row.tool === 'REPL') {
    // The script run in a console, and the calls it made under it.
    const terminal = <ScriptConsole key={row.toolUseId ?? row.id} row={row} script={script} addons={addons} />;
    const calls = script && row.calls && row.toolUseId ? <ScriptNow repl={row} script={script} addons={addons} screen={{ taskId, runId, agentId, addons, source, nameOf }} /> : null;
    body = !calls ? (
      terminal
    ) : isPhone ? (
      // A phone can't drag a splitter: the call comes after the console at its own height, and Now scrolls to it.
      <div className="now-script-stack">
        {terminal}
        {calls}
      </div>
    ) : (
      <SplitPane axis="y" initial={60} unit="%" min={15} max={85} storageKey="now-script-split" first={terminal} second={calls} />
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
  } else if (row.tool === 'Read' || (row.tool && CHANGE_TOOLS.has(row.tool))) {
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
      {isPhone && !inner ? (
        // A phone's Activity is a sheet or a column with a bar of its own: the call's name and subject go there.
        <NavBar title={title} subtitle={[row.resultError ? 'Failed' : '', subject].filter(Boolean).join(' · ') || undefined} order={30} />
      ) : (
        <div className="now-title">
          <span className={`now-tool${subject ? '' : ' now-tool-only'}`}>{title}</span>
          {subject && <span className="mono now-subject">{subject}</span>}
          {row.resultError && <span className="error-text">Failed</span>}
        </div>
      )}
      <div className={`now-body${screen ? ' now-body-screen' : ''}${mail && !custom && doc === null ? ' now-body-mail' : ''}`}>{body}</div>
    </div>
  );
}

/** How many finished background tasks the Background tab lists, newest first. */
const FINISHED_SHOWN = 20;

/** What the Background list says a task is, beside its label; a command and a subagent say nothing. */
const BACKGROUND_KINDS: Partial<Record<BackgroundTask['kind'], string>> = { workflow: 'Workflow', monitor: 'Monitor' };

/** A file's thumbnail when it's an image. */
function FileThumb({ path, taskId }: { path: string; taskId: string }) {
  const thumb = useThumbnail(IMAGE_RE.test(path) ? () => window.looper.sessions.fileThumbnail(taskId, path) : null, [taskId, path]);
  return thumb ? <img className="file-thumb" src={thumb} alt="" /> : null;
}

/** A background command's or workflow's state (useBackgroundStatus), ticking in a component of its own. */
function BackgroundStatus({ b }: { b: BackgroundTask }) {
  return <>{useBackgroundStatus(b)}</>;
}

const effortText = (a: SubagentInfo) => (a.effort ? effortLabel('claude-code', a.effort) : undefined);
const contextText = (a: SubagentInfo) => (a.contextTokens !== undefined ? tokensText(a.contextTokens) : undefined);

/**
 * One of a script's calls, read from the engine, and read again when `version` changes. `current` is false while the
 * call read last is another one (an earlier index, or another script's).
 */
function useScriptCall(script: ScriptView | undefined, toolUseId: string | undefined, index: number, version: unknown) {
  const [read, setRead] = useState<{ key: string; call: MessageRow | 'gone' } | null>(null);
  const key = `${toolUseId}\0${index}`;
  useEffect(() => {
    if (!script || !toolUseId || index < 0) return;
    let live = true;
    const { ctx, agentId } = script;
    const page = ctx.scriptCalls ? ctx.scriptCalls(toolUseId, index + 1, 1) : window.looper.runs.scriptCalls(ctx.taskId, ctx.runId, toolUseId, index + 1, 1, agentId);
    void page.then(
      (p) => live && setRead({ key, call: p?.rows[0] ?? 'gone' }),
      () => live && setRead({ key, call: 'gone' }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, version]);
  return { call: read?.call ?? null, current: read?.key === key };
}

/** One of a script's calls, read from the engine, as its own screen. */
function ScriptCallScreen({ repl, index, script, ...screen }: { repl: MessageRow; index: number; script: ScriptView } & Omit<Parameters<typeof NowScreen>[0], 'row' | 'script'>) {
  // Read again as the script's calls end: this one may have.
  const { call, current } = useScriptCall(script, repl.toolUseId, index, repl.calls?.running ?? 0);
  if (!current || call === null || call === 'gone') {
    return <div className="now-body muted">{!current || call === null ? 'Loading the call…' : 'The call can’t be shown.'}</div>;
  }
  return <NowScreen {...screen} row={call} inner />;
}

/**
 * A REPL call's lower half, as Now is for the conversation: the script's latest call (or the one picked) as its
 * screen, a toolbar that steps through the script's calls and follows its latest, and the list of them.
 */
function ScriptNow({ repl, script, addons, screen }: { repl: MessageRow; script: ScriptView; addons: AddonInfo[]; screen: Omit<Parameters<typeof NowScreen>[0], 'row' | 'script'> }) {
  const count = repl.calls!.count;
  const [listView, setListView] = useState(false);
  const k = Math.min(script.shown ?? count - 1, count - 1);
  const go = (to: number) => script.onShown?.(to >= count - 1 ? undefined : Math.max(0, to));
  return (
    <div className="now-script-now">
      <Toolbar
        inline
        className="pane-toolbar"
        groups={[
          {
            id: 'calls',
            items: [
              { id: 'previous', label: 'Previous Call in the Script', icon: 'previous', enabled: k > 0, run: () => go(k - 1) },
              { id: 'next', label: 'Next Call in the Script', icon: 'next', enabled: k < count - 1, run: () => go(k + 1) },
              { id: 'latest', label: 'Follow the Script’s Latest Call', icon: 'latest', pressed: script.shown === undefined, run: () => go(count - 1) },
            ],
          },
          { id: 'view', items: [{ id: 'list', label: 'The Script’s Call List', icon: 'list', pressed: listView, run: () => setListView((v) => !v) }] },
        ]}
      >
        <span className="muted now-place">
          {k + 1} of {count}
        </span>
      </Toolbar>
      {listView ? (
        <ScriptCallRows
          repl={repl}
          script={{
            ...script,
            onShow: (_r, index) => {
              go(index);
              setListView(false);
            },
          }}
          addons={addons}
          shown={k}
          className="now-script-calls"
        />
      ) : (
        <ScriptCallScreen key={k} repl={repl} index={k} script={script} {...screen} />
      )}
    </div>
  );
}

/** The tool call Now shows: the one at `pos`, or the latest when it's null. */
export function nowIndex(count: number, pos: number | null): number {
  return pos === null ? count - 1 : Math.min(pos, count - 1);
}

/**
 * The Sessions window's right panel: Now shows the agent's latest tool call
 * like its screen (the toolbar goes back through earlier ones, the last one
 * follows new calls, and the list shows them all), Subagents lists each one's
 * agent, model, effort and context, newest first, with the selected one's
 * conversation under the list, Files lists what it sent the user and worked on,
 * and Background lists the commands and workflows that run in the background,
 * with the selected one's output as a console under the list (a workflow's item
 * opens its tab beside the conversation). On a phone a row of either list pushes
 * what the desktop shows under it.
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
  scriptCalls,
  canStopBackground,
  agentConversation,
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
  /** A transcript outside Looper's runs: its Code Mode scripts' calls (HistoryConversation.scriptCalls). */
  scriptCalls?: Record<string, MessageRow[]>;
  /** Background's running items have Stop: a chat's or task run's (a terminal session's work stops in its terminal). */
  canStopBackground?: boolean;
  /** The Subagents tab's selected agent's conversation (a subagent's, or the open workflow's agent's), under the list. */
  agentConversation?: (agent: { agentId: string; running: boolean; subagent?: SubagentInfo }) => ReactNode;
}) {
  const [picked, pickTab] = useState<Tab>(initialTab);
  // A phone's Background or Subagents row pushed what the desktop shows under the list; `pushed`: it covers the list.
  const [detailOpen, setDetailOpen] = useState(false);
  const [pushed, setPushed] = useState(false);
  // A phone's sheet or column whose bar has a pushed screen's Back (a Git diff, an addon's item): the tabs give way too.
  const panelPushed = useContext(PanelPushedContext);
  const setTab = (t: Tab) => {
    pickTab(t);
    setDetailOpen(false);
  };
  const addonTabs = useAddonProjectTabs(projectId).filter((t) => !only || only.includes(t.id));
  const addonTab = addonTabs.find((t) => t.id === picked);
  const tab = (picked === 'git' && !gitProject) || (picked.startsWith('addon:') && !addonTab) ? 'now' : picked;
  const git = useGitStatus(gitProject, !!working || background.some((b) => b.status === 'running') || subagents.some((a) => a.status === 'running'));
  const { addons } = useAddonList();
  const tools = rows.filter((r) => r.kind === 'tool' && !r.fromScript);
  const i = nowIndex(tools.length, pos);
  const row = tools[i];
  // A script's call Now shows instead of its REPL call, which stays the call Now is at.
  const [inner, setInner] = useState<{ repl: string; index: number } | null>(null);
  const shownCall = inner && row?.toolUseId === inner.repl && row.calls ? inner : null;
  const step = (to: number) => {
    setInner(null);
    onPos(to >= tools.length - 1 ? null : Math.max(0, to));
  };
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const scriptCtx = useMemo<RowCtx>(() => ({ taskId, runId: sessionId, ...(scriptCalls ? { scriptCalls: localScriptCalls(scriptCalls) } : {}) }), [taskId, sessionId, scriptCalls]);
  const script: ScriptView = {
    ctx: scriptCtx,
    agentId: rowsAgent ?? undefined,
    onShow: (repl, index) => {
      onPos(tools.indexOf(repl));
      setInner({ repl: repl.toolUseId!, index });
    },
  };
  // Now as a list of every tool call instead of the one call's screen; a Markdown file as its source.
  const [listView, setListView] = useState(false);
  const [mdSource, setMdSource] = useState(false);
  const agentNames = new Map<string, string>([
    ...subagents.map((a) => [a.agentId, a.description || a.type] as [string, string]),
    ...(workflowRun ? workflowAgents(workflowRun).map((a) => [a.agentId, a.label] as [string, string]) : []),
  ]);
  const nameOf = (id: string | null) => (id === null ? MAIN_AGENT : (agentNames.get(id) ?? id));

  // A file a script's call worked on shows that call (`call`) under its REPL call.
  const files = new Map<string, { changed: boolean; index: number; call?: number }>();
  tools.forEach((t, n) => {
    for (const f of t.calls?.files ?? []) files.set(f.path, { changed: (files.get(f.path)?.changed ?? false) || f.changed, index: n, call: f.index });
    if (!t.file) return;
    const prev = files.get(t.file);
    files.set(t.file, { changed: (prev?.changed ?? false) || CHANGE_TOOLS.has(t.tool ?? ''), index: n });
  });
  const changed = [...files].filter(([, f]) => f.changed);
  const read = [...files].filter(([, f]) => !f.changed);
  // The files the agent sent the user (SendUserFile), each once.
  const received = [...new Map(rows.flatMap((r) => r.sent?.files ?? []).map((f) => [f.path, f] as [string, SentFile])).values()];
  const receivedFiles = received.map((f): [string, { index: number; call?: number; sent?: true }] => [f.path, { index: tools.findLastIndex((t) => t.sent?.files.some((s) => s.path === f.path)), sent: true }]);
  const showFile = (index: number, call?: number) => {
    setTab('now');
    setListView(false);
    if (call === undefined) step(index);
    else script.onShow(tools[index], call);
  };
  // Subagents are in their own tab, background ones too.
  const own = background.filter((b) => b.kind !== 'agent');
  const running = own.filter((b) => b.status === 'running');
  // The newest finished ones, whose output can still be read below the list.
  const finished = own.filter((b) => b.status !== 'running').slice(0, FINISHED_SHOWN);
  // The Subagents tab's count is the running ones, as Background's is.
  const runningSubagents = subagents.filter((a) => a.status === 'running').length;
  // Each list's selected row: the desktop shows the first until one is picked; a phone shows one once it's tapped.
  const [sel, setSel] = useState<{ background: string | null; file: string | null; agent: string | null }>({ background: null, file: null, agent: null });
  const listed = [...running, ...finished];
  const shownBackground = listed.find((b) => b.id === sel.background) ?? (selectsFirstRow ? listed[0] : undefined);
  // A workflow's item opens its tab beside the conversation; any other shows its output (a phone pushes it).
  const openBackground = (b: BackgroundTask) => {
    if (b.workflowRunId) return onOpenWorkflow(b.workflowRunId);
    setSel((p) => ({ ...p, background: b.id }));
    setDetailOpen(true);
  };
  const flowAgents = workflowRun ? workflowAgents(workflowRun) : [];
  const agentIds = [...subagents.map((a) => a.agentId), ...flowAgents.map((a) => a.agentId)];
  const shownAgent =
    sel.agent && agentIds.includes(sel.agent) ? sel.agent : selectsFirstRow ? (following && agentIds.includes(following) ? following : (newestFirst(subagents)[0]?.agentId ?? flowAgents[0]?.agentId ?? null)) : null;
  const shownSubagent = subagents.find((a) => a.agentId === shownAgent);
  const shownFlowAgent = flowAgents.find((a) => a.agentId === shownAgent);
  // The desktop's Enter or double-click shows the subagent's tab beside the conversation; a phone's tap pushes its conversation.
  const openSubagent = (a: SubagentInfo) => {
    if (selectsFirstRow) return onFollow(a.agentId);
    setSel((p) => ({ ...p, agent: a.agentId }));
    setDetailOpen(true);
  };
  // A running item's Stop, then its output file, then its command; a separator between the groups.
  const backgroundMenu = (b: BackgroundTask): ListMenuItem[] => {
    const file = b.outputFile;
    const command = b.command;
    const groups: ListMenuItem[][] = [
      canStopBackground && b.status === 'running'
        ? [{ label: 'Stop', destructive: true, run: () => void window.looper.sessions.stopBackground(sessionId, b.id).catch(reportError) }]
        : [],
      file
        ? [
            { label: 'Open File', run: () => void window.looper.sessions.openFile(taskId, sessionId, file, false).catch(reportError) },
            { label: 'Copy Path', run: () => void navigator.clipboard.writeText(file) },
          ]
        : [],
      command ? [{ label: 'Copy Command', run: () => void navigator.clipboard.writeText(command) }] : [],
    ];
    return groups.filter((g) => g.length).flatMap((g, i) => (i ? [{ ...g[0], separator: true as const }, ...g.slice(1)] : g));
  };
  // A running subagent the agent started in the background is a task with an id, stopped as Background's items are;
  // one the agent waits for is part of its turn, which the message box's Stop ends.
  const subagentMenu = (a: SubagentInfo): ListMenuItem[] => {
    const stoppable = canStopBackground && a.status === 'running' && background.some((b) => b.kind === 'agent' && b.id === a.agentId && b.status === 'running');
    const open: ListMenuItem = { label: 'Open Subagent Conversation', run: () => void window.looper.openMessages(taskId, sessionId, a.agentId, a.description).catch(reportError) };
    return stoppable
      ? [{ label: 'Stop', destructive: true, run: () => void window.looper.sessions.stopBackground(sessionId, a.agentId).catch(reportError) }, { ...open, separator: true }]
      : [open];
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
          selected={shownBackground?.id ?? null}
          onSelect={(b) => setSel((p) => ({ ...p, background: b.id }))}
          onOpen={openBackground}
          menu={(b) => backgroundMenu(b)}
          empty={null}
          row={(b) => (
            <>
              <div className="bg-item-head">
                <span className={`bg-status${b.status === 'failed' ? ' error-text' : ''}${b.status === 'running' ? ' live-only' : ''}`}>
                  <BackgroundStatus b={b} />
                </span>
                <span className="bg-label">{b.label}</span>
                <span className="muted bg-kind">{BACKGROUND_KINDS[b.kind] ?? ''}</span>
              </div>
              {b.summary && b.status !== 'running' && <div className="muted bg-summary">{b.summary}</div>}
            </>
          )}
          phoneRow={(b) => ({
            title: b.label,
            sub: (
              <>
                <BackgroundStatus b={b} />
                {BACKGROUND_KINDS[b.kind] ? ` · ${BACKGROUND_KINDS[b.kind]}` : ''}
                {b.summary && b.status !== 'running' ? ` · ${b.summary}` : ''}
              </>
            ),
            tone: b.status === 'failed' ? 'error' : b.status === 'running' ? undefined : 'muted',
          })}
        />
      </Section>
    );
  // A double-click or Enter opens a file in the Preview window, or its default app for a kind Preview doesn't show; Show on Now is in the right-click menu.
  const openFile = (p: string, list: [string, unknown][]) => {
    const image = SENT_IMAGE_RE.test(p);
    void window.looper.sessions.openFile(taskId, sessionId, p, image, image ? list.map(([q]) => q).filter((q) => SENT_IMAGE_RE.test(q)) : undefined).catch(reportError);
  };
  const fileList = (title: string, list: [string, { index: number; call?: number; sent?: true }][]) =>
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
          onOpen={([p]) => openFile(p, list)}
          menu={([p, f]) => [
            { label: 'Open File', run: () => openFile(p, list) },
            { label: 'Show on Now', enabled: f.index >= 0, run: () => showFile(f.index, f.call) },
            ...(f.sent ? [{ label: 'Save As…', run: () => void window.looper.sessions.saveFile(taskId, p).catch(reportError) }] : []),
            { label: 'Copy Path', separator: true as const, run: () => void navigator.clipboard.writeText(p) },
          ]}
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
      {!(pushed && detailOpen) && !panelPushed && (
        <TabBar
          tabs={(
            [
              ['now', 'Now'],
              ['background', running.length ? `Background (${running.length})` : 'Background'],
              ['subagents', runningSubagents ? `Subagents (${runningSubagents})` : 'Subagents'],
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
      )}
      <div className="activity-body">
        {tab === 'now' &&
          (row ? (
            <BottomToolbar
              label="Tool Calls"
              groups={[
                {
                  id: 'calls',
                  items: [
                    { id: 'previous', label: 'Previous Tool Call', icon: 'previous', enabled: i > 0, run: () => step(i - 1) },
                    { id: 'next', label: 'Next Tool Call', icon: 'next', enabled: i < tools.length - 1, run: () => step(i + 1) },
                    { id: 'latest', label: 'Follow the Latest Tool Call', icon: 'latest', pressed: pos === null, run: () => step(tools.length - 1) },
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
              places={{ leading: [['previous', 'next']], trailing: [['list', 'source'], ['latest']] }}
              status={`${i + 1} of ${tools.length}`}
            >
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
                  expanded={expanded}
                  onToggle={(t) =>
                    setExpanded((s) => {
                      const next = new Set(s);
                      if (!next.delete(t.toolUseId!)) next.add(t.toolUseId!);
                      return next;
                    })
                  }
                  script={{
                    ...script,
                    onShow: (repl, index) => {
                      script.onShow(repl, index);
                      setListView(false);
                    },
                  }}
                  shownCall={shownCall}
                />
              ) : (
                <NowScreen
                  row={row}
                  taskId={taskId}
                  runId={sessionId}
                  agentId={rowsAgent ?? undefined}
                  addons={addons}
                  source={mdSource}
                  nameOf={nameOf}
                  script={{ ...script, shown: shownCall?.index, onShown: (index) => setInner(index === undefined ? null : { repl: row.toolUseId!, index }) }}
                />
              )}
            </BottomToolbar>
          ) : (
            <EmptyState>The agent hasn't used a tool yet.</EmptyState>
          ))}
        {tab === 'background' &&
          (listed.length === 0 ? (
            <div className="background-tab">
              <div className="muted background-none">Nothing is running in the background.</div>
            </div>
          ) : (
            <ListDetail
              panes={{ axis: 'y', initial: 40, unit: '%', min: 15, max: 85, storageKey: 'activity-background-split' }}
              tabs={{ list: 'Tasks', detail: 'Output' }}
              open={detailOpen && !!shownBackground}
              onClose={() => setDetailOpen(false)}
              detailTitle={shownBackground?.label}
              onPushed={setPushed}
              list={
                <div className="background-tab activity-list">
                  {backgroundList('Running', running)}
                  {backgroundList('Finished', finished)}
                </div>
              }
              detail={shownBackground && <BackgroundConsole key={shownBackground.id} b={shownBackground} sessionId={sessionId} />}
            />
          ))}
        {tab === 'subagents' &&
          (agentIds.length === 0 ? (
            <div className="subagent-list">
              <EmptyState>{working ? 'No subagents yet.' : 'No subagents.'}</EmptyState>
            </div>
          ) : (
            <ListDetail
              panes={{ axis: 'y', initial: 40, unit: '%', min: 15, max: 85, storageKey: 'activity-subagents-split' }}
              tabs={{ list: 'Subagents', detail: 'Conversation' }}
              open={detailOpen && !!shownAgent}
              onClose={() => setDetailOpen(false)}
              detailTitle={shownSubagent ? shownSubagent.description || shownSubagent.type : shownFlowAgent?.label}
              onPushed={setPushed}
              list={
                <div className="subagent-list activity-list">
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
                        selected={shownAgent}
                        onSelect={(a) => setSel((p) => ({ ...p, agent: a.agentId }))}
                        onOpen={openSubagent}
                        menu={subagentMenu}
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
                        })}
                      />
                    </Section>
                  )}
                  {workflowRun && flowAgents.length > 0 && (
                    <Section className="activity-section" title="Workflow">
                      <WorkflowAgentList
                        agents={flowAgents}
                        label="Workflow"
                        idPrefix="workflow-agent"
                        listClass="pane-rows"
                        selected={shownAgent}
                        onSelect={(agent) => setSel((p) => ({ ...p, agent }))}
                        onOpen={(agentId) => onOpenWorkflowAgent?.(workflowRun.runId, agentId)}
                        taskId={taskId}
                        sessionId={sessionId}
                      />
                    </Section>
                  )}
                </div>
              }
              detail={
                shownAgent &&
                agentConversation?.({
                  agentId: shownAgent,
                  running: shownSubagent ? shownSubagent.status === 'running' : !!shownFlowAgent && tabStatus(shownFlowAgent.status) === 'running',
                  subagent: shownSubagent,
                })
              }
            />
          ))}
        {tab === 'files' && (
          <div className="files-tab">
            {fileList('Received', receivedFiles)}
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
