import { describe, expect, it } from 'vitest';
import { describeSpans, mainSpan } from '../src/main/main-stalls';
import { IpcTable, type IpcMainLike } from '../src/main/platform/ipc-table';

describe('main process freezes', () => {
  it('names the work that ended inside a freeze, summed by name, biggest first', () => {
    const spans = [
      { name: 'ipc sessions:fileThumbnail', end: 110, ms: 40 },
      { name: 'menu bar', end: 150, ms: 12 },
      { name: 'ipc sessions:fileThumbnail', end: 190, ms: 45 },
      { name: 'event chat', end: 400, ms: 90 },
    ];
    expect(describeSpans(spans, 100, 200)).toBe('ipc sessions:fileThumbnail 85 ms ×2, menu bar 12 ms');
  });

  it('a span hands back what its work returns, and throws what it throws', () => {
    expect(mainSpan('x', () => 7)).toBe(7);
    expect(() =>
      mainSpan('x', () => {
        throw new Error('no');
      }),
    ).toThrow('no');
  });

  it("the IPC table times each listener and still removes it by the caller's function", () => {
    const registered: Record<string, unknown[]> = {};
    const electron: IpcMainLike = {
      handle: () => undefined,
      removeHandler: () => undefined,
      on: (ch, l) => (registered[ch] ??= []).push(l),
      removeListener: (ch, l) => {
        registered[ch] = registered[ch].filter((x) => x !== l);
      },
    };
    const table = new IpcTable(electron);
    const calls: string[] = [];
    const listener = (_e: unknown, v: string) => calls.push(v);
    table.on('a', listener);
    table.on('b', listener);
    (registered.a[0] as (e: unknown, v: string) => void)({}, 'hi');
    expect(calls).toEqual(['hi']);
    table.removeListener('a', listener);
    expect(registered.a).toEqual([]);
    expect(registered.b).toHaveLength(1);
  });
});
