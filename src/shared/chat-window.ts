import type { ChatState } from './chat';
import type { ChatWire } from './chat-delta';
import { HANDBACK_TOOL, briefRow, type MessageRow } from './messages';

/**
 * A chat as a phone or tablet gets it: its newest rows whole, about CHAT_TAIL_CHARS of them, and every older row
 * that's heavy (a tool call's result, a long reply) brief (MessageRow.brief), without what it doesn't draw until it's
 * drawn or opened. A conversation draws its newest messages first, so a chat of 12 MB came to a phone whole for a
 * screen of it, and one over the WebSocket's 8 MB never came at all. Every row is there, in order, with its id, kind,
 * tool, file and preview, so Now, Files, the context menu's Fork and the message box's recall see the whole chat;
 * the page reads a brief row whole (chat.rows) when it draws it, or when a tool call opens.
 */

/** How much of a chat's newest rows (UTF-16 units of their text, rowWeight) a phone or tablet gets whole. */
export const CHAT_TAIL_CHARS = 256 * 1024;
/** An older row that weighs at most this goes whole anyway: a short reply, a call with a short result. */
export const LIGHT_ROW_CHARS = 2000;
/** The most rows one chat.rows call reads whole. */
export const WHOLE_ROWS_MAX = 500;

/** About how much of a row's JSON its text makes, without making the JSON (which, for a chat's every row, would hold the main process). */
export function rowWeight(r: MessageRow): number {
  let n = 200 + r.text.length + r.preview.length + (r.result?.length ?? 0) + (r.logs?.length ?? 0) + (r.skill?.length ?? 0);
  // `text` renders the input, so the input weighs about as much.
  if (r.input !== undefined) n += r.text.length;
  for (const h of r.patch ?? []) for (const l of h.lines) n += l.length + 4;
  for (const s of r.started ?? []) n += rowWeight(s);
  for (const a of r.attachments ?? []) if (a.command) n += JSON.stringify(a.command).length;
  return n;
}

/**
 * Whether drawing the row, before anything in it is opened, shows its text: a message, thinking drawn apart, an
 * error, a subagent's report. A tool call shows only its line until it opens.
 */
export function drawsText(r: MessageRow): boolean {
  return r.kind === 'agent' || r.kind === 'thinking' || r.kind === 'error' || r.kind === 'prompt' || r.kind === 'guidance' || (r.kind === 'tool' && r.tool === HANDBACK_TOOL);
}

/** The row as an older row goes to a phone: brief when it's heavy; the user's own messages always whole (the message box recalls them). */
export function briefChatRow(r: MessageRow): MessageRow {
  if (r.brief || r.kind === 'prompt' || r.kind === 'guidance' || rowWeight(r) <= LIGHT_ROW_CHARS) return r;
  return { ...briefRow(r), brief: true };
}

/** `rows` with the newest whole until `budget` is spent (the one that spends it too), the older ones brief; the same array when none is. */
function windowRows(rows: MessageRow[], budget: number): { rows: MessageRow[]; left: number } {
  let left = budget;
  let out: MessageRow[] | null = null;
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (left > 0) {
      left -= rowWeight(r);
      continue;
    }
    const b = briefChatRow(r);
    if (b === r) continue;
    out ??= rows.slice();
    out[i] = b;
  }
  return { rows: out ?? rows, left };
}

/** The chat's history and rows with the newest `budget` of them (rows, then history) whole and the older ones brief. */
export function windowChat<T extends Pick<ChatState, 'history' | 'rows'>>(state: T, budget = CHAT_TAIL_CHARS): T {
  const rows = windowRows(state.rows, budget);
  const history = windowRows(state.history, rows.left);
  return rows.rows === state.rows && history.rows === state.history ? state : { ...state, rows: rows.rows, history: history.rows };
}

/**
 * A chat event as a phone or tablet gets it: the rows and history it carries whole (its first event, a history read
 * in) windowed as windowChat does; the rows that changed (`delta`) are the newest, and go whole. History that comes
 * without the rows is older than them all, and gets the whole budget, as when the chat's rows are still few.
 */
export function windowWire(wire: ChatWire, budget = CHAT_TAIL_CHARS): ChatWire {
  if (!wire.rows && !wire.history) return wire;
  const rows = wire.rows ? windowRows(wire.rows, budget) : null;
  const history = wire.history ? windowRows(wire.history, rows ? rows.left : budget) : null;
  if ((!rows || rows.rows === wire.rows) && (!history || history.rows === wire.history)) return wire;
  return { ...wire, ...(rows ? { rows: rows.rows } : {}), ...(history ? { history: history.rows } : {}) };
}

/** The whole rows of a chat by id, from its history and rows, in the order asked; ids it doesn't have are left out. */
export function wholeRowsOf(state: Pick<ChatState, 'history' | 'rows'>, ids: readonly string[]): MessageRow[] {
  const want = new Set(ids.slice(0, WHOLE_ROWS_MAX));
  const byId = new Map<string, MessageRow>();
  for (const r of state.history) if (want.has(r.id)) byId.set(r.id, r);
  for (const r of state.rows) if (want.has(r.id)) byId.set(r.id, r);
  return [...want].flatMap((id) => byId.get(id) ?? []);
}

/** The state with its brief rows that `whole` has read replaced by them; the same object (and arrays) when there's none. */
export function fillWhole<T extends Pick<ChatState, 'history' | 'rows'>>(state: T, whole: ReadonlyMap<string, MessageRow> | undefined): T {
  if (!whole?.size) return state;
  const fill = (rows: MessageRow[]): MessageRow[] => {
    let out: MessageRow[] | null = null;
    rows.forEach((r, i) => {
      const w = r.brief ? whole.get(r.id) : undefined;
      if (!w) return;
      out ??= rows.slice();
      out[i] = w;
    });
    return out ?? rows;
  };
  const history = fill(state.history);
  const rows = fill(state.rows);
  return history === state.history && rows === state.rows ? state : { ...state, history, rows };
}
