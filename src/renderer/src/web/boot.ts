import type { MeResponse } from '../../../shared/remote-access';

/** What GET /api/me says about this device: paired, not paired, or nothing (no answer). */
export type PairingAnswer = 'paired' | 'unpaired' | 'unreachable';

/**
 * Only the computer's own answer that this device isn't paired counts as
 * "unpaired". A request that fails (Looper restarting for an update, the
 * Tailscale helper not up yet, a source refusing while it starts, the network)
 * says nothing about the pairing: treating it as unpaired sent paired devices
 * to the pairing page, and pairing again left the old pairing behind.
 */
export async function askPairing(fetchMe: () => Promise<Response>): Promise<PairingAnswer> {
  let me: Partial<MeResponse> | null;
  try {
    const res = await fetchMe();
    if (!res.ok) return 'unreachable';
    me = (await res.json()) as Partial<MeResponse> | null;
  } catch {
    return 'unreachable';
  }
  return me?.paired === true ? 'paired' : me?.paired === false ? 'unpaired' : 'unreachable';
}

/** A sleep that `wake` cuts short: the Try Again button asks at once instead of at the next retry. */
export function wakeableSleep(): { sleep: (ms: number) => Promise<void>; wake: () => void } {
  let wake: (() => void) | null = null;
  return {
    sleep: (ms) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(done, ms);
        function done() {
          clearTimeout(timer);
          wake = null;
          resolve();
        }
        wake = done;
      }),
    wake: () => wake?.(),
  };
}

/** Ask until the computer answers, every `retryMs`; `onWaiting` runs once, after the first miss. */
export async function waitForPairing(
  fetchMe: () => Promise<Response>,
  opts: { retryMs: number; onWaiting?: () => void; sleep?: (ms: number) => Promise<void> },
): Promise<Exclude<PairingAnswer, 'unreachable'>> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let waiting = false;
  for (;;) {
    const answer = await askPairing(fetchMe);
    if (answer !== 'unreachable') return answer;
    if (!waiting) {
      waiting = true;
      opts.onWaiting?.();
    }
    await sleep(opts.retryMs);
  }
}
