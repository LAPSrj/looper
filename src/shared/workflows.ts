/**
 * A Claude Code workflow run (the Workflow tool): a script that starts many
 * subagents, grouped into phases, as the engine reads it from the run's files
 * (see src/engine/workflows.ts).
 */

/** How a run is doing: running until its final state says otherwise (killed runs are stopped). */
export type WorkflowStatus = 'running' | 'completed' | 'failed' | 'stopped';

/** An agent the run started: running until the journal records its result or failure; stopped when the run ended first. */
export type WorkflowAgentStatus = 'running' | 'done' | 'failed' | 'stopped';

export interface WorkflowAgent {
  agentId: string;
  /** The label the script gave it (agent opts.label). */
  label: string;
  /** Its phase's title, when it has one. */
  phase?: string;
  /** The model the script asked for ("opus"), when it named one. */
  model?: string;
  /** From its transcript's newest response: the model id it runs on, its effort, and its context in tokens. */
  modelId?: string;
  effort?: string;
  contextTokens?: number;
  status: WorkflowAgentStatus;
  /** When it started and, once it isn't running, when it ended (ms since the epoch). */
  startedAt?: number;
  endedAt?: number;
  /** Its latest tool call: the tool and one line of what it does. */
  lastTool?: { name: string; preview: string };
  /** From the run's final state: its tool calls and the tokens it used. */
  toolCalls?: number;
  tokens?: number;
  /** What it returned, as one capped text (a schema result is JSON). */
  result?: string;
  /** Why it failed: the error its transcript ended with. */
  error?: string;
}

export interface WorkflowPhase {
  /** The phase's title; '' holds the agents that have none. */
  title: string;
  detail?: string;
  agents: WorkflowAgent[];
}

export interface WorkflowRun {
  /** "wf_…": the run's id, which names its transcript folder. */
  runId: string;
  /** The Workflow tool's background task id, when the parent transcript names it. */
  taskId?: string;
  /** The script's meta.name; the run id when it can't be read. */
  name: string;
  description?: string;
  status: WorkflowStatus;
  startedAt?: number;
  endedAt?: number;
  /** The script's phases in order (those that haven't started have no agents), then any other phase an agent named. */
  phases: WorkflowPhase[];
  /** The script's log() lines. Claude Code writes them with the final state, so a running run has none yet. */
  logs: string[];
  /** What the script returned, as one capped text. */
  result?: string;
  error?: string;
}

/** A phase's state: waiting before any agent started in it, running while one runs, else failed if one failed. */
export function workflowPhaseStatus(p: WorkflowPhase): 'waiting' | WorkflowAgentStatus {
  if (p.agents.length === 0) return 'waiting';
  if (p.agents.some((a) => a.status === 'running')) return 'running';
  if (p.agents.some((a) => a.status === 'failed')) return 'failed';
  if (p.agents.some((a) => a.status === 'stopped')) return 'stopped';
  return 'done';
}

/** How many of a run's agents are in each state. */
export function workflowCounts(run: WorkflowRun): { total: number; running: number; done: number; failed: number; stopped: number } {
  const out = { total: 0, running: 0, done: 0, failed: 0, stopped: 0 };
  for (const p of run.phases) {
    for (const a of p.agents) {
      out.total += 1;
      out[a.status] += 1;
    }
  }
  return out;
}

/** The words the UI shows for a run's, phase's or agent's state. */
export const WORKFLOW_STATUS_TEXT: Record<WorkflowStatus | WorkflowAgentStatus | 'waiting', string> = {
  running: 'Running',
  completed: 'Completed',
  done: 'Done',
  failed: 'Failed',
  stopped: 'Stopped',
  waiting: 'Not started',
};

/**
 * A run's or agent's state as a tab's dot shows a subagent's: running, failed,
 * or ended (completed, done and stopped alike; a stopped one didn't fail).
 */
export function tabStatus(status: WorkflowStatus | WorkflowAgentStatus): 'running' | 'done' | 'failed' {
  return status === 'running' ? 'running' : status === 'failed' ? 'failed' : 'done';
}

/** A run's agents in the order its phases list them (its tabs' order). */
export function workflowAgents(run: WorkflowRun): WorkflowAgent[] {
  return run.phases.flatMap((p) => p.agents);
}

/** What a session's workflow view shows: the run and, when one is open, its agent; null when the run is gone. */
export function openWorkflow(
  runs: WorkflowRun[],
  open: { runId: string; agentId: string | null } | null,
): { run: WorkflowRun; agent: WorkflowAgent | null } | null {
  const run = open ? runs.find((r) => r.runId === open.runId) : undefined;
  if (!run) return null;
  return { run, agent: open?.agentId ? (workflowAgents(run).find((a) => a.agentId === open.agentId) ?? null) : null };
}

/** How long something ran, or has been running at `now`; undefined before it started. */
export function elapsedMs(item: { startedAt?: number; endedAt?: number }, now: number): number | undefined {
  if (item.startedAt === undefined) return undefined;
  return Math.max(0, (item.endedAt ?? now) - item.startedAt);
}
