// Relative imports and no DOM types: the unit tests (node tsconfig) load this file.
import type { SubagentInfo } from '../../../shared/sessions';
import { contextFraction } from './usage';

/** The subagents by when their Agent call was made, newest first; one the conversation doesn't show yet has just started, so it comes first. */
export function newestFirst(subagents: SubagentInfo[]): SubagentInfo[] {
  const at = (a: SubagentInfo) => (a.startedAt ? Date.parse(a.startedAt) || 0 : Infinity);
  return subagents
    .map((a, i) => ({ a, i }))
    .sort((x, y) => at(y.a) - at(x.a) || y.i - x.i)
    .map((x) => x.a);
}

/** How full a subagent's context is (0..1), for its icon's ring; null until both its context and its model's window are known. */
export const subagentContext = (a: SubagentInfo): number | null =>
  a.contextTokens === undefined ? null : contextFraction({ tokens: a.contextTokens, window: a.contextWindow });

/**
 * The subagents that have a tab: the running ones, and the one open now
 * (finished or not), running first. A finished subagent not open stays in the
 * Activity pane's Subagents list.
 */
export function subagentTabs(subagents: SubagentInfo[], follow: string | null): SubagentInfo[] {
  const shown = subagents.filter((a) => a.status === 'running' || a.agentId === follow);
  return [...shown.filter((a) => a.status === 'running'), ...shown.filter((a) => a.status !== 'running')];
}

/** A count and the state of a group of subagents or workflow runs, as plain text: "3 · 1 running". */
export function groupStatusText(statuses: ('running' | 'done' | 'failed')[]): string {
  const running = statuses.filter((s) => s === 'running').length;
  if (running) return `${statuses.length} · ${running} running`;
  const failed = statuses.filter((s) => s === 'failed').length;
  return failed ? `${statuses.length} · ${failed} failed` : `${statuses.length} · done`;
}
