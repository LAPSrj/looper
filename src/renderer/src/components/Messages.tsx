import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MessageRow, MessagesResult } from '@shared/messages';
import { messagesToMarkdown } from '@shared/messages-md';
import { groupRuns } from '@shared/runs';
import type { RunRecord } from '@shared/types';
import { subscribe } from '../events';
import { capFirst, fmtTime, formatDuration, resultLabel, stripAnsi } from '../format';
import { clockTime, dayGroups, resultTone, timeAndDuration } from '../phone-lists';
import { initialRow, rowMatches, runTableRows, type ConversationRow, type RunTableRow, type StepRow } from '../run-rows';
import { isPhone } from '../web/page-nav';
import { NavBar } from './NavBar';
import { useDragResize, useListNav } from './hooks';
import { Markdown } from './Markdown';
import { EmptyRow, Group, Row as ListRow } from './phone/PhoneList';
import { TranscriptView } from './Transcript';
import { ResizableColumns, type TableCol } from './ui';

const POLL_MS = 2000;

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
    case 'question':
      if (r.result === 'sent') return `The agent asked: ${note ?? ''}`;
      if (r.result === 'delivered') return `You answered: ${note ?? ''}`;
      return `Question not answered: ${note ?? ''}`;
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

function typeLabel(row: RunTableRow): string {
  switch (row.kind) {
    case 'step':
      return 'Run';
    case 'conversation':
      return row.source === 'classifier' ? 'Classifier' : 'Agent';
    default:
      // View → Raw Messages: the record's type.
      return row.tool ?? '';
  }
}

const MESSAGE_COLS: readonly TableCol[] = [
  { label: 'Time', width: 76 },
  { label: 'Type', width: 110, min: 60 },
  { label: 'Details' },
];

/** A conversation's text for Copy Content: as Save as Markdown writes it. */
const conversationText = (c: ConversationRow): string =>
  messagesToMarkdown(c.rows, { title: c.source === 'classifier' ? 'Classifier' : 'Agent', includeThinking: true, includeTools: true, plain: false });

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
  /** A phone's bar title for the list screen (the task's name); a row's own screen is titled by its type. */
  phoneTitle?: string;
}

/**
 * A run's window: its own records (check, classifier, agent, result,
 * guidance…) and a row for its conversation in one table; the selected
 * record's content, or the conversation as a chat, in the panel below. A
 * subagent's window (agentId set) shows only its conversation, as a chat.
 * View → Raw Messages lists every transcript record as a row instead.
 */
export function MessagesView({ taskId, runId, agentId, running, refreshKey, focusReport, phoneTitle }: ViewProps) {
  const [result, setResult] = useState<MessagesResult | null>(null);
  const [records, setRecords] = useState<RunRecord[]>([]);
  const [mode, setMode] = useState<AgentMode>('interactive');
  const [raw, setRaw] = useState(false);
  const [rawOutput, setRawOutput] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [stepOutput, setStepOutput] = useState<Output | null>(null);
  const [splitPct, setSplitPct] = useState(40);
  const [showRun, setShowRun] = useState(true);
  const [filter, setFilter] = useState('');
  const [autoScroll, setAutoScroll] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);

  // The window's View menu drives the toggles; the filter window sends its value.
  useEffect(() => {
    return window.looper.onUi((e) => {
      if (e.type === 'messages-show-run') {
        setShowRun(e.checked);
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
    atBottomRef.current = true;
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
  const rows = useMemo(() => runTableRows(result?.rows ?? [], steps, { raw, running }), [result, steps, raw, running]);
  const visible = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return rows.filter((r) => (r.kind !== 'step' || showRun) && (!f || rowMatches(r, f)));
  }, [rows, showRun, filter]);

  // Follow the table while the reader is at its bottom.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (wrap && atBottomRef.current) wrap.scrollTop = wrap.scrollHeight;
  }, [visible.length]);

  // Auto Scroll: while the last row is selected (or none is), a new last row
  // takes the selection and the table scrolls to the bottom. Selecting an
  // earlier row stops it until the last row is selected again.
  const lastId = visible.length > 0 ? visible[visible.length - 1].id : null;
  const prevLastRef = useRef<string | null>(null);
  useEffect(() => {
    const prevLast = prevLastRef.current;
    prevLastRef.current = lastId;
    // A phone's selection opens a row: the list doesn't follow the newest one.
    if (isPhone || !autoScroll || lastId === null || selected === lastId) return;
    if (selected !== null && selected !== prevLast) return;
    setSelected(lastId);
    atBottomRef.current = true;
    const wrap = wrapRef.current;
    if (wrap) wrap.scrollTop = wrap.scrollHeight;
  }, [autoScroll, lastId, selected]);

  // As the window opens, once the records and the transcript are both in: the
  // conversation is selected, or, opened from a toast, the report row (an
  // error run may have none: then its last step).
  const initialPicked = useRef(false);
  useEffect(() => {
    // A phone's list shows the run's result first: there's no row to open.
    if (isPhone || agentId || initialPicked.current || result === null) return;
    if (focusReport) {
      if (steps.length === 0) return;
      initialPicked.current = true;
      const report = steps.findLast((s) => s.record.phase === 'result') ?? steps[steps.length - 1];
      setSelected(report.id);
      atBottomRef.current = false;
      return;
    }
    const first = initialRow(rows);
    if (first === null) return;
    initialPicked.current = true;
    setSelected(first);
  }, [focusReport, result, steps, rows, agentId]);

  const idx = selected === null ? -1 : visible.findIndex((r) => r.id === selected);
  const current = idx >= 0 ? visible[idx] : null;

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
    scrollToId: selected !== null ? `msg-${selected}` : null,
  });

  const onDragStart = useDragResize({
    axis: 'y',
    containerRef,
    onDrag: (y, rect) => setSplitPct(Math.max(15, Math.min(90, (y / rect.height) * 100))),
  });

  /** The row's menu; it doesn't select the row (on a phone a selection opens it). */
  const showRowMenu = (r: RunTableRow) => {
    if (r.kind === 'step') {
      const text = r.record.body || r.record.stdoutTail || r.record.error || r.preview;
      window.looper.showMessageContextMenu({ taskId, runId, label: r.preview, text });
    } else if (r.kind === 'conversation') {
      window.looper.showMessageContextMenu({ taskId, runId, label: r.preview, text: conversationText(r) || undefined });
    } else {
      window.looper.showMessageContextMenu({ taskId, runId, label: r.preview, text: r.text || undefined });
    }
  };
  const onRowContextMenu = (e: React.MouseEvent, r: RunTableRow) => {
    e.preventDefault();
    setSelected(r.id);
    showRowMenu(r);
  };

  // A phone: the list screen, and a row's own screen pushed over it (Back returns to the list where it was).
  const listRef = useRef<HTMLDivElement>(null);
  const listScroll = useRef(0);
  const showingDetail = isPhone && current !== null;
  useLayoutEffect(() => {
    if (isPhone && !showingDetail && listRef.current) listRef.current.scrollTop = listScroll.current;
  }, [showingDetail]);
  const phoneBar = !isPhone ? null : agentId ? (
    <NavBar title={phoneTitle} order={10} />
  ) : (
    <NavBar
      title={current ? (current.kind === 'conversation' ? 'Conversation' : typeLabel(current)) : phoneTitle}
      back={current ? () => setSelected(null) : undefined}
      order={10}
    />
  );
  const run = useMemo(() => (agentId ? undefined : groupRuns(records)[0]), [records, agentId]);

  const emptyText = (): string => {
    if (result === null) return '';
    if (result.status === 'no-session') {
      return running ? 'Waiting for the session to start…' : 'No conversation was recorded for this run.';
    }
    if (result.status === 'no-transcript') {
      return running ? 'Waiting for the transcript…' : 'The session transcript is no longer available.';
    }
    return running ? "Waiting for the agent's first message…" : 'No messages yet.';
  };

  const chat = (c: { rows: MessageRow[]; source?: 'classifier' }) => (
    <TranscriptView
      key={c.source ?? 'agent'}
      taskId={taskId}
      runId={runId}
      rows={c.rows}
      waitingText={emptyText()}
      pendingGuidance={c.source === 'classifier' ? undefined : result?.pendingGuidance}
    />
  );

  // A subagent's window: its conversation alone, as a chat (Raw Messages lists its records).
  if (agentId && !raw) {
    return (
      <div className="messages messages-chat">
        {phoneBar}
        {chat({ rows: result?.rows ?? [] })}
      </div>
    );
  }

  const stepDetail = () => {
    if (stepOutput === null) return null;
    return stepOutput.kind === 'markdown' ? <Markdown text={stepOutput.text} /> : <pre className="output">{stepOutput.text}</pre>;
  };

  const detail = (row: RunTableRow) => {
    if (row.kind === 'step') return stepDetail();
    if (row.kind === 'conversation') return chat(row);
    return <pre className="output">{row.text}</pre>;
  };

  const rowClass = (r: RunTableRow) =>
    r.kind === 'step' ? `msg-row msg-step result-${r.record.result}` : `msg-row msg-${r.kind}`;

  if (isPhone) {
    if (current) {
      return (
        <div className="messages messages-phone">
          {phoneBar}
          <div className={`messages-detail${current.kind === 'conversation' ? ' messages-detail-chat' : ''}`}>{detail(current)}</div>
        </div>
      );
    }
    const now = Date.now();
    const days = dayGroups(visible, (r) => (r.ts ? Date.parse(r.ts) : NaN), now);
    const toneOf = (r: RunTableRow) => (r.kind === 'step' ? resultTone(r.record.result) : undefined);
    return (
      <div className="messages messages-phone" ref={containerRef}>
        {phoneBar}
        <div
          className="messages-phone-scroll"
          ref={listRef}
          onScroll={(e) => {
            listScroll.current = e.currentTarget.scrollTop;
          }}
        >
          {run?.resultText && (
            <Group title="Result">
              <div className="pg-result">
                <Markdown text={run.resultText} />
              </div>
            </Group>
          )}
          {run && (
            <Group>
              <ListRow
                title="Outcome"
                sub={<span className="pg-oneline">{timeAndDuration(run.startTs, run.totalDurationMs > 0 ? formatDuration(run.totalDurationMs) : '')}</span>}
                value={running ? 'Running' : resultLabel(run.result)}
                valueTone={resultTone(run.result)}
              />
            </Group>
          )}
          {(result?.dropped ?? 0) > 0 && <p className="pg-group-footer">{result!.dropped} earlier messages not shown</p>}
          {visible.length === 0 ? (
            <Group title="Run">
              <EmptyRow>{rows.length > 0 ? 'No rows match the filter.' : emptyText()}</EmptyRow>
            </Group>
          ) : (
            days.map((day) => (
              <Group key={day.key} title={days.length > 1 ? `Run, ${day.title}` : 'Run'}>
                {day.items.map((r) => (
                  <ListRow
                    key={r.id}
                    title={r.preview}
                    sub={<span className="pg-oneline">{[r.ts ? clockTime(r.ts) : '', typeLabel(r)].filter(Boolean).join(' · ')}</span>}
                    tone={toneOf(r)}
                    chevron
                    onOpen={() => setSelected(r.id)}
                    onMenu={() => showRowMenu(r)}
                  />
                ))}
              </Group>
            ))
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="messages" ref={containerRef}>
      <div
        className="messages-table-wrap"
        style={{ height: `${splitPct}%` }}
        tabIndex={0}
        onKeyDown={nav}
        ref={wrapRef}
        onScroll={() => {
          const w = wrapRef.current;
          if (w) atBottomRef.current = w.scrollHeight - w.scrollTop - w.clientHeight < 40;
        }}
      >
        <table className="runlog-table">
          <ResizableColumns cols={MESSAGE_COLS} storageKey="messages" />
          <tbody>
            {raw && (result?.dropped ?? 0) > 0 && (
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
                  {rows.length > 0 ? 'No rows match the current view or filter.' : emptyText()}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="runlog-divider" onMouseDown={onDragStart} />
      <div
        className={`messages-detail${current?.kind === 'conversation' ? ' messages-detail-chat' : ''}`}
        style={{ height: `calc(${100 - splitPct}% - 5px)` }}
      >
        {current === null ? <div className="messages-detail-empty muted">Select a row</div> : detail(current)}
      </div>
    </div>
  );
}
