import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MessagesShowKey } from '@shared/api';
import type { MessageRow, MessagesResult } from '@shared/messages';
import type { RunRecord } from '@shared/types';
import { subscribe } from '../events';
import { capFirst, fmtTime, formatDuration, resultLabel, stripAnsi } from '../format';
import { useDragResize, useListNav } from './hooks';
import { Markdown, MessageBody } from './Markdown';
import { ToolInputView, ToolResultView } from './ToolContent';
import { ResizableColumns, TabBar, type TableCol } from './ui';

const POLL_MS = 2000;

/** One of the run's own records (check, classifier, agent, result, guidance), shown among the messages. */
interface StepRow {
  id: string;
  ts: string;
  kind: 'step';
  preview: string;
  record: RunRecord;
}

type Row = MessageRow | StepRow;

const STEP_NAMES: Record<string, string> = {
  check: 'Check',
  classify: 'Classifier',
  agent: 'Agent',
  guidance: 'Guidance',
};

const STEP_OUTCOMES: Record<string, string> = {
  started: 'started',
  done: 'completed',
  success: 'completed',
  warning: 'warning',
  act: 'found work',
  noop: 'found nothing to do',
  error: 'failed',
  stopped: 'stopped',
  interrupted: 'was interrupted',
  'idle-timeout': 'went idle',
  'max-runtime': 'timed out',
  held: 'is waiting for you',
  exited: 'exited',
  sent: 'sent',
  delivered: 'delivered',
  undelivered: 'not delivered',
};

/** The Details text of a run record, e.g. "Agent completed in 5m10s". */
function stepText(r: RunRecord): string {
  const note = r.error ?? r.summary;
  switch (r.phase) {
    case 'result':
      return note ? `Result: ${note}` : 'Result';
    case 'skip':
      return note ? `Skipped: ${note}` : 'Skipped';
    case 'watcher':
      return note ? `Watcher fired: ${note}` : 'Watcher fired';
    case 'system':
      return capFirst(note ?? resultLabel(r.result));
    case 'chat':
    case 'terminal': {
      const what = r.phase === 'chat' ? 'Chat' : 'Terminal';
      return r.detail?.event === 'closed'
        ? `${what} closed${r.durationMs !== undefined ? ` after ${formatDuration(r.durationMs)}` : ''}`
        : `${what} opened`;
    }
  }
  let text = `${STEP_NAMES[r.phase] ?? capFirst(r.phase)} ${STEP_OUTCOMES[r.result] ?? resultLabel(r.result).toLowerCase()}`;
  if (r.durationMs !== undefined) text += ` in ${formatDuration(r.durationMs)}`;
  if (r.detail?.costUsd !== undefined) text += ` ($${Number(r.detail.costUsd).toFixed(3)})`;
  // A started record repeats the check's summary, and a delivered one says only that.
  if (r.result === 'started' || r.result === 'delivered') return text;
  const shown = r.phase === 'guidance' ? note?.replace(/^not delivered: /, '') : note;
  return shown ? `${text}: ${shown}` : text;
}

/** The run's records and the conversation in one timeline; rows without a timestamp stay where they are. */
function mergeRows(messages: MessageRow[], steps: StepRow[]): Row[] {
  if (steps.length === 0) return messages;
  const out: Row[] = [];
  let i = 0;
  for (const m of messages) {
    if (m.ts) {
      const at = Date.parse(m.ts);
      while (i < steps.length && Date.parse(steps[i].ts) < at) out.push(steps[i++]);
    }
    out.push(m);
  }
  while (i < steps.length) out.push(steps[i++]);
  return out;
}

type AgentMode = 'interactive' | 'headless';

/** Pretty output: JSON is indented and kept verbatim, anything else renders as markdown. */
interface Output {
  text: string;
  kind: 'json' | 'markdown' | 'raw';
}

function formatOutput(text: string, mode: AgentMode): Output {
  if (mode !== 'headless') return { text, kind: 'markdown' };
  const trimmed = text.trim();
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      return { text: JSON.stringify(JSON.parse(trimmed), null, 2), kind: 'json' };
    } catch { /* not valid JSON */ }
  }
  const lines = trimmed.split('\n');
  if (lines.length > 1) {
    let anyFormatted = false;
    const formatted = lines.map((line) => {
      const t = line.trim();
      if (t.startsWith('{') || t.startsWith('[')) {
        try {
          const pretty = JSON.stringify(JSON.parse(t), null, 2);
          anyFormatted = true;
          return pretty;
        } catch { /* not JSON */ }
      }
      return line;
    });
    if (anyFormatted) return { text: formatted.join('\n'), kind: 'json' };
  }
  return { text, kind: 'markdown' };
}

/** The agent's end record shows the session's captured terminal output. */
const isAgentEnd = (r: RunRecord) => r.phase === 'agent' && r.result !== 'started' && r.result !== 'warning';

function typeLabel(row: Row): string {
  switch (row.kind) {
    case 'step':
      return 'Run';
    case 'prompt':
      return 'Prompt';
    case 'guidance':
      return 'Guidance';
    case 'agent':
      return row.source === 'classifier' ? 'Classifier' : 'Agent';
    case 'thinking':
      return 'Thinking';
    default:
      return row.tool ?? '';
  }
}

function openSubagent(taskId: string, runId: string, row: MessageRow): void {
  if (!row.agentId) return;
  void window.looper.openMessages(taskId, runId, row.agentId, row.preview);
}

/** Double-click: an image row opens its image window; a Task row opens the subagent. */
function openRow(taskId: string, runId: string, agentId: string | undefined, row: Row): void {
  if (row.kind === 'step') return;
  if (row.image) {
    void window.looper.openMessageImage(taskId, runId, row.id, agentId, row.file ?? row.preview);
  } else {
    openSubagent(taskId, runId, row);
  }
}

const MESSAGE_COLS: readonly TableCol[] = [
  { label: 'Time', width: 76 },
  { label: 'Type', width: 110, min: 60 },
  { label: 'Details' },
];

/** The View-menu category a row belongs to; null (raw rows) is always shown. */
function categoryOf(r: Row): MessagesShowKey | null {
  switch (r.kind) {
    case 'step':
      return 'run';
    case 'prompt':
    case 'guidance':
    case 'agent':
      return 'messages';
    case 'thinking':
      return 'thinking';
    case 'tool':
      return r.tool === 'Task' || r.tool === 'Agent' ? 'subagents' : 'tools';
    default:
      return null;
  }
}

function matchesFilter(r: Row, f: string): boolean {
  if (r.kind === 'step') {
    return r.preview.toLowerCase().includes(f) || (r.record.body?.toLowerCase().includes(f) ?? false);
  }
  return (
    r.preview.toLowerCase().includes(f) ||
    r.text.toLowerCase().includes(f) ||
    (r.tool?.toLowerCase().includes(f) ?? false) ||
    (r.result?.toLowerCase().includes(f) ?? false)
  );
}

type DetailTab = 'input' | 'result';

interface ViewProps {
  taskId: string;
  runId: string;
  agentId?: string;
  /** The run is mid-flight: poll the transcript, and read "no transcript" as "not started yet". */
  running: boolean;
  /** Changing it refetches right away. */
  refreshKey?: number;
  /** Select the run's report row (or, without one, its last step) once both have loaded. */
  focusReport?: boolean;
}

/**
 * A run's window: its own records (check, classifier, agent, result) and its
 * conversation in one table, full content in the panel below. A subagent's
 * window (agentId set) shows only its conversation.
 */
export function MessagesView({ taskId, runId, agentId, running, refreshKey, focusReport }: ViewProps) {
  const [result, setResult] = useState<MessagesResult | null>(null);
  const [records, setRecords] = useState<RunRecord[]>([]);
  const [mode, setMode] = useState<AgentMode>('interactive');
  const [raw, setRaw] = useState(false);
  const [rawOutput, setRawOutput] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<DetailTab>('result');
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [stepOutput, setStepOutput] = useState<Output | null>(null);
  const [splitPct, setSplitPct] = useState(60);
  const [show, setShow] = useState<Record<MessagesShowKey, boolean>>({ run: true, messages: true, thinking: true, tools: true, subagents: true });
  const [filter, setFilter] = useState('');
  const [autoScroll, setAutoScroll] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const imageCache = useRef(new Map<string, string>());

  // The window's View menu drives the toggles; the filter window sends its value.
  useEffect(() => {
    return window.looper.onUi((e) => {
      if (e.type === 'messages-show') {
        setShow((s) => ({ ...s, [e.key]: e.checked }));
      } else if (e.type === 'messages-raw') {
        setRaw(e.checked);
      } else if (e.type === 'messages-raw-output') {
        setRawOutput(e.checked);
      } else if (e.type === 'messages-auto-scroll') {
        setAutoScroll(e.checked);
      } else if (e.type === 'messages-filter') {
        setFilter(e.value);
        window.looper.reportMessagesFilter(e.value);
      }
    });
  }, []);

  // The run's own records: loaded once, then appended as the engine writes them.
  useEffect(() => {
    if (agentId) return;
    let cancelled = false;
    void window.looper.tasks.list().then((tasks) => {
      const t = tasks.find((x) => x.id === taskId);
      if (!cancelled && t) setMode(t.agent.mode);
    });
    void window.looper.runs.list(taskId).then((all) => {
      if (!cancelled) setRecords(all.filter((r) => r.runId === runId));
    });
    const unsubscribe = subscribe((e) => {
      if (e.type === 'record' && e.record.taskId === taskId && e.record.runId === runId) {
        setRecords((prev) => [...prev, e.record]);
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [taskId, runId, agentId]);

  const fetchNow = useCallback(() => {
    void window.looper.runs
      .messages(taskId, runId, agentId, raw)
      .then(setResult)
      .catch(() => undefined);
  }, [taskId, runId, agentId, raw]);

  useEffect(() => {
    setResult(null);
    setSelected(null);
    atBottomRef.current = true;
    imageCache.current.clear();
    fetchNow();
  }, [fetchNow]);

  // Poll while the run is live; also refetch once when it ends, to catch the
  // tail, and whenever the window sends guidance, so it shows as waiting at once.
  useEffect(() => {
    fetchNow();
    if (!running) return;
    const t = setInterval(fetchNow, POLL_MS);
    return () => clearInterval(t);
  }, [running, fetchNow, refreshKey]);

  const steps = useMemo(
    () =>
      records.map((r, i): StepRow => ({ id: `step-${i}`, ts: r.ts, kind: 'step', preview: stepText(r), record: r })),
    [records],
  );
  const rows = useMemo(() => mergeRows(result?.rows ?? [], steps), [result, steps]);
  const visible = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return rows.filter((r) => {
      const cat = categoryOf(r);
      if (cat && !show[cat]) return false;
      return !f || matchesFilter(r, f);
    });
  }, [rows, show, filter]);

  // Follow the conversation while the reader is at the bottom of the table.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (wrap && atBottomRef.current) wrap.scrollTop = wrap.scrollHeight;
  }, [visible.length, result?.pendingGuidance]);

  // Auto Scroll: while the last row is selected (or none is), a new last row
  // takes the selection and the table scrolls to the bottom. Selecting an
  // earlier row stops it until the last row is selected again.
  const lastId = visible.length > 0 ? visible[visible.length - 1].id : null;
  const prevLastRef = useRef<string | null>(null);
  useEffect(() => {
    const prevLast = prevLastRef.current;
    prevLastRef.current = lastId;
    if (!autoScroll || lastId === null || selected === lastId) return;
    if (selected !== null && selected !== prevLast) return;
    setSelected(lastId);
    atBottomRef.current = true;
    const wrap = wrapRef.current;
    if (wrap) wrap.scrollTop = wrap.scrollHeight;
  }, [autoScroll, lastId, selected]);

  // Opened from a toast: once the records and the transcript are both in,
  // select the report row (an error run may have none: then its last step).
  const reportFocused = useRef(false);
  useEffect(() => {
    if (!focusReport || reportFocused.current || result === null || steps.length === 0) return;
    reportFocused.current = true;
    const report = steps.findLast((s) => s.record.phase === 'result') ?? steps[steps.length - 1];
    setSelected(report.id);
    atBottomRef.current = false;
  }, [focusReport, result, steps]);

  const idx = selected === null ? -1 : visible.findIndex((r) => r.id === selected);
  const current = idx >= 0 ? visible[idx] : null;
  useEffect(() => {
    setDetailTab('result');
  }, [selected]);

  // The image payload stays engine-side; fetch it when an image row is selected.
  const currentId = current?.id;
  const currentHasImage = current !== null && current.kind !== 'step' && !!current.image;
  useEffect(() => {
    setImageUrl(null);
    if (currentId === undefined || !currentHasImage) return;
    const cached = imageCache.current.get(currentId);
    if (cached) {
      setImageUrl(cached);
      return;
    }
    let cancelled = false;
    void window.looper.runs.messageImage(taskId, runId, currentId, agentId).then((img) => {
      if (cancelled || !img) return;
      const url = `data:${img.mediaType};base64,${img.data}`;
      imageCache.current.set(currentId, url);
      if (imageCache.current.size > 10) {
        const oldest = imageCache.current.keys().next().value;
        if (oldest !== undefined) imageCache.current.delete(oldest);
      }
      setImageUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [taskId, runId, agentId, currentId, currentHasImage]);

  // A run record's content; the agent's end record reads the captured terminal output.
  // Records are only ever appended, so the selected record's identity is stable.
  const currentRecord = current?.kind === 'step' ? current.record : null;
  useEffect(() => {
    setStepOutput(null);
    if (!currentRecord) return;
    let cancelled = false;
    void (async () => {
      if (isAgentEnd(currentRecord)) {
        const text = stripAnsi(await window.looper.runs.output(taskId, runId, rawOutput)) || '(no output captured)';
        if (!cancelled) setStepOutput(rawOutput ? { text, kind: 'raw' } : formatOutput(text, mode));
      } else {
        const r = currentRecord;
        const text = r.body || r.stdoutTail || r.error || r.summary || '(no output)';
        setStepOutput(formatOutput(text, mode));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentRecord, rawOutput, mode, taskId, runId]);

  const nav = useListNav({
    count: visible.length,
    index: idx,
    onIndex: (i) => setSelected(visible[i].id),
    onActivate: (i) => openRow(taskId, runId, agentId, visible[i]),
    scrollToId: selected !== null ? `msg-${selected}` : null,
  });

  /** Ctrl+Up/Down hops between the user's rows (prompts, guidance); everything else goes to the list nav. */
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.ctrlKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      const dir = e.key === 'ArrowDown' ? 1 : -1;
      const start = idx < 0 ? (dir > 0 ? -1 : visible.length) : idx;
      for (let i = start + dir; i >= 0 && i < visible.length; i += dir) {
        if (visible[i].kind === 'prompt' || visible[i].kind === 'guidance') {
          setSelected(visible[i].id);
          return;
        }
      }
      return;
    }
    nav(e);
  };

  const onDragStart = useDragResize({
    axis: 'y',
    containerRef,
    onDrag: (y, rect) => setSplitPct(Math.max(20, Math.min(90, (y / rect.height) * 100))),
  });

  const onRowContextMenu = (e: React.MouseEvent, r: Row) => {
    e.preventDefault();
    setSelected(r.id);
    if (r.kind === 'step') {
      const text = r.record.body || r.record.stdoutTail || r.record.error || r.preview;
      window.looper.showMessageContextMenu({ taskId, runId, label: r.preview, text });
      return;
    }
    window.looper.showMessageContextMenu({
      taskId,
      runId,
      agentId: r.agentId,
      label: r.preview,
      file: r.file,
      text: (r.kind === 'tool' ? (r.result ?? r.text) : r.text) || undefined,
    });
  };

  const emptyText = (): string => {
    if (result === null) return '';
    if (result.status === 'no-session') {
      return running ? 'Waiting for the session to start…' : 'No conversation was recorded for this run.';
    }
    if (result.status === 'no-transcript') {
      return running ? 'Waiting for the transcript…' : 'The session transcript is no longer available.';
    }
    return 'No messages yet.';
  };

  const imagePane = (row: MessageRow) => (
    <div
      className="msg-image-wrap"
      onDoubleClick={() => void window.looper.openMessageImage(taskId, runId, row.id, agentId, row.file ?? row.preview)}
    >
      {imageUrl ? <img src={imageUrl} alt={row.file ?? 'image'} /> : <span className="muted">Loading image…</span>}
    </div>
  );

  const toolDetail = (row: MessageRow) => {
    const hasResult = row.result !== undefined;
    const tab: DetailTab = hasResult ? detailTab : 'input';
    return (
      <div className="msg-tool-detail">
        {row.agentId && (
          <div className="msg-tool-actions">
            <button className="btn small" onClick={() => openSubagent(taskId, runId, row)}>
              Open Subagent Conversation
            </button>
          </div>
        )}
        {hasResult ? (
          <TabBar
            tabs={[
              ['input', 'Input'],
              ['result', 'Result'],
            ]}
            active={tab}
            onSelect={setDetailTab}
          />
        ) : (
          <div className="msg-tool-pending muted">{running ? 'No result yet' : 'No result recorded'}</div>
        )}
        <div className="msg-tool-body">
          {tab === 'result' ? (
            row.image ? (
              imagePane(row)
            ) : (
              <ToolResultView row={row} ctx={{ taskId, runId }} />
            )
          ) : (
            <ToolInputView row={row} />
          )}
        </div>
      </div>
    );
  };

  const stepDetail = () => {
    if (stepOutput === null) return null;
    return stepOutput.kind === 'markdown' ? <Markdown text={stepOutput.text} /> : <pre className="output">{stepOutput.text}</pre>;
  };

  const detail = (row: Row) => {
    if (row.kind === 'step') return stepDetail();
    if (row.kind === 'tool') return toolDetail(row);
    if (row.image) return imagePane(row);
    if (row.kind === 'thinking' || row.kind === 'raw') return <pre className="output">{row.text}</pre>;
    return <MessageBody text={row.text} />;
  };

  const rowClass = (r: Row) =>
    r.kind === 'step'
      ? `msg-row msg-step result-${r.record.result}`
      : `msg-row msg-${r.kind}${r.resultError ? ' msg-error' : ''}`;

  return (
    <div className="messages" ref={containerRef}>
      <div
        className="messages-table-wrap"
        style={{ height: `${splitPct}%` }}
        tabIndex={0}
        onKeyDown={onKeyDown}
        ref={wrapRef}
        onScroll={() => {
          const w = wrapRef.current;
          if (w) atBottomRef.current = w.scrollHeight - w.scrollTop - w.clientHeight < 40;
        }}
      >
        <table className="runlog-table">
          <ResizableColumns cols={MESSAGE_COLS} storageKey="messages" />
          <tbody>
            {(result?.dropped ?? 0) > 0 && (
              <tr>
                <td colSpan={3} className="muted">
                  {result!.dropped} earlier messages not shown
                </td>
              </tr>
            )}
            {visible.map((r) => (
              <tr
                key={r.id}
                id={`msg-${r.id}`}
                className={`${rowClass(r)}${selected === r.id ? ' selected' : ''}`}
                onClick={() => setSelected(r.id)}
                onDoubleClick={() => openRow(taskId, runId, agentId, r)}
                onContextMenu={(e) => onRowContextMenu(e, r)}
              >
                <td>{r.ts ? fmtTime(r.ts) : ''}</td>
                <td>{typeLabel(r)}</td>
                <td title={r.preview}>{r.preview}</td>
              </tr>
            ))}
            {visible.length === 0 && (
              <tr>
                <td colSpan={3} className="muted">
                  {rows.length > 0 ? 'No messages match the current view or filter.' : emptyText()}
                </td>
              </tr>
            )}
            {result?.pendingGuidance && (
              <tr className="muted" title={result.pendingGuidance}>
                <td />
                <td>Guidance</td>
                <td>Waiting for the agent: {result.pendingGuidance.replace(/\s+/g, ' ')}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="runlog-divider" onMouseDown={onDragStart} />
      <div className="messages-detail" style={{ height: `calc(${100 - splitPct}% - 5px)` }}>
        {current === null ? <div className="messages-detail-empty muted">Select a message</div> : detail(current)}
      </div>
    </div>
  );
}
