import { useEffect, useRef, useState } from 'react';
import type { RunRecord } from '@shared/types';
import { capFirst, fmtTime, formatDuration, resultLabel, stripAnsi } from './format';
import { useListNav, useDragResize } from './components/hooks';
import { subscribe } from './events';
import { Markdown } from './components/Markdown';
import { ResizableColumns, type TableCol } from './components/ui';

const STEP_COLS: readonly TableCol[] = [
  { label: 'Time', width: 76 },
  { label: 'Phase', width: 84 },
  { label: 'Result', width: 96 },
  { label: 'Duration', width: 72 },
  { label: 'Details' },
];

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

export function RunDetailApp({ taskId, runId }: { taskId: string; runId: string }) {
  const [records, setRecords] = useState<RunRecord[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [output, setOutput] = useState<Output | null>(null);
  const [raw, setRaw] = useState(false);
  const [mode, setMode] = useState<AgentMode>('interactive');
  const [splitPct, setSplitPct] = useState(50);
  const containerRef = useRef<HTMLDivElement>(null);
  const recordsLenRef = useRef(0);
  recordsLenRef.current = records.length;

  useEffect(() => {
    window.looper.tasks.list().then((tasks) => {
      const t = tasks.find((x) => x.id === taskId);
      document.title = t ? `${t.name} – ${runId}` : `Run ${runId}`;
      setMode(t ? t.agent.mode : 'interactive');
    });
    window.looper.runs.list(taskId).then((all) => {
      const filtered = all.filter((r) => r.runId === runId);
      setRecords(filtered);
      if (filtered.length > 0) setSelected(filtered.length - 1);
    });
  }, [taskId, runId]);

  useEffect(() => {
    return subscribe((e) => {
      if (e.type !== 'record') return;
      if (e.record.taskId !== taskId || e.record.runId !== runId) return;
      const prevLen = recordsLenRef.current;
      setRecords((prev) => [...prev, e.record]);
      setSelected((prev) => (prev === null || prev === prevLen - 1 ? prevLen : prev));
    });
  }, [taskId, runId]);

  useEffect(() => {
    return window.looper.onUi((e) => {
      if (e.type === 'toggle-raw-output') setRaw((prev) => !prev);
    });
  }, []);

  // Records are only ever appended, so the selected record's identity is stable
  // across updates: this effect runs on a selection change, not on every record.
  const current = selected === null ? null : (records[selected] ?? null);
  useEffect(() => {
    const r = current;
    if (!r) {
      setOutput(null);
      return;
    }
    let cancelled = false;
    (async () => {
      if (r.phase === 'agent' && r.result !== 'started') {
        const text = stripAnsi(await window.looper.runs.output(taskId, runId, raw)) || '(no output captured)';
        if (cancelled) return;
        setOutput(raw ? { text, kind: 'raw' } : formatOutput(text, mode));
      } else {
        const text = r.body || r.stdoutTail || r.error || r.summary || '(no output)';
        setOutput(raw ? { text, kind: 'raw' } : formatOutput(text, mode));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [current, raw, mode, taskId, runId]);

  const onKeyDown = useListNav({
    count: records.length,
    index: selected ?? -1,
    onIndex: (i) => setSelected(i),
    scrollToId: selected !== null ? `step-${selected}` : null,
  });

  const onDragStart = useDragResize({
    axis: 'y',
    containerRef,
    onDrag: (y, rect) => setSplitPct(Math.max(15, Math.min(85, (y / rect.height) * 100))),
  });

  return (
    <div className="run-detail-app" ref={containerRef}>
      <div className="run-detail-table-wrap" style={{ height: `${splitPct}%` }} tabIndex={0} onKeyDown={onKeyDown}>
        <table className="runlog-table">
          <ResizableColumns cols={STEP_COLS} storageKey="run-detail" />
          <tbody>
            {records.map((r, i) => (
              <tr
                key={`${r.ts}-${i}`}
                id={`step-${i}`}
                className={`result-${r.result}${selected === i ? ' selected' : ''}`}
                onClick={() => setSelected(i)}
              >
                <td>{fmtTime(r.ts)}</td>
                <td>{capFirst(r.phase)}</td>
                <td>{resultLabel(r.result)}</td>
                <td>{r.durationMs !== undefined ? formatDuration(r.durationMs) : ''}</td>
                <td title={r.error ?? r.summary ?? ''}>
                  {r.error ?? r.summary ?? ''}
                  {r.detail?.costUsd !== undefined ? ` ($${Number(r.detail.costUsd).toFixed(3)})` : ''}
                </td>
              </tr>
            ))}
            {records.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">
                  No records.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="run-detail-divider" onMouseDown={onDragStart} />
      <div className="run-detail-output" style={{ height: `calc(${100 - splitPct}% - 5px)` }}>
        {output === null ? (
          <div className="run-detail-empty muted">Click a row to see its output</div>
        ) : output.kind === 'markdown' ? (
          <Markdown text={output.text} />
        ) : (
          <pre className="output">{output.text}</pre>
        )}
      </div>
    </div>
  );
}
