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
 * What a conversation has running beside it, as its bar's subtitle: "2 subagents
 * running", "1 subagent and 1 workflow running"; null when nothing is.
 */
export function runningText(subagents: RunState[], workflows: RunState[]): string | null {
  const count = (statuses: RunState[], noun: string) => {
    const n = statuses.filter((s) => s === 'running').length;
    return n ? `${n} ${noun}${n === 1 ? '' : 's'}` : null;
  };
  const parts = [count(subagents, 'subagent'), count(workflows, 'workflow')].filter(Boolean);
  return parts.length ? `${parts.join(' and ')} running` : null;
}
