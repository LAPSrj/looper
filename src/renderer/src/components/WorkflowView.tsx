import { useEffect, useState, type ReactNode } from 'react';
import { WORKFLOW_STATUS_TEXT, tabStatus, workflowCounts, workflowPhaseStatus, type WorkflowAgent, type WorkflowRun } from '@shared/workflows';
import { isPhone } from '../web/page-nav';
import { WorkflowAgentList } from './AgentRows';
import { Icon } from './Icon';
import { ICONS } from './icons';
import { Elapsed } from './Live';
import { MessageBody } from './Markdown';
import { Group, Row } from './phone/PhoneList';
import { Section } from './Section';
import { StatusMark } from './StatusMark';
import { ParamTable } from './ToolContent';
import { resultParts } from './workflow-summary';

/** How long the run ran, or has run; nothing before it started. */
const elapsedNode = (run: WorkflowRun) => (run.startedAt === undefined ? undefined : <Elapsed since={run.startedAt} until={run.endedAt} />);

/** "4 of 9 agents done · 1 failed". */
function countsLine(run: WorkflowRun): string {
  const c = workflowCounts(run);
  return `${c.done} of ${c.total} agents done${c.failed ? ` · ${c.failed} failed` : ''}`;
}

/** "Running · 4 of 9 agents done · 12m3s". */
function RunLine({ run }: { run: WorkflowRun }) {
  return (
    <>
      {WORKFLOW_STATUS_TEXT[run.status]} · {countsLine(run)}
      {run.startedAt !== undefined && <> · {elapsedNode(run)}</>}
    </>
  );
}

const isTextField = (el: EventTarget | null): boolean => el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

/**
 * The bar above an agent's conversation inside a workflow's tab: "‹ Overview"
 * goes back to the run's Overview (so does Alt+Left, and Backspace outside a
 * text field), and the agent's name and state follow.
 */
function WorkflowAgentBack({ run, agent, onBack }: { run: WorkflowRun; agent: WorkflowAgent | null; onBack: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const back = (e.key === 'ArrowLeft' && e.altKey && !e.ctrlKey && !e.metaKey) || (e.key === 'Backspace' && !e.altKey && !e.ctrlKey && !e.metaKey && !isTextField(e.target));
      if (!back) return;
      e.preventDefault();
      onBack();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onBack]);
  if (!agent) return null;
  return (
    <div className="workflow-back">
      <button type="button" className="workflow-back-button" title={`Back to the ${run.name} Overview (Alt+Left)`} onClick={onBack}>
        <Icon size={10} bold>
          {ICONS.previous}
        </Icon>
        Overview
      </button>
      <span className="workflow-back-agent">
        <StatusMark status={tabStatus(agent.status)} />
        <span className="workflow-back-label">{agent.label}</span>
        <span className="sr-only">, {WORKFLOW_STATUS_TEXT[agent.status].toLowerCase()}</span>
      </span>
    </div>
  );
}

/**
 * A workflow run: its Overview, or the open agent's conversation (`agentView`). The desktop shows the
 * conversation under a bar back to the Overview; a phone shows it as a page of its own, and the Overview as a list.
 */
export function WorkflowView({
  run,
  agent,
  agentView,
  taskId,
  sessionId,
  onAgent,
}: {
  run: WorkflowRun;
  agent: WorkflowAgent | null;
  agentView: ReactNode;
  taskId: string;
  sessionId: string;
  /** Open an agent's conversation; null goes back to the Overview. */
  onAgent: (id: string | null) => void;
}) {
  const props = { run, taskId, sessionId, onAgent };
  if (isPhone) return <>{agentView || <WorkflowOverview {...props} />}</>;
  return (
    <div className="workflow-view">
      {agentView ? (
        <>
          <WorkflowAgentBack run={run} agent={agent} onBack={() => onAgent(null)} />
          {agentView}
        </>
      ) : (
        <WorkflowOverview {...props} />
      )}
    </div>
  );
}

/** What a run returned: its summary as Markdown, its other fields in a table, the raw JSON on demand. */
function ResultSection({ text }: { text: string }) {
  const parts = resultParts(text);
  if (parts.kind === 'text') return <pre className="mono workflow-log">{text}</pre>;
  return (
    <div className="workflow-result">
      {parts.main && <MessageBody text={parts.main.text} />}
      <ParamTable entries={parts.rest} />
      <details className="workflow-json">
        <summary>Show JSON</summary>
        <pre className="mono workflow-log">{text}</pre>
      </details>
    </div>
  );
}

/**
 * A workflow run's Overview tab: its phases in order with their agents (what
 * each does, its state, model and time, its latest tool call while it runs,
 * its result or error once it ends), then the script's log and what it
 * returned, which Claude Code writes when the run ends. The agents are its
 * navigator: one opens its conversation.
 */
function WorkflowOverview({
  run,
  taskId,
  sessionId,
  onAgent,
}: {
  run: WorkflowRun;
  taskId: string;
  sessionId: string;
  onAgent: (id: string) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <div className={isPhone ? 'pg-scroll' : 'workflow-overview'}>
      {isPhone ? (
        <Section detail={run.error ?? run.description}>
          <Row title={WORKFLOW_STATUS_TEXT[run.status]} sub={countsLine(run)} value={elapsedNode(run)} tone={run.status === 'failed' ? 'error' : undefined} />
        </Section>
      ) : (
        <>
          <div className="workflow-head">
            <span className="workflow-name">{run.name}</span>
            <span className={run.status === 'failed' ? 'error-text' : 'muted'}>
              <RunLine run={run} />
            </span>
          </div>
          {run.description && <div className="muted workflow-description">{run.description}</div>}
          {run.error && <div className="error-text workflow-error">{run.error}</div>}
        </>
      )}
      {run.phases.map((p) => {
        const state = workflowPhaseStatus(p);
        return (
          <Section
            key={p.title || '-'}
            className="workflow-phase workflow-agents"
            title={p.title || 'Other agents'}
            state={{ text: WORKFLOW_STATUS_TEXT[state], error: state === 'failed' }}
            detail={p.detail}
            empty={p.agents.length === 0 && 'No agents yet.'}
          >
            <WorkflowAgentList
              agents={p.agents}
              label={p.title || 'Other agents'}
              idPrefix="workflow-overview-agent"
              listClass="subagent-list pane-rows"
              selected={selected}
              onSelect={setSelected}
              onOpen={onAgent}
              taskId={taskId}
              sessionId={sessionId}
              detailed
            />
          </Section>
        );
      })}
      {run.logs.length > 0 && (
        <Section className="workflow-phase" title="Log">
          <pre className="mono workflow-log">{run.logs.join('\n')}</pre>
        </Section>
      )}
      {run.result !== undefined &&
        (isPhone ? (
          <PhoneResult text={run.result} />
        ) : (
          <Section className="workflow-phase" title="Result">
            <ResultSection text={run.result} />
          </Section>
        ))}
    </div>
  );
}

/** The phone's Result: each string field as a labelled text block, the others in a table, the raw JSON behind a disclosure. */
function PhoneResult({ text }: { text: string }) {
  const parts = resultParts(text);
  if (parts.kind === 'text') {
    return (
      <Group title="Result">
        <pre className="mono workflow-log">{text}</pre>
      </Group>
    );
  }
  const strings = parts.rest.filter(([, v]) => typeof v === 'string' && v.trim());
  const others = parts.rest.filter(([, v]) => !(typeof v === 'string' && v.trim()));
  return (
    <>
      {parts.main && (
        <Group title={parts.main.key}>
          <div className="workflow-text">
            <MessageBody text={parts.main.text} />
          </div>
        </Group>
      )}
      {strings.map(([k, v]) => (
        <Group key={k} title={k}>
          <div className="workflow-text">{v as string}</div>
        </Group>
      ))}
      {others.length > 0 && (
        <Group title={parts.main || strings.length ? 'Other fields' : 'Result'}>
          <ParamTable entries={others} />
        </Group>
      )}
      <Group>
        <details className="workflow-json">
          <summary>Show JSON</summary>
          <pre className="mono workflow-log">{text}</pre>
        </details>
      </Group>
    </>
  );
}
