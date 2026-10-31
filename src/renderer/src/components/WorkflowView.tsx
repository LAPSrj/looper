import { formatTokens } from '@shared/chat';
import { formatDuration } from '@shared/duration';
import {
  WORKFLOW_STATUS_TEXT,
  elapsedMs,
  tabStatus,
  workflowAgents,
  workflowCounts,
  workflowPhaseStatus,
  type WorkflowAgent,
  type WorkflowRun,
} from '@shared/workflows';
import { Group, Row } from './phone/PhoneList';

/** A state as a tab's dot: pulsing while it runs, red when it failed (a subagent's tab, a workflow's, a workflow agent's). */
export function StatusMark({ status }: { status: 'running' | 'done' | 'failed' }) {
  return (
    <svg className={`session-icon ${status === 'running' ? 'working' : status === 'failed' ? 'failed' : 'ended'}`} width="14" height="14" viewBox="0 0 18 18" aria-hidden="true">
      <circle cx="9" cy="9" r="7" className="ring" fill="none" strokeWidth="2" />
      <circle cx="9" cy="9" r="3" className="core" />
    </svg>
  );
}

const elapsedText = (item: { startedAt?: number; endedAt?: number }, now: number): string | undefined => {
  const ms = elapsedMs(item, now);
  return ms === undefined ? undefined : formatDuration(ms);
};

/** "Running · 4 of 9 agents done · 12m3s". */
function runLine(run: WorkflowRun, now: number): string {
  const c = workflowCounts(run);
  const parts = [WORKFLOW_STATUS_TEXT[run.status], `${c.done} of ${c.total} agents done`];
  if (c.failed) parts.push(`${c.failed} failed`);
  const t = elapsedText(run, now);
  if (t) parts.push(t);
  return parts.join(' · ');
}

const agentModel = (a: WorkflowAgent): string | undefined => a.modelId ?? a.model;

/** Its first line, for a short place; a result that is indented JSON (its first line a lone "{" or "["), all of it on one line. */
const firstLine = (text: string): string => {
  const line = text.split('\n').find((l) => l.trim())?.trim() ?? '';
  return line === '{' || line === '[' ? text.replace(/\s+/g, ' ').trim() : line;
};

/**
 * The workflow's own tabs, inside its tab beside the conversation's:
 * Overview, then one per agent in the order its phases list them.
 */
export function WorkflowTabs({ run, agentId, onAgent }: { run: WorkflowRun; agentId: string | null; onAgent: (id: string | null) => void }) {
  return (
    <div className="subagent-tabs workflow-tabs" role="tablist" aria-label={run.name}>
      <button role="tab" aria-selected={!agentId} className={`subagent-tab${agentId ? '' : ' active'}`} onClick={() => onAgent(null)}>
        Overview
      </button>
      {workflowAgents(run).map((a) => (
        <button
          key={a.agentId}
          role="tab"
          aria-selected={agentId === a.agentId}
          className={`subagent-tab${agentId === a.agentId ? ' active' : ''}`}
          title={a.phase ? `${a.label} (${a.phase})` : a.label}
          onClick={() => onAgent(a.agentId)}
        >
          <StatusMark status={tabStatus(a.status)} />
          <span className="subagent-tab-label">{a.label}</span>
        </button>
      ))}
    </div>
  );
}

/** Right-click on an agent: the subagent menu (Open Subagent Conversation). */
const agentMenu = (taskId: string, sessionId: string, a: WorkflowAgent) => window.looper.showMessageContextMenu({ taskId, runId: sessionId, agentId: a.agentId, label: a.label });

/**
 * A workflow run's Overview tab: its phases in order with their agents (what
 * each does, its state, model and time, its latest tool call while it runs,
 * its result or error once it ends), then the script's log and what it
 * returned, which Claude Code writes when the run ends.
 */
export function WorkflowOverview({
  run,
  now,
  taskId,
  sessionId,
  onAgent,
}: {
  run: WorkflowRun;
  now: number;
  taskId: string;
  sessionId: string;
  onAgent: (id: string) => void;
}) {
  return (
    <div className="workflow-overview">
      <div className="workflow-head">
        <span className="workflow-name">{run.name}</span>
        <span className={run.status === 'failed' ? 'error-text' : 'muted'}>{runLine(run, now)}</span>
      </div>
      {run.description && <div className="muted workflow-description">{run.description}</div>}
      {run.error && <div className="error-text workflow-error">{run.error}</div>}
      {run.phases.map((p) => {
        const state = workflowPhaseStatus(p);
        return (
          <section key={p.title || '-'} className="workflow-phase">
            <div className="pane-title workflow-phase-title">
              <span>{p.title || 'Other agents'}</span>
              <span className={state === 'failed' ? 'error-text' : 'muted'}>{WORKFLOW_STATUS_TEXT[state]}</span>
            </div>
            {p.detail && <div className="muted workflow-phase-detail">{p.detail}</div>}
            <div className="subagent-list">
              {p.agents.map((a) => (
                <div
                  key={a.agentId}
                  className="subagent-item"
                  onClick={() => onAgent(a.agentId)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    agentMenu(taskId, sessionId, a);
                  }}
                >
                  <div className="subagent-head">
                    <span className="subagent-desc">{a.label}</span>
                    <span className={a.status === 'failed' ? 'error-text' : 'muted'}>{WORKFLOW_STATUS_TEXT[a.status]}</span>
                  </div>
                  <dl className="subagent-facts">
                    <dt>Model</dt>
                    <dd className="mono">{agentModel(a) ?? 'Not known yet'}</dd>
                    <dt>Time</dt>
                    <dd>{elapsedText(a, now) ?? 'Not known yet'}</dd>
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
                        <dd className="workflow-result-line">{firstLine(a.result)}</dd>
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
          <pre className="mono workflow-log">{run.result}</pre>
        </section>
      )}
    </div>
  );
}

/**
 * The phone's workflow page, pushed from the conversation's workflow tab: the
 * run's line, a list section per phase with a row per agent (a tap pushes the
 * agent's conversation), then the log and result once it ended.
 */
export function PhoneWorkflow({
  run,
  now,
  taskId,
  sessionId,
  onAgent,
}: {
  run: WorkflowRun;
  now: number;
  taskId: string;
  sessionId: string;
  onAgent: (id: string) => void;
}) {
  return (
    <div className="pg-scroll">
      <Group footer={run.error ?? run.description}>
        <Row title={run.name} sub={runLine(run, now)} tone={run.status === 'failed' ? 'error' : undefined} />
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
                  : (a.error ?? (a.result ? firstLine(a.result) : agentModel(a)))
              }
              value={elapsedText(a, now)}
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
      {run.result !== undefined && (
        <Group title="Result">
          <pre className="mono workflow-log">{run.result}</pre>
        </Group>
      )}
    </div>
  );
}
