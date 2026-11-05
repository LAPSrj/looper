import { bareId } from '../shared/model-update';
import { readJson, writeJsonAtomic } from './store/fsutil';

type Rec = Record<string, unknown>;
const obj = (v: unknown): Rec | null => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : null);

/** Every model's context window in claude's `result` record (its subagents' models too), by the model id without a `[1m]` suffix. */
export function claudeModelWindows(result: Rec): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [model, entry] of Object.entries(obj(result.modelUsage) ?? {})) {
    const w = obj(entry)?.contextWindow;
    if (typeof w === 'number' && w > 0) out[bareId(model)] = w;
  }
  return out;
}

/**
 * The context windows Claude's result records have named, kept across
 * restarts: transcripts don't say how large a model's window is, so a terminal
 * session's, a task run's and a past conversation's subagents get theirs from
 * what chats and headless runs reported. A model keeps every window it has run
 * with (200k, and 1M with `[1m]`), by its id without the suffix.
 */
export class ModelWindows {
  private windows: Record<string, number[]> = {};
  private file?: string;

  /** Read the saved windows; `learn` saves to the same file from now on. */
  open(file: string): void {
    this.file = file;
    const saved = obj(readJson<unknown>(file, {})) ?? {};
    this.windows = {};
    for (const [model, list] of Object.entries(saved)) {
      const ws = Array.isArray(list) ? list.filter((w): w is number => typeof w === 'number' && w > 0) : [];
      if (ws.length) this.windows[model] = [...new Set(ws)].sort((a, b) => a - b);
    }
  }

  /** Windows a result record named (claudeModelWindows); saved when one is new. */
  learn(found: Record<string, number>): void {
    let changed = false;
    for (const [model, w] of Object.entries(found)) {
      const ws = this.windows[model] ?? [];
      if (ws.includes(w)) continue;
      this.windows[model] = [...ws, w].sort((a, b) => a - b);
      changed = true;
    }
    if (changed && this.file) writeJsonAtomic(this.file, this.windows);
  }

  /** A model's window for a context of `tokens`: the smallest known one that holds it, else the largest; undefined for a model never seen. */
  pick(model: string, tokens: number): number | undefined {
    const ws = this.windows[bareId(model)];
    if (!ws) return undefined;
    return ws.find((w) => w >= tokens) ?? ws[ws.length - 1];
  }
}

/** Looper's one store: the engine opens it in the data dir, and chats and headless runs teach it. */
export const modelWindows = new ModelWindows();
