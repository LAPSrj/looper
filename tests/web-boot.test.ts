import { describe, expect, it } from 'vitest';
import { askPairing, waitForPairing } from '../src/renderer/src/web/boot';

const json = (body: unknown, status = 200) => () => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
const text = (body: string, status: number) => () => Promise.resolve(new Response(body, { status }));
const down = () => Promise.reject(new TypeError('Failed to fetch'));

describe('a browser deciding whether it is paired', () => {
  it("shows the pairing page only when the computer says this device isn't paired", async () => {
    expect(await askPairing(json({ paired: true, device: { id: 'a', name: 'Phone' } }))).toBe('paired');
    expect(await askPairing(json({ paired: false }))).toBe('unpaired');
  });

  // The bug: while Looper restarted for an update (or a source was still starting), a paired device that
  // loaded the page got no answer, took it for "not paired", and was sent to pair again.
  it('takes no answer for no answer, not for unpaired', async () => {
    expect(await askPairing(down)).toBe('unreachable');
    expect(await askPairing(text('Forbidden', 403))).toBe('unreachable');
    expect(await askPairing(text('Looper is not reachable', 502))).toBe('unreachable');
    expect(await askPairing(text('<html>', 200))).toBe('unreachable');
    expect(await askPairing(json({}))).toBe('unreachable');
  });

  it('asks again until the computer answers, and says once that it is waiting', async () => {
    const answers = [down, text('Forbidden', 403), json({ paired: true })];
    let asked = 0;
    let waiting = 0;
    const slept: number[] = [];
    const answer = await waitForPairing(() => answers[asked++](), {
      retryMs: 3000,
      onWaiting: () => waiting++,
      sleep: async (ms) => void slept.push(ms),
    });
    expect(answer).toBe('paired');
    expect(asked).toBe(3);
    expect(waiting).toBe(1);
    expect(slept).toEqual([3000, 3000]);
  });
});
