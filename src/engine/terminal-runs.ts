import fs from 'node:fs';
import path from 'node:path';
import { chatTitle, type TerminalInfo } from '../shared/chat';
import type { MessageRow } from '../shared/messages';
import type { RunRecord } from '../shared/types';
import { errMsg, type Logger } from './log';
import { readRunSessionId } from './messages';
import { writeJsonAtomic } from './store/fsutil';

const POLL_MS = 1500;

export interface TerminalRunsDeps {
  runDir: (taskId: string, runId: string) => string;
  /** The conversation the run recorded, as rows (its first message titles the run). */
  readHistory: (taskId: string, runId: string) => Promise<MessageRow[]>;
  writeInfo: (taskId: string, runId: string, info: TerminalInfo) => void;
  appendRecord: (record: RunRecord) => void;
  taskVersion: (taskId: string) => number | undefined;
  log: Logger;
  pollMs?: number;
}

export interface TerminalRunOpts {
  taskId: string;
  runId: string;
  harnessKind: 'claude-code' | 'codex';
  /** Continue in Terminal on a terminal session's run: what the run recorded before. */
  info?: TerminalInfo;
  /** Continue in Terminal on another run: the run whose conversation the session goes on with. */
  fromRunId?: string;
}

interface Watch extends TerminalRunOpts {
  dir: string;
  /** stop.json's time when the window opened (an earlier window's last turn), null when there was none. */
  initialTurn: number | null;
  /** The session is a run: it had a turn, now or when it was opened before. */
  recorded: boolean;
  /** When this window's first turn made its "Terminal opened" record. */
  openedAt?: number;
  timer: NodeJS.Timeout;
  /** The first turn is being recorded (the title is read from the transcript). */
  busy: boolean;
  /** The window closed while its first turn was being recorded: the run closes once it is. */
  closing?: boolean;
}

/** When the hooks last wrote a finished turn into the folder; null before any. */
function turnTime(dir: string): number | null {
  try {
    return fs.statSync(path.join(dir, 'stop.json')).mtimeMs;
  } catch {
    return null;
  }
}

/** codex's TUI names the session in a side thread; its notify isn't a turn of the user's. */
const isTitleThread = (payload: Record<string, unknown>): boolean => {
  const inputs = payload['input-messages'];
  return Array.isArray(inputs) && typeof inputs[0] === 'string' && inputs[0].startsWith('Generate a concise, single-line task title');
};

/**
 * Looper terminal windows (Open Project in Terminal, Continue in Terminal) as
 * runs of their task. The launcher's hooks write each finished turn into the
 * run folder (stop.json); the window's first one makes the session a run:
 * terminal.json, a "Terminal opened" record, and for Codex the thread id the
 * run window and Continue read. Closing the window adds "Terminal closed"; a
 * session that never had a turn leaves no folder.
 */
export class TerminalRuns {
  private readonly watches = new Map<string, Watch>();

  constructor(private readonly d: TerminalRunsDeps) {}

  start(opts: TerminalRunOpts): void {
    const dir = this.d.runDir(opts.taskId, opts.runId);
    const watch: Watch = {
      ...opts,
      fromRunId: opts.fromRunId ?? opts.info?.fromRunId,
      dir,
      initialTurn: turnTime(dir),
      recorded: !!opts.info,
      busy: false,
      timer: setInterval(() => void this.poll(watch), this.d.pollMs ?? POLL_MS),
    };
    this.watches.set(opts.runId, watch);
  }

  /** The open window holding a run's conversation: the run's own, one going on with it, or one on the same session. */
  findOpen(taskId: string, runId: string, sessionId: string): string | undefined {
    for (const w of this.watches.values()) {
      if (w.taskId !== taskId) continue;
      if (w.runId === runId || w.fromRunId === runId || readRunSessionId(w.dir, w.harnessKind) === sessionId) return w.runId;
    }
    return undefined;
  }

  /** The open windows' runs: run-log pruning leaves them alone. */
  openIds(): Set<string> {
    return new Set(this.watches.keys());
  }

  hasOpen(taskId: string): boolean {
    return [...this.watches.values()].some((w) => w.taskId === taskId);
  }

  /** The window closed: the session ends. */
  close(runId: string): void {
    const w = this.watches.get(runId);
    if (!w) return;
    clearInterval(w.timer);
    this.watches.delete(runId);
    if (w.busy) w.closing = true;
    else if (w.openedAt !== undefined) this.record(w, 'closed', Date.now() - w.openedAt);
    else if (this.hasNewTurn(w)) {
      // The first turn ended before the poll saw it: the session is still a run.
      w.closing = true;
      void this.recordFirstTurn(w).then((ok) => {
        if (!ok && !w.recorded) this.remove(w);
      });
    } else if (!w.recorded) this.remove(w);
  }

  closeAll(): void {
    for (const id of [...this.watches.keys()]) this.close(id);
  }

  private remove(w: Watch): void {
    try {
      fs.rmSync(w.dir, { recursive: true, force: true });
    } catch (err) {
      this.d.log.warn(`terminal ${w.runId}: cannot delete ${w.dir}: ${errMsg(err)}`);
    }
  }

  /** A turn of this window: an earlier window's last one is the file as it was when this one opened. */
  private hasNewTurn(w: Watch): boolean {
    const time = turnTime(w.dir);
    return time !== null && time !== w.initialTurn;
  }

  private async poll(w: Watch): Promise<void> {
    if (w.busy || w.openedAt !== undefined) return;
    await this.recordFirstTurn(w);
  }

  /** The window's first turn, once its hook wrote it: the session becomes a run. False when there's none to record yet. */
  private async recordFirstTurn(w: Watch): Promise<boolean> {
    if (!this.hasNewTurn(w)) return false;
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(fs.readFileSync(path.join(w.dir, 'stop.json'), 'utf8').replace(/^﻿/, '')) as Record<string, unknown>;
    } catch {
      return false; // the hook is still writing
    }
    if (w.harnessKind === 'codex') {
      if (isTitleThread(payload)) return false;
      const tid = payload['thread-id'];
      if (typeof tid !== 'string' || !tid) return false;
      writeJsonAtomic(path.join(w.dir, 'codex-session.json'), { thread_id: tid });
    }
    w.busy = true;
    try {
      await this.opened(w);
    } finally {
      w.busy = false;
    }
    return true;
  }

  /** The window's first turn: the session is a run, with a "Terminal opened" record. */
  private async opened(w: Watch): Promise<void> {
    let title = w.info?.title;
    if (!title) {
      const rows = await this.d.readHistory(w.taskId, w.runId).catch(() => [] as MessageRow[]);
      title = rows.some((r) => r.kind === 'prompt') ? chatTitle(rows) : 'Terminal session';
    }
    w.openedAt = Date.now();
    w.recorded = true;
    w.info = { harnessKind: w.harnessKind, title, ...(w.fromRunId ? { fromRunId: w.fromRunId } : {}) };
    try {
      this.d.writeInfo(w.taskId, w.runId, w.info);
    } catch (err) {
      this.d.log.warn(`terminal ${w.runId}: cannot save: ${errMsg(err)}`);
    }
    this.record(w, 'opened');
    if (w.closing) this.record(w, 'closed', 0);
  }

  private record(w: Watch, event: 'opened' | 'closed', durationMs?: number): void {
    const version = this.d.taskVersion(w.taskId);
    this.d.appendRecord({
      ts: new Date().toISOString(),
      taskId: w.taskId,
      runId: w.runId,
      phase: 'terminal',
      result: 'terminal',
      summary: w.info?.title ?? 'Terminal session',
      ...(durationMs !== undefined ? { durationMs } : {}),
      detail: { event, ...(w.fromRunId ? { fromRunId: w.fromRunId } : {}) },
      ...(version !== undefined ? { taskVersion: version } : {}),
    });
  }
}
