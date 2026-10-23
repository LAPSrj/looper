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
  hideNoAction: boolean;
  hideChatsAndTerminals: boolean;
}

function bestResult(records: RunRecord[]): string {
  const priority = ['error', 'max-runtime', 'interrupted', 'idle-timeout', 'held', 'stopped', 'warning', 'success', 'done', 'started', 'noop', 'skipped', 'act'];
  for (const p of priority) {
    if (records.some((r) => r.phase !== 'result' && r.result === p)) return p;
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
    // Guidance records say nothing about how the run went; they may even land after its result.
    const steps = sorted.filter((r) => r.phase !== 'guidance');
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

export function runShown(g: RunSummary, filter: RunFilter): boolean {
  // "No action" to the user covers both no-action check runs and scheduler skips.
  if (filter.hideNoAction && (g.result === 'skipped' || g.result === 'noop')) return false;
  return !(filter.hideChatsAndTerminals && (g.result === 'chat' || g.result === 'terminal'));
}
