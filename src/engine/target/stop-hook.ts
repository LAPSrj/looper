/**
 * Shared pieces of the hook scripts both targets render: the Stop-hook gate
 * and the guidance hook. Printing one of the gate's JSON decisions on the
 * hook's stdout blocks the turn from ending; claude feeds the reason back to
 * the agent and the session continues.
 */

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
  /** Looper's own notice waiting for the agent, taken the same way after any guidance. */
  noticeFile?: string;
  /** JSON decision blocking a stop while background tasks run. */
  blockBackground: string;
  /** JSON decision reminding once that the done command was never run. */
  blockNoDone: string;
}

/** How the guidance hook hands its message over: claude's PostToolUse output, or codex's. */
export type GuideHookFormat = 'claude' | 'codex';

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

/** The Stop-hook decision around a guidance message literal: block, and continue with the guidance. */
export const STOP_GUIDANCE_JSON = { before: '{"decision":"block","reason":', after: '}' };

/** The gate's block decisions for a step, worded around its done command. */
export function stopHookMessages(step: 'agent' | 'classify'): { blockBackground: string; blockNoDone: string } {
  const done = step === 'classify' ? 'looper-classify' : 'looper-done';
  const blockBackground = JSON.stringify({
    decision: 'block',
    reason:
      `Looper: this unattended session still has background tasks running. Ending the turn ends the session and kills them — no notification can wake you afterwards. Wait for their results now, or stop them if they no longer matter. When the work is done, run ${done} and write your final message.`,
  });
  const blockNoDone = JSON.stringify({
    decision: 'block',
    reason:
      step === 'classify'
        ? 'Looper: the turn ended without looper-classify. Give your verdict now: run looper-classify act "<reason>" if the agent should be started, or looper-classify noop "<reason>" if not — then write a short closing message.'
        : 'Looper: the turn ended without looper-done. If the job is finished (or there is nothing to do), run looper-done <status> "<headline>" now, then write your final report. If work remains, continue it — nobody is watching this session to nudge you.',
  });
  return { blockBackground, blockNoDone };
}
