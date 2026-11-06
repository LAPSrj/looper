import type { RunRecord } from './types';

/** One run: its records, gathered from the task's run log. */
export interface RunGroup {
  runId: string;
  startTs: string;
  endTs: string;
  result: string;
  totalDurationMs: number;
  details: string;
  resultText: string;
  records: RunRecord[];
}

/** A run without its records, small enough to keep for every run and send to the dashboard. */
export type RunSummary = Omit<RunGroup, 'records' | 'resultText'>;

/** The run list's View filters. */
export interface RunFilter {
  /** Runs the scheduler skipped (or deferred), and the ones whose steps Run Options skipped. */
  hideSkipped: boolean;
  /** Runs whose check or classifier found nothing to do. */
  hideNoAction: boolean;
}

const PRIORITY: string[] = ['error', 'max-runtime', 'interrupted', 'idle-timeout', 'held', 'stopped', 'warning', 'success', 'done', 'exited', 'started', 'noop', 'skipped', 'act'];

function bestResult(records: RunRecord[]): string {
  // A start means the run is in progress only until a later record ends a step, such as the classifier's noop.
  const lastEnd = records.findLastIndex((r) => r.result !== 'started' && PRIORITY.includes(r.result));
  const counted = records.filter((r, i) => r.phase !== 'result' && (r.result !== 'started' || i > lastEnd));
  for (const p of PRIORITY) {
    if (counted.some((r) => r.result === p)) return p;
  }
  return records[records.length - 1]?.result ?? '';
}

function lastDetail(records: RunRecord[]): string {
  const result = records.findLast((r) => r.phase === 'result');
  if (result) return result.summary ?? '';
  const last = records[records.length - 1];
  if (!last) return '';
  const text = last.error ?? last.summary ?? '';
  const cost = last.detail?.costUsd !== undefined ? ` ($${Number(last.detail.costUsd).toFixed(3)})` : '';
  return text + cost;
}

function resultText(records: RunRecord[]): string {
  const r = records.findLast((rec) => rec.phase === 'result');
  return r?.body ?? r?.summary ?? '';
}

/** Records gathered into runs, newest first. */
export function groupRuns(records: RunRecord[]): RunGroup[] {
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
    // Guidance, events and question records say nothing about how the run went; guidance may even land after its result.
    const steps = sorted.filter((r) => r.phase !== 'guidance' && r.phase !== 'events' && r.phase !== 'question');
    const durations = sorted.filter((r) => r.durationMs !== undefined).map((r) => r.durationMs!);
    result.push({
      runId,
      startTs: sorted[0].ts,
      endTs: sorted[sorted.length - 1].ts,
      result: bestResult(steps),
      totalDurationMs: durations.reduce((a, b) => a + b, 0),
      details: lastDetail(steps),
      resultText: resultText(steps),
      records: sorted,
    });
  }
  return result.sort((a, b) => b.startTs.localeCompare(a.startTs));
}

/** Whether a run is a chat or terminal session, not a task run. */
export const isSessionRun = (g: Pick<RunSummary, 'result'>): boolean => g.result === 'chat' || g.result === 'terminal';

/** Whether a task run shows in the run lists (a task's Runs tab, Recent runs). Sessions show in their project's Chat tab instead. */
export function runShown(g: RunSummary, filter: RunFilter): boolean {
  if (isSessionRun(g)) return false;
  if (g.result === 'skipped') return !filter.hideSkipped;
  return !(filter.hideNoAction && g.result === 'noop');
}
