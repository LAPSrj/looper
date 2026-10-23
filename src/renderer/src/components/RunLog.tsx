import { useEffect, useMemo, useRef, useState } from 'react';
import { groupRuns, runShown } from '@shared/runs';
import type { RunRecord, Task, TaskRuntime } from '@shared/types';
import { fmtDate, fmtTime, formatDuration, resultLabel } from '../format';
import { useDragResize, useListNav } from './hooks';
import { Markdown } from './Markdown';
import { ResizableColumns, type TableCol } from './ui';

const RUN_COLS: readonly TableCol[] = [
  { label: 'Date', width: 92 },
  { label: 'Start', width: 76 },
  { label: 'End', width: 76 },
  { label: 'Result', width: 96 },
  { label: 'Duration', width: 72 },
  { label: 'Details' },
];

interface Props {
  task: Task;
  records: RunRecord[];
  runtime: TaskRuntime | undefined;
  hideNoAction: boolean;
  hideChatsAndTerminals: boolean;
  /** Run to select (notification click); a fresh object per click re-triggers. */
  focusRun?: { runId: string } | null;
}

export function RunLog({ task, records, runtime, hideNoAction, hideChatsAndTerminals, focusRun }: Props) {
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    if (focusRun) setSelected(focusRun.runId);
  }, [focusRun]);
  const [splitPct, setSplitPct] = useState(65);
  const containerRef = useRef<HTMLDivElement>(null);

  const groups = useMemo(
    () => groupRuns(records).filter((g) => runShown(g, { hideNoAction, hideChatsAndTerminals })),
    [records, hideNoAction, hideChatsAndTerminals],
  );

  useEffect(() => {
    // While records are still loading (groups empty) keep the selection: a
    // notification click may have selected a run before its records arrived.
    if (selected && groups.length > 0 && !groups.some((g) => g.runId === selected)) {
      setSelected(groups[0].runId);
    }
  }, [groups, selected]);

  const idx = groups.findIndex((g) => g.runId === selected);
  const selectedGroup = idx >= 0 ? groups[idx] : null;
  const nav = useListNav({
    count: groups.length,
    index: idx,
    onIndex: (i) => setSelected(groups[i].runId),
    onActivate: (i) => void window.looper.openMessages(task.id, groups[i].runId),
    scrollToId: selected ? `run-${selected}` : null,
  });
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.ctrlKey && e.key === 'c' && selectedGroup) {
      void navigator.clipboard.writeText(selectedGroup.resultText || selectedGroup.details);
      e.preventDefault();
      return;
    }
    nav(e);
  };

  const isRunning = (runId: string) => runtime?.runs.some((r) => r.runId === runId) ?? false;

  const onDragStart = useDragResize({
    axis: 'y',
    containerRef,
    onDrag: (y, rect) => setSplitPct(Math.max(20, Math.min(90, (y / rect.height) * 100))),
  });

  return (
    <div className="runlog" ref={containerRef}>
      <div className="runlog-table-wrap" style={{ height: `${splitPct}%` }} tabIndex={0} onKeyDown={onKeyDown}>
        <table className="runlog-table">
          <ResizableColumns cols={RUN_COLS} storageKey="runlog" />
          <tbody>
            {groups.map((g) => (
              <tr
                key={g.runId}
                id={`run-${g.runId}`}
                className={`result-${g.result} run-row${selected === g.runId ? ' selected' : ''}`}
                onClick={() => setSelected(g.runId)}
                onDoubleClick={() => void window.looper.openMessages(task.id, g.runId)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setSelected(g.runId);
                  window.looper.showRunContextMenu({ taskId: task.id, runId: g.runId, details: g.details });
                }}
              >
                <td>{fmtDate(g.startTs)}</td>
                <td>{fmtTime(g.startTs)}</td>
                <td>{fmtTime(g.endTs)}</td>
                <td>{isRunning(g.runId) ? 'Running' : resultLabel(g.result)}</td>
                <td>{g.totalDurationMs > 0 ? formatDuration(g.totalDurationMs) : ''}</td>
                <td title={g.details}>{g.details}</td>
              </tr>
            ))}
            {groups.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  No runs yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="runlog-divider" onMouseDown={onDragStart} />
      <div className="runlog-result" style={{ height: `calc(${100 - splitPct}% - 5px)` }}>
        {selectedGroup?.resultText ? (
          <Markdown text={selectedGroup.resultText} />
        ) : (
          <div className="runlog-result-empty muted">
            {selectedGroup ? 'No result' : 'Select a run'}
          </div>
        )}
      </div>
    </div>
  );
}
