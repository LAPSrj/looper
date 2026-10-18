import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Logger } from '../src/engine/log';
import type { SessionProc } from '../src/engine/steps/session';
import { TerminalSessions } from '../src/engine/terminal-sessions';
import type { EngineEvent } from '../src/shared/types';

/** A pty stand-in the test drives: what the harness prints, and its exit. */
function fakeProc() {
  let out: (d: string) => void = () => {};
  let exit: (code: number | null) => void = () => {};
  const written: string[] = [];
  const state = { killed: false, size: [0, 0] };
  const proc: SessionProc = {
    pid: 0,
    onStdout: (cb) => (out = cb),
    onStderr: () => {},
    onExit: (cb) => (exit = cb),
    write: (d) => written.push(d),
    resize: (c, r) => (state.size = [c, r]),
    kill: () => (state.killed = true),
  };
  return { proc, print: (d: string) => out(d), exit: () => exit(0), written, state };
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-terminals-'));
  const events: EngineEvent[] = [];
  const fake = fakeProc();
  const sessions = new TerminalSessions({ emit: (e) => events.push(e), log: new Logger(), spawn: () => fake.proc });
  const launcher = path.join(dir, 'terminal.sh');
  const id = sessions.start('task-1', (sid) => {
    fs.writeFileSync(launcher, `# ${sid}`);
    return { spec: { command: 'bash', args: [] }, cwd: dir, launcher };
  });
  return { sessions, events, fake, launcher, id };
}

describe('terminal sessions', () => {
  it('streams output to its window, keeps it for a late one, and passes input and size through', () => {
    const { sessions, events, fake, id } = setup();
    fake.print('hello ');
    fake.print('world');
    expect(events).toEqual([
      { type: 'terminal:data', id, data: 'hello ' },
      { type: 'terminal:data', id, data: 'world' },
    ]);
    expect(sessions.output(id)).toEqual({ data: 'hello world', ended: false });
    sessions.write(id, 'ls\r');
    sessions.resize(id, 100, 30);
    expect(fake.written).toEqual(['ls\r']);
    expect(fake.state.size).toEqual([100, 30]);
    expect(sessions.running()).toBe(1);
  });

  it('reports the end when the harness exits, and deletes the launcher', () => {
    const { sessions, events, fake, launcher, id } = setup();
    fake.exit();
    expect(events.at(-1)).toEqual({ type: 'terminal:end', id });
    expect(sessions.output(id)?.ended).toBe(true);
    expect(sessions.running()).toBe(0);
    expect(fs.existsSync(launcher)).toBe(false);
  });

  it('closing the window kills the session and forgets it', () => {
    const { sessions, fake, launcher, id } = setup();
    sessions.close(id);
    expect(fake.state.killed).toBe(true);
    expect(sessions.output(id)).toBeNull();
    expect(sessions.running()).toBe(0);
    expect(fs.existsSync(launcher)).toBe(false);
  });

  it("a closed session's late output and exit stay out of a new session that took its id", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-terminals-'));
    const events: EngineEvent[] = [];
    const procs = [fakeProc(), fakeProc()];
    let n = 0;
    const sessions = new TerminalSessions({ emit: (e) => events.push(e), log: new Logger(), spawn: () => procs[n++].proc });
    const launcher = path.join(dir, 'terminal.sh');
    const prepare = () => {
      fs.writeFileSync(launcher, '');
      return { spec: { command: 'bash', args: [] }, cwd: dir, launcher };
    };
    sessions.start('task-1', prepare, 'run-1');
    sessions.close('run-1');
    sessions.start('task-1', prepare, 'run-1');
    procs[0].print('old');
    procs[0].exit();
    procs[1].print('new');
    expect(events).toEqual([{ type: 'terminal:data', id: 'run-1', data: 'new' }]);
    expect(sessions.output('run-1')).toEqual({ data: 'new', ended: false });
    expect(fs.existsSync(launcher)).toBe(true);
  });

  it('deletes the launcher when the pty cannot start', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-terminals-'));
    const launcher = path.join(dir, 'terminal.sh');
    const sessions = new TerminalSessions({
      emit: () => {},
      log: new Logger(),
      spawn: () => {
        throw new Error('spawn wsl.exe ENOENT');
      },
    });
    expect(() =>
      sessions.start('task-1', () => {
        fs.writeFileSync(launcher, '');
        return { spec: { command: 'wsl.exe', args: [] }, cwd: dir, launcher };
      }),
    ).toThrow(/ENOENT/);
    expect(fs.existsSync(launcher)).toBe(false);
  });
});
