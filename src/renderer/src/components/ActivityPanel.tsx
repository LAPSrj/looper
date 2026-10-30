import { useEffect, useState } from 'react';
import { formatTokens, type Attachment } from '@shared/chat';
import { EFFORT_LEVELS } from '@shared/environments';
import type { MessageRow } from '@shared/messages';
import type { BackgroundTask, SubagentInfo } from '@shared/sessions';
import { waitedText } from '@shared/sessions';
import { stripAnsi } from '../format';
import { AttachmentList } from './ChatRows';
import { gitTabLabel } from '@shared/git';
import { GitView, useGitStatus } from './GitView';
import { ToolButton } from './ToolButton';
import { ToolInputView, ToolResultView } from './ToolContent';
import { TabBar } from './ui';

type Tab = 'now' | 'subagents' | 'files' | 'git';

const CHANGES = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** The Now tab's toolbar icons. */
const NAV_ICONS = {
  previous: <path d="M10 3.5 5.5 8l4.5 4.5" />,
  next: <path d="M6 3.5 10.5 8 6 12.5" />,
  latest: <path d="M4 3.5 8.5 8 4 12.5M12 3v10" />,
};
const IMAGE_RE = /\.(png|jpe?g|gif|webp)$/i;

const baseName = (p: string) => p.split(/[\\/]/).pop() || p;
const dirName = (p: string) => p.slice(0, Math.max(0, p.length - baseName(p).length)).replace(/[\\/]$/, '');

/** One tool call as the agent's screen: the file it read, the change it made, the command and its output. */
function NowScreen({ row, taskId, runId }: { row: MessageRow; taskId: string; runId: string }) {
  const ctx = { taskId, runId };
  const running = row.result === undefined;
  const subject = row.file ?? row.preview;
  let body;
  if (row.tool === 'Read') {
    body = running ? <div className="muted">Reading…</div> : <ToolResultView row={row} ctx={ctx} />;
  } else if (row.tool && CHANGES.has(row.tool)) {
    body = <ToolInputView row={row} />;
  } else {
    body = (
      <>
        <ToolInputView row={row} />
        {row.result !== undefined ? (
          <div className="now-result">
            <ToolResultView row={row} ctx={ctx} />
          </div>
        ) : (
          <div className="muted now-result">{row.background ? 'Running in the background…' : 'Running…'}</div>
        )}
      </>
    );
  }
  return (
    <div className="now-screen">
      <div className="now-title">
        <span className="now-tool">{row.tool}</span>
        <span className="mono now-subject">{subject}</span>
        {row.resultError && <span className="error-text">Failed</span>}
      </div>
      <div className="now-body">{body}</div>
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
function BackgroundItem({ b, sessionId, taskId, now }: { b: BackgroundTask; sessionId: string; taskId: string; now: number }) {
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
  const started = b.startedAt ? Date.parse(b.startedAt) : NaN;
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
      <div className="bg-item-head" onClick={() => b.outputFile && setOpen((o) => !o)}>
        <span className={`bg-status${b.status === 'failed' ? ' error-text' : ''}`}>{status}</span>
        <span className="bg-label">{b.label}</span>
        <span className="muted bg-kind">{b.kind === 'agent' ? 'Subagent' : ''}</span>
      </div>
      {b.summary && b.status !== 'running' && <div className="muted bg-summary">{b.summary}</div>}
      {open && <pre className="output bg-output">{output === null ? 'The output can’t be read.' : stripAnsi(output) || 'No output yet.'}</pre>}
    </div>
  );
}

/** The tool call Now shows: the one at `pos`, or the latest when it's null. */
export function nowIndex(count: number, pos: number | null): number {
  return pos === null ? count - 1 : Math.min(pos, count - 1);
}

/**
 * The Sessions window's right panel: Now shows the agent's latest tool call
 * like its screen (the toolbar goes back through earlier ones, and the last
 * one follows new calls), Subagents lists each one's agent, model, effort and
 * context, Files lists what it worked on, and Background always shows what
 * runs in the background.
 */
export function ActivityPanel({
  sessionId,
  taskId,
  rows,
  attachments,
  background,
  subagents,
  following,
  onFollow,
  pos,
  onPos,
  now,
  gitProject,
}: {
  sessionId: string;
  taskId: string;
  /** The conversation being watched: the session's, or the followed subagent's. */
  rows: MessageRow[];
  attachments: Attachment[];
  background: BackgroundTask[];
  subagents: SubagentInfo[];
  following: string | null;
  onFollow: (agentId: string | null) => void;
  /** The tool call Now shows; null follows the latest. */
  pos: number | null;
  onPos: (pos: number | null) => void;
  now: number;
  /** The session's project, when its folder is in a git repository: the Git tab shows it. */
  gitProject?: string;
}) {
  const [picked, setTab] = useState<Tab>('now');
  const tab = picked === 'git' && !gitProject ? 'now' : picked;
  const git = useGitStatus(gitProject);
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
          ['subagents', subagents.length ? `Subagents (${subagents.length})` : 'Subagents'],
          ['files', 'Files'],
          ...(gitProject ? ([['git', gitTabLabel(git.status?.repo ? git.status.changes : undefined)]] as [Tab, string][]) : []),
        ]}
        active={tab}
        onSelect={setTab}
        className="activity-tabs"
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
              <NowScreen row={row} taskId={taskId} runId={sessionId} />
            </>
          ) : (
            <div className="empty">The agent hasn't used a tool yet.</div>
          ))}
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
            {subagents.length === 0 && <div className="empty">No subagents yet.</div>}
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
      <div className="background-pane">
        <div className="pane-title background-title">Background</div>
        {running.length === 0 && <div className="muted background-none">Nothing is running in the background.</div>}
        {[...running, ...finished].map((b) => (
          <BackgroundItem key={b.id} b={b} sessionId={sessionId} taskId={taskId} now={now} />
        ))}
      </div>
    </aside>
  );
}
