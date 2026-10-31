import { useEffect, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { formatTokens } from '@shared/chat';
import { formatDuration } from '@shared/duration';
import {
  WORKFLOW_STATUS_TEXT,
  elapsedMs,
  tabStatus,
  workflowCounts,
  workflowPhaseStatus,
  type WorkflowAgent,
  type WorkflowRun,
} from '@shared/workflows';
import { tickFor, useNow } from '../useNow';
import { MessageBody } from './Markdown';
import { Group, Row } from './phone/PhoneList';
import { StatusMark } from './StatusMark';
import { ParamTable } from './ToolContent';
import { resultParts, resultSummary } from './workflow-summary';

type Timed = { startedAt?: number; endedAt?: number };

const elapsedText = (item: Timed, now: number): string | undefined => {
  const ms = elapsedMs(item, now);
  return ms === undefined ? undefined : formatDuration(ms);
};

/** A time that runs while the item does: it ticks each second below an hour, then each minute, and stops when the item ends. */
function useElapsed(item: Timed): string | undefined {
  const running = item.startedAt !== undefined && item.endedAt === undefined;
  const now = useNow(running ? tickFor(Date.now() - item.startedAt!) : null);
  return elapsedText(item, now);
}

/** An item's time, or `fallback` before it has started. */
function ElapsedText({ item, fallback }: { item: Timed; fallback?: string }) {
  const text = useElapsed(item);
  return <>{text ?? fallback}</>;
}

const elapsedNode = (item: Timed) => (item.startedAt === undefined ? undefined : <ElapsedText item={item} />);

/** "4 of 9 agents done · 1 failed". */
function countsLine(run: WorkflowRun): string {
  const c = workflowCounts(run);
  return `${c.done} of ${c.total} agents done${c.failed ? ` · ${c.failed} failed` : ''}`;
}

/** "Running · 4 of 9 agents done · 12m3s". */
function RunLine({ run }: { run: WorkflowRun }) {
  const parts = [WORKFLOW_STATUS_TEXT[run.status], countsLine(run)];
  const t = useElapsed(run);
  if (t) parts.push(t);
  return <>{parts.join(' · ')}</>;
}

const agentModel = (a: WorkflowAgent): string | undefined => a.modelId ?? a.model;

const isTextField = (el: EventTarget | null): boolean => el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

/**
 * The bar above an agent's conversation inside a workflow's tab: "‹ Overview"
 * goes back to the run's Overview (so does Alt+Left, and Backspace outside a
 * text field), and the agent's name and state follow.
 */
export function WorkflowAgentBack({ run, agent, onBack }: { run: WorkflowRun; agent: WorkflowAgent | null; onBack: () => void }) {
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
        <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M10 3.5 5.5 8l4.5 4.5" />
        </svg>
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

/** Right-click on an agent: the subagent menu (Open Subagent Conversation). */
const agentMenu = (taskId: string, sessionId: string, a: WorkflowAgent) => window.looper.showMessageContextMenu({ taskId, runId: sessionId, agentId: a.agentId, label: a.label });

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
export function WorkflowOverview({
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
  const activate = (id: string) => (e: ReactKeyboardEvent) => {
    if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    onAgent(id);
  };
  return (
    <div className="workflow-overview">
      <div className="workflow-head">
        <span className="workflow-name">{run.name}</span>
        <span className={run.status === 'failed' ? 'error-text' : 'muted'}><RunLine run={run} /></span>
      </div>
      {run.description && <div className="muted workflow-description">{run.description}</div>}
      {run.error && <div className="error-text workflow-error">{run.error}</div>}
      {run.phases.map((p) => {
        const state = workflowPhaseStatus(p);
        return (
          <section key={p.title || '-'} className="workflow-phase">
            <div className="workflow-phase-title">
              <span>{p.title || 'Other agents'}</span>
              <span className={`workflow-phase-state ${state === 'failed' ? 'error-text' : 'muted'}`}>{WORKFLOW_STATUS_TEXT[state]}</span>
            </div>
            {p.detail && <div className="muted workflow-phase-detail">{p.detail}</div>}
            <div className="subagent-list">
              {p.agents.map((a) => (
                <div
                  key={a.agentId}
                  className="subagent-item"
                  role="button"
                  tabIndex={0}
                  onClick={() => onAgent(a.agentId)}
                  onKeyDown={activate(a.agentId)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    agentMenu(taskId, sessionId, a);
                  }}
                >
                  <div className="subagent-head">
                    <StatusMark status={tabStatus(a.status)} />
                    <span className="subagent-desc">{a.label}</span>
                    <span className={a.status === 'failed' ? 'error-text' : 'muted'}>{WORKFLOW_STATUS_TEXT[a.status]}</span>
                  </div>
                  <dl className="subagent-facts">
                    <dt>Model</dt>
                    <dd className="mono">{agentModel(a) ?? 'Not known yet'}</dd>
                    <dt>Time</dt>
                    <dd><ElapsedText item={a} fallback="Not known yet" /></dd>
                    {a.status === 'running' && a.lastTool && (
                      <>
                        <dt>Now</dt>
                        <dd className="workflow-tool">
                          {a.lastTool.name}
                          {a.lastTool.preview ? `: ${a.lastTool.preview}` : ''}
                        </dd>
                      </>
                    )}
                    {a.contextTokens !== undefined && a.status === 'running' && (
                      <>
                        <dt>Context</dt>
                        <dd>{formatTokens(a.contextTokens)} tokens</dd>
                      </>
                    )}
                    {a.tokens !== undefined && (
                      <>
                        <dt>Used</dt>
                        <dd>
                          {formatTokens(a.tokens)} tokens{a.toolCalls !== undefined ? `, ${a.toolCalls} tool calls` : ''}
                        </dd>
                      </>
                    )}
                    {a.result && (
                      <>
                        <dt>Result</dt>
                        <dd className="workflow-result-line">{resultSummary(a.result)}</dd>
                      </>
                    )}
                    {a.error && (
                      <>
                        <dt>Error</dt>
                        <dd className="error-text">{a.error}</dd>
                      </>
                    )}
                  </dl>
                </div>
              ))}
              {p.agents.length === 0 && <div className="muted workflow-none">No agents yet.</div>}
            </div>
          </section>
        );
      })}
      {run.logs.length > 0 && (
        <section className="workflow-phase">
          <div className="pane-title">Log</div>
          <pre className="mono workflow-log">{run.logs.join('\n')}</pre>
        </section>
      )}
      {run.result !== undefined && (
        <section className="workflow-phase">
          <div className="pane-title">Result</div>
          <ResultSection text={run.result} />
        </section>
      )}
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

/**
 * The phone's workflow page, pushed from the conversation's workflow tab: the
 * run's state, a list section per phase with a row per agent (a tap pushes the
 * agent's conversation), then the log and result once it ended.
 */
export function PhoneWorkflow({
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
  return (
    <div className="pg-scroll">
      <Group footer={run.error ?? run.description}>
        <Row title={WORKFLOW_STATUS_TEXT[run.status]} sub={countsLine(run)} value={elapsedNode(run)} tone={run.status === 'failed' ? 'error' : undefined} />
      </Group>
      {run.phases.map((p) => (
        <Group key={p.title || '-'} title={`${p.title || 'Other agents'} · ${WORKFLOW_STATUS_TEXT[workflowPhaseStatus(p)]}`} footer={p.detail}>
          {p.agents.map((a) => (
            <Row
              key={a.agentId}
              lead={<StatusMark status={tabStatus(a.status)} />}
              title={a.label}
              sub={
                a.status === 'running'
                  ? a.lastTool
                    ? `${a.lastTool.name}${a.lastTool.preview ? `: ${a.lastTool.preview}` : ''}`
                    : agentModel(a)
                  : (a.error ?? (a.result ? resultSummary(a.result) : agentModel(a)))
              }
              value={elapsedNode(a)}
              tone={a.status === 'failed' ? 'error' : undefined}
              chevron
              onOpen={() => onAgent(a.agentId)}
              onMenu={() => agentMenu(taskId, sessionId, a)}
            />
          ))}
          {p.agents.length === 0 && <Row title={<span className="pg-empty">Not started</span>} />}
        </Group>
      ))}
      {run.logs.length > 0 && (
        <Group title="Log">
          <pre className="mono workflow-log">{run.logs.join('\n')}</pre>
        </Group>
      )}
      {run.result !== undefined && <PhoneResult text={run.result} />}
    </div>
  );
}
