import { useEffect, useMemo, useState } from 'react';
import { groupRuns, runShown, type RunFilter, type RunGroup } from '@shared/runs';
import type { RunRecord, TaskRuntime } from '@shared/types';
import { fmtDate, fmtTime, formatDuration, resultLabel } from '../format';
import { resultTone, timeAndDuration } from '../phone-lists';
import { DataTable, type DataCol } from './DataTable';
import { ListDetail } from './ListDetail';
import { Markdown } from './Markdown';

interface Props {
  /** The records to group into runs: a task's, or the chat and terminal records of a project's Chat tab. */
  records: RunRecord[];
  runtime?: TaskRuntime;
  /** A project's Chat tab: lists every run in `records` (sessions) without a Result column. */
  sessions?: boolean;
  /** View → Task Runs: the runs it leaves out (none when unset). */
  filter?: RunFilter;
  /** Run to select (notification click); a fresh object per click re-triggers. */
  focusRun?: { runId: string } | null;
}

const SHOW_ALL: RunFilter = { hideSkipped: false, hideNoAction: false };

export function RunLog({ records, runtime, sessions = false, filter = SHOW_ALL, focusRun }: Props) {
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    if (focusRun) setSelected(focusRun.runId);
  }, [focusRun]);

  const groups = useMemo(
    () => groupRuns(records).filter((g) => sessions || runShown(g, filter)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [records, filter.hideSkipped, filter.hideNoAction, sessions],
  );
  // A run's records are all its own task's (a project's Chat tab mixes its tasks' sessions with its own).
  const taskOf = (g: { records: RunRecord[] }) => g.records[0].taskId;

  useEffect(() => {
    // While records are still loading (groups empty) keep the selection: a
    // notification click may have selected a run before its records arrived.
    if (selected && groups.length > 0 && !groups.some((g) => g.runId === selected)) {
      setSelected(groups[0].runId);
    }
  }, [groups, selected]);

  const selectedGroup = groups.find((g) => g.runId === selected) ?? null;
  const isRunning = (runId: string) => runtime?.runs.some((r) => r.runId === runId) ?? false;
  const duration = (g: RunGroup) => (g.totalDurationMs > 0 ? formatDuration(g.totalDurationMs) : '');

  // A project's chats and terminal sessions all share one result, so they have no Result column.
  const cols: DataCol<RunGroup>[] = [
    { label: 'Date', width: 92, cell: (g) => fmtDate(g.startTs) },
    { label: 'Start', width: 76, cell: (g) => fmtTime(g.startTs) },
    { label: 'End', width: 76, cell: (g) => fmtTime(g.endTs) },
    ...(sessions ? [] : [{ label: 'Result', width: 96, cell: (g: RunGroup) => (isRunning(g.runId) ? 'Running' : resultLabel(g.result)) }]),
    { label: 'Duration', width: 72, cell: duration },
    { label: 'Details', cell: (g) => g.details, title: (g) => g.details },
  ];

  return (
    <div className="runlog">
      <ListDetail
        preview
        panes={{ axis: 'y', initial: 65, unit: '%', min: 20, max: 90 }}
        list={
          <DataTable
            cols={cols}
            rows={groups}
            rowKey={(g) => g.runId}
            idPrefix="run"
            storageKey={sessions ? 'runlog-sessions' : 'runlog'}
            rowClass={(g) => `result-${g.result}`}
            selected={selected}
            onSelect={(g) => setSelected(g.runId)}
            onOpen={(g) => void window.looper.openMessages(taskOf(g), g.runId)}
            onMenu={(g) => window.looper.showRunContextMenu({ taskId: taskOf(g), runId: g.runId, details: g.details })}
            copyText={(g) => g.resultText || g.details}
            empty={sessions ? 'No chats or terminal sessions yet.' : 'No runs yet.'}
            dayOf={(g) => Date.parse(g.startTs)}
            phoneRow={(g) => ({
              title: g.details || (sessions ? 'Session' : resultLabel(g.result)),
              sub: timeAndDuration(g.startTs, duration(g)),
              value: sessions ? undefined : isRunning(g.runId) ? 'Running' : resultLabel(g.result),
              valueTone: resultTone(g.result),
            })}
          />
        }
        detail={
          <div className="runlog-result">
            {selectedGroup?.resultText ? <Markdown text={selectedGroup.resultText} /> : <div className="runlog-result-empty muted">{selectedGroup ? 'No result' : 'Select a run'}</div>}
          </div>
        }
      />
    </div>
  );
}
