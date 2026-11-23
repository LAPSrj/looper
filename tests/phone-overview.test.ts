import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CARD_RETRY_MS, followCard } from '../src/renderer/src/components/card-feed';
import { TYPING_GAP, TYPING_MIN_HEIGHT, typingCardFit } from '../src/renderer/src/components/phone/typing-card';
import { statusBarTapped } from '../src/renderer/src/web/status-tap';

const SESSIONS_APP = path.join(__dirname, '..', 'src', 'renderer', 'src', 'SessionsApp.tsx');

/** Each top-level function's body in a source file, by name. */
function functions(source: string): Map<string, string> {
  const out = new Map<string, string>();
  const starts = [...source.matchAll(/^(?:export )?function (\w+)/gm)];
  starts.forEach((m, i) => out.set(m[1], source.slice(m.index, starts[i + 1]?.index ?? source.length)));
  return out;
}

describe("a dashboard card's conversation", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  type Ev = { id: string; state: string };
  const bus = () => {
    const fns = new Set<(e: Ev) => void>();
    return { subscribe: (fn: (e: Ev) => void) => (fns.add(fn), () => fns.delete(fn)), emit: (e: Ev) => fns.forEach((f) => f(e)), size: () => fns.size };
  };
  const of = (e: Ev, id: string) => (e.id === id ? e.state : undefined);
  const holder = () => {
    let value: string | null = null;
    return { set: (u: (p: string | null) => string | null) => (value = u(value)), get: () => value };
  };

  it('reads it again after a read that failed, so the card shows the conversation and not only its last messages', async () => {
    // A phone's read fails when its connection drops, or comes back empty while Looper is still opening the chat;
    // the card waited for events that never came (the phone's Overview told Looper nothing) and showed its last text for good.
    vi.useFakeTimers();
    const answers: (() => Promise<string | null>)[] = [() => Promise.reject(new Error('Not connected to Looper.')), () => Promise.resolve(null), () => Promise.resolve('conversation')];
    const read = vi.fn(() => answers.shift()!());
    const b = bus();
    const h = holder();
    const stop = followCard('c1', read, of, b.subscribe, h.set);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.get()).toBeNull();
    await vi.advanceTimersByTimeAsync(CARD_RETRY_MS[0]);
    expect(read).toHaveBeenCalledTimes(2);
    expect(h.get()).toBeNull();
    await vi.advanceTimersByTimeAsync(CARD_RETRY_MS[1]);
    expect(read).toHaveBeenCalledTimes(3);
    expect(h.get()).toBe('conversation');
    // Nothing more is read once it came; its events keep it current.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(3);
    b.emit({ id: 'c1', state: 'newer' });
    b.emit({ id: 'other', state: 'not this card' });
    expect(h.get()).toBe('newer');
    stop();
    expect(b.size()).toBe(0);
  });

  it('stops reading when an event brings the conversation first, or when the card goes', async () => {
    vi.useFakeTimers();
    const read = vi.fn(() => Promise.reject(new Error('Not connected to Looper.')));
    const b = bus();
    const h = holder();
    followCard('c1', read, of, b.subscribe, h.set);
    await vi.advanceTimersByTimeAsync(0);
    b.emit({ id: 'c1', state: 'from an event' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(2);
    expect(h.get()).toBe('from an event');
    const read2 = vi.fn(() => Promise.resolve(null));
    const stop = followCard('c2', read2, of, b.subscribe, holder().set);
    await vi.advanceTimersByTimeAsync(0);
    stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read2).toHaveBeenCalledTimes(1);
  });

  it('keeps an event newer than the read that was on its way', async () => {
    let answer: (v: string) => void = () => undefined;
    const b = bus();
    const h = holder();
    followCard('c1', () => new Promise<string | null>((r) => (answer = r)), of, b.subscribe, h.set);
    b.emit({ id: 'c1', state: 'event' });
    answer('older read');
    await Promise.resolve();
    expect(h.get()).toBe('event');
  });

  it("every dashboard that follows its cards in view tells Looper which show their conversation, the phone's Overview too", () => {
    // Without it a phone's card got none of its chat's events: a message sent from the computer never showed in it.
    const fns = functions(fs.readFileSync(SESSIONS_APP, 'utf8'));
    // The components that call it (the hook itself and other hooks aside).
    const dashboards = [...fns].filter(([name, body]) => !name.startsWith('use') && body.includes('useCardsInView(')).map(([name]) => name);
    expect(dashboards).toEqual(expect.arrayContaining(['ChatsDashboard', 'PhoneOverview']));
    for (const name of dashboards) expect({ name, reports: /useLiveCards\(|showCards\(/.test(fns.get(name)!) }).toEqual({ name, reports: true });
  });
});

describe('a card typed in with the on-screen keyboard up', () => {
  // An iPhone 15 Pro Max in the Home Screen app: the window's page starts under the bar, and with the keyboard and
  // Safari's form bar up 499 pt of it shows. The large card starts at 243 pt, under the large title and the switch.
  const phone = { top: 0, bottom: 499, cardTop: 243, cardHeight: 280, scrollTop: 0, scrollHeight: 640, clientHeight: 499 };

  it('fills what shows between the bar and the keyboard, and scrolls to the top, the large title out of view', () => {
    const fit = typingCardFit(phone);
    expect(fit.height).toBe(499 - 2 * TYPING_GAP);
    // The card's top lands TYPING_GAP under the page's top, its bottom TYPING_GAP above the keyboard.
    expect(phone.cardTop - (fit.scrollTop - phone.scrollTop)).toBe(TYPING_GAP);
    expect(phone.cardTop - (fit.scrollTop - phone.scrollTop) + fit.height).toBe(phone.bottom - TYPING_GAP);
    expect(fit.extra).toBe(0);
  });

  it('measures from where the page has scrolled to', () => {
    const fit = typingCardFit({ ...phone, scrollTop: 40, cardTop: 203 });
    expect(fit.scrollTop).toBe(40 + 203 - TYPING_GAP);
  });

  it('adds room below the card when the page could not scroll it to the top', () => {
    const fit = typingCardFit({ ...phone, scrollHeight: 520 });
    const max = 520 + (fit.height - phone.cardHeight) - phone.clientHeight;
    expect(fit.extra).toBe(fit.scrollTop - max);
    expect(fit.extra).toBeGreaterThan(0);
  });

  it('keeps the message box above the keyboard where less than its least height shows (a phone held sideways)', () => {
    const sideways = { top: 0, bottom: 126, cardTop: 107, cardHeight: 282, scrollTop: 0, scrollHeight: 483, clientHeight: 126 };
    const fit = typingCardFit(sideways);
    expect(fit.height).toBe(TYPING_MIN_HEIGHT);
    // Its bottom stays TYPING_GAP above the keyboard; its title goes under the bar.
    expect(sideways.cardTop - (fit.scrollTop - sideways.scrollTop) + fit.height).toBe(sideways.bottom - TYPING_GAP);
  });

  it("the phone's Overview fits a card typed in", () => {
    expect(functions(fs.readFileSync(SESSIONS_APP, 'utf8')).get('PhoneOverview')).toContain('useTypingCard(');
  });
});

describe("the status bar's tap", () => {
  it('is a scroll of the top document back to 0 with no finger on the screen', () => {
    expect(statusBarTapped({ scrollY: 0, fingers: 0, sinceTouch: 5000, sinceResize: 5000 })).toBe(true);
    expect(statusBarTapped({ scrollY: 1, fingers: 0, sinceTouch: 5000, sinceResize: 5000 })).toBe(false);
    expect(statusBarTapped({ scrollY: 0, fingers: 1, sinceTouch: 0, sinceResize: 5000 })).toBe(false);
    expect(statusBarTapped({ scrollY: 0, fingers: 0, sinceTouch: 200, sinceResize: 5000 })).toBe(false);
  });

  it("isn't the keyboard going: the viewport growing scrolls the document back too", () => {
    // Taken for a tap, closing the keyboard threw the conversation above the message box to its first message.
    expect(statusBarTapped({ scrollY: 0, fingers: 0, sinceTouch: 5000, sinceResize: 30 })).toBe(false);
    expect(statusBarTapped({ scrollY: 0, fingers: 0, sinceTouch: 5000, sinceResize: 900 })).toBe(false);
  });
});
