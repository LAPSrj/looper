import { useEffect, useMemo, useState } from 'react';
import type { RunRecord, Task } from '@shared/types';
import { fmtTime, formatDuration } from '../format';
import { useListNav } from './hooks';

interface Props {
  task: Task;
  records: RunRecord[];
}

interface RunGroup {
  runId: string;
  startTs: string;
  endTs: string;
  result: string;
  totalDurationMs: number;
  details: string;
  records: RunRecord[];
}

const RESULT_LABELS: Record<string, string> = {
  act: 'Action',
  done: 'Done',
  noop: 'No action',
  skipped: 'Skipped',
  started: 'Started',
  error: 'Error',
  'max-runtime': 'Timed out',
  interrupted: 'Interrupted',
  'idle-timeout': 'Idle timeout',
  held: 'Held',
  stopped: 'Stopped',
};

function resultLabel(result: string): string {
  return RESULT_LABELS[result] ?? result;
}

function bestResult(records: RunRecord[]): string {
  const priority = ['error', 'max-runtime', 'interrupted', 'idle-timeout', 'held', 'stopped', 'done', 'started', 'noop', 'skipped', 'act'];
  for (const p of priority) {
    if (records.some((r) => r.result === p)) return p;
  }
  return records[records.length - 1]?.result ?? '';
}

function lastDetail(records: RunRecord[]): string {
  const last = records[records.length - 1];
  if (!last) return '';
  const text = last.error ?? last.summary ?? '';
  const cost = last.detail?.costUsd !== undefined ? ` ($${Number(last.detail.costUsd).toFixed(3)})` : '';
  return text + cost;
}

export function RunLog({ task, records }: Props) {
  const [selected, setSelected] = useState<string | null>(null);

  const groups = useMemo(() => {
    const map = new Map<string, RunRecord[]>();
    for (const r of records) {
      let list = map.get(r.runId);
      if (!list) {
        list = [];
        map.set(r.runId, list);
      }
      list.push(r);
    }
    const result: RunGroup[] = [];
    for (const [runId, recs] of map) {
      const sorted = [...recs].sort((a, b) => a.ts.localeCompare(b.ts));
      const durations = sorted.filter((r) => r.durationMs !== undefined).map((r) => r.durationMs!);
      const totalMs = durations.reduce((a, b) => a + b, 0);
      result.push({
        runId,
        startTs: sorted[0].ts,
        endTs: sorted[sorted.length - 1].ts,
        result: bestResult(sorted),
        totalDurationMs: totalMs,
        details: lastDetail(sorted),
        records: sorted,
      });
    }
    result.sort((a, b) => b.startTs.localeCompare(a.startTs));
    return result;
  }, [records]);

  useEffect(() => {
    if (selected && !groups.some((g) => g.runId === selected)) {
      setSelected(groups[0]?.runId ?? null);
    }
  }, [groups, selected]);

  const idx = groups.findIndex((g) => g.runId === selected);
  const nav = useListNav({
    count: groups.length,
    index: idx,
    onIndex: (i) => setSelected(groups[i].runId),
    onActivate: (i) => void window.looper.openRunDetail(task.id, groups[i].runId),
    scrollToId: selected ? `run-${selected}` : null,
  });
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.ctrlKey && e.key === 'c' && idx >= 0) {
      void navigator.clipboard.writeText(groups[idx].details);
      e.preventDefault();
      return;
    }
    nav(e);
  };

  return (
    <div className="runlog">
      <div className="runlog-table-wrap" tabIndex={0} onKeyDown={onKeyDown}>
        <table className="runlog-table">
          <thead>
            <tr>
              <th>Start</th>
              <th>End</th>
              <th>Result</th>
              <th>Duration</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <tr
                key={g.runId}
                id={`run-${g.runId}`}
                className={`result-${g.result} run-row${selected === g.runId ? ' selected' : ''}`}
                onClick={() => setSelected(g.runId)}
                onDoubleClick={() => void window.looper.openRunDetail(task.id, g.runId)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setSelected(g.runId);
                  window.looper.showRunContextMenu({ taskId: task.id, runId: g.runId, details: g.details });
                }}
              >
                <td className="nowrap">{fmtTime(g.startTs)}</td>
                <td className="nowrap">{fmtTime(g.endTs)}</td>
                <td className="nowrap">{resultLabel(g.result)}</td>
                <td className="nowrap">{g.totalDurationMs > 0 ? formatDuration(g.totalDurationMs) : ''}</td>
                <td className="details" title={g.details}>
                  {g.details}
                </td>
              </tr>
            ))}
            {groups.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">
                  No runs yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
