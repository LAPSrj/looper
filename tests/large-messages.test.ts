import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_WS_MESSAGE_BYTES, MessageJoiner, PART_CHARS, isMessagePart, splitMessage, type ServerMessage } from '../src/shared/remote-access';
import { Session, type SocketLike } from '../src/renderer/src/web/session';

/**
 * A message longer than one WebSocket message (MAX_WS_MESSAGE_BYTES) goes as parts, both ways: a chat of 12 MB never
 * reached a phone, which got "The answer to chat:get was too large to send." and a card stuck on its last text.
 */
describe('splitMessage and MessageJoiner', () => {
  it('a short message goes as it is', () => {
    expect(splitMessage('{"t":"pong"}', '1')).toEqual(['{"t":"pong"}']);
    expect(isMessagePart('{"t":"pong"}')).toBe(false);
  });

  it('a long one goes as parts under the cap, a surrogate pair kept whole, and comes back the same', () => {
    // A surrogate pair across the first cut: 😀 starts at the last unit of the first part.
    const text = `{"v":"${'a'.repeat(PART_CHARS - 7)}😀${'é'.repeat(PART_CHARS)}${'b'.repeat(PART_CHARS + 3)}"}`;
    const parts = splitMessage(text, '42');
    expect(parts.length).toBe(4);
    for (const p of parts) {
      expect(isMessagePart(p)).toBe(true);
      expect(Buffer.byteLength(p)).toBeLessThanOrEqual(MAX_WS_MESSAGE_BYTES);
      // Each part is valid UTF-16 on its own: no lone surrogate at either end.
      expect(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(p.slice(p.indexOf('\n') + 1))).toBe(false);
    }
    const j = new MessageJoiner(64 * 1024 * 1024);
    expect(parts.slice(0, -1).map((p) => j.push(p))).toEqual([null, null, null]);
    expect(j.push(parts.at(-1)!)).toBe(text);
    expect(j.waiting).toBe(0);
  });

  it('joins messages whose parts come between each other, by id', () => {
    const a = splitMessage('x'.repeat(PART_CHARS * 2), 'a');
    const b = splitMessage('y'.repeat(PART_CHARS + 1), 'b');
    const j = new MessageJoiner(64 * 1024 * 1024);
    expect([j.push(a[0]), j.push(b[0]), j.push(a[1]), j.push(b[1])].map((m) => m?.length ?? null)).toEqual([null, null, PART_CHARS * 2, PART_CHARS + 1]);
  });

  it('drops a message past its limit, and the rest of its parts', () => {
    const parts = splitMessage('x'.repeat(PART_CHARS * 3), 'big');
    const j = new MessageJoiner(PART_CHARS * 2);
    expect(parts.map((p) => j.push(p))).toEqual([null, null, null]);
    expect(j.waiting).toBe(0);
    // A part whose first part never came, and text that isn't a part, are nothing.
    expect(j.push(splitMessage('y'.repeat(PART_CHARS + 1), 'late')[1])).toBeNull();
    expect(j.push('{"t":"pong"}')).toBeNull();
  });
});

class RawSocket implements SocketLike {
  static last: RawSocket;
  readyState = 0;
  frames: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    RawSocket.last = this;
  }
  send(data: string) {
    this.frames.push(data);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(text: string) {
    this.onmessage?.({ data: text });
  }
}

describe('the phone side (Session)', () => {
  let session: Session;
  beforeEach(() => {
    vi.useFakeTimers();
    session = new Session({
      wsUrl: 'ws://x/api/ws',
      createSocket: () => new RawSocket(),
      storage: { getItem: () => null, setItem: () => undefined },
      platform: 'ios',
      fetch: (() => Promise.reject(new Error('no'))) as unknown as typeof fetch,
    });
    session.start();
    RawSocket.last.open();
    const welcome: ServerMessage = { t: 'welcome', device: { id: 'd', name: 'Phone' }, version: '1', clientId: 'c', resumed: false, windows: [], replayed: false, seq: 0 };
    RawSocket.last.receive(JSON.stringify(welcome));
  });
  afterEach(() => {
    session.stop();
    vi.useRealTimers();
  });

  it('joins an answer that comes as parts', async () => {
    const answer = session.invoke('w1', 'chat:get', ['c1']);
    const sent = JSON.parse(RawSocket.last.frames.at(-1)!) as { id: number };
    const value = { rows: 'r'.repeat(MAX_WS_MESSAGE_BYTES + 10) };
    const parts = splitMessage(JSON.stringify({ t: 'result', id: sent.id, ok: true, value } satisfies ServerMessage), '9');
    expect(parts.length).toBe(4);
    for (const p of parts) RawSocket.last.receive(p);
    await expect(answer).resolves.toEqual(value);
  });

  it('sends a message over the cap as parts, where it refused one before', () => {
    // A send's text past the cap: it went nowhere ("The request to Looper is too large").
    const before = RawSocket.last.frames.length;
    session.transportFor('w1').send('chat:send', 'c1', 'm'.repeat(MAX_WS_MESSAGE_BYTES), []);
    const frames = RawSocket.last.frames.slice(before);
    expect(frames.length).toBe(4);
    for (const f of frames) expect(Buffer.byteLength(f)).toBeLessThanOrEqual(MAX_WS_MESSAGE_BYTES);
    const j = new MessageJoiner(64 * 1024 * 1024);
    const whole = frames.map((f) => j.push(f)).at(-1);
    expect(JSON.parse(whole!)).toMatchObject({ t: 'send', w: 'w1', channel: 'chat:send', args: ['c1', 'm'.repeat(MAX_WS_MESSAGE_BYTES), []] });
  });

  it("forgets a long message's parts when its socket goes: the next socket's ids start over", async () => {
    const first = session.invoke('w1', 'chat:get', ['c1']).catch((e: Error) => e.message);
    const sent = JSON.parse(RawSocket.last.frames.at(-1)!) as { id: number };
    RawSocket.last.receive(splitMessage(JSON.stringify({ t: 'result', id: sent.id, ok: true, value: 'v'.repeat(PART_CHARS * 2) }), '1')[0]);
    RawSocket.last.close();
    await expect(first).resolves.toBe('Not connected to Looper.');
    vi.advanceTimersByTime(1000);
    RawSocket.last.open();
    RawSocket.last.receive(JSON.stringify({ t: 'welcome', device: { id: 'd', name: 'Phone' }, version: '1', clientId: 'c', resumed: true, windows: [], replayed: false, seq: 0 }));
    const second = session.invoke('w1', 'chat:get', ['c2']);
    const again = JSON.parse(RawSocket.last.frames.at(-1)!) as { id: number };
    const value = 'w'.repeat(PART_CHARS + 5);
    for (const p of splitMessage(JSON.stringify({ t: 'result', id: again.id, ok: true, value }), '1')) RawSocket.last.receive(p);
    await expect(second).resolves.toBe(value);
  });
});
