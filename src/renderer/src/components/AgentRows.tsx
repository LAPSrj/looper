import { formatTokens } from '@shared/chat';
import { WORKFLOW_STATUS_TEXT, tabStatus, type WorkflowAgent, type WorkflowAgentStatus } from '@shared/workflows';
import { RowList } from './DataTable';
import { Elapsed } from './Live';
import { PropertyList, type Property } from './PropertyList';
import { StatusMark } from './StatusMark';
import { resultSummary } from './workflow-summary';

/** "12k tokens". */
export const tokensText = (n: number): string => `${formatTokens(n)} tokens`;

/** A subagent's or workflow agent's row: what it does and its state (`mark`: with the state's dot before), then its facts. */
export function AgentRow({ label, status, mark = false, facts }: { label: string; status: WorkflowAgentStatus; mark?: boolean; facts?: (Property | false | null | undefined)[] }) {
  return (
    <>
      <div className="subagent-head">
        {mark && <StatusMark status={tabStatus(status)} />}
        <span className="subagent-desc">{label}</span>
        <span className={status === 'failed' ? 'error-text' : 'muted'}>{WORKFLOW_STATUS_TEXT[status]}</span>
      </div>
      {facts && <PropertyList className="subagent-facts" items={facts} />}
    </>
  );
}

const agentModel = (a: WorkflowAgent): string | undefined => a.modelId ?? a.model;
const lastTool = (a: WorkflowAgent) => a.lastTool && `${a.lastTool.name}${a.lastTool.preview ? `: ${a.lastTool.preview}` : ''}`;
/** How long the agent ran, or has run; nothing before it started. */
const elapsedNode = (a: WorkflowAgent) => (a.startedAt === undefined ? undefined : <Elapsed since={a.startedAt} until={a.endedAt} />);

/**
 * A workflow's agents as a list, one opening its conversation; a right-click shows the subagent menu.
 * `detailed`: each row with its model, time, latest tool call, tokens and result (the workflow's Overview).
 */
export function WorkflowAgentList({
  agents,
  label,
  idPrefix,
  listClass,
  selected,
  onSelect,
  onOpen,
  taskId,
  sessionId,
  detailed = false,
}: {
  agents: WorkflowAgent[];
  label: string;
  idPrefix: string;
  listClass: string;
  selected: string | null;
  onSelect: (agentId: string) => void;
  onOpen: (agentId: string) => void;
  taskId: string;
  sessionId: string;
  detailed?: boolean;
}) {
  return (
    <RowList
      bare
      rows={agents}
      rowKey={(a) => a.agentId}
      idPrefix={idPrefix}
      label={label}
      listClass={listClass}
      rowClass="subagent-item"
      selected={selected}
      onSelect={(a) => onSelect(a.agentId)}
      onOpen={(a) => onOpen(a.agentId)}
      activateOnClick
      onMenu={(a) => window.looper.showMessageContextMenu({ taskId, runId: sessionId, agentId: a.agentId, label: a.label })}
      empty={null}
      row={(a) => (
        <AgentRow
          label={a.label}
          status={a.status}
          mark
          facts={
            detailed
              ? [
                  { label: 'Model', value: agentModel(a) ?? 'Not known yet', className: 'mono' },
                  { label: 'Time', value: elapsedNode(a) ?? 'Not known yet' },
                  a.status === 'running' && !!a.lastTool && { label: 'Now', value: lastTool(a), className: 'workflow-tool' },
                  a.contextTokens !== undefined && a.status === 'running' && { label: 'Context', value: tokensText(a.contextTokens) },
                  a.tokens !== undefined && { label: 'Used', value: `${tokensText(a.tokens)}${a.toolCalls !== undefined ? `, ${a.toolCalls} tool calls` : ''}` },
                  !!a.result && { label: 'Result', value: resultSummary(a.result), className: 'workflow-result-line' },
                  !!a.error && { label: 'Error', value: a.error, className: 'error-text' },
                ]
              : undefined
          }
        />
      )}
      phoneRow={(a) =>
        detailed
          ? {
              lead: <StatusMark status={tabStatus(a.status)} />,
              title: a.label,
              sub: a.status === 'running' ? (lastTool(a) ?? agentModel(a)) : (a.error ?? (a.result ? resultSummary(a.result) : agentModel(a))),
              value: elapsedNode(a),
              tone: a.status === 'failed' ? 'error' : undefined,
            }
          : {
              lead: <StatusMark status={tabStatus(a.status)} />,
              title: a.label,
              value: WORKFLOW_STATUS_TEXT[a.status],
              valueTone: a.status === 'failed' ? 'error' : undefined,
            }
      }
    />
  );
}
