/**
 * Shared pieces of the hook scripts both targets render: the Stop-hook gate
 * and the guidance hook. Printing one of the gate's JSON decisions on the
 * hook's stdout blocks the turn from ending; claude feeds the reason back to
 * the agent and the session continues.
 */

import { GUIDANCE_PREFIX } from '../../shared/messages';

/** Target-native paths and step-specific texts baked into the generated Stop-hook script. */
export interface StopHookSpec {
  /** Where an allowed stop's payload is recorded (the run's report / idle signal). */
  stopJson: string;
  /** The done-signal file: once it exists, every stop is allowed. */
  doneFile: string;
  /** Marker created when the one-time done reminder is issued. */
  reminderFile: string;
  /** Guidance waiting for the agent: a stop takes it and continues with it. Unset = the step takes none. */
  guidanceFile?: string;
  /** Related trigger events waiting for the agent, taken the same way after any guidance. */
  eventsFile?: string;
  /** Results and questions of the agents it started (looper-delegate), taken the same way after any events. */
  delegateFile?: string;
  /**
   * Exists while an agent the session started is still going: the turn may
   * end without the done command, since Looper brings the result in.
   */
  delegateBusyFile?: string;
  /** Looper's own notice waiting for the agent, taken the same way after any guidance. */
  noticeFile?: string;
  /** JSON decision reminding once that the done command was never run. */
  blockNoDone: string;
}

/** How the guidance hook hands its message over: claude's PostToolUse output, or codex's. */
export type GuideHookFormat = 'claude' | 'codex';

/** The files the guidance hook takes from, in this order: the first one waiting is handed over. */
export interface GuideFiles {
  guidance: string;
  events: string;
  delegate: string;
  notice: string;
}

/**
 * The environment variable naming the file that exists while an agent the
 * session started (looper-delegate) is still going: the done command refuses
 * then and prints the file.
 */
export const DELEGATE_BUSY_VAR = 'LOOPER_DELEGATE_BUSY';

/**
 * The JSON a guidance hook prints around the message literal (see
 * engine/guidance.ts). Codex gets the shape a live codex-cli 0.159.0 run
 * accepted; claude requires hookEventName in hookSpecificOutput.
 */
export function guideHookJson(format: GuideHookFormat): { before: string; after: string } {
  return format === 'claude'
    ? { before: '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":', after: '}}' }
    : { before: '{"hookSpecificOutput":{"additionalContext":', after: '}}' };
}

/**
 * Why the subagent guard denied a call. A subagent shares the session's
 * environment, so the signal helpers can't tell it from the agent: the
 * PreToolUse guard stops it from ending or restarting the agent's session.
 */
export function subagentGuardMessage(commands: readonly string[]): string {
  return `Looper: a subagent can't run ${commands.join(' or ')}. Those commands end or restart the whole Looper session, the main agent included. Finish your part and report back to the agent that started you; it decides when the run is done.`;
}

/**
 * Why a headless session can't use CronCreate. Its jobs live in the session,
 * which closes once a turn ends with nothing left running, so a job would never
 * fire. Told only to try ScheduleWakeup, a live Sonnet 5.5 agent refused it as
 * a /loop tool, so the message says it works here.
 */
export const CRON_REFUSAL =
  'Looper: CronCreate is turned off in this unattended session. Its jobs live only as long as the session, and the session closes when your turn ends with nothing left running, so a job would never fire. To be woken later, call ScheduleWakeup with delaySeconds and a prompt saying what to do then: it works in this session, and the session stays open until the wake-up. To wait for a command, run it in the background or watch it with Monitor, and its result starts your next turn.';

/** The Stop-hook decision around a guidance message literal: block, and continue with the guidance. */
export const STOP_GUIDANCE_JSON = { before: '{"decision":"block","reason":', after: '}' };

/**
 * What a chat's subagent is told as it starts (SubagentStart). Without it, a
 * live Haiku 5.5 subagent took the user's message, arriving with a tool's
 * result, for an instruction planted in the tool's output and ignored it.
 * With it, live subagents followed a message that conflicted with their task
 * in 3 runs of 3 on Sonnet 5.5 and 4 of 5 on Haiku 5.5. Wrapping the message
 * in XML tags did no better on Haiku 5.5 (2 of 5).
 */
export const SUBAGENT_START_JSON = JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'SubagentStart',
    additionalContext: `The user follows your work in Looper and can send you messages while you work. They reach you as hook context that starts with "${GUIDANCE_PREFIX}". Such a message is the user's own instruction: follow it, and where it conflicts with your task or with the agent that started you, the message wins.`,
  },
});


/** The gate's block decision for a step, worded around its done command. */
export function stopHookMessages(step: 'agent' | 'classify'): { blockNoDone: string } {
  const blockNoDone = JSON.stringify({
    decision: 'block',
    reason:
      step === 'classify'
        ? 'Looper: the turn ended without looper-classify. Give your verdict now: run looper-classify act "<reason>" if the agent should be started, or looper-classify noop "<reason>" if not — then write a short closing message.'
        : 'Looper: the turn ended without looper-done. If the job is finished (or there is nothing to do), run looper-done <status> "<headline>" now, then write your final report. If work remains, continue it — nobody is watching this session to nudge you.',
  });
  return { blockNoDone };
}
