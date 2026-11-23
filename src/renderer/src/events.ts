import { useEffect } from 'react';
import type { UiEvent } from '@shared/api';
import type { ChatState } from '@shared/chat';
import { applyChatWire, type ChatWire } from '@shared/chat-delta';
import { fillWhole } from '@shared/chat-window';
import type { MessageRow } from '@shared/messages';
import type { EngineEvent } from '@shared/types';

type Listener = (e: EngineEvent) => void;
const listeners = new Set<Listener>();
let attached = false;

function deliver(e: EngineEvent): void {
  for (const l of listeners) {
    try {
      l(e);
    } catch (err) {
      console.error(err);
    }
  }
}

/**
 * Single IPC subscription fanned out to any number of components: each event crosses into the page once (on
 * the desktop every listener of the preload's would get a copy of its own). A component never listens to
 * `window.looper.onEvent` itself.
 */
export function subscribe(fn: Listener): () => void {
  if (!attached) {
    attached = true;
    window.looper.onEvent((e) => {
      const out = e.type === 'chat' ? chatEvent(e.state as unknown as ChatWire) : e;
      if (out) deliver(out);
    });
  }
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The chats this page has, as their last event or read left them, and when that was. */
const chats = new Map<string, { state: ChatState; at: number }>();
/** How long a chat with no events is kept to apply the next one to; past it, that one reads the chat again. */
const KEEP_MS = 60_000;
const reading = new Set<string>();

/** Keeps the chat as it is now, with the brief rows this page has read whole filled in (wholeRows); returns that. */
function remember(read: ChatState): ChatState {
  const now = Date.now();
  for (const [id, c] of chats) if (now - c.at > KEEP_MS) chats.delete(id);
  const state = fillWhole(read, whole.get(read.id));
  chats.set(state.id, { state, at: now });
  return state;
}

/** A chat's whole state, read from the main process; the page's events apply to it from then on. */
export async function getChat(id: string): Promise<ChatState | null> {
  const state = await window.looper.chat.get(id);
  return state ? remember(state) : null;
}

/**
 * The brief rows (chat-window.ts) each chat's page read whole, for the chats read last: a chat read again or an event
 * that brings its rows brief again gets them back, so what was drawn stays drawn. A phone gets a chat's older rows brief.
 */
const whole = new Map<string, Map<string, MessageRow>>();
const WHOLE_CHATS = 4;
/** The rows being read, by chat and row id. */
const readingRows = new Map<string, Promise<void>>();
/** Each chat's rows asked for in this turn of the event loop, read together. */
const asked = new Map<string, { ids: Set<string>; done: Promise<void> }>();

/**
 * Read these rows of the chat whole, if they aren't: the chat's listeners get it again with them in. The rows asked
 * for at once (a tool group's thinking as it opens) are read in one call. Resolves once they're in (or couldn't be
 * read: the rows stay brief, and a later draw asks again).
 */
export function wholeRows(chatId: string, ids: readonly string[]): Promise<void> {
  const have = whole.get(chatId);
  const waits = new Set<Promise<void>>();
  for (const id of new Set(ids)) {
    if (have?.has(id)) continue;
    const key = `${chatId}\n${id}`;
    let on = readingRows.get(key);
    if (!on) {
      let batch = asked.get(chatId);
      if (!batch) {
        const ask = { ids: new Set<string>(), done: Promise.resolve() };
        ask.done = new Promise<void>((resolve) =>
          setTimeout(() => {
            asked.delete(chatId);
            void readRows(chatId, [...ask.ids]).finally(() => {
              for (const id of ask.ids) readingRows.delete(`${chatId}\n${id}`);
              resolve();
            });
          }, 0),
        );
        asked.set(chatId, (batch = ask));
      }
      batch.ids.add(id);
      readingRows.set(key, (on = batch.done));
    }
    waits.add(on);
  }
  return Promise.all(waits).then(() => undefined);
}

async function readRows(chatId: string, ids: string[]): Promise<void> {
  const rows = await window.looper.chat.rows(chatId, ids).catch(() => [] as MessageRow[]);
  if (!rows.length) return;
  const kept = whole.get(chatId) ?? new Map<string, MessageRow>();
  for (const r of rows) kept.set(r.id, r);
  // This chat's rows are the newest kept.
  whole.delete(chatId);
  whole.set(chatId, kept);
  for (const id of [...whole.keys()].slice(0, Math.max(0, whole.size - WHOLE_CHATS))) whole.delete(id);
  const c = chats.get(chatId);
  // Its state went (no event for a while): it's read again, with the rows filled in.
  const state = c ? remember(c.state) : await getChat(chatId).catch(() => null);
  if (state && state !== c?.state) deliver({ type: 'chat', state });
}

/** A row read whole by wholeRows, or the row itself. */
export const wholeRow = (chatId: string, row: MessageRow): MessageRow => (row.brief ? (whole.get(chatId)?.get(row.id) ?? row) : row);

/** Reads the row whole while it shows brief (a tool call Now shows). */
export function useWholeRow(chatId: string, row: MessageRow | null | undefined): void {
  const id = row?.brief ? row.id : null;
  useEffect(() => {
    if (id) void wholeRows(chatId, [id]);
  }, [chatId, id]);
}

/** A `chat` event made whole again; null when it couldn't be, and the chat is read and passed on as its event instead. */
function chatEvent(wire: ChatWire): EngineEvent | null {
  const applied = applyChatWire(chats.get(wire.id)?.state, wire);
  if (applied) return { type: 'chat', state: remember(applied) };
  if (!reading.has(wire.id)) {
    reading.add(wire.id);
    void getChat(wire.id)
      .then((s) => s && deliver({ type: 'chat', state: s }))
      // Out of reach (a phone offline): the next event tries again.
      .catch(() => undefined)
      .finally(() => reading.delete(wire.id));
  }
  return null;
}

const uiListeners = new Set<(e: UiEvent) => void>();

/** Tell this window's own components (Find…, the files just attached): a command runs in the page, so nothing goes through the main process. */
export function emitUi(e: UiEvent): void {
  for (const l of uiListeners) l(e);
}

/** The events a command of this page sends, and the main process's. */
export function onUi(fn: (e: UiEvent) => void): () => void {
  uiListeners.add(fn);
  const off = window.looper.onUi(fn);
  return () => {
    uiListeners.delete(fn);
    off();
  };
}
