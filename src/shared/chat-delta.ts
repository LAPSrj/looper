import type { ChatState } from './chat';
import type { MessageRow } from './messages';

/**
 * A chat's state as its `chat` events carry it: a working chat changes every 100 ms, and sending its whole
 * conversation (up to 1,000 rows, 1-2 MB) each time cost the main process, every window showing it and every
 * phone a copy of all of it. The event carries `seq`, the history only when it changed, and either every row
 * (`rows`) or the rows' ids in order with only the rows that are new or changed since the event before (`delta`).
 * A page rebuilds the whole state from the one it has (applyChatWire), keeping its unchanged rows as they were.
 */
export interface ChatWire extends Omit<ChatState, 'history' | 'rows'> {
  /** Which encoder made it: a chat closed and opened again gets a new one, whose `seq` starts over. */
  epoch: number;
  seq: number;
  history?: MessageRow[];
  rows?: MessageRow[];
  delta?: { ids: string[]; changed: MessageRow[] };
  /** Fields left out because they're as in the event before (the slash commands alone are about 29 KB). */
  kept?: (typeof KEPT_FIELDS)[number][];
}

/** The state's large fields that seldom change, sent only when they do. */
const KEPT_FIELDS = ['commands', 'models', 'harnesses', 'modelWindows', 'subagentMessages'] as const;

/**
 * What a row shows, cheaply: its rows only grow at their end (streamed text, a result) or change state, so the
 * lengths, the last characters and the state fields find every change the accumulators make.
 */
export function rowSignature(r: MessageRow): string {
  const tail = (s: string | undefined) => (s === undefined ? '-' : `${s.length}:${s.slice(-24)}`);
  return [
    r.kind,
    tail(r.text),
    tail(r.result),
    tail(r.preview),
    r.resultError ? 1 : 0,
    r.background ? `${r.background.status}:${tail(r.background.summary)}:${r.background.outputFile ?? ''}` : '',
    r.agentId ?? '',
    r.patch?.length ?? '',
    r.sent ? `${r.sent.files.length}:${tail(r.sent.caption)}` : '',
    tail(r.skill),
    r.image?.mediaType ?? '',
    r.file ?? '',
    // A "!" command's output is filled into the prompt's last attachment in place.
    r.attachments?.length ? `${r.attachments.length}:${JSON.stringify(r.attachments.at(-1)).length}` : '',
    r.input === undefined ? 0 : 1,
  ].join('|');
}

const historyKey = (h: MessageRow[]) => `${h.length}:${h[0]?.id ?? ''}:${h.at(-1)?.id ?? ''}`;

let encoders = 0;

/** The main process's side: one per chat, making each of its states into the event that carries it. */
export class ChatEncoder {
  readonly epoch = ++encoders;
  seq = 0;
  private sigs = new Map<string, string>();
  private history: string | null = null;
  private fields = new Map<string, string | undefined>();

  encode(state: ChatState): ChatWire {
    const { history, rows, ...rest } = state;
    this.seq++;
    const key = historyKey(history);
    const out: ChatWire = { ...rest, epoch: this.epoch, seq: this.seq };
    if (key !== this.history) out.history = history;
    this.history = key;
    const first = this.seq === 1;
    const kept: (typeof KEPT_FIELDS)[number][] = [];
    for (const f of KEPT_FIELDS) {
      const json = JSON.stringify(state[f]);
      if (!first && json === this.fields.get(f)) {
        delete out[f];
        kept.push(f);
      }
      this.fields.set(f, json);
    }
    if (kept.length) out.kept = kept;
    const sigs = new Map<string, string>();
    const changed: MessageRow[] = [];
    for (const r of rows) {
      const sig = rowSignature(r);
      sigs.set(r.id, sig);
      if (first || this.sigs.get(r.id) !== sig) changed.push(r);
    }
    this.sigs = sigs;
    if (first) out.rows = rows;
    else out.delta = { ids: rows.map((r) => r.id), changed };
    return out;
  }
}

/**
 * The whole state from the state a page has and the next event, its unchanged rows the same objects; null when
 * the event can't be applied to it (the page missed an event, or has none to start from) and the page must read
 * the chat again.
 */
export function applyChatWire(prev: ChatState | null | undefined, wire: ChatWire): ChatState | null {
  const { history, rows, delta, kept, ...fields } = wire;
  const base = prev && prev.id === wire.id ? prev : null;
  const hist = history ?? base?.history;
  if (!hist) return null;
  if (rows && !kept) return { ...fields, history: hist, rows };
  if (!base || base.epoch !== wire.epoch || base.seq !== wire.seq - 1) return null;
  const rest = { ...fields } as Omit<ChatState, 'history' | 'rows'>;
  for (const f of kept ?? []) (rest as Record<string, unknown>)[f] = base[f];
  if (rows) return { ...rest, history: hist, rows };
  if (!delta) return null;
  const byId = new Map<string, MessageRow>();
  for (const r of base.rows) byId.set(r.id, r);
  for (const r of delta.changed) byId.set(r.id, r);
  const next: MessageRow[] = [];
  for (const id of delta.ids) {
    const r = byId.get(id);
    if (!r) return null;
    next.push(r);
  }
  return { ...rest, history: hist, rows: next };
}
