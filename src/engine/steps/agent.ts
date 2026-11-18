import fs from 'node:fs';
import path from 'node:path';
import { resolveEffort, resolveEnvironment, resolveHarness } from '../../shared/environments';
import type { Task } from '../../shared/types';
import { agentArgs } from '../../shared/projects';
import {
  AGENT_ASK,
  AGENT_COMPLETE,
  AGENT_DELEGATE,
  AGENT_DONE,
  AGENT_RESTART,
  buildPrompt,
  expandFileTags,
  noteSection,
  type RunContext,
} from './common';
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
  type SessionOpts,
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

export type AgentCallbacks = SessionCallbacks & {
  /** How Looper answers looper-delegate, for a task whose agent may start agents in other folders. */
  delegate?: Omit<NonNullable<SessionOpts['delegate']>, 'command'>;
};

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

type AskSettings = Task['agent']['ask'];

/** Minutes the way the editor shows them: "5 min", "1.5 min". */
function minutes(n: number): string {
  return `${Number(n.toFixed(2))} min`;
}

/** What the agent is told to do when nobody answers its question. */
const NO_ANSWER_INSTRUCTION = `continue the run without an answer: make the most reasonable decision yourself, and pick the status you give ${AGENT_DONE.command} from what is left open, as for any run. Say in your final report which question went unanswered and what you decided`;

/** Who answers an agent's `looper-ask`: the user, or the agent that started it (looper-delegate). */
type AskWho = 'user' | 'parent';

/** What `looper-ask` prints when the wait runs out. */
export function noAnswerText(ask: AskSettings, who: AskWho = 'user'): string {
  return `No answer from ${who === 'user' ? 'the user' : 'the agent that started you'} within ${minutes(ask.waitMin)}. Don't ask again; ${NO_ANSWER_INSTRUCTION}.`;
}

/** What the agent is told when nobody allowed or denied its tool call within the task's answer wait. */
export function permissionNoAnswerText(ask: AskSettings): string {
  return `Nobody answered this permission request within ${minutes(ask.waitMin)}, so it was denied. Don't try the same call again; find another way to do it, or say in your report what you needed.`;
}

/** The part on running looper-ask so the shell tool doesn't give up on it first. */
function askWait(ask: AskSettings, nobody: string): string {
  return `The command waits up to ${minutes(ask.waitMin)} for the answer and prints it. Run it so your shell tool doesn't time out first (in Claude Code, run it in the foreground: Looper gives that call the time it needs). If ${nobody} answers in time, it says so, and you ${NO_ANSWER_INSTRUCTION}.`;
}

/** The footer's part about asking the user: a last resort, with what makes a good question. */
function askSection(ask: AskSettings): string {
  return [
    `As a last resort, you can ask the user one question with the shell command:`,
    `    ${AGENT_ASK} "<question>"`,
    'Every question interrupts the user, so needing to ask means you failed to work it out yourself. Before asking, try every other way to settle it: read the code, docs, config and history, try another approach, and make the call yourself when it is a reasonable choice. That is also how you avoid ending the run with a warning or an error: settle the things that would otherwise be left for a person to decide.',
    "Ask only when the work can't go on correctly without the user: a decision only they can make, a credential, or access you don't have. Make the question one paragraph that stands on its own: what you need, why, what you tried, and the answer you suggest.",
    askWait(ask, 'nobody'),
  ].join('\n');
}

/** A delegated agent's part about asking: the question goes to the agent that started it. */
function askParentSection(ask: AskSettings): string {
  return [
    `When you can't go on correctly without a decision or information that the agent that started you has, ask it one question with the shell command:`,
    `    ${AGENT_ASK} "<question>"`,
    'Before asking, try every other way to settle it: read the code, docs, config and history, and make the call yourself when it is a reasonable choice. Make the question one paragraph that stands on its own: what you need, why, what you tried, and the answer you suggest.',
    askWait(ask, 'no answer'),
  ].join('\n');
}

/** The footer's part about looper-delegate, for an agent whose task lets it start agents in other folders. */
export function delegateSection(): string {
  return [
    'You can hand work in another folder to an agent of its own, which runs in that folder with its own settings, instructions and tools. Write a brief to a file first: it is the whole prompt that agent gets, so it must stand on its own. Then run the shell command:',
    `    ${AGENT_DELEGATE} start <folder> --title "<short title>" --brief-file <file> [--model <model>] [--effort <effort>]`,
    "It prints the agent's id and returns at once, so you can start several. An agent whose folder has another session working in it waits to start until that session is done.",
    `When an agent ends, however it ends, its status, headline, final report, transcript and run folder reach you in a message that starts with "Looper messages from the agents you started". A question an agent asks reaches you the same way: answer it with ${AGENT_DELEGATE} tell. The other commands:`,
    `    ${AGENT_DELEGATE} list                 the agents you started and their state`,
    `    ${AGENT_DELEGATE} tell <id> "<text>"   send an agent new instructions (a change to what you asked), or the answer to its question`,
    `    ${AGENT_DELEGATE} stop <id>            stop an agent`,
    `While an agent you started is running or waiting to start, ${AGENT_DONE.command} refuses. When you have nothing else to do until a result arrives, end your turn: Looper keeps the session open and starts your next turn with the result. Check each result yourself before you rely on it.`,
  ].join('\n');
}

/** Who started a delegated agent's run: its parent's task, run and the title it gave the agent. */
export type DelegatedBy = NonNullable<RunContext['delegatedBy']>;

export function systemFooter(
  taskName: string,
  runId: string,
  headless: boolean,
  canComplete = false,
  ask?: AskSettings,
  more: { delegate?: boolean; delegatedBy?: DelegatedBy } = {},
): string {
  const by = more.delegatedBy;
  const lines = [
    by
      ? `You were started by Looper as "${by.title}" (run ${runId}) by the agent of the task "${by.taskName}" (run ${by.runId}), which is waiting for your result. This is a one-shot, unattended session: nobody is typing at the other end unless they choose to intervene.`
      : `You were started by Looper for the task "${taskName}" (run ${runId}). This is a one-shot, unattended session: nobody is typing at the other end unless they choose to intervene.`,
    'Do the work described in the prompt without asking for confirmation. Make reasonable decisions yourself.',
    'When you are finished, or if there is nothing to do, run the shell command:',
    '    looper-done <status> "<headline>"',
    'The status is success, warning or error. success: everything was done and verified. warning: everything was done and verified, but a person must decide or act on something in your report (a decision, a credential, access you don\'t have). A check you didn\'t run or couldn\'t get working is unfinished work, not a warning: keep going. error: you could not finish (blocked, failed, gave up). List each method you tried and what it showed.',
    'The headline is one short phrase stating the outcome, e.g. "Fixed 3 flaky tests" or "Nothing to do". State the outcome, not that you are done (no "Done:", "Completed:", etc.).',
    by
      ? "Then write your final message: a detailed report of what you did, what you found and what is left open and who needs to act on it, in Markdown. Looper records it as the run's summary and hands it to the agent that started you, which checks your work from it, so include what it needs for that: the commits, how you verified the work, the exact error of anything blocked, and the paths of files it should look at."
      : "Then write your final message: a detailed report of what you did, what you found and what is left open and who needs to act on it, in Markdown. Looper records it as the run's summary.",
  ];
  if (canComplete) {
    lines.push(
      `If this task is finished for good — future runs would have nothing left to do — run \`${AGENT_COMPLETE} "<why>"\` before ${AGENT_DONE.command}. Looper then stops scheduling the task. Leave it alone if the job is merely done for now.`,
    );
  }
  if (ask?.allowed) lines.push(by ? askParentSection(ask) : askSection(ask));
  if (more.delegate) lines.push(delegateSection());
  lines.push(
    'You can end your turn to wait: a background task you start (a background shell command, a Monitor) or a wake-up you schedule (ScheduleWakeup) keeps this session open, and its result, event or wake-up starts your next turn.',
  );
  lines.push(
    headless
      ? 'Stop every background task that never ends on its own (a server, a watcher, a Monitor with no end) before your final message: one left running keeps the session open until the run hits its maximum runtime, and the run then ends as timed out instead of with your report.'
      : "Looper doesn't count the session as idle while one is running or due. Stop every background task that never ends on its own (a server, a watcher, a Monitor with no end) and delete every recurring scheduled job once you no longer need them: while one is left, a turn that ends without looper-done keeps the session open until the run hits its maximum runtime.",
  );
  if (!headless) {
    lines.push('Looper closes this session when your final message ends. Do not run anything after looper-done and do not wait for further input.');
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
  if (ctx.resume) return ctx.resume.prompt;
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
  const delegate = a.delegate.allowed && cb.delegate ? { command: AGENT_DELEGATE, ...cb.delegate } : undefined;
  return startSession(
    ctx,
    {
      step: 'agent',
      prefix: '',
      launcherName: 'run',
      harness: a.command ? { ...harness, command: a.command } : harness,
      headless,
      model: a.model,
      effort: resolveEffort(a, harness),
      permissionMode: a.permissionMode,
      session: ctx.agentSession,
      extraArgs: agentArgs(task),
      footer: systemFooter(task.name, ctx.runId, headless, canComplete, a.ask, { delegate: !!delegate, delegatedBy: ctx.delegatedBy }),
      prompt: agentPrompt(ctx),
      doneCommand: AGENT_DONE.command,
      doneStatuses: AGENT_DONE.statuses,
      completeCommand: canComplete ? AGENT_COMPLETE : undefined,
      restartCommand: limit ? AGENT_RESTART : undefined,
      ask: a.ask.allowed
        ? { command: AGENT_ASK, waitMs: a.ask.waitMin * 60_000, noAnswer: noAnswerText(a.ask, ctx.delegatedBy ? 'parent' : 'user') }
        : undefined,
      // Its permission prompts go to the run window and phones too; a delegated agent's stay in its terminal, since its parent agent can't answer them.
      permissions:
        harness.kind === 'claude-code' && !headless && !ctx.delegatedBy
          ? { waitMs: a.ask.waitMin * 60_000, noAnswer: permissionNoAnswerText(a.ask) }
          : undefined,
      delegate,
      context: limit ? { limit, notice: (tokens, again) => contextNotice(tokens, limit, again) } : undefined,
      continued: ctx.restart !== undefined || ctx.resume !== undefined,
      implicitDoneStatus: 'success',
      stopGate: true,
      guidance: true,
      // The max runtime covers the whole run, the sessions before a restart (or a wait on delegated agents) included.
      maxRuntimeMs: Math.max(1000, a.maxRuntimeMin * 60_000 - (ctx.resume?.usedMs ?? ctx.restart?.elapsedMs ?? 0)),
      maxRuntimeText: `exceeded ${a.maxRuntimeMin} min`,
      idleGraceMs: a.idleGraceMin * 60_000,
      idleText: `idle for ${a.idleGraceMin} min without looper-done`,
      onIdleTimeout: a.onIdleTimeout,
    },
    cb,
  ) as Promise<AgentHandle>;
}
