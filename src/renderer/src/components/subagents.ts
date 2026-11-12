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

type RunState = 'running' | 'done' | 'failed';

/**
 * What a conversation has running beside it, as its bar's subtitle, longest form first for the bar to show the
 * first that fits: ["1 subagent and 2 processes running", "1 subagent, 2 processes", "3 running"]; null when
 * nothing is. `processes`: its background commands still running.
 */
export function runningText(subagents: RunState[], workflows: RunState[], processes = 0): string[] | null {
  const running = (statuses: RunState[]) => statuses.filter((s) => s === 'running').length;
  const counts: [number, string, string][] = [
    [running(subagents), 'subagent', 'subagents'],
    [running(workflows), 'workflow', 'workflows'],
    [processes, 'process', 'processes'],
  ];
  const parts = counts.filter(([n]) => n > 0).map(([n, one, many]) => `${n} ${n === 1 ? one : many}`);
  if (!parts.length) return null;
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0];
  const total = counts.reduce((sum, [n]) => sum + n, 0);
  return [...new Set([`${list} running`, parts.join(', '), `${total} running`])];
}
