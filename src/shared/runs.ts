import type { RunRecord } from './types';

/** One run: its records, gathered from the task's run log. */
export interface RunGroup {
  runId: string;
  /** A delegated agent's run (looper-delegate): the run whose agent started it. */
  parentRunId?: string;
  /** A delegated agent's run: the title its parent gave it. */
  title?: string;
  /** A delegated agent's run: the folder it works in, in its environment's path form. */
  folder?: string;
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

/** The results a run can end with, the most important first: a run with several records has the first of them that any record has. */
export const RUN_RESULTS: readonly string[] = ['error', 'max-runtime', 'interrupted', 'idle-timeout', 'held', 'stopped', 'warning', 'success', 'done', 'exited', 'started', 'noop', 'skipped', 'act'];
const PRIORITY = RUN_RESULTS;

/** The record of a run opened in a chat starting its report: how the run went is decided from here on. */
export function startsOver(r: RunRecord): boolean {
  return r.phase === 'system' && r.result === 'started' && typeof r.detail?.chat === 'string';
}

function bestResult(all: RunRecord[]): string {
  const records = all.slice(Math.max(0, all.findLastIndex(startsOver)));
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

/** What a delegated agent's run's first delegate record says about it. */
function delegatedBy(r: RunRecord): { parentRunId: string; title?: string; folder?: string } {
  const d = r.detail!;
  return {
    parentRunId: d.parentRunId as string,
    ...(typeof d.title === 'string' ? { title: d.title } : {}),
    ...(typeof d.folder === 'string' ? { folder: d.folder } : {}),
  };
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
    // A delegated agent's run says who started it in its first delegate record.
    const by = sorted.find((r) => r.phase === 'delegate' && typeof r.detail?.parentRunId === 'string');
    // Guidance, events and question records say nothing about how the run went; guidance may even land after its result.
    // Nor do the records of the agents a run's agent started: those are the agents' own runs.
    const steps = sorted.filter((r) => r.phase !== 'guidance' && r.phase !== 'events' && r.phase !== 'question' && (r.phase !== 'delegate' || r === by));
    const durations = sorted.filter((r) => r.durationMs !== undefined).map((r) => r.durationMs!);
    result.push({
      runId,
      ...(by ? delegatedBy(by) : {}),
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

/** What a run's summary needs of its records so far, kept as they come in time order. */
interface RunAcc {
  runId: string;
  by?: ReturnType<typeof delegatedBy>;
  startTs: string;
  endTs: string;
  totalDurationMs: number;
  /** Results of the steps that always count: not a result phase, not a start. */
  results: Set<string>;
  /** A step started after the last step that ended something (bestResult's `i > lastEnd`). */
  startedAfterEnd: boolean;
  /** The last step's result and what lastDetail shows of it, without its body or detail. */
  lastStep?: { result: string; text: string; costUsd?: unknown };
  /** The last result step's summary. */
  lastResultSummary?: string;
}

/**
 * A task's run summaries, the same as groupRuns gives, updated a record at a time without keeping the records.
 * `add` returns false for a record older than its run's last one: groupRuns sorts by time, so the caller reads the log again.
 */
export class RunSummaries {
  private runs = new Map<string, RunAcc>();
  private listed: RunSummary[] | null = null;

  add(r: RunRecord): boolean {
    let a = this.runs.get(r.runId);
    if (a && r.ts < a.endTs) return false;
    if (!a) {
      a = { runId: r.runId, startTs: r.ts, endTs: r.ts, totalDurationMs: 0, results: new Set(), startedAfterEnd: false };
      this.runs.set(r.runId, a);
    }
    a.endTs = r.ts;
    if (r.durationMs !== undefined) a.totalDurationMs += r.durationMs;
    const isBy = !a.by && r.phase === 'delegate' && typeof r.detail?.parentRunId === 'string';
    if (isBy) a.by = delegatedBy(r);
    const step = r.phase !== 'guidance' && r.phase !== 'events' && r.phase !== 'question' && (r.phase !== 'delegate' || isBy);
    if (step) {
      if (startsOver(r)) a.results.clear();
      if (r.result !== 'started' && PRIORITY.includes(r.result)) a.startedAfterEnd = false;
      else if (r.result === 'started' && r.phase !== 'result') a.startedAfterEnd = true;
      if (r.phase !== 'result' && r.result !== 'started') a.results.add(r.result);
      if (r.phase === 'result') a.lastResultSummary = r.summary ?? '';
      a.lastStep = { result: r.result, text: r.error ?? r.summary ?? '', ...(r.detail?.costUsd !== undefined ? { costUsd: r.detail.costUsd } : {}) };
    }
    this.listed = null;
    return true;
  }

  /** Newest first, as groupRuns sorts them. */
  list(): RunSummary[] {
    this.listed ??= [...this.runs.values()].map(summaryOf).sort((x, y) => y.startTs.localeCompare(x.startTs));
    return this.listed;
  }
}

function summaryOf(a: RunAcc): RunSummary {
  const best = PRIORITY.find((p) => (p === 'started' ? a.startedAfterEnd : a.results.has(p))) ?? a.lastStep?.result ?? '';
  let details: string;
  if (a.lastResultSummary !== undefined) details = a.lastResultSummary;
  else if (!a.lastStep) details = '';
  else details = a.lastStep.text + (a.lastStep.costUsd !== undefined ? ` ($${Number(a.lastStep.costUsd).toFixed(3)})` : '');
  return { runId: a.runId, ...(a.by ?? {}), startTs: a.startTs, endTs: a.endTs, result: best, totalDurationMs: a.totalDurationMs, details };
}

/** Whether a run is a chat or terminal session, not a task run. */
export const isSessionRun = (g: Pick<RunSummary, 'result'>): boolean => g.result === 'chat' || g.result === 'terminal';

/** Whether a task run shows in the run lists (a task's Runs tab, Recent runs). Sessions show in their project's Chat tab instead. */
export function runShown(g: Pick<RunSummary, 'result'>, filter: RunFilter): boolean {
  if (isSessionRun(g)) return false;
  if (g.result === 'skipped') return !filter.hideSkipped;
  return !(filter.hideNoAction && g.result === 'noop');
}
