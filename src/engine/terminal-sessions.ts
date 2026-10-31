import fs from 'node:fs';
import type { EngineEvent } from '../shared/types';
import type { Logger } from './log';
import { spawnPty, type SessionProc } from './steps/session';
import type { SpawnSpec } from './target';
import { killHostTree } from './target/kill';

/** Bytes of a session's output kept for a window that opens or reloads after it started. */
const OUTPUT_BYTES = 262144;

/** How to start one session, known once its id is: the launcher is written under that id. */
export interface TerminalSessionSpec {
  spec: SpawnSpec;
  /** Host directory the pty starts in (the launcher changes to the task's own directory). */
  cwd: string;
  /** Host path of the launcher, deleted when the session closes. */
  launcher: string;
}

export interface TerminalSessionsDeps {
  emit: (e: EngineEvent) => void;
  log: Logger;
  /** Tests replace the pty. */
  spawn?: (spec: SpawnSpec, cwd: string) => SessionProc;
}

interface Session {
  taskId: string;
  proc: SessionProc | null;
  output: string;
  launcher: string;
  startedAt: number;
  /** Opened again at Looper's start, its harness not running: the first input starts it (see restore). */
  wake?: () => void;
  /** Its harness started again after a restore: the session keeps its place in the list and its output. */
  restored?: boolean;
  /** The size the window asked for while nothing ran: the harness gets it once it starts. */
  size?: { cols: number; rows: number };
}

/**
 * Terminal sessions in Looper (Open Project in Terminal and Continue in
 * Terminal, with the Looper terminal setting, and Remote Control's
 * conversations): the task's harness in a pty, typed into by the user. It has
 * no time limits or done signal, and it ends when it's closed. TerminalRuns
 * records it as a run.
 */
export class TerminalSessions {
  private readonly sessions = new Map<string, Session>();
  private seq = 0;

  constructor(private readonly d: TerminalSessionsDeps) {}

  /** Start a session for the task; `prepare` writes its launcher. `id` (its run id) defaults to a new one. Returns the session id. */
  start(taskId: string, prepare: (id: string) => TerminalSessionSpec, id = `${taskId}-${Date.now().toString(36)}${(++this.seq).toString(36)}`): string {
    const { spec, cwd, launcher } = prepare(id);
    let proc: SessionProc;
    try {
      proc = (this.d.spawn ?? spawnPty)(spec, cwd);
    } catch (err) {
      removeFile(launcher);
      throw err;
    }
    // A restored session's harness starting again: it stays where the list had it, after the output it had.
    const prev = this.sessions.get(id);
    const was = prev?.restored && !prev.proc ? prev : undefined;
    const session: Session = { taskId, proc, output: was?.output ?? '', launcher, startedAt: was?.startedAt ?? Date.now() };
    this.sessions.set(id, session);
    if (was?.size) this.resize(id, was.size.cols, was.size.rows);
    // A closed session whose id a new one took (a restarted Remote Control conversation) speaks for it no longer.
    const replaced = () => {
      const now = this.sessions.get(id);
      return !!now && now !== session;
    };
    proc.onStdout((data) => {
      session.output = (session.output + data).slice(-OUTPUT_BYTES);
      if (!replaced()) this.d.emit({ type: 'terminal:data', id, data });
    });
    proc.onExit(() => {
      session.proc = null;
      if (replaced()) return;
      removeFile(launcher);
      this.d.emit({ type: 'terminal:end', id });
    });
    this.d.log.info(`[${taskId}] opened terminal session ${id}: ${spec.command} ${spec.args.join(' ')}`);
    return id;
  }

  /**
   * A session that was open when Looper quit, listed again with the output it
   * had, its harness not running. The first input typed into it calls `wake`,
   * which starts the harness again under the same id (start); the input
   * itself isn't sent, since the harness isn't there yet to read it. A wake
   * that throws ends the session with the reason.
   */
  restore(id: string, taskId: string, startedAt: number, output: string, wake: () => void): void {
    this.sessions.set(id, { taskId, proc: null, output, launcher: '', startedAt, wake, restored: true });
  }

  /** Quitting Looper stopped its harness: a key typed into it starts it again. */
  isStopped(id: string): boolean {
    const s = this.sessions.get(id);
    return !!s && !s.proc && !!s.wake;
  }

  write(id: string, data: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    if (s.proc) {
      s.proc.write(data);
      return;
    }
    const wake = s.wake;
    if (!wake) return;
    s.wake = undefined;
    try {
      wake();
    } catch (err) {
      const text = `\r\n${err instanceof Error ? err.message : String(err)}\r\n`;
      s.output = (s.output + text).slice(-OUTPUT_BYTES);
      this.d.log.warn(`[${s.taskId}] cannot start terminal session ${id} again: ${text.trim()}`);
      this.d.emit({ type: 'terminal:data', id, data: text });
      this.d.emit({ type: 'terminal:end', id });
    }
  }

  resize(id: string, cols: number, rows: number): void {
    const s = this.sessions.get(id);
    if (s && !s.proc) s.size = { cols, rows };
    try {
      s?.proc?.resize(cols, rows);
    } catch {
      /* the pty is gone */
    }
  }

  /** The output so far, and whether the session has ended or quitting stopped it. Null for an unknown or closed session. */
  output(id: string): { data: string; ended: boolean; stopped?: boolean } | null {
    const s = this.sessions.get(id);
    if (!s) return null;
    return { data: s.output, ended: !s.proc && !s.wake, ...(this.isStopped(id) ? { stopped: true } : {}) };
  }

  /** The open sessions, oldest first. */
  list(): { id: string; taskId: string; startedAt: number; ended: boolean; stopped: boolean }[] {
    return [...this.sessions].map(([id, s]) => ({ id, taskId: s.taskId, startedAt: s.startedAt, ended: !s.proc && !s.wake, stopped: !s.proc && !!s.wake }));
  }

  /** The task a session belongs to; undefined once it's closed. */
  taskOf(id: string): string | undefined {
    return this.sessions.get(id)?.taskId;
  }

  /** Sessions still running (their window is open and the harness hasn't exited). */
  running(): number {
    let n = 0;
    for (const s of this.sessions.values()) if (s.proc) n += 1;
    return n;
  }

  /** End the session (its window closed) and forget it. */
  close(id: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    const proc = s.proc;
    s.proc = null;
    if (proc) {
      // On Windows the pty's own kill leaves wsl.exe or the harness behind: take the whole tree.
      if (process.platform === 'win32' && proc.pid) void killHostTree(proc.pid);
      try {
        proc.kill();
      } catch {
        /* already gone */
      }
    }
    removeFile(s.launcher);
  }

  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.close(id);
  }
}

function removeFile(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* it stays behind; the next session of the task writes its own */
  }
}
