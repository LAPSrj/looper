import fs from 'node:fs';
import { createElement, type FunctionComponent } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChatState } from '../src/shared/chat';
import { ChatEncoder, applyChatWire } from '../src/shared/chat-delta';
import { CHAT_TAIL_CHARS, briefChatRow, drawsText, fillWhole, rowWeight, wholeRowsOf, windowChat, windowWire } from '../src/shared/chat-window';
import { MAX_WS_MESSAGE_BYTES } from '../src/shared/remote-access';
import type { MessageRow } from '../src/shared/messages';
import type { EngineEvent } from '../src/shared/types';

/**
 * A chat shaped like Leandro's that never reached his phone (12 MB, over the WebSocket's 8 MB): 1,000 rows, most of
 * them tool calls with long results, replies short and long, and a compacted history before them. Generated.
 */
function bigRows(prefix: string, count: number): MessageRow[] {
  return Array.from({ length: count }, (_, i): MessageRow => {
    const id = `${prefix}${i}`;
    if (i % 10 === 0) return { id, kind: 'prompt', preview: `Message ${i}`, text: `Message ${i}: ${'please '.repeat(20)}`, uuid: `u${i}` };
    if (i % 10 < 7) {
      const file = `/home/dev/src/file-${i}.ts`;
      return { id, kind: 'tool', tool: i % 3 ? 'Read' : 'Bash', preview: file, file, text: `file_path: ${file}`, input: { file_path: file }, result: `${i}`.padEnd(15_000, ' code line\n'), toolUseId: `t${i}` };
    }
    const text = (i % 10 === 9 ? 'A long reply with a table and code. ' : 'A short reply. ').repeat(i % 10 === 9 ? 120 : 30);
    return { id, kind: 'agent', preview: text.slice(0, 80), text };
  });
}

const chat = (history: MessageRow[], rows: MessageRow[]): ChatState =>
  ({ id: 'c1', taskId: 't', taskName: 'T', environmentId: 'e', harnessId: 'h', harnessName: 'Claude', harnessKind: 'claude-code', harnesses: [], harnessLocked: true, settings: { permissionMode: 'auto' }, autoCompactDefault: { enabled: false, percent: 80 }, models: [], status: 'ready', history, rows, permissions: [], queued: [], commands: [], commandPrefix: '/', runningCommands: 0, startedAt: 0, autoContinue: false }) as ChatState;

const full = chat(bigRows('h', 200), bigRows('r', 1000));

describe('a chat as a phone or tablet gets it', () => {
  it('is all its rows, in order, the newest whole and the heavy older ones brief, in a small part of its size', () => {
    const whole = JSON.stringify(full).length;
    expect(whole).toBeGreaterThan(MAX_WS_MESSAGE_BYTES);
    const w = windowChat(full);
    const size = JSON.stringify(w).length;
    expect(size).toBeLessThan(whole / 8);
    expect(size).toBeLessThan(CHAT_TAIL_CHARS + 1024 * 1024);
    // Every row, with its id and kind, as Now, Files, Fork and the message box's recall read them.
    expect(w.rows.map((r) => [r.id, r.kind, r.tool, r.file])).toEqual(full.rows.map((r) => [r.id, r.kind, r.tool, r.file]));
    expect(w.history.map((r) => r.id)).toEqual(full.history.map((r) => r.id));
    // The newest rows are the same objects; the ones before them that are heavy are brief.
    let tail = 0;
    let n = full.rows.length - 1;
    for (; n >= 0 && tail < CHAT_TAIL_CHARS; n--) {
      expect(w.rows[n]).toBe(full.rows[n]);
      tail += rowWeight(full.rows[n]);
    }
    const older = w.rows.slice(0, n);
    expect(older.filter((r) => r.brief).length).toBeGreaterThan(older.length / 2);
    for (const r of [...older, ...w.history]) {
      if (r.kind === 'prompt') expect(r).toBe(full.rows.find((x) => x.id === r.id) ?? full.history.find((x) => x.id === r.id));
      if (!r.brief) continue;
      expect(r.text).toBe('');
      expect(r.result === undefined || r.result === '').toBe(true);
      expect(r.preview).not.toBe('');
    }
    // A short reply goes whole wherever it is.
    expect(w.rows[8]).toBe(full.rows[8]);
    expect(w.rows[9].brief).toBe(true);
    // The desktop's chat, already small, is the same object.
    const small = chat([], bigRows('s', 5));
    expect(windowChat(small)).toBe(small);
  });

  it("the chat's events window what they carry whole, and leave its changed rows whole", () => {
    const enc = new ChatEncoder();
    const first = enc.encode(full);
    const w = windowWire(first);
    expect(JSON.stringify(w).length).toBeLessThan(JSON.stringify(first).length / 8);
    // The page applies it as it did the whole one, with every row there.
    const page = applyChatWire(null, w)!;
    expect(page.rows.map((r) => r.id)).toEqual(full.rows.map((r) => r.id));
    // A delta carries the new row whole, and the page keeps its brief ones as they were.
    const next = { ...full, rows: [...full.rows, bigRows('n', 2)[1]] };
    const delta = enc.encode(next);
    expect(windowWire(delta)).toBe(delta);
    const applied = applyChatWire(page, windowWire(delta))!;
    expect(applied.rows.at(-1)).toEqual(next.rows.at(-1));
    expect(applied.rows[9]).toBe(page.rows[9]);
  });

  it('reads brief rows whole by id, and fills a state read again with the rows read whole', () => {
    const w = windowChat(full);
    const got = wholeRowsOf(full, ['r9', 'h19', 'nope']);
    expect(got).toEqual([full.rows[9], full.history[19]]);
    const filled = fillWhole(w, new Map(got.map((r) => [r.id, r])));
    expect(filled.rows[9]).toBe(full.rows[9]);
    expect(filled.history[19]).toBe(full.history[19]);
    expect(filled.rows[19]).toBe(w.rows[19]);
    expect(fillWhole(w, new Map())).toBe(w);
  });

  it('draws as text what shows before anything opens; a tool call shows its line until it opens', () => {
    expect(drawsText(full.rows[9])).toBe(true);
    expect(drawsText(full.rows[1])).toBe(false);
    expect(drawsText({ ...full.rows[1], tool: 'SubagentHandback' })).toBe(true);
    expect(briefChatRow(full.rows[0])).toBe(full.rows[0]);
  });
});

describe("the page's whole rows (events.ts)", () => {
  type Listener = (e: EngineEvent) => void;
  let push: Listener = () => undefined;
  const get = vi.fn(async (_id: string) => ({ ...windowChat(full), seq: 1, epoch: 1 }));
  const rows = vi.fn(async (_id: string, ids: string[]) => wholeRowsOf(full, ids));
  // Read by its path at run time: the tests' type check (tsconfig.node.json) doesn't take the renderer's files.
  const EVENTS = '../src/renderer/src/events';
  let events: {
    subscribe(fn: Listener): () => void;
    getChat(id: string): Promise<ChatState | null>;
    wholeRows(chatId: string, ids: readonly string[]): Promise<void>;
    wholeRow(chatId: string, row: MessageRow): MessageRow;
  };
  beforeAll(async () => {
    (globalThis as { window?: unknown }).window = { looper: { chat: { get, rows }, onEvent: (cb: Listener) => ((push = cb), () => undefined), onUi: () => () => undefined } };
    events = (await import(/* @vite-ignore */ EVENTS)) as typeof events;
  });
  afterAll(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it('reads a brief row once, passes the chat on with it, and keeps it through an event and a read again', async () => {
    const seen: ChatState[] = [];
    events.subscribe((e) => void (e.type === 'chat' && seen.push(e.state)));
    const read = await events.getChat('c1');
    expect(read!.rows[9].brief).toBe(true);
    await Promise.all([events.wholeRows('c1', ['r9', 'r19']), events.wholeRows('c1', ['r9'])]);
    expect(rows).toHaveBeenCalledTimes(1);
    expect(rows.mock.calls[0][1]).toEqual(['r9', 'r19']);
    expect(seen.at(-1)!.rows[9]).toEqual(full.rows[9]);
    expect(events.wholeRow('c1', read!.rows[9])).toEqual(full.rows[9]);
    // Read already: not asked again.
    await events.wholeRows('c1', ['r9']);
    expect(rows).toHaveBeenCalledTimes(1);
    // The chat's next event (its rows whole, windowed as a phone gets them) and a read again keep it whole.
    const enc = new ChatEncoder();
    push({ type: 'chat', state: windowWire(enc.encode(full)) as unknown as ChatState });
    expect(seen.at(-1)!.rows[9]).toEqual(full.rows[9]);
    expect((await events.getChat('c1'))!.rows[19]).toEqual(full.rows[19]);
  });
});

describe('a brief row drawn', () => {
  // The desktop app's page, as now-list.test.ts stands it in. Read by its path at run time: the tests' type check
  // (tsconfig.node.json) doesn't take the renderer's JSX.
  const CHAT_ROWS = '../src/renderer/src/components/ChatRows';
  let ChatRow: FunctionComponent<{ row: MessageRow; ctx: { taskId: string; runId: string } }>;
  beforeAll(async () => {
    const element = { dataset: {}, classList: { add: () => undefined, remove: () => undefined, toggle: () => undefined, contains: () => false }, style: {} };
    Object.assign(globalThis, { window: { looper: {}, performance, addEventListener: () => undefined, matchMedia: () => ({ matches: false, addEventListener: () => undefined }) }, document: { documentElement: element, addEventListener: () => undefined } });
    ({ ChatRow } = (await import(/* @vite-ignore */ CHAT_ROWS)) as { ChatRow: typeof ChatRow });
  });
  afterAll(() => {
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { document?: unknown }).document;
  });

  it('shows its line until it comes whole, and a tool call its line, closed', () => {
    const ctx = { taskId: 't', runId: 'c1' };
    const w = windowChat(full);
    const reply = w.rows[9];
    expect(reply.brief).toBe(true);
    const drawn = renderToStaticMarkup(createElement(ChatRow, { row: reply, ctx }));
    expect(drawn).toContain(reply.preview);
    expect(renderToStaticMarkup(createElement(ChatRow, { row: full.rows[9], ctx }))).toContain(full.rows[9].text.slice(0, 60));
    const call = w.rows[1];
    expect(call.brief).toBe(true);
    expect(renderToStaticMarkup(createElement(ChatRow, { row: call, ctx }))).toContain(call.preview);
  });
});

describe('Looper sends a phone its chats windowed', () => {
  it('chat:get for a remote caller, and the chat events to its windows', () => {
    const ipc = fs.readFileSync(new URL('../src/main/ipc.ts', import.meta.url), 'utf8');
    const get = /ipc\.handle\('chat:get'[\s\S]*?\n {2}\}\);/.exec(ipc)?.[0] ?? '';
    expect(get).toMatch(/caller\(\) \? windowChat\(state\) : state/);
    expect(ipc).toMatch(/ipc\.handle\('chat:rows'/);
    const chatEvent = /if \(event\.type === 'chat'\) \{[\s\S]*?\n {4}\}/.exec(ipc)?.[0] ?? '';
    expect(chatEvent).toMatch(/isRemote\(w\) \? \(windowed \?\?= windowWire\(wire\)\) : wire/);
  });
});
