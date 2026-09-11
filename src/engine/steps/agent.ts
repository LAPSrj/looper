import fs from 'node:fs';
import path from 'node:path';
import type { Note } from '../../shared/types';
import { resolveEnvironment, resolveHarness } from '../../shared/environments';
import { AGENT_COMPLETE, AGENT_DONE, buildPrompt, type RunContext } from './common';
import {
  parseDoneText,
  startSession,
  type SessionCallbacks,
  type SessionEnd,
  type SessionEndReason,
  type SessionHandle,
} from './session';

// The generic session machinery lives in session.ts; this module is the agent
// step: its prompts, its looper-done contract, and the AgentEnd it reports.
export {
  HEADLINE_MAX,
  TRUST_PROMPT_RE,
  USAGE_LIMIT_RE,
  WAITING_PROMPT_RE,
  headlineOf,
  parseUsageLimitReset,
} from './session';

export type AgentEndReason = SessionEndReason;

/** Outcome the agent reports via `looper-done <status>`. */
export type DoneStatus = 'success' | 'warning' | 'error';

/**
 * The done file as the helper writes it: the status on the first line, the
 * headline on the rest. A file without a status line (e.g. written by hand)
 * reads as success.
 */
export function parseDoneSignal(text: string): { status: DoneStatus; message: string } {
  const parsed = parseDoneText(text, AGENT_DONE.statuses);
  return { status: (parsed.status ?? 'success') as DoneStatus, message: parsed.message };
}

export interface AgentEnd extends SessionEnd {
  /** Only for reason 'done': the status the agent gave looper-done (success when it gave none). */
  doneStatus?: DoneStatus;
}

export type AgentHandle = Omit<SessionHandle, 'finished'> & { finished: Promise<AgentEnd> };

export type AgentCallbacks = SessionCallbacks;

/**
 * The reason the agent gave `looper-complete`, or null when it never called it.
 * Read once the agent step is over: the completion takes effect when the cycle
 * ends, so there is nothing to watch for live.
 */
export function readCompleteSignal(runDir: string): string | null {
  try {
    const text = fs.readFileSync(path.join(runDir, 'complete'), 'utf8').trim();
    return text || 'completed';
  } catch {
    return null;
  }
}

export function systemFooter(taskName: string, runId: string, headless: boolean, canComplete = false): string {
  const lines = [
    `You were started by Looper for the task "${taskName}" (run ${runId}). This is a one-shot, unattended session: nobody is typing at the other end unless they choose to intervene.`,
    'Do the work described in the prompt without asking for confirmation. Make reasonable decisions yourself.',
    'When you are finished, or if there is nothing to do, run the shell command:',
    '    looper-done <status> "<headline>"',
    'The status is success, warning or error. success: everything was fully done. warning: the job was fully done, but the user should read your report. error: you could not complete the job (blocked, failed, gave up) — say why in your report.',
    'The headline is one short phrase stating the outcome, e.g. "Fixed 3 flaky tests" or "Nothing to do". State the outcome, not that you are done (no "Done:", "Completed:", etc.).',
    "Then write your final message: a detailed report of what you did, what you found and what is left open, in Markdown. Looper records it as the run's summary.",
  ];
  if (canComplete) {
    lines.push(
      `If this task is finished for good — future runs would have nothing left to do — run \`${AGENT_COMPLETE} "<why>"\` before ${AGENT_DONE.command}. Looper then stops scheduling the task. Leave it alone if the job is merely done for now.`,
    );
  }
  if (!headless) {
    lines.push('Looper closes this session when that message ends. Do not run anything after looper-done and do not wait for further input.');
  }
  return lines.join('\n');
}

/** The full prompt the agent gets: the rendered template plus the run's one-off note. */
export function agentPrompt(ctx: RunContext): string {
  return buildPrompt(ctx.task.agent.prompt, ctx.vars) + noteSection(ctx.task.note);
}

/** The task's one-off guidance, appended after everything else so it wins. */
export function noteSection(note: Note | undefined): string {
  if (!note) return '';
  return (
    '\n\n## One-off guidance for this run\n' +
    'The user attached this note to this specific run. It applies to this run only and overrides any conflicting instruction above.\n\n' +
    note.text
  );
}

export async function startAgent(ctx: RunContext, cb: AgentCallbacks): Promise<AgentHandle> {
  const { task, settings } = ctx;
  const a = task.agent;
  const headless = a.mode === 'headless';
  const env = resolveEnvironment(task, settings);
  const harness = resolveHarness(task, env);
  const canComplete = task.completion.allowed;
  return startSession(
    ctx,
    {
      step: 'agent',
      prefix: '',
      launcherName: 'run',
      harness,
      headless,
      model: a.model,
      permissionMode: a.permissionMode,
      session: ctx.agentSession,
      extraArgs: a.extraArgs,
      footer: systemFooter(task.name, ctx.runId, headless, canComplete),
      prompt: agentPrompt(ctx),
      doneCommand: AGENT_DONE.command,
      doneStatuses: AGENT_DONE.statuses,
      completeCommand: canComplete ? AGENT_COMPLETE : undefined,
      implicitDoneStatus: 'success',
      stopGate: true,
      maxRuntimeMs: a.maxRuntimeMin * 60_000,
      maxRuntimeText: `exceeded ${a.maxRuntimeMin} min`,
      idleGraceMs: a.idleGraceMin * 60_000,
      idleText: `idle for ${a.idleGraceMin} min without looper-done`,
      onIdleTimeout: a.onIdleTimeout,
    },
    cb,
  ) as Promise<AgentHandle>;
}
