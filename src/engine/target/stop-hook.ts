/**
 * Shared pieces of the Stop-hook gate both targets render. Printing one of
 * these JSON decisions on the hook's stdout blocks the turn from ending;
 * claude feeds the reason back to the agent and the session continues.
 */

/** Target-native paths and step-specific texts baked into the generated Stop-hook script. */
export interface StopHookSpec {
  /** Where an allowed stop's payload is recorded (the run's report / idle signal). */
  stopJson: string;
  /** The done-signal file: once it exists, every stop is allowed. */
  doneFile: string;
  /** Marker created when the one-time done reminder is issued. */
  reminderFile: string;
  /** JSON decision blocking a stop while background tasks run. */
  blockBackground: string;
  /** JSON decision reminding once that the done command was never run. */
  blockNoDone: string;
}

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
