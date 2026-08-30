import { useEffect, useMemo, useRef, useState } from 'react';
import type { RunPhase, RunRecord, Task } from '@shared/types';
import { fmtTime, formatDuration, stripAnsi } from '../format';

interface Props {
  task: Task;
  records: RunRecord[];
}

const PHASES: (RunPhase | 'all')[] = ['all', 'check', 'classify', 'agent', 'skip', 'system'];

export function RunLog({ task, records }: Props) {
  const [phase, setPhase] = useState<RunPhase | 'all'>('all');
  const [hideNoop, setHideNoop] = useState(false);
  const [output, setOutput] = useState<{ runId: string; text: string } | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // Modal keyboard semantics: Esc closes, focus lands on the close button.
  useEffect(() => {
    if (!output) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOutput(null);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [output]);

  const rows = useMemo(() => {
    let list = records;
    if (phase !== 'all') list = list.filter((r) => r.phase === phase);
    if (hideNoop) list = list.filter((r) => r.result !== 'noop');
    return [...list].reverse();
  }, [records, phase, hideNoop]);

  const showOutput = async (runId: string) => {
    const text = await window.looper.runs.output(task.id, runId);
    setOutput({ runId, text: stripAnsi(text) || '(no output captured)' });
  };

  return (
    <div className="runlog">
      <div className="runlog-toolbar">
        <label>
          phase{' '}
          <select value={phase} onChange={(e) => setPhase(e.target.value as RunPhase | 'all')}>
            {PHASES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <label>
          <input type="checkbox" checked={hideNoop} onChange={(e) => setHideNoop(e.target.checked)} /> hide "nothing to do"
        </label>
        <span className="muted">{records.length} records</span>
      </div>
      <div className="runlog-table-wrap">
        <table className="runlog-table">
          <thead>
            <tr>
              <th>time</th>
              <th>run</th>
              <th>phase</th>
              <th>result</th>
              <th>duration</th>
              <th>details</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${r.ts}-${i}`} className={`result-${r.result}`}>
                <td className="nowrap">{fmtTime(r.ts)}</td>
                <td className="mono nowrap">{r.runId}</td>
                <td>{r.phase}</td>
                <td>
                  <span className={`pill pill-${r.result}`}>{r.result}</span>
                </td>
                <td className="nowrap">{r.durationMs !== undefined ? formatDuration(r.durationMs) : ''}</td>
                <td className="details" title={r.error ?? r.summary ?? ''}>
                  {r.error ?? r.summary ?? ''}
                  {r.detail?.costUsd !== undefined ? ` ($${Number(r.detail.costUsd).toFixed(3)})` : ''}
                </td>
                <td className="nowrap">
                  {r.phase === 'agent' && r.result !== 'started' && (
                    <button className="link" onClick={() => void showOutput(r.runId)}>
                      output
                    </button>
                  )}{' '}
                  {r.runId !== '-' && (
                    <button className="link" onClick={() => void window.looper.runs.openDir(task.id, r.runId)}>
                      folder
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="muted">
                  no runs yet
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {output && (
        <div className="modal-backdrop" onClick={() => setOutput(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span>
                output of run <span className="mono">{output.runId}</span>
              </span>
              <button ref={closeRef} className="btn small" onClick={() => setOutput(null)}>
                close
              </button>
            </div>
            <pre className="output">{output.text}</pre>
          </div>
        </div>
      )}
    </div>
  );
}
