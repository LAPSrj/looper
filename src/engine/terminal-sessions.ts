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
}

/**
 * Terminal sessions in Looper's own windows (Open Project in Terminal and
 * Continue in Terminal, with the Looper terminal setting): the task's harness
 * in a pty, typed into by the user. A session isn't a run: it has no time
 * limits, records or done signal, and it ends when its window closes.
 */
export class TerminalSessions {
  private readonly sessions = new Map<string, Session>();
  private seq = 0;

  constructor(private readonly d: TerminalSessionsDeps) {}

  /** Start a session for the task; `prepare` writes its launcher. Returns the session id. */
  start(taskId: string, prepare: (id: string) => TerminalSessionSpec): string {
    const id = `${taskId}-${Date.now().toString(36)}${(++this.seq).toString(36)}`;
    const { spec, cwd, launcher } = prepare(id);
    let proc: SessionProc;
    try {
      proc = (this.d.spawn ?? spawnPty)(spec, cwd);
    } catch (err) {
      removeFile(launcher);
      throw err;
    }
    const session: Session = { taskId, proc, output: '', launcher };
    this.sessions.set(id, session);
    proc.onStdout((data) => {
      session.output = (session.output + data).slice(-OUTPUT_BYTES);
      this.d.emit({ type: 'terminal:data', id, data });
    });
    proc.onExit(() => {
      session.proc = null;
      removeFile(launcher);
      this.d.emit({ type: 'terminal:end', id });
    });
    this.d.log.info(`[${taskId}] opened terminal session ${id}: ${spec.command} ${spec.args.join(' ')}`);
    return id;
  }

  write(id: string, data: string): void {
    this.sessions.get(id)?.proc?.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    try {
      this.sessions.get(id)?.proc?.resize(cols, rows);
    } catch {
      /* the pty is gone */
    }
  }

  /** The output so far, and whether the session has ended. Null for an unknown or closed session. */
  output(id: string): { data: string; ended: boolean } | null {
    const s = this.sessions.get(id);
    return s ? { data: s.output, ended: !s.proc } : null;
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
