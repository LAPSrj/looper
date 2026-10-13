import fs from 'node:fs';
import path from 'node:path';
import { resolveEffort, resolveEnvironment, resolveHarness } from '../../shared/environments';
import { AGENT_COMPLETE, AGENT_DONE, AGENT_RESTART, buildPrompt, expandFileTags, noteSection, type RunContext } from './common';
import { NOTICE_FILE } from '../guidance';
import { restartPrefix } from '../messages';
import {
  parseDoneText,
  RESTART_STATUS,
  startSession,
  type SessionCallbacks,
  type SessionEnd,
  type SessionEndReason,
  type SessionHandle,
} from './session';

// The generic session machinery lives in session.ts; this module is the agent
// step: its prompts, its looper-done contract, and the AgentEnd it reports.
export {
  CODEX_TRUST_PROMPT_RE,
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
  /**
   * Only for reason 'done': the status the agent gave looper-done (success
   * when it gave none), or 'restart' when it ran looper-restart instead.
   */
  doneStatus?: DoneStatus | typeof RESTART_STATUS;
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

/** Thousands of tokens, the way the context limit is set: "412k". */
function kTokens(n: number): string {
  return `${Math.round(n / 1000)}k`;
}

/** What Looper tells an agent whose context passed the task's limit. */
export function contextNotice(tokens: number, limit: number, again: boolean): string {
  return (
    `Looper notice: this conversation's context is at ${kTokens(tokens)} tokens${again ? ' and still growing' : ''}, past this task's limit of ${kTokens(limit)}. ` +
    `Restart with a clean context as soon as you can: finish the step you are on without starting a new one, then run \`${AGENT_RESTART} "<one-line reason>"\` and write a handoff as your final message. ` +
    "The next session gets the task's prompt and your handoff, nothing else, so the handoff must say what is done, what is left, and anything it needs to know (files, commands, decisions, open problems). " +
    `Looper then continues this run in a new session. If the whole job is finished instead, run ${AGENT_DONE.command} as usual.`
  );
}

/** The part of a restarted session's prompt that carries the earlier session's handoff. */
function handoffSection(restart: NonNullable<RunContext['restart']>, maxRestarts: number): string {
  return (
    '\n\n## Continuing after a context restart\n' +
    `An earlier session of this run worked on this task until its context grew past the task's limit, then restarted (restart ${restart.count} of at most ${maxRestarts}). ` +
    "It left the handoff below. Continue from it, and don't redo the work it reports as done.\n\n" +
    restart.handoff
  );
}

/** The full prompt the agent gets: the rendered template plus the run's one-off
 * note — or, for a continuation run, the user's guidance verbatim. A session
 * that continues the run after a context restart gets the task's prompt again,
 * the continuation's guidance if any, and the earlier session's handoff. */
export function agentPrompt(ctx: RunContext): string {
  if (ctx.restart) {
    const task = expandFileTags(buildPrompt(ctx.task.agent.prompt, ctx.vars) + noteSection(ctx.note), ctx);
    const guidance =
      ctx.promptOverride !== undefined ? '\n\n## Guidance the user sent for this run\n' + ctx.promptOverride : '';
    return task + guidance + handoffSection(ctx.restart, ctx.task.agent.maxRestarts);
  }
  if (ctx.promptOverride !== undefined) return ctx.promptOverride;
  return expandFileTags(buildPrompt(ctx.task.agent.prompt, ctx.vars) + noteSection(ctx.note), ctx);
}

/** The agent session's own run-dir files, renamed with restartPrefix() once a context restart ends it. */
const SESSION_FILES = [
  'session.json',
  'stop.json',
  'stop-reminded',
  'done',
  'codex-session.json',
  'prompt.txt',
  'system.txt',
  'settings.json',
];

/**
 * A context restart ended agent session `session` (numbered from 1): its
 * files get the session's prefix, so the next session starts with the plain
 * names (no done file, no reminder given) and the Messages view still finds
 * the earlier transcript. The codex home is copied, since the launcher writes
 * it again; a notice still waiting is dropped.
 */
export function endAgentSession(runDir: string, session: number): void {
  const prefix = restartPrefix(session);
  for (const name of SESSION_FILES) {
    try {
      fs.renameSync(path.join(runDir, name), path.join(runDir, prefix + name));
    } catch {
      /* this session never wrote it */
    }
  }
  try {
    fs.copyFileSync(path.join(runDir, 'codex-home'), path.join(runDir, prefix + 'codex-home'));
  } catch {
    /* not a codex session */
  }
  fs.rmSync(path.join(runDir, NOTICE_FILE), { force: true });
}

export async function startAgent(ctx: RunContext, cb: AgentCallbacks): Promise<AgentHandle> {
  const { task, settings } = ctx;
  const a = task.agent;
  const headless = a.mode === 'headless';
  const env = resolveEnvironment(task, settings);
  const harness = resolveHarness(task, env);
  const canComplete = task.completion.allowed;
  // The context limit needs a transcript to read: Claude Code and Codex only.
  // Once the run used up its restarts, the session gets neither the notice nor the helper.
  const limit =
    a.contextLimitK !== undefined &&
    (harness.kind === 'claude-code' || harness.kind === 'codex') &&
    (ctx.restart?.count ?? 0) < a.maxRestarts
      ? a.contextLimitK * 1000
      : undefined;
  // An earlier session of the run may have left the helper on the PATH.
  if (!limit) fs.rmSync(path.join(ctx.runDir, 'bin', ctx.target.doneHelperFile(AGENT_RESTART)), { force: true });
  return startSession(
    ctx,
    {
      step: 'agent',
      prefix: '',
      launcherName: 'run',
      harness,
      headless,
      model: a.model,
      effort: resolveEffort(a, harness),
      permissionMode: a.permissionMode,
      session: ctx.agentSession,
      extraArgs: a.extraArgs,
      footer: systemFooter(task.name, ctx.runId, headless, canComplete),
      prompt: agentPrompt(ctx),
      doneCommand: AGENT_DONE.command,
      doneStatuses: AGENT_DONE.statuses,
      completeCommand: canComplete ? AGENT_COMPLETE : undefined,
      restartCommand: limit ? AGENT_RESTART : undefined,
      context: limit ? { limit, notice: (tokens, again) => contextNotice(tokens, limit, again) } : undefined,
      continued: ctx.restart !== undefined,
      implicitDoneStatus: 'success',
      stopGate: true,
      guidance: true,
      // The max runtime covers the whole run, the sessions before a restart included.
      maxRuntimeMs: Math.max(1000, a.maxRuntimeMin * 60_000 - (ctx.restart?.elapsedMs ?? 0)),
      maxRuntimeText: `exceeded ${a.maxRuntimeMin} min`,
      idleGraceMs: a.idleGraceMin * 60_000,
      idleText: `idle for ${a.idleGraceMin} min without looper-done`,
      onIdleTimeout: a.onIdleTimeout,
    },
    cb,
  ) as Promise<AgentHandle>;
}
