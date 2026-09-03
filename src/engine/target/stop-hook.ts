/**
 * Shared pieces of the Stop-hook gate both targets render. Printing one of
 * these JSON decisions on the hook's stdout blocks the turn from ending;
 * claude feeds the reason back to the agent and the session continues.
 */

/** Target-native paths baked into the generated Stop-hook script. */
export interface StopHookSpec {
  /** Where an allowed stop's payload is recorded (the run's report / idle signal). */
  stopJson: string;
  /** The looper-done signal file: once it exists, every stop is allowed. */
  doneFile: string;
  /** Marker created when the one-time looper-done reminder is issued. */
  reminderFile: string;
}

export const STOP_BLOCK_BACKGROUND = JSON.stringify({
  decision: 'block',
  reason:
    'Looper: this unattended session still has background tasks running. Ending the turn ends the session and kills them — no notification can wake you afterwards. Wait for their results now, or stop them if they no longer matter. When the work is done, run looper-done and write your final report.',
});

export const STOP_BLOCK_NO_DONE = JSON.stringify({
  decision: 'block',
  reason:
    'Looper: the turn ended without looper-done. If the job is finished (or there is nothing to do), run looper-done <status> "<headline>" now, then write your final report. If work remains, continue it — nobody is watching this session to nudge you.',
});
