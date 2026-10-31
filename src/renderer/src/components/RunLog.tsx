import { useEffect, useMemo, useRef, useState } from 'react';
import { groupRuns, runShown } from '@shared/runs';
import type { RunRecord, TaskRuntime } from '@shared/types';
import { fmtDate, fmtTime, formatDuration, resultLabel } from '../format';
import { useDragResize, useListNav } from './hooks';
import { Markdown } from './Markdown';
import { ResizableColumns, type TableCol } from './ui';
import { isPhone } from '../web/page-nav';

const RUN_COLS: readonly TableCol[] = [
  { label: 'Date', width: 92 },
  { label: 'Start', width: 76 },
  { label: 'End', width: 76 },
  { label: 'Result', width: 96 },
  { label: 'Duration', width: 72 },
  { label: 'Details' },
];

/** A project's chats and terminal sessions all share one result, so they have no Result column. */
const SESSION_COLS: readonly TableCol[] = RUN_COLS.filter((c) => c.label !== 'Result');

interface Props {
  /** The records to group into runs: a task's, or the chat and terminal records of a project's Chat tab. */
  records: RunRecord[];
  runtime?: TaskRuntime;
  /** A project's Chat tab: lists every run in `records` (sessions) without a Result column. */
  sessions?: boolean;
  hideNoAction?: boolean;
  /** Run to select (notification click); a fresh object per click re-triggers. */
  focusRun?: { runId: string } | null;
}

export function RunLog({ records, runtime, sessions = false, hideNoAction = false, focusRun }: Props) {
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    if (focusRun) setSelected(focusRun.runId);
  }, [focusRun]);
  const [splitPct, setSplitPct] = useState(65);
  const containerRef = useRef<HTMLDivElement>(null);

  const groups = useMemo(
    () => groupRuns(records).filter((g) => sessions || runShown(g, { hideNoAction })),
    [records, hideNoAction, sessions],
  );
  const cols = sessions ? SESSION_COLS : RUN_COLS;
  // A run's records are all its own task's (a project's Chat tab mixes its tasks' sessions with its own).
  const taskOf = (g: { records: RunRecord[] }) => g.records[0].taskId;

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
    onActivate: (i) => void window.looper.openMessages(taskOf(groups[i]), groups[i].runId),
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
          <ResizableColumns cols={cols} storageKey={sessions ? 'runlog-sessions' : 'runlog'} />
          <tbody>
            {groups.map((g) => (
              <tr
                key={g.runId}
                id={`run-${g.runId}`}
                className={`result-${g.result} run-row${selected === g.runId ? ' selected' : ''}`}
                onClick={() => {
                  setSelected(g.runId);
                  // A phone has no double-click: a tap opens the run window.
                  if (isPhone) void window.looper.openMessages(taskOf(g), g.runId);
                }}
                onDoubleClick={() => void window.looper.openMessages(taskOf(g), g.runId)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setSelected(g.runId);
                  window.looper.showRunContextMenu({ taskId: taskOf(g), runId: g.runId, details: g.details });
                }}
              >
                <td>{fmtDate(g.startTs)}</td>
                <td>{fmtTime(g.startTs)}</td>
                <td>{fmtTime(g.endTs)}</td>
                {!sessions && <td>{isRunning(g.runId) ? 'Running' : resultLabel(g.result)}</td>}
                <td>{g.totalDurationMs > 0 ? formatDuration(g.totalDurationMs) : ''}</td>
                <td title={g.details}>{g.details}</td>
              </tr>
            ))}
            {groups.length === 0 && (
              <tr>
                <td colSpan={cols.length} className="muted">
                  {sessions ? 'No chats or terminal sessions yet.' : 'No runs yet.'}
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
