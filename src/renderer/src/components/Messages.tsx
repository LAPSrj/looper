import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RUN_VIEWS } from '@shared/commands/build';
import type { CommandContext } from '@shared/commands/context';
import type { MessageRow, MessagesResult } from '@shared/messages';
import { messagesToMarkdown } from '@shared/messages-md';
import { groupRuns } from '@shared/runs';
import type { RunRecord } from '@shared/types';
import { subscribe } from '../events';
import { useRunPermission } from '../live-state';
import { capFirst, fmtHourMinute, fmtTime, formatDuration, resultLabel, stripAnsi } from '../format';
import { resultTone } from '../phone-lists';
import { initialRow, rowMatches, runTableRows, type ConversationRow, type RunTableRow, type StepRow } from '../run-rows';
import { phoneNav } from './command-surfaces';
import { DataTable, type DataCol } from './DataTable';
import { FindBar, useFindFocus, useFindHighlights, type FindState } from './FindBar';
import { useCommandMenu, useCommandState } from './useCommands';
import { ListDetail, selectsFirstRow } from './ListDetail';
import { NavBar } from './NavBar';
import { Markdown } from './Markdown';
import { atEnd, useStayAtEnd } from './newest-first';
import { Group } from './phone/PhoneList';
import { TranscriptView } from './Transcript';

const POLL_MS = 2000;

const STEP_NAMES: Record<string, string> = {
  check: 'Check',
  classify: 'Classifier',
  agent: 'Agent',
  guidance: 'Guidance',
  events: 'Events',
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
    case 'delegate':
      // On a delegated agent's own run: who started it. On its parent's: the agents it started, and their results.
      if (typeof r.detail?.parentRunId === 'string') return `Started by the agent of run ${r.detail.parentRunId}`;
      if (r.result === 'started') return `Started an agent: ${note ?? ''}`;
      if (r.result === 'delivered') return 'The agent got the messages from the agents it started';
      if (r.result === 'undelivered') return `Not delivered: ${(note ?? '').replace(/^not delivered: /, '')}`;
      return `Agent ended (${resultLabel(r.result).toLowerCase()}): ${note ?? ''}`;
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

const MESSAGE_COLS: readonly DataCol<RunTableRow>[] = [
  { label: 'Time', width: 76, cell: (r) => (r.ts ? fmtTime(r.ts) : '') },
  { label: 'Type', width: 110, min: 60, cell: typeLabel },
  { label: 'Details', cell: (r) => r.preview, title: (r) => r.preview },
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
  const [showResult, setShowResult] = useState(true);
  const [filter, setFilter] = useState('');
  const [autoScroll, setAutoScroll] = useState(false);
  const [find, setFind] = useState<FindState | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const findField = useFindFocus();
  const atBottomRef = useRef(true);

  // The filter window sends its value.
  useEffect(
    () =>
      window.looper.onUi((e) => {
        if (e.type === 'filter') setFilter(e.value);
      }),
    [],
  );

  // The window's menu bar (a phone's More), from the one list.
  const commandState = useCommandState();
  const [canContinue, setCanContinue] = useState({ chat: false, terminal: false, guidance: false, compact: false, start: false });
  const [workFolder, setWorkFolder] = useState(false);
  const [inAttention, setInAttention] = useState(false);
  // Opening a run's window takes its notices off Needs attention; Close and Keep in Needs Attention puts them back.
  useEffect(() => {
    if (agentId) return;
    void window.looper.runtime.markRunSeen(taskId, runId).then(setInAttention, () => undefined);
  }, [taskId, runId, agentId]);
  useEffect(() => {
    if (agentId) return;
    // Read once as the window opens: a run still going keeps the Continue items off.
    void window.looper.runs.canContinue(taskId, runId).then(setCanContinue);
  }, [taskId, runId, agentId]);
  useEffect(() => {
    void window.looper.tasks.list().then((tasks) => setWorkFolder(!!tasks.find((x) => x.id === taskId)?.cwd));
  }, [taskId]);
  const run = useMemo(() => (agentId ? undefined : groupRuns(records)[0]), [records, agentId]);
  // A phone's Result tab shows the run's result; with none, the list is all there is.
  const hasResult = !!run?.resultText;
  const commands: CommandContext = {
    ...commandState,
    run: {
      taskId,
      runId,
      agentId,
      title: document.title,
      workFolder,
      canContinue,
      raw,
      rawOutput,
      autoScroll,
      filter,
      inAttention,
      tab: hasResult && showResult ? 'result' : 'details',
      message: !selectsFirstRow && selected !== null,
      findInMessage:
        selected === null
          ? undefined
          : () => {
              setFind((f) => f ?? { query: '', index: 0 });
              findField.focus();
            },
      set: (patch) => {
        if (patch.raw !== undefined) setRaw(patch.raw);
        if (patch.rawOutput !== undefined) setRawOutput(patch.rawOutput);
        if (patch.autoScroll !== undefined) setAutoScroll(patch.autoScroll);
        // A phone's list goes to its end as Auto Scroll comes on.
        if (patch.autoScroll && !selectsFirstRow) atBottomRef.current = true;
      },
    },
  };
  useCommandMenu(RUN_VIEWS, commands);

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
  // A permission request of the run's agent shows in its conversation, as in the Chats view.
  const permission = useRunPermission(taskId, runId);
  const visible = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return rows.filter((r) => !f || rowMatches(r, f));
  }, [rows, filter]);

  // Follow the table while the reader is at its bottom. A phone's list stays where it's read, unless Auto Scroll is on.
  useStayAtEnd(wrapRef, atBottomRef, visible.length, selectsFirstRow || autoScroll);

  // Auto Scroll: while the last row is selected (or none is), a new last row
  // takes the selection and the table scrolls to the bottom. Selecting an
  // earlier row stops it until the last row is selected again.
  const lastId = visible.length > 0 ? visible[visible.length - 1].id : null;
  const prevLastRef = useRef<string | null>(null);
  useEffect(() => {
    const prevLast = prevLastRef.current;
    prevLastRef.current = lastId;
    // A phone's selection opens a row: the list doesn't follow the newest one.
    if (!selectsFirstRow || !autoScroll || lastId === null || selected === lastId) return;
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
    if (!selectsFirstRow || agentId || initialPicked.current || result === null) return;
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

  // Find in Message searches the open row; another row closes it, and so does the filter hiding it, which takes its pane away.
  const shown = current !== null;
  useEffect(() => setFind(null), [selected, shown]);
  const matches = useFindHighlights(detailRef, find, setFind);

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

  const phoneBar = <NavBar title={phoneTitle} more={phoneNav(RUN_VIEWS, commands).more} order={10} />;

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
      drawAll={find !== null}
      permission={c.source === 'classifier' || agentId ? undefined : permission}
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

  const rowClass = (r: RunTableRow) => (r.kind === 'step' ? `msg-row msg-step result-${r.record.result}` : `msg-row msg-${r.kind}`);

  return (
    <div className="messages">
      {phoneBar}
      <ListDetail
        panes={{ axis: 'y', initial: 40, unit: '%', min: 15, max: 90 }}
        open={current !== null}
        onClose={() => setSelected(null)}
        detailTitle={current ? (current.kind === 'conversation' ? 'Conversation' : typeLabel(current)) : undefined}
        empty="Select a row"
        summary={
          hasResult
            ? {
                label: 'Result',
                listLabel: 'Details',
                shown: showResult,
                onShown: setShowResult,
                body: (
                  <Group>
                    <div className="pg-result">
                      <Markdown text={run.resultText!} />
                    </div>
                  </Group>
                ),
              }
            : undefined
        }
        list={
          <DataTable
            cols={MESSAGE_COLS}
            rows={visible}
            rowKey={(r) => r.id}
            idPrefix="msg"
            storageKey="messages"
            rowClass={rowClass}
            selected={selected}
            onSelect={(r) => setSelected(r.id)}
            onMenu={showRowMenu}
            tableRef={wrapRef}
            onTableScroll={(e) => {
              const w = e.currentTarget;
              atBottomRef.current = atEnd(w);
            }}
            empty={rows.length > 0 ? 'No rows match the filter.' : emptyText()}
            search={{ value: filter, onChange: setFilter }}
            dayOf={(r) => (r.ts ? Date.parse(r.ts) : NaN)}
            sectionTitle={(day, days) => (days > 1 ? `Run, ${day}` : 'Run')}
            phoneRow={(r) => ({
              title: r.preview,
              sub: [r.ts ? fmtHourMinute(r.ts) : '', typeLabel(r)].filter(Boolean).join(' · '),
              tone: r.kind === 'step' ? resultTone(r.record.result) : undefined,
            })}
          />
        }
        detail={
          current && (
            <div className={`messages-detail${current.kind === 'conversation' ? ' messages-detail-chat' : ''}`}>
              {find && <FindBar find={find} matches={matches} onChange={setFind} onClose={() => setFind(null)} inputRef={findField.inputRef} />}
              <div className="messages-detail-body" ref={detailRef}>
                {detail(current)}
              </div>
            </div>
          )
        }
      />
    </div>
  );
}
