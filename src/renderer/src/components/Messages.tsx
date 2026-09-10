import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MessagesShowKey } from '@shared/api';
import type { MessageRow, MessagesResult } from '@shared/messages';
import type { RunRecord, Task, TaskRuntime } from '@shared/types';
import { fmtDate, fmtTime, resultLabel } from '../format';
import { useDragResize, useListNav } from './hooks';
import { MessageBody } from './Markdown';
import { ToolInputView, ToolResultView } from './ToolContent';
import { ResizableColumns, TabBar, type TableCol } from './ui';

const POLL_MS = 2000;

function typeLabel(row: MessageRow): string {
  switch (row.kind) {
    case 'prompt':
      return 'Prompt';
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
function openRow(taskId: string, runId: string, agentId: string | undefined, row: MessageRow): void {
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
function categoryOf(r: MessageRow): MessagesShowKey | null {
  switch (r.kind) {
    case 'prompt':
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

function matchesFilter(r: MessageRow, f: string): boolean {
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
}

/** The conversation itself: a row per message/tool call, full content in the panel below. */
export function MessagesView({ taskId, runId, agentId, running }: ViewProps) {
  const [result, setResult] = useState<MessagesResult | null>(null);
  const [raw, setRaw] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<DetailTab>('result');
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [splitPct, setSplitPct] = useState(60);
  const [show, setShow] = useState<Record<MessagesShowKey, boolean>>({ messages: true, thinking: true, tools: true, subagents: true });
  const [filter, setFilter] = useState('');
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
      } else if (e.type === 'messages-filter') {
        setFilter(e.value);
        window.looper.reportMessagesFilter(e.value);
      }
    });
  }, []);

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

  // Poll while the run is live; also refetch once when it ends, to catch the tail.
  useEffect(() => {
    fetchNow();
    if (!running) return;
    const t = setInterval(fetchNow, POLL_MS);
    return () => clearInterval(t);
  }, [running, fetchNow]);

  const rows = result?.rows ?? [];
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
  }, [visible.length]);

  const idx = selected === null ? -1 : visible.findIndex((r) => r.id === selected);
  const current = idx >= 0 ? visible[idx] : null;
  useEffect(() => {
    setDetailTab('result');
  }, [selected]);

  // The image payload stays engine-side; fetch it when an image row is selected.
  const currentId = current?.id;
  const currentHasImage = !!current?.image;
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

  const nav = useListNav({
    count: visible.length,
    index: idx,
    onIndex: (i) => setSelected(visible[i].id),
    onActivate: (i) => openRow(taskId, runId, agentId, visible[i]),
    scrollToId: selected !== null ? `msg-${selected}` : null,
  });

  /** Ctrl+Up/Down hops between prompt rows; everything else goes to the list nav. */
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.ctrlKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      const dir = e.key === 'ArrowDown' ? 1 : -1;
      const start = idx < 0 ? (dir > 0 ? -1 : visible.length) : idx;
      for (let i = start + dir; i >= 0 && i < visible.length; i += dir) {
        if (visible[i].kind === 'prompt') {
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

  const onRowContextMenu = (e: React.MouseEvent, r: MessageRow) => {
    e.preventDefault();
    setSelected(r.id);
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

  const detail = (row: MessageRow) => {
    if (row.kind === 'tool') return toolDetail(row);
    if (row.image) return imagePane(row);
    if (row.kind === 'thinking' || row.kind === 'raw') return <pre className="output">{row.text}</pre>;
    return <MessageBody text={row.text} />;
  };

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
                className={`msg-row msg-${r.kind}${r.resultError ? ' msg-error' : ''}${selected === r.id ? ' selected' : ''}`}
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

const RUN_COLS: readonly TableCol[] = [
  { label: 'Date', width: 92 },
  { label: 'Start', width: 76 },
  { label: 'Result', width: 96, min: 60 },
  { label: 'Details' },
];

interface RunEntry {
  runId: string;
  ts: string;
  result: string;
  details: string;
}

interface Props {
  task: Task;
  records: RunRecord[];
  runtime: TaskRuntime | undefined;
}

/** The Messages tab: the task's agent runs; a run's conversation opens in its own window. */
export function Messages({ task, records, runtime }: Props) {
  const runs = useMemo(() => {
    const byRun = new Map<string, RunRecord[]>();
    for (const r of records) {
      const list = byRun.get(r.runId);
      if (list) list.push(r);
      else byRun.set(r.runId, [r]);
    }
    const out: RunEntry[] = [];
    for (const [runId, recs] of byRun) {
      // Only runs that reached the classifier or the agent have a conversation.
      const step = recs.find((r) => r.phase === 'agent') ?? recs.find((r) => r.phase === 'classify');
      if (!step) continue;
      const final = recs.findLast((r) => r.phase === 'result');
      const last = recs[recs.length - 1];
      out.push({
        runId,
        ts: step.ts,
        result: final?.result ?? last.result,
        details: final?.summary ?? last.error ?? last.summary ?? '',
      });
    }
    out.sort((a, b) => b.runId.localeCompare(a.runId));
    return out;
  }, [records]);

  const [selected, setSelected] = useState<string | null>(null);
  const idx = selected === null ? -1 : runs.findIndex((r) => r.runId === selected);
  const open = (runId: string) => void window.looper.openMessages(task.id, runId);
  const nav = useListNav({
    count: runs.length,
    index: idx,
    onIndex: (i) => setSelected(runs[i].runId),
    onActivate: (i) => open(runs[i].runId),
    scrollToId: selected !== null ? `msgrun-${selected}` : null,
  });

  const isRunning = (runId: string) =>
    runtime?.runs.some((r) => r.runId === runId && (r.state === 'running' || r.state === 'classifying')) ?? false;

  return (
    <div className="messages-runs" tabIndex={0} onKeyDown={nav}>
      <table className="runlog-table">
        <ResizableColumns cols={RUN_COLS} storageKey="messages-runs" />
        <tbody>
          {runs.map((r) => (
            <tr
              key={r.runId}
              id={`msgrun-${r.runId}`}
              className={`msg-run-row result-${r.result}${selected === r.runId ? ' selected' : ''}`}
              onClick={() => setSelected(r.runId)}
              onDoubleClick={() => open(r.runId)}
            >
              <td>{fmtDate(r.ts)}</td>
              <td>{fmtTime(r.ts)}</td>
              <td>{isRunning(r.runId) ? 'Running' : resultLabel(r.result)}</td>
              <td title={r.details}>{r.details}</td>
            </tr>
          ))}
          {runs.length === 0 && (
            <tr>
              <td colSpan={4} className="muted">
                No agent runs yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
