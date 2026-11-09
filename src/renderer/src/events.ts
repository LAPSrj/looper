import type { UiEvent } from '@shared/api';
import type { ChatState } from '@shared/chat';
import { applyChatWire, type ChatWire } from '@shared/chat-delta';
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

function remember(state: ChatState): void {
  const now = Date.now();
  for (const [id, c] of chats) if (now - c.at > KEEP_MS) chats.delete(id);
  chats.set(state.id, { state, at: now });
}

/** A chat's whole state, read from the main process; the page's events apply to it from then on. */
export async function getChat(id: string): Promise<ChatState | null> {
  const state = await window.looper.chat.get(id);
  if (state) remember(state);
  return state;
}

/** A `chat` event made whole again; null when it couldn't be, and the chat is read and passed on as its event instead. */
function chatEvent(wire: ChatWire): EngineEvent | null {
  const state = applyChatWire(chats.get(wire.id)?.state, wire);
  if (state) {
    remember(state);
    return { type: 'chat', state };
  }
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
