// No DOM here (the unit tests load this file under the node tsconfig): the IndexedDB side is in offline-idb.ts.
import type { MenuItemSpec, WindowRole } from '../../../shared/remote-access';
import type { ChatState } from '../../../shared/chat';
import { applyChatWire, type ChatWire } from '../../../shared/chat-delta';
import type { EngineEvent } from '../../../shared/types';
import { encodeBytes } from './session';
import { mergeOutput, type OutputRead } from '../../../shared/output-tail';

/**
 * The read-only invoke channels whose answers the phone keeps and shows while the computer is out of reach.
 * Each one only reads (checked against its handler under src/main).
 */
export const READ_CHANNELS: ReadonlySet<string> = new Set([
  'info',
  'tasks:list',
  'projects:list',
  'folders:list',
  'folders:layout',
  'templates:list',
  'recycleBin:list',
  'versions:list',
  'versions:detail',
  'runtime:list',
  'runs:list',
  'runs:recent',
  'runs:output',
  'runs:messages',
  'runs:messageImage',
  'runs:scriptCalls',
  'rest:state',
  'prevent-sleep:state',
  'logins:list',
  'chat:get',
  'sessions:state',
  'sessions:activity',
  'sessions:backgroundOutput',
  'sessions:fileThumbnail',
  'sessions:sentFile',
  'attachment:thumbnail',
  'terminalSession:output',
  'remote:state',
  'remote:lastMessage',
  'remoteAccess:state',
  'addons:list',
  'addons:pane',
  'addons:render',
  'addons:projectTab',
  'run:canGuide',
  'git:repos',
  'git:check',
]);

export const FLUSH_DELAY_MS = 500;
export const SWEEP_DELAY_MS = 30_000;
export const REFRESH_DELAY_MS = 2000;
const LOAD_TIMEOUT_MS = 4000;

/** A window of the shell, as it is kept for the next launch (the iframe's `nonce` isn't). */
export interface StoredWindow {
  w: string;
  role: WindowRole;
  parent?: string;
  modal: boolean;
  hash: string;
  title: string;
  width: number;
  height: number;
  resizable: boolean;
  menu: MenuItemSpec[] | null;
}

export interface StoredShell {
  windows: StoredWindow[];
  /** Window ids, back to front. */
  order: string[];
  focused: string | null;
  minimized: string[];
}

export interface OfflineEntry {
  key: string;
  channel: string;
  args: unknown[];
  /** What the invoke resolved with, decoded. */
  value: unknown;
  /** The connection (welcome) that last read or wrote it. */
  gen: number;
  at: number;
}

export interface OfflineMeta {
  /** The app version that wrote the data; another version finds it invalid. */
  version: string;
  deviceId: string | null;
  shell: StoredShell | null;
  lastLive: number | null;
  gen: number;
}

export interface OfflineBatch {
  put: OfflineEntry[];
  del: string[];
  meta?: OfflineMeta;
  /** Delete every entry first. */
  clear?: boolean;
}

/** Where the entries live between page loads (IndexedDB in the browser, memory in tests). */
export interface OfflineBackend {
  load(): Promise<{ entries: OfflineEntry[]; meta: OfflineMeta | null }>;
  save(batch: OfflineBatch): Promise<void>;
}

export function memoryBackend(): OfflineBackend & { entries: Map<string, OfflineEntry>; meta: OfflineMeta | null } {
  const b = {
    entries: new Map<string, OfflineEntry>(),
    meta: null as OfflineMeta | null,
    async load() {
      return { entries: [...b.entries.values()].map((e) => structuredClone(e)), meta: b.meta ? structuredClone(b.meta) : null };
    },
    async save(batch: OfflineBatch) {
      if (batch.clear) b.entries.clear();
      for (const k of batch.del) b.entries.delete(k);
      for (const e of batch.put) b.entries.set(e.key, structuredClone(e));
      if (batch.meta) b.meta = structuredClone(batch.meta);
    },
  };
  return b;
}

export const entryKey = (channel: string, args: unknown[]): string => `${channel}\0${JSON.stringify(encodeBytes(args))}`;

const emptyMeta = (version: string): OfflineMeta => ({ version, deviceId: null, shell: null, lastLive: null, gen: 0 });

// Channels whose first argument is a chat or session id.
const SESSION_KEYED = new Set(['chat:get', 'sessions:activity', 'sessions:backgroundOutput', 'terminalSession:output']);

/**
 * A background command's output comes a piece at a time (its third argument is the size the reader has): one entry
 * per command, keyed without that size, holds all of it the phone has read, and grows with each piece.
 */
const OUTPUT_CHANNEL = 'sessions:backgroundOutput';
// A subagent's rows are read with the version the reader holds (a fifth argument): the entry is the same for every one, and an "unchanged" answer has no rows to keep.
const MESSAGES_CHANNEL = 'runs:messages';
const storedArgs = (channel: string, args: unknown[]): unknown[] => (channel === OUTPUT_CHANNEL ? args.slice(0, 2) : channel === MESSAGES_CHANNEL ? args.slice(0, 4) : args);
const isUnchanged = (v: unknown): boolean => !!v && typeof v === 'object' && (v as { unchanged?: unknown }).unchanged === true;
const isOutput = (v: unknown): v is OutputRead => !!v && typeof v === 'object' && typeof (v as OutputRead).end === 'number' && typeof (v as OutputRead).from === 'number';
const utf8Length = (s: string): number => new TextEncoder().encode(s).length;

/** The kept output with a new piece added (or in its place, when it doesn't follow on). */
function withPiece(kept: unknown, piece: OutputRead): OutputRead {
  const prev = isOutput(kept) ? { end: kept.end, text: kept.text ?? '', cut: kept.from > 0 } : null;
  const next = mergeOutput(prev, piece);
  return { end: next.end, from: next.end - utf8Length(next.text), text: next.text };
}
// Channels whose first argument is a task id.
const TASK_KEYED = new Set(['runs:list', 'versions:list', 'versions:detail', 'runs:output', 'runs:messages', 'runs:messageImage', 'runs:scriptCalls', 'run:canGuide']);
// Channels whose second argument is a run id (a session's id for its subagents' transcripts).
const RUN_KEYED = new Set(['runs:output', 'runs:messages', 'runs:messageImage', 'runs:scriptCalls', 'run:canGuide']);
// Kept while the task they belong to exists, whatever connection last read them.
const SWEPT_BY_OWNER = new Set([...SESSION_KEYED, ...TASK_KEYED].filter((c) => c !== 'versions:detail'));

interface Refresher {
  (w: string, channel: string, args: unknown[]): void;
}

type Listish = Array<Record<string, unknown>>;

export class OfflineStore {
  private readonly entries = new Map<string, OfflineEntry>();
  private readonly byChannel = new Map<string, Set<string>>();
  private readonly dirty = new Set<string>();
  private readonly deleted = new Set<string>();
  private metaDirty = false;
  private cleared = false;
  private meta: OfflineMeta;
  private gen = 0;
  private connected = false;
  /** The channels (read without arguments) that were answered or updated in this connection. */
  private readonly received = new Set<string>();
  private readonly lastWindow = new Map<string, string>();
  private readonly refreshKeys = new Set<string>();
  private refresher: Refresher | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private sweepTimer: ReturnType<typeof setTimeout> | null = null;
  private saving: Promise<void> = Promise.resolve();

  private constructor(
    version: string,
    private readonly backend: OfflineBackend | null,
  ) {
    this.meta = emptyMeta(version);
  }

  /**
   * Loads what an earlier page load kept. Without a working backend (private
   * browsing) the store lives in memory only; data of another app version is
   * dropped, as old formats are never read.
   */
  static async open(opts: { version: string; backend?: OfflineBackend | null; loadTimeoutMs?: number }): Promise<OfflineStore> {
    let backend = opts.backend ?? null;
    let loaded: { entries: OfflineEntry[]; meta: OfflineMeta | null } = { entries: [], meta: null };
    if (backend) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        loaded = await Promise.race([
          backend.load(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('IndexedDB did not answer')), opts.loadTimeoutMs ?? LOAD_TIMEOUT_MS);
          }),
        ]);
      } catch {
        backend = null;
      } finally {
        clearTimeout(timer);
      }
    }
    const store = new OfflineStore(opts.version, backend);
    if (loaded.meta && loaded.meta.version === opts.version) {
      store.meta = { ...emptyMeta(opts.version), ...loaded.meta };
      store.gen = store.meta.gen;
      for (const e of loaded.entries) store.index(e);
    } else {
      // The first write also records which version wrote the entries.
      store.cleared = !!loaded.meta || loaded.entries.length > 0;
      store.metaDirty = true;
      if (store.cleared) store.scheduleFlush();
    }
    return store;
  }

  // ----- reading and writing -----

  reads(channel: string): boolean {
    return READ_CHANNELS.has(channel);
  }

  /** The stored answer; reading it counts as using it in this connection. */
  get(channel: string, args: unknown[], w?: string): { value: unknown } | undefined {
    const key = entryKey(channel, storedArgs(channel, args));
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (e.gen !== this.gen) {
      e.gen = this.gen;
      this.touch(e);
    }
    if (w) this.lastWindow.set(key, w);
    // A reader that has all of the kept output gets nothing new; any other gets all of it.
    if (channel === OUTPUT_CHANNEL && isOutput(e.value) && args[2] === e.value.end) return { value: { end: e.value.end, from: e.value.end } };
    return { value: e.value };
  }

  put(channel: string, args: unknown[], value: unknown, w?: string): void {
    if (channel === MESSAGES_CHANNEL) {
      if (isUnchanged(value)) return;
      args = storedArgs(channel, args);
    }
    if (channel === OUTPUT_CHANNEL) {
      // Unreadable now: what was kept stays.
      if (!isOutput(value)) return;
      args = storedArgs(channel, args);
      value = withPiece(this.entries.get(entryKey(channel, args))?.value, value);
    }
    const key = entryKey(channel, args);
    const e: OfflineEntry = { key, channel, args, value, gen: this.gen, at: Date.now() };
    this.index(e);
    this.touch(e);
    if (w) this.lastWindow.set(key, w);
    if (this.connected && args.length === 0) this.received.add(channel);
  }

  keys(channel?: string): OfflineEntry[] {
    const all = channel ? [...(this.byChannel.get(channel) ?? [])] : [...this.entries.keys()];
    return all.map((k) => this.entries.get(k)!);
  }

  get size(): number {
    return this.entries.size;
  }

  private index(e: OfflineEntry): void {
    this.entries.set(e.key, e);
    let set = this.byChannel.get(e.channel);
    if (!set) this.byChannel.set(e.channel, (set = new Set()));
    set.add(e.key);
  }

  private touch(e: OfflineEntry): void {
    this.dirty.add(e.key);
    this.deleted.delete(e.key);
    this.scheduleFlush();
  }

  private remove(key: string): void {
    const e = this.entries.get(key);
    if (!e) return;
    this.entries.delete(key);
    this.byChannel.get(e.channel)?.delete(key);
    this.lastWindow.delete(key);
    this.refreshKeys.delete(key);
    this.dirty.delete(key);
    this.deleted.add(key);
    this.scheduleFlush();
  }

  // ----- events -----

  /** An engine event updates the answers already stored; it never makes one. */
  applyEvent(ev: EngineEvent): void {
    switch (ev.type) {
      case 'tasks':
        return this.update('tasks:list', [], () => ev.tasks);
      case 'projects':
        return this.update('projects:list', [], () => ev.projects);
      case 'recycleBin':
        return this.update('recycleBin:list', [], () => ev.entries);
      case 'folders':
        this.update('folders:list', [], () => ev.folders);
        return this.update('folders:layout', [], () => ev.layout);
      case 'templates':
        return this.update('templates:list', [], () => ev.templates);
      case 'chat':
        // The event holds what changed (chat-delta.ts); one that can't be applied leaves the kept answer for the next read to renew.
        return this.update('chat:get', [ev.state.id], (old) => applyChatWire(old as ChatState | null, ev.state as unknown as ChatWire) ?? old);
      case 'sessions':
        return this.update('sessions:state', [], () => ev.state);
      case 'session:activity':
        return this.update('sessions:activity', [ev.activity.id], () => ev.activity);
      case 'rest':
        return this.update('rest:state', [], () => ev.rest);
      case 'prevent-sleep':
        return this.update('prevent-sleep:state', [], () => ev.state);
      case 'logins':
        return this.update('logins:list', [], () => ev.logins);
      case 'remote':
        return this.update('remote:state', [], () => ev.state);
      case 'remote-access':
        return this.update('remoteAccess:state', [], () => ev.state);
      case 'settings':
        return this.update('info', [], (old) => (old && typeof old === 'object' && 'settings' in old ? { ...old, settings: ev.settings } : old));
      case 'runtime':
        return this.update('runtime:list', [], (old) => {
          if (!Array.isArray(old)) return old;
          const list = old as Listish;
          const at = list.findIndex((r) => r.taskId === ev.runtime.taskId);
          return at === -1 ? [...list, ev.runtime] : list.map((r, i) => (i === at ? ev.runtime : r));
        });
      case 'record':
        return this.refreshLater(['runs:list', 'runs:output', 'runs:messages'], ev.record.taskId, ['runs:recent']);
      case 'versions':
        return this.refreshLater(['versions:list', 'versions:detail'], ev.taskId, []);
      default:
        return;
    }
  }

  private update(channel: string, args: unknown[], next: (old: unknown) => unknown): void {
    const e = this.entries.get(entryKey(channel, args));
    if (!e) return;
    e.value = next(e.value);
    e.at = Date.now();
    this.touch(e);
    if (this.connected && args.length === 0) this.received.add(channel);
  }

  /** Re-asks the answers a change affects, through the window that last read each, once the changes stop for a moment. */
  private refreshLater(perTask: string[], taskId: string, everyKey: string[]): void {
    for (const channel of perTask) for (const e of this.keys(channel)) if (e.args[0] === taskId) this.refreshKeys.add(e.key);
    for (const channel of everyKey) for (const e of this.keys(channel)) this.refreshKeys.add(e.key);
    if (!this.refreshKeys.size) return;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      const keys = [...this.refreshKeys];
      this.refreshKeys.clear();
      for (const key of keys) {
        const e = this.entries.get(key);
        const w = this.lastWindow.get(key);
        if (e && w) this.refresher?.(w, e.channel, e.args);
      }
    }, REFRESH_DELAY_MS);
  }

  /** What re-asks an answer: it does nothing when the window is gone or the connection is down. */
  setRefresher(fn: Refresher): void {
    this.refresher = fn;
  }

  // ----- connections -----

  /** The server welcomed this device. Another device than the one the data belongs to finds it empty. */
  welcome(deviceId: string): void {
    this.connected = true;
    this.received.clear();
    if (this.meta.deviceId && this.meta.deviceId !== deviceId) this.wipe();
    this.meta.deviceId = deviceId;
    this.meta.gen = ++this.gen;
    this.metaDirty = true;
    this.scheduleFlush();
    if (this.sweepTimer) clearTimeout(this.sweepTimer);
    this.sweepTimer = setTimeout(() => {
      this.sweepTimer = null;
      this.sweep();
    }, SWEEP_DELAY_MS);
  }

  disconnected(lastLive?: number): void {
    this.connected = false;
    if (this.sweepTimer) clearTimeout(this.sweepTimer);
    this.sweepTimer = null;
    if (lastLive !== undefined) this.setLastLive(lastLive);
  }

  /**
   * Drops what this connection no longer uses: chats' answers for chats that
   * are gone, per-task answers for tasks that are gone, runs' answers for runs
   * no list names, and other keyed answers nothing read in this connection.
   * A rule that needs the sessions or the tasks runs only when this
   * connection received that list. Answers without arguments (the lists) stay.
   */
  sweep(): void {
    if (!this.connected) return;
    const storedSessions = (this.value('sessions:state', []) as { sessions?: Listish } | undefined)?.sessions ?? [];
    const chatIds = this.received.has('sessions:state') ? new Set(storedSessions.map((s) => s.id as string)) : null;
    const tasks = this.received.has('tasks:list') ? ((this.value('tasks:list', []) as Listish | undefined) ?? null) : null;
    // A chat's own task isn't in the task list, so the sessions' tasks count too.
    const taskIds = tasks ? new Set([...tasks.map((t) => t.id as string), ...storedSessions.map((s) => s.taskId as string)]) : null;
    const runIds = new Set<string>(storedSessions.map((s) => s.id as string));
    for (const channel of ['runs:list', 'runs:recent']) for (const e of this.keys(channel)) for (const r of (e.value as Listish | undefined) ?? []) runIds.add(r.runId as string);
    for (const rt of (this.value('runtime:list', []) as Listish | undefined) ?? []) {
      if (typeof rt.lastRunId === 'string') runIds.add(rt.lastRunId);
      for (const r of (rt.runs as Listish | undefined) ?? []) runIds.add(r.runId as string);
    }
    for (const c of (this.value('remote:state', []) as { conversations?: Listish } | undefined)?.conversations ?? []) runIds.add(c.id as string);

    const doomed: string[] = [];
    for (const e of this.entries.values()) {
      if (e.args.length === 0) continue;
      const owner = e.args[0];
      let drop = false;
      if (SESSION_KEYED.has(e.channel)) drop = !!chatIds && !chatIds.has(owner as string);
      if (!drop && TASK_KEYED.has(e.channel)) drop = !!taskIds && !taskIds.has(owner as string);
      if (!drop && RUN_KEYED.has(e.channel) && typeof e.args[1] === 'string') drop = !runIds.has(e.args[1]);
      if (!drop && !SWEPT_BY_OWNER.has(e.channel)) drop = e.gen !== this.gen;
      if (drop) doomed.push(e.key);
    }
    for (const key of doomed) this.remove(key);
  }

  private value(channel: string, args: unknown[]): unknown {
    return this.entries.get(entryKey(channel, args))?.value;
  }

  // ----- meta -----

  shell(): StoredShell | null {
    return this.meta.shell;
  }

  setShell(shell: StoredShell | null): void {
    this.meta.shell = shell;
    this.metaDirty = true;
    this.scheduleFlush();
  }

  lastLive(): number | null {
    return this.meta.lastLive;
  }

  setLastLive(at: number): void {
    if (this.meta.lastLive === at) return;
    this.meta.lastLive = at;
    this.metaDirty = true;
    this.scheduleFlush();
  }

  // ----- persistence -----

  private wipe(): void {
    this.entries.clear();
    this.byChannel.clear();
    this.lastWindow.clear();
    this.refreshKeys.clear();
    this.dirty.clear();
    this.deleted.clear();
    this.received.clear();
    this.cleared = true;
    this.meta.shell = null;
    this.meta.lastLive = null;
    this.metaDirty = true;
  }

  /** Delete everything kept (this device was unpaired). */
  async clear(): Promise<void> {
    this.wipe();
    this.meta.deviceId = null;
    return this.flush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer || !this.backend) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, FLUSH_DELAY_MS);
  }

  /** Write what changed since the last write. Also runs when the page is hidden. */
  flush(): Promise<void> {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    const backend = this.backend;
    if (!backend || (!this.dirty.size && !this.deleted.size && !this.metaDirty && !this.cleared)) return this.saving;
    const batch: OfflineBatch = {
      put: [...this.dirty].map((k) => this.entries.get(k)!).filter(Boolean),
      del: [...this.deleted],
      ...(this.metaDirty ? { meta: structuredClone(this.meta) } : {}),
      ...(this.cleared ? { clear: true } : {}),
    };
    this.dirty.clear();
    this.deleted.clear();
    this.metaDirty = false;
    this.cleared = false;
    this.saving = this.saving.then(() => backend.save(batch)).catch(() => undefined);
    return this.saving;
  }
}
