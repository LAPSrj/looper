import type { SubagentInfo } from '@shared/sessions';
import { ContextRing } from './ContextRing';
import type { TabItem } from './Tabs';
import { subagentContext } from './subagents';

const STATE: Record<SubagentInfo['status'], string> = { running: 'working', done: 'done', failed: 'failed' };

/**
 * A subagent's tab icon, drawn like a session's in the list: the ring fills
 * with its context, the dot says whether it works, is done or failed. It's
 * hidden from assistive technology: the tab names the state in words.
 */
export function SubagentIcon({ a }: { a: SubagentInfo }) {
  return (
    <svg className={`session-icon ${STATE[a.status]}`} width="16" height="16" viewBox="0 0 18 18" aria-hidden="true">
      <ContextRing frac={subagentContext(a)} />
      <circle cx="9" cy="9" r="3" className="core" />
    </svg>
  );
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
