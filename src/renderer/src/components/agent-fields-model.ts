/**
 * The agent fields every editor shows (Project, Helper, New Task with Agent, and
 * the task editor's Agent tab): one name per field, in one order, in the same
 * rows. AgentFields (RemoteFields.tsx) draws them from this.
 */

export type AgentField = 'name' | 'cwd' | 'environment' | 'harness' | 'model' | 'effort' | 'mode' | 'permission';

/** The label of each field, in every editor. */
export const AGENT_LABELS: Record<AgentField, string> = {
  name: 'Name',
  cwd: 'Working directory',
  environment: 'Environment',
  harness: 'Harness',
  model: 'Model',
  effort: 'Effort',
  mode: 'Session type',
  permission: 'Permission mode',
};

/** What an editor has of the agent fields. */
export interface AgentFieldsShown {
  name: boolean;
  /** The harness is one the app knows (Claude Code, Codex): it has models and efforts. */
  models: boolean;
  mode: boolean;
  permission: boolean;
}

/**
 * The rows, top to bottom, each with the fields side by side: Name, Working
 * directory, Environment | Harness, Model | Effort, Session type | Permission
 * mode. A field an editor doesn't have leaves its place, and a row left empty goes.
 */
export function agentRows(shown: AgentFieldsShown): AgentField[][] {
  const rows: AgentField[][] = [
    shown.name ? ['name'] : [],
    ['cwd'],
    ['environment', 'harness'],
    shown.models ? ['model', 'effort'] : [],
    [...(shown.mode ? (['mode'] as const) : []), ...(shown.permission ? (['permission'] as const) : [])],
  ];
  return rows.filter((r) => r.length > 0);
}
