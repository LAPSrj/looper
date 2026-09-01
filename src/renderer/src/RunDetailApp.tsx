import { useCallback, useEffect, useRef, useState } from 'react';
import type { RunRecord } from '@shared/types';
import { capFirst, fmtTime, formatDuration, stripAnsi } from './format';
import { useListNav, useDragResize } from './components/hooks';

function formatOutput(text: string): string {
  const trimmed = text.trim();
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2);
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
    if (anyFormatted) return formatted.join('\n');
  }
  return text;
}

export function RunDetailApp({ taskId, runId }: { taskId: string; runId: string }) {
  const [records, setRecords] = useState<RunRecord[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [outputText, setOutputText] = useState<string | null>(null);
  const [, setRaw] = useState(false); // forces a re-render when the raw toggle flips rawRef
  const [splitPct, setSplitPct] = useState(50);
  const containerRef = useRef<HTMLDivElement>(null);
  const rawRef = useRef(false);

  const loadOutput = useCallback(
    async (idx: number, recs: RunRecord[], useRaw: boolean) => {
      setSelected(idx);
      const r = recs[idx];
      if (!r) {
        setOutputText(null);
        return;
      }
      if (r.phase === 'agent' && r.result !== 'started') {
        const text = await window.looper.runs.output(taskId, runId, useRaw);
        setOutputText(stripAnsi(text) || '(no output captured)');
      } else {
        const text = r.stdoutTail || r.error || r.summary || '(no output)';
        setOutputText(useRaw ? text : formatOutput(text));
      }
    },
    [taskId, runId],
  );

  useEffect(() => {
    window.looper.tasks.list().then((tasks) => {
      const t = tasks.find((x) => x.id === taskId);
      document.title = t ? `${t.name} – ${runId}` : `Run ${runId}`;
    });
    window.looper.runs.list(taskId).then((all) => {
      const filtered = all.filter((r) => r.runId === runId);
      setRecords(filtered);
      if (filtered.length > 0) {
        void loadOutput(filtered.length - 1, filtered, rawRef.current);
      }
    });
  }, [taskId, runId, loadOutput]);

  useEffect(() => {
    return window.looper.onUi((e) => {
      if (e.type === 'toggle-raw-output') {
        const next = !rawRef.current;
        rawRef.current = next;
        setRaw(next);
        if (selected !== null) void loadOutput(selected, records, next);
      }
    });
  }, [records, selected, loadOutput]);

  const onKeyDown = useListNav({
    count: records.length,
    index: selected ?? -1,
    onIndex: (i) => void loadOutput(i, records, rawRef.current),
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
          <thead>
            <tr>
              <th>Time</th>
              <th>Phase</th>
              <th>Result</th>
              <th>Duration</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {records.map((r, i) => (
              <tr
                key={`${r.ts}-${i}`}
                id={`step-${i}`}
                className={`result-${r.result}${selected === i ? ' selected' : ''}`}
                onClick={() => void loadOutput(i, records, rawRef.current)}
              >
                <td className="nowrap">{fmtTime(r.ts)}</td>
                <td>{capFirst(r.phase)}</td>
                <td>{r.result}</td>
                <td className="nowrap">{r.durationMs !== undefined ? formatDuration(r.durationMs) : ''}</td>
                <td className="details" title={r.error ?? r.summary ?? ''}>
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
        {outputText !== null ? (
          <pre className="output">{outputText}</pre>
        ) : (
          <div className="run-detail-empty muted">Click a row to see its output</div>
        )}
      </div>
    </div>
  );
}
