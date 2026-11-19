import type { SubagentInfo } from '@shared/sessions';
import { tabStatus, type WorkflowRun } from '@shared/workflows';
import { StatusRing } from './ContextRing';
import { Tabs, type TabItem } from './Tabs';
import { subagentContext } from './subagents';

const STATE: Record<SubagentInfo['status'], string> = { running: 'working', done: 'done', failed: 'failed' };

/** A subagent's tab icon, drawn like a session's in the list: the ring fills with its context, the dot says whether it works, is done or failed. */
export function SubagentIcon({ a }: { a: SubagentInfo }) {
  return <StatusRing state={STATE[a.status]} frac={subagentContext(a)} size={16} />;
}

/** The tab before the subagents' tabs: the conversation itself. */
export const CONVERSATION_TAB: TabItem = { id: 'conversation', label: 'Conversation', dividerAfter: true };

/** A subagent's tab beside its conversation (`agent:<id>`): its description, type, state and icon. */
export const subagentTab = (a: SubagentInfo): TabItem => ({
  id: `agent:${a.agentId}`,
  label: a.description || a.type,
  title: `${a.description || a.type} (${a.type})`,
  status: a.status,
  mark: <SubagentIcon a={a} />,
});

/** An interactive chat's tab after its conversation's: Claude Code's own terminal. */
const TERMINAL_TAB: TabItem = { id: 'terminal', label: 'Terminal', dividerAfter: true };

/**
 * The conversation's tabs: the conversation itself, an interactive chat's
 * terminal (`terminal`), a tab per subagent in `agents` (`agent:<id>`), then
 * one per workflow run (`run:<id>`). `closable`: the followed subagent's tab,
 * once it has finished, has a close button that goes back to the conversation.
 */
export function SubagentTabs({
  agents,
  follow,
  onFollow,
  closable = false,
  workflows = [],
  openRun = null,
  onWorkflow,
  terminal,
}: {
  agents: SubagentInfo[];
  follow: string | null;
  onFollow: (agentId: string | null) => void;
  closable?: boolean;
  workflows?: Pick<WorkflowRun, 'runId' | 'name' | 'status'>[];
  openRun?: string | null;
  onWorkflow?: (runId: string) => void;
  /** An interactive chat: whether its terminal shows, and how to show it. */
  terminal?: { open: boolean; onOpen: () => void };
}) {
  const active = openRun ? `run:${openRun}` : follow ? `agent:${follow}` : terminal?.open ? 'terminal' : 'conversation';
  const tabs: TabItem[] = [
    ...(terminal ? [{ ...CONVERSATION_TAB, dividerAfter: false }, TERMINAL_TAB] : [CONVERSATION_TAB]),
    ...agents.map((a) => ({ ...subagentTab(a), onClose: closable && follow === a.agentId && a.status !== 'running' ? () => onFollow(null) : undefined })),
    ...workflows.map((run) => ({ id: `run:${run.runId}`, label: run.name, title: `${run.name} (workflow)`, status: tabStatus(run.status) })),
  ];
  const select = (id: string) => {
    if (id === 'conversation') onFollow(null);
    else if (id === 'terminal') terminal?.onOpen();
    else if (id.startsWith('agent:')) onFollow(id.slice('agent:'.length));
    else onWorkflow?.(id.slice('run:'.length));
  };
  return <Tabs tabs={tabs} active={active} onSelect={select} label={terminal ? 'Conversation, terminal and agents' : 'Conversation and agents'} className="subagent-tabs" ctrlTab />;
}
